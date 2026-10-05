#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const CONTROLLERS_FILE = join(SKILL_DIR, 'controllers.json');
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const SESSION_DIR = join(DATA_DIR, 'tmp');
const SNAPSHOT_DIR = join(DATA_DIR, 'unifi', 'snapshots');
const CLOUD_CONNECTOR_URL = 'https://api.ui.com/v1/connector/consoles';
const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const SYSLOG_PAGE_SIZE = 500;
const SYSLOG_MAX_PAGES = 40;
const WAIT_POLL_INTERVAL_MS = 5_000;
const WAIT_DEFAULT_TIMEOUT_S = 600;
const DEVICE_STATE_CONNECTED = 1;

const REPORT_DEFAULT_ATTRS = {
	site: [
		'bytes',
		'wan-tx_bytes',
		'wan-rx_bytes',
		'num_sta',
		'wlan-num_sta',
		'lan-num_sta',
		'time',
	],
	ap: [
		'bytes',
		'num_sta',
		'time',
		'tx_bytes',
		'rx_bytes',
		'tx_packets',
		'tx_retries',
		'tx_dropped',
		'rx_dropped',
		'wifi_tx_attempts',
		'wifi_tx_dropped',
	],
	user: [
		'time',
		'signal',
		'rssi',
		'rx_bytes',
		'tx_bytes',
		'rx_rate',
		'tx_rate',
		'rx_packets',
		'tx_packets',
		'rx_retries',
		'tx_retries',
		'satisfaction',
		'wifi_tx_attempts',
		'duration',
	],
	gw: [
		'time',
		'wan-tx_bytes',
		'wan-rx_bytes',
		'lan-tx_bytes',
		'lan-rx_bytes',
		'cpu',
		'mem',
		'latency_avg',
	],
};

const COMMANDS = {
	controllers: listControllers,
	get: (context, positional) => callAndPrint(context, 'GET', positional),
	post: (context, positional) => callAndPrint(context, 'POST', positional),
	put: (context, positional) => callAndPrint(context, 'PUT', positional),
	report: runReport,
	syslog: runSyslog,
	snapshot: runSnapshot,
	wait: runWait,
	logout: runLogout,
};

export async function main(argv) {
	const [command, ...rest] = argv;
	const { positional, flags } = parseArgs(rest);
	const handler = COMMANDS[command];
	if (!handler)
		fail(
			`unknown command: ${command ?? '(none)'}. Commands: ${Object.keys(COMMANDS).join(', ')}`,
		);
	const controllers = await loadControllers();
	if (command === 'controllers') return handler(controllers);
	const name = flags.controller ?? Object.keys(controllers)[0];
	const controller = controllers[name];
	if (!controller)
		fail(
			`unknown controller: ${name}. Configured: ${Object.keys(controllers).join(', ')}`,
		);
	const context = {
		name,
		controller,
		site: flags.site ?? controller.site ?? 'default',
		flags,
	};
	return handler(context, positional);
}

main(process.argv.slice(2)).catch((error) => fail(error?.message ?? error));

function listControllers(controllers) {
	print(
		Object.entries(controllers).map(([name, controller]) => ({
			name,
			auth: controller.auth,
			url: controller.url,
			consoleId: controller.consoleId,
			site: controller.site ?? 'default',
			description: controller.description,
			credentialsPresent: credentialEnvNames(controller).every((envName) =>
				Boolean(process.env[envName]),
			),
		})),
	);
}

async function callAndPrint(context, method, positional) {
	const [path, body] = positional;
	if (!path)
		fail(
			`${method.toLowerCase()} requires a path, e.g. api/s/{site}/stat/device`,
		);
	if (method !== 'GET' && body === undefined)
		fail(`${method.toLowerCase()} requires a JSON body`);
	const result = await callApi(
		context,
		method,
		path,
		body === undefined ? undefined : parseJson(body),
	);
	print(shape(unwrap(result, context.flags), context.flags));
}

async function runReport(context, positional) {
	const [interval, type] = positional;
	if (
		!['5minutes', 'hourly', 'daily', 'monthly'].includes(interval) ||
		!REPORT_DEFAULT_ATTRS[type]
	) {
		fail(
			'report requires <5minutes|hourly|daily|monthly> <site|ap|user|gw> [--from] [--to] [--attrs a,b] [--macs m1,m2]',
		);
	}
	const body = {
		attrs: splitList(context.flags.attrs) ?? REPORT_DEFAULT_ATTRS[type],
		start: parseTime(context.flags.from ?? '-24h'),
		end: parseTime(context.flags.to ?? 'now'),
	};
	const macs = splitList(context.flags.macs);
	if (macs) body.macs = macs.map((mac) => mac.toLowerCase());
	const result = await callApi(
		context,
		'POST',
		`api/s/{site}/stat/report/${interval}.${type}`,
		body,
	);
	const rows = unwrap(result, context.flags).map((row) => ({
		...row,
		time_iso: new Date(row.time).toISOString(),
	}));
	print(shape(rows, context.flags));
}

