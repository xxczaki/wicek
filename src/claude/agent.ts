import { query } from '@anthropic-ai/claude-agent-sdk';
import logger from '../utils/logger.ts';
import { type AgentEvent, mapSdkMessage } from './events.ts';

export type { AgentEvent } from './events.ts';

export interface StreamAgentOptions {
	prompt: string;
	sessionId?: string;
	model?: string;
	abortController?: AbortController;
}

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
				model: options.model,
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
