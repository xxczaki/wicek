import { query } from '@anthropic-ai/claude-agent-sdk';
import logger from '../utils/logger.ts';
import { type AgentEvent, mapSdkMessage } from './events.ts';
import { createMailMcpServers, MAIL_AGENTS, MAIL_HOOKS } from './mail.ts';
import { agentEnv, REDACTION_HOOKS } from './secrets.ts';

export type { AgentEvent } from './events.ts';

export interface StreamAgentOptions {
	prompt: string;
	sessionId?: string;
	model?: string;
	abortController?: AbortController;
	withoutMcp?: boolean;
}

// The Agent SDK does not expand ${VARS} in .mcp.json headers, so the Home
// Assistant MCP server is configured here with the real token at runtime.
const HOME_ASSISTANT_MCP = process.env.HA_TOKEN
	? {
			'home-assistant': {
				type: 'sse' as const,
				url:
					process.env.HA_MCP_URL ??
					'http://homeassistant.wicek.svc.cluster.local:8123/mcp_server/sse',
				headers: { Authorization: `Bearer ${process.env.HA_TOKEN}` },
			},
		}
	: undefined;

export async function* streamAgent(
	options: StreamAgentOptions,
): AsyncGenerator<AgentEvent> {
	logger.debug({ sessionId: options.sessionId }, 'Starting agent query');

	let resume = options.sessionId;

	for (let attempt = 0; attempt < 2; attempt++) {
		const response = query({
			prompt: options.prompt,
			options: {
				resume,
				model: options.model ?? 'opus',
				mcpServers: options.withoutMcp
					? undefined
					: { ...HOME_ASSISTANT_MCP, ...createMailMcpServers() },
				agents: options.withoutMcp ? undefined : MAIL_AGENTS,
				strictMcpConfig: options.withoutMcp,
				includePartialMessages: true,
				permissionMode: 'auto',
				settingSources: ['user', 'project', 'local'],
				systemPrompt: { type: 'preset', preset: 'claude_code' },
				abortController: options.abortController,
				env: agentEnv(),
				hooks: { ...REDACTION_HOOKS, ...MAIL_HOOKS },
			},
		});

		try {
			for await (const message of response) {
				yield* mapSdkMessage(message);
			}
			return;
		} catch (error) {
			if (options.abortController?.signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			// A resumed session can vanish (e.g. a pod restart dropped an
			// in-flight session). Fall back to a fresh session rather than
			// surfacing the error to the user.
			if (
				attempt === 0 &&
				resume &&
				/No conversation found with session ID/i.test(message)
			) {
				logger.warn({ sessionId: resume }, 'Stale session, starting fresh');
				resume = undefined;
				continue;
			}
			logger.error({ error }, 'Agent query failed');
			yield { type: 'error', message };
			return;
		}
	}
}
