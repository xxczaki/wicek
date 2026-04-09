import logger from '../utils/logger.ts';

export type AgentEvent =
	| { type: 'text'; content: string }
	| { type: 'tool'; name: string; status: 'start' | 'end' }
	| {
			type: 'result';
			sessionId: string;
			cost: number;
			turns: number;
			text: string;
	  }
	| { type: 'error'; message: string };

export async function* parseClaudeStream(
	lines: AsyncIterable<string>,
): AsyncGenerator<AgentEvent> {
	let sessionId = '';
	let resultText = '';

	for await (const line of lines) {
		if (!line.trim()) continue;

		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			logger.warn({ line }, 'Failed to parse NDJSON line');
			continue;
		}

		const type = event.type as string | undefined;

		// System init — capture session ID
		if (type === 'system' && event.subtype === 'init') {
			sessionId = (event.session_id as string) || '';
			continue;
		}

		// Streaming text delta
		if (type === 'stream_event') {
			const delta = (event.event as Record<string, unknown> | undefined)
				?.delta as Record<string, unknown> | undefined;
			if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
				yield { type: 'text', content: delta.text };
			}
			continue;
		}

		// Assistant message (non-streaming, for tool use tracking)
		if (type === 'assistant') {
			const message = event.message as Record<string, unknown> | undefined;
			const content = message?.content as
				| Array<Record<string, unknown>>
				| undefined;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === 'tool_use') {
						yield {
							type: 'tool',
							name: block.name as string,
							status: 'start',
						};
					} else if (block.type === 'text' && typeof block.text === 'string') {
						resultText += block.text;
					}
				}
			}
			continue;
		}

		// Tool result
		if (type === 'user') {
			const message = event.message as Record<string, unknown> | undefined;
			const content = message?.content as
				| Array<Record<string, unknown>>
				| undefined;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === 'tool_result') {
						yield {
							type: 'tool',
							name: '',
							status: 'end',
						};
					}
				}
			}
			continue;
		}

		// Final result
		if (type === 'result') {
			yield {
				type: 'result',
				sessionId: (event.session_id as string) || sessionId,
				cost: (event.total_cost_usd as number) || 0,
				turns: (event.num_turns as number) || 0,
				text: (event.result as string) || resultText,
			};
		}
	}
}
