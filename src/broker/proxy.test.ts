import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import {
	createServer,
	type IncomingHttpHeaders,
	request,
	type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Route } from './config.ts';
import { createRouteServer } from './proxy.ts';

const secretsDirectory = mkdtempSync(join(tmpdir(), 'broker-test-'));
const openServers: { close(): void }[] = [];

after(() => {
	for (const server of openServers) server.close();
});

interface ReceivedRequest {
	method?: string;
	url?: string;
	headers: IncomingHttpHeaders;
	body: string;
}

async function startUpstream(
	handler: (request: ReceivedRequest, response: ServerResponse) => void,
) {
	const received: ReceivedRequest[] = [];
	const server = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		const entry = {
			method: request.method,
			url: request.url,
			headers: request.headers,
			body,
		};
		received.push(entry);
		handler(entry, response);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	openServers.push(server);
	const { port } = server.address() as AddressInfo;
	return { origin: `http://127.0.0.1:${port}`, received };
}

async function startBroker(route: Omit<Route, 'port' | 'name'>) {
	const server = createRouteServer({ ...route, name: 'test', port: 0 });
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	openServers.push(server);
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

function secretFile(name: string, value: string) {
	const path = join(secretsDirectory, name);
	writeFileSync(path, `${value}\n`);
	return path;
}

test('injects the bearer token and strips client credentials', async () => {
	const upstream = await startUpstream((_, response) => {
		response.setHeader('set-cookie', 'session=leak');
		response.end('ok');
	});
	const broker = await startBroker({
		upstream: upstream.origin,
		auth: { type: 'bearer', tokenFile: secretFile('grafana', 'glc_token') },
	});

	const response = await fetch(`${broker}/api/search?query=up`, {
		headers: { authorization: 'Bearer agent-guess', cookie: 'a=b' },
	});

	assert.equal(response.status, 200);
	assert.equal(await response.text(), 'ok');
	assert.equal(response.headers.get('set-cookie'), null);
	assert.equal(upstream.received[0].url, '/api/search?query=up');
	assert.equal(upstream.received[0].headers.authorization, 'Bearer glc_token');
	assert.equal(upstream.received[0].headers.cookie, undefined);
});

test('rejects methods outside the allowlist', async () => {
	const upstream = await startUpstream((_, response) => response.end());
	const broker = await startBroker({
		upstream: upstream.origin,
		methods: ['GET'],
		auth: { type: 'bearer', tokenFile: secretFile('readonly', 'token123') },
	});

	const response = await fetch(`${broker}/api/states`, { method: 'DELETE' });

	assert.equal(response.status, 405);
	assert.equal(upstream.received.length, 0);
});

test('keeps absolute and protocol-relative request targets on the upstream', async () => {
	const upstream = await startUpstream((_, response) => response.end('ok'));
	const broker = await startBroker({
		upstream: upstream.origin,
		auth: { type: 'bearer', tokenFile: secretFile('pinned', 'token123') },
	});
	const { port } = new URL(broker);

	for (const path of ['http://example.com/steal', '//example.com/steal']) {
		const status = await new Promise((resolve, reject) =>
			request({ host: '127.0.0.1', port, path }, (response) => {
				response.resume();
				resolve(response.statusCode);
			})
				.on('error', reject)
				.end(),
		);
		assert.equal(status, 200);
	}

	assert.deepEqual(
		upstream.received.map((entry) => entry.url),
		['/steal', '/steal'],
	);
});

test('logs in to UniFi, forwards the session, and logs in again after a 401', async () => {
	let logins = 0;
	const upstream = await startUpstream((request, response) => {
		if (request.url === '/api/auth/login') {
			logins++;
			assert.deepEqual(JSON.parse(request.body), {
				username: 'wicek',
				password: 'hunter22',
			});
			response.setHeader('set-cookie', [
				`TOKEN=session-${logins}; Path=/; HttpOnly`,
			]);
			response.setHeader('x-csrf-token', `csrf-${logins}`);
			response.end('{}');
			return;
		}
		if (request.headers.cookie === 'TOKEN=session-1') {
			response.statusCode = 401;
			response.end();
			return;
		}
		response.setHeader('x-updated-csrf-token', 'rotated');
		response.end(
			JSON.stringify({
				csrf: request.headers['x-csrf-token'],
				body: request.body,
			}),
		);
	});
	const broker = await startBroker({
		upstream: upstream.origin,
		auth: {
			type: 'unifi',
			usernameFile: secretFile('unifi-username', 'wicek'),
			passwordFile: secretFile('unifi-password', 'hunter22'),
		},
	});

	const response = await fetch(
		`${broker}/proxy/network/api/s/default/stat/sta`,
		{
			method: 'POST',
			body: '{"limit":1}',
		},
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		csrf: 'csrf-2',
		body: '{"limit":1}',
	});
	assert.equal(response.headers.get('x-updated-csrf-token'), null);
	assert.equal(logins, 2);

	await fetch(`${broker}/proxy/network/api/s/default/stat/device`);
	assert.equal(upstream.received.at(-1)?.headers['x-csrf-token'], 'rotated');
	assert.equal(logins, 2);
});

test('returns 502 when the upstream is unreachable', async () => {
	const broker = await startBroker({
		upstream: 'http://127.0.0.1:1',
		auth: { type: 'bearer', tokenFile: secretFile('unreachable', 'token123') },
	});

	const response = await fetch(`${broker}/api`);

	assert.equal(response.status, 502);
});
