#!/usr/bin/env node
const HA_URL =
	process.env.HA_URL ?? 'http://homeassistant.wicek.svc.cluster.local:8123';
const HA_TOKEN = process.env.HA_TOKEN;
const TIMEOUT_MS = 60_000;

const SHORTCUTS = {
	entities: () => ({ type: 'config/entity_registry/list' }),
	devices: () => ({ type: 'config/device_registry/list' }),
	areas: () => ({ type: 'config/area_registry/list' }),
	floors: () => ({ type: 'config/floor_registry/list' }),
	labels: () => ({ type: 'config/label_registry/list' }),
	'config-entries': () => ({ type: 'config_entries/get' }),
	services: () => ({ type: 'get_services' }),
	traces: ({ positional, flags }) => ({
		type: 'trace/list',
		domain: flags.domain ?? 'automation',
		...(positional[0] && { item_id: positional[0] }),
	}),
	trace: ({ positional, flags }) => ({
		type: 'trace/get',
		domain: flags.domain ?? 'automation',
		item_id: required(positional[0], 'item_id'),
		run_id: required(positional[1], 'run_id'),
	}),
	'statistic-ids': ({ flags }) => ({
		type: 'recorder/list_statistic_ids',
		...(flags.type && { statistic_type: flags.type }),
	}),
	statistics: ({ positional, flags }) => ({
		type: 'recorder/statistics_during_period',
		statistic_ids: required(positional[0], 'statistic_id[,statistic_id]').split(
			',',
		),
		start_time: toIso(required(flags.start, '--start')),
		...(flags.end && { end_time: toIso(flags.end) }),
		period: flags.period ?? 'hour',
		...(flags.types && { types: flags.types.split(',') }),
	}),
	related: ({ positional }) => ({
		type: 'search/related',
		item_type: required(positional[0], 'item_type'),
		item_id: required(positional[1], 'item_id'),
	}),
};

const USAGE = `Usage: node ha.mjs <command> [args] [--flags]

  ws <type> [json]                       any WebSocket command, e.g. ws get_config
  entities | devices | areas | floors | labels | config-entries | services
  traces [item_id] [--domain script]     list automation (or script) traces
  trace <item_id> <run_id> [--domain script]
  statistic-ids [--type mean|sum]
  statistics <id[,id]> --start <ISO> [--end <ISO>] [--period 5minute|hour|day|week|month] [--types mean,sum,...]
  related <item_type> <item_id>          e.g. related entity light.kitchen
  subscribe [event_type] [--seconds 30]  stream events as JSON lines`;

process.stdout.on('error', () => process.exit(0));

await main();

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const { positional, flags } = parseArgs(rest);

	if (!command || command === 'help' || flags.help) {
		console.log(USAGE);
		return;
	}
	if (!HA_TOKEN) fail('HA_TOKEN is not set');

	const connection = await connect();
	try {
		if (command === 'subscribe') {
			await streamEvents(
				connection,
				positional[0],
				Number(flags.seconds ?? 30),
			);
			return;
		}
		const message = buildMessage(command, positional, flags);
		const result = await connection.send(message);
		console.log(JSON.stringify(result, null, 2));
	} finally {
		connection.close();
	}
}

function buildMessage(command, positional, flags) {
	if (command === 'ws') {
		const type = required(positional[0], 'type');
		const payload = positional[1] ? parseJson(positional[1]) : {};
		return { ...payload, type };
	}
	const shortcut = SHORTCUTS[command];
	if (!shortcut) fail(`unknown command: ${command}\n\n${USAGE}`);
	return shortcut({ positional, flags });
}

async function streamEvents(connection, eventType, durationSeconds) {
	await connection.send(
		{ type: 'subscribe_events', ...(eventType && { event_type: eventType }) },
		(event) => console.log(JSON.stringify(event)),
	);
	await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
}

function connect() {
	const socket = new WebSocket(
		`${HA_URL.replace(/^http/, 'ws')}/api/websocket`,
	);
	const pending = new Map();
	const listeners = new Map();
	let nextId = 1;

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error('timed out connecting')),
			TIMEOUT_MS,
		);

		socket.addEventListener('error', () =>
			reject(new Error(`cannot connect to ${HA_URL}`)),
		);
		socket.addEventListener('message', ({ data }) => {
			const message = JSON.parse(data);

			if (message.type === 'auth_required') {
				socket.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
			} else if (message.type === 'auth_invalid') {
				reject(new Error(`auth failed: ${message.message}`));
			} else if (message.type === 'auth_ok') {
				clearTimeout(timeout);
				resolve({ send, close: () => socket.close() });
			} else if (message.type === 'event') {
				listeners.get(message.id)?.(message.event);
			} else if (message.type === 'result') {
				const request = pending.get(message.id);
				pending.delete(message.id);
				if (message.success) request?.resolve(message.result);
				else
					request?.reject(
						new Error(`${message.error?.code}: ${message.error?.message}`),
					);
			}
		});
	}).catch((error) => fail(error.message));

	function send(message, onEvent) {
		const id = nextId++;
		if (onEvent) listeners.set(id, onEvent);
		socket.send(JSON.stringify({ ...message, id }));
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`timed out waiting for ${message.type}`)),
				TIMEOUT_MS,
			);
			pending.set(id, {
				resolve: (result) => {
					clearTimeout(timeout);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
		}).catch((error) => fail(error.message));
	}
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
		const next = argv[index + 1];
		if (next !== undefined && !next.startsWith('--')) {
			flags[argument.slice(2)] = next;
			index++;
		} else {
			flags[argument.slice(2)] = true;
		}
	}
	return { positional, flags };
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		fail(`invalid JSON payload: ${text}`);
	}
}

function toIso(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) fail(`invalid date: ${value}`);
	return date.toISOString();
}

function required(value, name) {
	if (value === undefined || value === true)
		fail(`missing ${name}\n\n${USAGE}`);
	return value;
}

function fail(message) {
	console.error(JSON.stringify({ error: String(message) }));
	process.exit(1);
}
