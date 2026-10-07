import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { ReaderAnswer } from '../claude/readers.ts';

let readerStub: Server;
let webhookServer: Server;
let delivered: ReaderAnswer[] = [];
const PENDING_STATE = 'state-123';

before(async () => {
	readerStub = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		const { params } = JSON.parse(body);
		const matches = params.state === PENDING_STATE;
		response.writeHead(matches ? 200 : 404, {
			'content-type': 'application/json',
		});
		response.end(JSON.stringify(matches ? { answer: 'Connected' } : {}));
	}).listen(0);
	const { port } = readerStub.address() as AddressInfo;
	process.env.READERS = JSON.stringify([
		{ name: 'bank', description: 'Bank', url: `http://127.0.0.1:${port}` },
	]);

	const { handleReaderCallback, readerCallbackName } = await import(
		'./callback.ts'
	);
	webhookServer = createServer((request, response) => {
		const name = readerCallbackName(request);
		if (!name) return response.writeHead(404).end();
		handleReaderCallback(name, request, response, async (answer) => {
			delivered.push(answer);
		});
	}).listen(0);
});

after(() => {
	readerStub.close();
	webhookServer.close();
});

async function visit(path: string) {
	const { port } = webhookServer.address() as AddressInfo;
	const response = await fetch(`http://127.0.0.1:${port}${path}`);
	const page = await response.text();
	await new Promise((resolve) => setTimeout(resolve, 100));
	return { status: response.status, page };
}

test('delivers the reader answer only for the pending state', async () => {
	delivered = [];
	const wrong = await visit('/hooks/callback/bank?code=abc&state=guess');
	assert.equal(wrong.status, 200);
	assert.deepEqual(delivered, []);

	await visit(`/hooks/callback/bank?code=abc&state=${PENDING_STATE}`);
	assert.deepEqual(delivered, [
		{ reader: 'bank', answer: 'Connected', conversation: undefined },
	]);
});

test('never reflects the query and rejects unknown readers', async () => {
	const { page } = await visit('/hooks/callback/bank?code=<script>x</script>');
	assert.equal(page.includes('script'), false);
	assert.equal((await visit('/hooks/callback/other?state=x')).status, 404);
	assert.equal((await visit('/hooks/callback/../ask')).status, 404);
});
