import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkBrowserServer, type WorkBrowserServer } from './devtools.ts';

const FIXTURE_DIRECTORY = await mkdtemp(join(tmpdir(), 'wicek-devtools-'));
const START_LOG_PATH = join(FIXTURE_DIRECTORY, 'starts.log');
const FAKE_SERVER_PATH = join(FIXTURE_DIRECTORY, 'fake-devtools.mjs');
process.env.FAKE_DEVTOOLS_START_LOG = START_LOG_PATH;

await writeFile(START_LOG_PATH, '');
await writeFile(
	FAKE_SERVER_PATH,
	`import { appendFileSync } from 'node:fs';
import { McpServer } from ${JSON.stringify(resolveSdk('server/mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(resolveSdk('server/stdio.js'))};
appendFileSync(process.env.FAKE_DEVTOOLS_START_LOG, 'start\\n');
const server = new McpServer({ name: 'fake', version: '1.0.0' });
server.registerTool('list_pages', { description: 'List pages' }, async () => ({
	content: [{ type: 'text', text: 'pages listed' }],
}));
await server.connect(new StdioServerTransport());
`,
);

const FAKE_COMMAND = { command: process.execPath, args: [FAKE_SERVER_PATH] };
const openServers: WorkBrowserServer[] = [];

after(async () => {
	await Promise.all(openServers.map((server) => server.close()));
});

describe('createWorkBrowserServer', () => {
	it('lists tools once without keeping chrome-devtools-mcp running', async () => {
		const first = await connect();
		const second = await connect();

		const tools = await first.listTools();
		await second.listTools();

		assert.deepEqual(
			tools.tools.map((tool) => tool.name),
			['list_pages'],
		);
		assert.equal(await startCount(), 1);
	});

	it('starts chrome-devtools-mcp on the first tool call and reuses it', async () => {
		const client = await connect();
		const before = await startCount();

		const result = await client.callTool({ name: 'list_pages', arguments: {} });
		await client.callTool({ name: 'list_pages', arguments: {} });

		assert.deepEqual(result.content, [{ type: 'text', text: 'pages listed' }]);
		assert.equal(await startCount(), before + 1);
	});
});

async function connect(): Promise<Client> {
	const workBrowser = createWorkBrowserServer(FAKE_COMMAND);
	openServers.push(workBrowser);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await workBrowser.config.instance.connect(serverTransport);
	const client = new Client({ name: 'test', version: '1.0.0' });
	await client.connect(clientTransport);
	return client;
}

async function startCount(): Promise<number> {
	return (await readFile(START_LOG_PATH, 'utf8')).split('\n').filter(Boolean)
		.length;
}

function resolveSdk(path: string): string {
	return fileURLToPath(
		import.meta.resolve(`@modelcontextprotocol/sdk/${path}`),
	);
}
