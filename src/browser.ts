import { randomUUID } from 'node:crypto';
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { allowedTools, sanitizeCall } from './browser/tools.ts';
import logger from './utils/logger.ts';

const BROWSER_MCP_PORT = Number(process.env.BROWSER_MCP_PORT ?? 8931);
const BROWSER_DEBUG_URL =
	process.env.BROWSER_DEBUG_URL ?? 'http://127.0.0.1:9222';
const CHROME_DEVTOOLS_MCP_PATH =
	process.env.CHROME_DEVTOOLS_MCP_PATH ??
	'/app/node_modules/.bin/chrome-devtools-mcp';
const BLOCKED_URL_PATTERNS = ['chrome-extension://*', 'http://logins.broker/*'];
const CHROME_DEVTOOLS_MCP_ARGS = [
	`--browserUrl=${BROWSER_DEBUG_URL}`,
	'--usageStatistics=false',
	'--javascriptEvaluation=false',
	'--fileNavigations=false',
	'--categoryNetwork=false',
	'--categoryPerformance=false',
	'--categoryMemory=false',
	...BLOCKED_URL_PATTERNS.map((pattern) => `--blockedUrlPattern=${pattern}`),
];
const MAX_SESSIONS = 4;
const SESSION_IDLE_MS = 15 * 60_000;
const SESSION_SWEEP_INTERVAL_MS = 60_000;

const sessions = new Map<
	string,
	{ transport: StreamableHTTPServerTransport; lastUsedAt: number }
>();

setInterval(closeIdleSessions, SESSION_SWEEP_INTERVAL_MS).unref();

createServer((request, response) => {
	handle(request, response).catch((error) => {
		logger.error({ err: error }, 'Browser MCP request failed');
		if (!response.headersSent) respond(response, 500, 'Browser MCP failed');
	});
}).listen(BROWSER_MCP_PORT, () => {
	logger.info({ port: BROWSER_MCP_PORT }, 'Browser MCP listening');
});

async function handle(request: IncomingMessage, response: ServerResponse) {
	const path = new URL(request.url ?? '/', 'http://localhost').pathname;
	if (request.method === 'GET' && path === '/healthz') {
		return respond(response, 200, 'ok');
	}
	if (path !== '/mcp') return respond(response, 404, 'Not found');

	const sessionId = request.headers['mcp-session-id'];
	const existing =
		typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
	if (existing) {
		existing.lastUsedAt = Date.now();
		return existing.transport.handleRequest(request, response);
	}
	if (sessionId) return respond(response, 404, 'Unknown session');
	if (request.method !== 'POST') {
		return respond(response, 405, 'Start a session with a POST');
	}
	if (sessions.size >= MAX_SESSIONS) await closeLeastRecentSession();

	const transport = await openSession();
	await transport.handleRequest(request, response);
	if (!transport.sessionId) await transport.close();
}

async function openSession(): Promise<StreamableHTTPServerTransport> {
	const devtools = new Client({ name: 'wicek-browser', version: '1.0.0' });
	await devtools.connect(
		new StdioClientTransport({
			command: CHROME_DEVTOOLS_MCP_PATH,
			args: CHROME_DEVTOOLS_MCP_ARGS,
			env: { ...cleanEnv(), CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
			stderr: 'ignore',
		}),
	);

	const server = new Server(
		{ name: 'account-browser', version: '1.0.0' },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: allowedTools((await devtools.listTools()).tools),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const params = sanitizeCall(request.params);
		if (!params) {
			return {
				content: [
					{ type: 'text', text: `Tool ${request.params.name} is disabled` },
				],
				isError: true,
			};
		}
		return devtools.callTool(params);
	});

	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: randomUUID,
		onsessioninitialized: (sessionId) => {
			sessions.set(sessionId, { transport, lastUsedAt: Date.now() });
			logger.info({ sessionId }, 'Browser session opened');
		},
	});
	transport.onclose = () => {
		if (transport.sessionId) sessions.delete(transport.sessionId);
		devtools.close().catch(() => {});
		logger.info({ sessionId: transport.sessionId }, 'Browser session closed');
	};
	await server.connect(transport);
	return transport;
}

function closeIdleSessions() {
	const cutoff = Date.now() - SESSION_IDLE_MS;
	for (const { transport, lastUsedAt } of sessions.values()) {
		if (lastUsedAt < cutoff) transport.close().catch(() => {});
	}
}

async function closeLeastRecentSession() {
	const [oldest] = [...sessions.values()].sort(
		(first, second) => first.lastUsedAt - second.lastUsedAt,
	);
	await oldest?.transport.close().catch(() => {});
}

function cleanEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}

function respond(response: ServerResponse, status: number, text: string) {
	response.writeHead(status, { 'content-type': 'text/plain' });
	response.end(text);
}