async function runSyslog(context) {
	const { flags } = context;
	const category = flags.category ?? 'all';
	const timestampFrom = parseTime(flags.from ?? '-24h');
	const timestampTo = parseTime(flags.to ?? 'now');
	const keyFilter = flags.key ? new RegExp(flags.key, 'i') : null;
	const textFilter = flags.grep ? new RegExp(flags.grep, 'i') : null;
	const limit = flags.limit ? Number(flags.limit) : Number.POSITIVE_INFINITY;
	const entries = [];
	for (
		let pageNumber = 0;
		pageNumber < SYSLOG_MAX_PAGES && entries.length < limit;
		pageNumber++
	) {
		const page = await callApi(
			context,
			'POST',
			`v2/api/site/{site}/system-log/${category}`,
			{
				timestampFrom,
				timestampTo,
				pageSize: SYSLOG_PAGE_SIZE,
				pageNumber,
			},
		);
		const items = page?.data ?? [];
		for (const item of items) {
			if (keyFilter && !keyFilter.test(item.key ?? '')) continue;
			if (textFilter && !textFilter.test(JSON.stringify(item))) continue;
			entries.push(flags.raw ? item : summarizeSyslogEntry(item));
		}
		if (
			items.length < SYSLOG_PAGE_SIZE ||
			pageNumber + 1 >= (page?.total_page_count ?? 0)
		)
			break;
	}
	print(shape(entries.slice(0, limit), flags));
}

async function runSnapshot(context, positional) {
	const [path] = positional;
	const { flags } = context;
	if (!path)
		fail('snapshot requires a path, e.g. api/s/{site}/rest/device/<_id>');
	const result = await callApi(context, 'GET', path, undefined);
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const label =
		flags.label ??
		resolvePath(context, path).split('/').filter(Boolean).slice(-2).join('-');
	const file = join(
		SNAPSHOT_DIR,
		`${timestamp}_${context.name}_${label.replace(/[^\w.-]/g, '_')}.json`,
	);
	await mkdir(SNAPSHOT_DIR, { recursive: true });
	await writeFile(
		file,
		JSON.stringify(
			{
				controller: context.name,
				path,
				takenAt: new Date().toISOString(),
				result,
			},
			null,
			2,
		),
	);
	print({ saved: file, bytes: JSON.stringify(result).length });
}

async function runWait(context, positional) {
	const [mac] = positional;
	const { flags } = context;
	if (!mac) fail('wait requires a device MAC');
	const timeoutMs = Number(flags.timeout ?? WAIT_DEFAULT_TIMEOUT_S) * 1000;
	const startedAt = Date.now();
	let stableChecks = 0;
	let last;
	while (Date.now() - startedAt < timeoutMs) {
		const [device] = unwrap(
			await callApi(
				context,
				'GET',
				`api/s/{site}/stat/device/${mac.toLowerCase()}`,
			),
			flags,
		);
		last = summarizeDevice(device);
		const ready =
			device?.state === DEVICE_STATE_CONNECTED &&
			expectationsMet(device, flags);
		stableChecks = ready ? stableChecks + 1 : 0;
		console.error(
			JSON.stringify({
				elapsed_s: Math.round((Date.now() - startedAt) / 1000),
				...last,
			}),
		);
		if (stableChecks >= 2)
			return print({
				settled: true,
				elapsed_s: Math.round((Date.now() - startedAt) / 1000),
				device: last,
			});
		await sleep(WAIT_POLL_INTERVAL_MS);
	}
	print({ settled: false, timeout_s: timeoutMs / 1000, device: last });
	process.exitCode = 2;
}

async function runLogout(context) {
	await rm(sessionFile(context.name), { force: true });
	print({ loggedOut: context.name });
}

