import { join } from 'node:path';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import logger from '../utils/logger.ts';
import { agentEnv } from './secrets.ts';

export const WORK_BROWSER_SERVER_NAME = 'chrome-devtools';

const CHROME_DEVTOOLS_MCP_PATH =
	process.env.CHROME_DEVTOOLS_MCP_PATH ??
	join(process.cwd(), 'node_modules/.bin/chrome-devtools-mcp');
const CHROME_DEVTOOLS_MCP_ARGS = [
	'--browser-url=http://localhost:9222',
	'--usageStatistics=false',
];
const TOOL_CALL_TIMEOUT_MS = 10 * 60_000;

export interface DevtoolsCommand {
	command: string;
	args: string[];
}

export interface WorkBrowserServer {
	config: McpSdkServerConfigWithInstance;
	close: () => Promise<void>;
}

const DEFAULT_COMMAND: DevtoolsCommand = {
	command: CHROME_DEVTOOLS_MCP_PATH,
	args: CHROME_DEVTOOLS_MCP_ARGS,
};

const toolLists = new Map<string, Promise<Tool[]>>();

export function createWorkBrowserServer(
	devtoolsCommand: DevtoolsCommand = DEFAULT_COMMAND,
): WorkBrowserServer {
	let devtools: Promise<Client> | undefined;
	const server = new McpServer(
		{ name: WORK_BROWSER_SERVER_NAME, version: '1.0.0' },
		{ capabilities: { tools: {} } },
	);

	server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: await listTools(devtoolsCommand),
	}));
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		devtools ??= openDevtools(devtoolsCommand);
		const client = await devtools.catch((error) => {
			devtools = undefined;
			throw error;
		});
		return client.callTool(request.params, undefined, {
			timeout: TOOL_CALL_TIMEOUT_MS,
			resetTimeoutOnProgress: true,
		});
	});

	return {
		config: { type: 'sdk', name: WORK_BROWSER_SERVER_NAME, instance: server },
		close: async () => {
			const client = await devtools?.catch(() => undefined);
			devtools = undefined;
			await client?.close().catch(() => {});
			await server.close().catch(() => {});
		},
	};
}

function listTools(devtoolsCommand: DevtoolsCommand): Promise<Tool[]> {
	const key = JSON.stringify(devtoolsCommand);
	const cached = toolLists.get(key);
	if (cached) return cached;

	const tools = (async () => {
		const client = await openDevtools(devtoolsCommand);
		try {
			return (await client.listTools()).tools;
		} finally {
			await client.close().catch(() => {});
		}
	})();
	toolLists.set(key, tools);
	tools.catch((error) => {
		toolLists.delete(key);
		logger.warn({ err: error }, 'Could not list chrome-devtools tools');
	});
	return tools;
}

async function openDevtools(devtoolsCommand: DevtoolsCommand): Promise<Client> {
	const client = new Client({ name: 'wicek', version: '1.0.0' });
	await client.connect(
		new StdioClientTransport({
			command: devtoolsCommand.command,
			args: devtoolsCommand.args,
			env: { ...definedEnv(), CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
			stderr: 'ignore',
		}),
	);
	return client;
}

function definedEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(agentEnv()).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}
