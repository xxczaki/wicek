import { query } from '@anthropic-ai/claude-agent-sdk';
import logger from '../utils/logger.ts';
import { type AgentEvent, mapSdkMessage } from './events.ts';

export type { AgentEvent } from './events.ts';

export interface StreamAgentOptions {
	prompt: string;
	sessionId?: string;
	abortController?: AbortController;
}

export async function* streamAgent(
	options: StreamAgentOptions,
): AsyncGenerator<AgentEvent> {
	logger.debug({ sessionId: options.sessionId }, 'Starting agent query');

	const response = query({
		prompt: options.prompt,
		options: {
			resume: options.sessionId,
			includePartialMessages: true,
			permissionMode: 'auto',
			settingSources: ['user', 'project', 'local'],
			systemPrompt: { type: 'preset', preset: 'claude_code' },
			abortController: options.abortController,
		},
	});

	try {
		for await (const message of response) {
			yield* mapSdkMessage(message);
		}
	} catch (error) {
		if (options.abortController?.signal.aborted) return;
		logger.error({ error }, 'Agent query failed');
		yield {
			type: 'error',
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