async function callApi(context, method, path, body) {
	const url = buildUrl(context, path);
	const payload = body === undefined ? undefined : JSON.stringify(body);
	let session = await getSession(context, false);
	let response = await send(
		context.controller,
		method,
		url,
		headersFor(context.controller, session, payload),
		payload,
	);
	if (
		(response.status === 401 || response.status === 403) &&
		context.controller.auth === 'local'
	) {
		session = await getSession(context, true);
		response = await send(
			context.controller,
			method,
			url,
			headersFor(context.controller, session, payload),
			payload,
		);
	}
	if (session && response.headers['x-updated-csrf-token']) {
		session.csrfToken = response.headers['x-updated-csrf-token'];
		await saveSession(context.name, session);
	}
	const parsed = parseJsonSafe(response.body);
	if (response.status >= 400) {
		fail(
			`${method} ${resolvePath(context, path)} → HTTP ${response.status}: ${truncate(response.body, 500)}`,
		);
	}
	return parsed;
}

async function getSession(context, forceLogin) {
	const { controller, name } = context;
	if (controller.auth !== 'local') return null;
	if (!forceLogin) {
		const cached = await readSession(name);
		if (cached && Date.now() - cached.savedAt < SESSION_MAX_AGE_MS)
			return cached;
	}
	const username = process.env[controller.usernameEnv ?? 'UNIFI_USERNAME'];
	const password = process.env[controller.passwordEnv ?? 'UNIFI_PASSWORD'];
	if (!username || !password)
		fail(
			`credentials for controller ${name} are not set (${credentialEnvNames(controller).join(', ')})`,
		);
	const payload = JSON.stringify({ username, password, rememberMe: true });
	const response = await send(
		controller,
		'POST',
		`${controller.url}/api/auth/login`,
		{ 'content-type': 'application/json', accept: 'application/json' },
		payload,
	);
	if (response.status !== 200)
		fail(`login to ${name} failed: HTTP ${response.status}`);
	const cookies = [response.headers['set-cookie'] ?? []].flat();
	const tokenCookie = cookies
		.map((cookie) => cookie.split(';')[0])
		.find((cookie) => cookie.startsWith('TOKEN='));
	const csrfToken =
		response.headers['x-csrf-token'] ??
		response.headers['x-updated-csrf-token'];
	if (!tokenCookie || !csrfToken)
		fail(`login to ${name} returned no TOKEN cookie or X-CSRF-Token header`);
	const session = { cookie: tokenCookie, csrfToken, savedAt: Date.now() };
	await saveSession(name, session);
	return session;
}

function headersFor(controller, session, payload) {
	const headers = { accept: 'application/json' };
	if (payload !== undefined) headers['content-type'] = 'application/json';
	if (session) {
		headers.cookie = session.cookie;
		headers['x-csrf-token'] = session.csrfToken;
	}
	if (controller.auth === 'cloud' || controller.auth === 'apikey') {
		const apiKey = process.env[controller.apiKeyEnv];
		if (!apiKey) fail(`API key env ${controller.apiKeyEnv} is not set`);
		headers['x-api-key'] = apiKey;
	}
	return headers;
}

function buildUrl(context, path) {
	const { controller } = context;
	const base =
		controller.auth === 'cloud'
			? `${CLOUD_CONNECTOR_URL}/${controller.consoleId}`
			: controller.url;
	return `${base}${resolvePath(context, path)}`;
}

