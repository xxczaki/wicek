#!/usr/bin/env node
const HA_URL = 'ws://homeassistant.wicek.svc.cluster.local:8123/api/websocket';
const TIMEOUT_MS = 60_000;

const [type, payload = '{}'] = process.argv.slice(2);
if (!type) fail('usage: node ws.mjs <type> [json-payload]');

const socket = new WebSocket(HA_URL);
setTimeout(() => fail('timed out'), TIMEOUT_MS).unref();

socket.addEventListener('error', () => fail(`cannot connect to ${HA_URL}`));
socket.addEventListener('message', ({ data }) => {
	const message = JSON.parse(data);

	if (message.type === 'auth_required') {
		socket.send(
			JSON.stringify({ type: 'auth', access_token: process.env.HA_TOKEN }),
		);
	} else if (message.type === 'auth_invalid') {
		fail(message.message);
	} else if (message.type === 'auth_ok') {
		socket.send(JSON.stringify({ ...JSON.parse(payload), id: 1, type }));
	} else if (message.type === 'result') {
		if (!message.success) fail(message.error?.message);
		console.log(JSON.stringify(message.result));
		socket.close();
	}
});

function fail(error) {
	console.error(JSON.stringify({ error }));
	process.exit(1);
}
