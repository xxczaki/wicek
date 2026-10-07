import {
	type HookCallbackMatcher,
	type HookEvent,
	query,
	type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import logger from '../utils/logger.ts';
import { type AgentEvent, mapSdkMessage } from './events.ts';
import type { AgentInbox } from './inbox.ts';
import { createMailMcpServers, MAIL_AGENTS, MAIL_HOOKS } from './mail.ts';
import {
	createReaderMcpServers,
	READER_HOOKS,
	type ReaderAnswer,
} from './readers.ts';
import { agentEnv, REDACTION_HOOKS } from './secrets.ts';

export type { AgentEvent } from './events.ts';

export interface StreamAgentOptions {
	prompt: string;
	sessionId?: string;
	conversation?: string;
	model?: string;
	abortController?: AbortController;
	withoutMcp?: boolean;
	inbox?: AgentInbox;
}

const HOME_ASSISTANT_MCP = {
	'home-assistant': {
		type: 'sse' as const,
		url:
			process.env.HA_MCP_URL ??
			'http://homeassistant.wicek.svc.cluster.local:8123/mcp_server/sse',
	},
};

const AGENT_HOOKS = mergeHooks(REDACTION_HOOKS, MAIL_HOOKS, READER_HOOKS);

export async function* streamAgent(
	options: StreamAgentOptions,
): AsyncGenerator<AgentEvent> {
	logger.debug({ sessionId: options.sessionId }, 'Starting agent query');

	let resume = options.sessionId;
	const readerAnswers: AgentEvent[] = [];
	const deliverReaderAnswer = (answer: ReaderAnswer) =>
		readerAnswers.push({ type: 'reader_answer', ...answer });

	for (let attempt = 0; attempt < 2; attempt++) {
		const response = query({
			prompt: options.inbox
				? options.inbox.messages(options.prompt)
				: options.prompt,
			options: {
				resume,
				model: options.model ?? 'opus',
				mcpServers: options.withoutMcp
					? undefined
					: {
							...HOME_ASSISTANT_MCP,
							...createMailMcpServers(),
							...createReaderMcpServers(
								deliverReaderAnswer,
								options.conversation,
							),
						},
				agents: options.withoutMcp ? undefined : MAIL_AGENTS,
				strictMcpConfig: options.withoutMcp,
				includePartialMessages: true,
				permissionMode: 'auto',
				settingSources: ['user', 'project', 'local'],
				systemPrompt: { type: 'preset', preset: 'claude_code' },
				abortController: options.abortController,
				env: { ...agentEnv(), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
				hooks: AGENT_HOOKS,
			},
		});

		try {
			for await (const message of response) {
				if (options.inbox?.takeDeliveredCount()) yield { type: 'user_message' };
				if (isIdle(message) && !options.inbox?.hasPending)
					options.inbox?.close();
				yield* mapSdkMessage(message);
				yield* readerAnswers.splice(0);
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

function mergeHooks(
	...hookSets: Partial<Record<HookEvent, HookCallbackMatcher[]>>[]
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
	for (const hookSet of hookSets) {
		for (const [event, matchers] of Object.entries(hookSet) as [
			HookEvent,
			HookCallbackMatcher[],
		][]) {
			merged[event] = [...(merged[event] ?? []), ...matchers];
		}
	}
	return merged;
}

function isIdle(message: SDKMessage): boolean {
	return (
		message.type === 'system' &&
		message.subtype === 'session_state_changed' &&
		message.state === 'idle'
	);
}