function resolvePath(context, path) {
	const withSite = path.replaceAll('{site}', context.site).replace(/^\/+/, '');
	if (/^(api\/auth|proxy)\//.test(withSite)) return `/${withSite}`;
	return `/proxy/network/${withSite}`;
}

function send(controller, method, url, headers, payload) {
	return new Promise((resolve, reject) => {
		const outgoing = request(
			url,
			{
				method,
				headers:
					payload === undefined
						? headers
						: { ...headers, 'content-length': Buffer.byteLength(payload) },
				rejectUnauthorized: controller.insecure !== true,
				timeout: REQUEST_TIMEOUT_MS,
			},
			(response) => {
				const chunks = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('end', () =>
					resolve({
						status: response.statusCode,
						headers: response.headers,
						body: Buffer.concat(chunks).toString('utf8'),
					}),
				);
			},
		);
		outgoing.on('timeout', () =>
			outgoing.destroy(
				new Error(`timeout after ${REQUEST_TIMEOUT_MS} ms: ${method} ${url}`),
			),
		);
		outgoing.on('error', reject);
		if (payload !== undefined) outgoing.write(payload);
		outgoing.end();
	});
}

async function loadControllers() {
	try {
		return JSON.parse(await readFile(CONTROLLERS_FILE, 'utf8'));
	} catch (error) {
		fail(`cannot read ${CONTROLLERS_FILE}: ${error.message}`);
	}
}

function credentialEnvNames(controller) {
	if (controller.auth === 'local')
		return [
			controller.usernameEnv ?? 'UNIFI_USERNAME',
			controller.passwordEnv ?? 'UNIFI_PASSWORD',
		];
	return [controller.apiKeyEnv];
}

function sessionFile(name) {
	return join(SESSION_DIR, `unifi-session-${name}.json`);
}

async function readSession(name) {
	try {
		return JSON.parse(await readFile(sessionFile(name), 'utf8'));
	} catch {
		return null;
	}
}

async function saveSession(name, session) {
	await mkdir(SESSION_DIR, { recursive: true });
	const file = sessionFile(name);
	await writeFile(file, JSON.stringify(session), { mode: 0o600 });
	await chmod(file, 0o600);
}

function unwrap(result, flags) {
	if (flags.raw) return result;
	if (
		result &&
		typeof result === 'object' &&
		'meta' in result &&
		'data' in result
	) {
		if (result.meta?.rc && result.meta.rc !== 'ok')
			fail(`controller error: ${JSON.stringify(result.meta)}`);
		return result.data;
	}
	return result;
}

function shape(value, flags) {
	const fields = splitList(flags.fields);
	if (!fields || !Array.isArray(value)) return value;
	return value.map((item) =>
		Object.fromEntries(fields.map((field) => [field, pick(item, field)])),
	);
}

function pick(item, field) {
	return field
		.split('.')
		.reduce(
			(current, key) => (current == null ? undefined : current[key]),
			item,
		);
}

function summarizeSyslogEntry(item) {
	const parameters = item.parameters ?? {};
	const template = item.message_raw ?? item.msg ?? '';
	return {
		time: new Date(item.timestamp ?? item.time).toISOString(),
		key: item.key,
		severity: item.severity,
		title: item.title_raw,
		message: template.replace(
			/\{(\w+)\}/g,
			(match, name) => describeParameter(parameters[name]) ?? match,
		),
		client: parameters.CLIENT?.id ?? item.user,
		device: parameters.DEVICE?.id ?? item.ap,
	};
}

function describeParameter(parameter) {
	if (parameter == null) return undefined;
	if (typeof parameter !== 'object') return String(parameter);
	return parameter.name ?? parameter.id;
}

function summarizeDevice(device) {
	if (!device) return { found: false };
	return {
		name: device.name,
		mac: device.mac,
		state: device.state,
		version: device.version,
		uptime: device.uptime,
		radios: (device.radio_table_stats ?? []).map((radio) => ({
			radio: radio.radio,
			channel: radio.channel,
			tx_power: radio.tx_power,
			num_sta: radio.num_sta,
			cu_total: radio.cu_total,
			state: radio.state,
		})),
	};
}

function expectationsMet(device, flags) {
	const radios = device.radio_table_stats ?? [];
	const target = flags.radio
		? radios.filter((radio) => radio.radio === flags.radio)
		: radios;
	if (
		flags.channel &&
		!target.some((radio) => String(radio.channel) === String(flags.channel))
	)
		return false;
	if (
		flags['tx-power'] &&
		!target.some(
			(radio) => String(radio.tx_power) === String(flags['tx-power']),
		)
	)
		return false;
	return true;
}

function parseTime(value) {
	if (value === 'now') return Date.now();
	const relative = /^-(\d+(?:\.\d+)?)(m|h|d)$/.exec(value);
	if (relative) {
		const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]];
		return Date.now() - Number(relative[1]) * unitMs;
	}
	if (/^\d{12,}$/.test(value)) return Number(value);
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed))
		fail(
			`invalid time: ${value} (use ISO 8601, epoch ms, now, or -30m/-6h/-2d)`,
		);
	return parsed;
}

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (!argument.startsWith('--')) {
			positional.push(argument);
			continue;
		}
		const key = argument.slice(2);
		const next = argv[index + 1];
		if (next !== undefined && !next.startsWith('--')) {
			flags[key] = next;
			index++;
		} else {
			flags[key] = true;
		}
	}
	return { positional, flags };
}

function splitList(value) {
	if (!value || value === true) return undefined;
	return String(value)
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		fail(`invalid JSON body: ${truncate(text, 200)}`);
	}
}

function parseJsonSafe(text) {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function truncate(text, maxLength) {
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function sleep(durationMs) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function print(data) {
	console.log(JSON.stringify(data, null, 2));
}

function fail(message) {
	console.error(JSON.stringify({ error: String(message) }));
	process.exit(1);
}
