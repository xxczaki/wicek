import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOptionalEnv } from '../utils/env.ts';
import logger from '../utils/logger.ts';

export type AgentEvent =
	| { type: 'text'; content: string }
	| { type: 'tool'; name: string; status: 'start' | 'end'; filePath?: string }
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

		if (type === 'system' && event.subtype === 'init') {
			sessionId = (event.session_id as string) || '';
			continue;
		}

		if (type === 'stream_event') {
			const delta = (event.event as Record<string, unknown> | undefined)
				?.delta as Record<string, unknown> | undefined;
			if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
				yield { type: 'text', content: delta.text };
			}
			continue;
		}

		if (type === 'assistant') {
			const message = event.message as Record<string, unknown> | undefined;
			const content = message?.content as
				| Array<Record<string, unknown>>
				| undefined;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === 'tool_use') {
						const input = block.input as Record<string, unknown> | undefined;
						const filePath = input?.file_path as string | undefined;
						logger.info({ tool: block.name, filePath }, 'Tool use');
						yield {
							type: 'tool',
							name: block.name as string,
							status: 'start',
							filePath,
						};
					} else if (block.type === 'text' && typeof block.text === 'string') {
						resultText += block.text;
					}
				}
			}
			continue;
		}

		if (type === 'user') {
			const message = event.message as Record<string, unknown> | undefined;
			const content = message?.content as
				| Array<Record<string, unknown>>
				| undefined;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === 'tool_result') {
						const savedPath = extractImageFromToolResult(block);
						yield {
							type: 'tool',
							name: '',
							status: 'end',
							filePath: savedPath,
						};
					}
				}
			}
			continue;
		}

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

const MEDIA_DIR = resolve(getOptionalEnv('DATA_DIR') || '/data', 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

function extractImageFromToolResult(
	block: Record<string, unknown>,
): string | undefined {
	const inner = block.content as Array<Record<string, unknown>> | undefined;
	if (!Array.isArray(inner)) return undefined;

	for (const item of inner) {
		if (item.type === 'image') {
			const source = item.source as Record<string, string> | undefined;
			if (source?.type === 'base64' && source.data) {
				return saveBase64Image(source.data, source.media_type || 'image/png');
			}
		}
	}
	return undefined;
}

function saveBase64Image(data: string, mediaType: string): string {
	const ext = mediaType.split('/')[1] || 'png';
	const filename = `screenshot-${Date.now()}.${ext}`;
	const filepath = join(MEDIA_DIR, filename);
	writeFileSync(filepath, Buffer.from(data, 'base64'));
	logger.info({ filepath }, 'Saved screenshot');
	return filepath;
}
