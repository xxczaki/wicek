import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOptionalEnv } from '../utils/env.ts';
import logger from '../utils/logger.ts';

export type AgentEvent =
	| { type: 'thinking'; content: string }
	| { type: 'text'; content: string }
	| { type: 'tool_start'; name: string; input: string; filePath?: string }
	| { type: 'tool_end'; filePath?: string }
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
	let currentToolInput = '';

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
			const evt = event.event as Record<string, unknown> | undefined;
			const delta = evt?.delta as Record<string, unknown> | undefined;
			const deltaType = delta?.type as string | undefined;

			if (
				deltaType === 'thinking_delta' &&
				typeof delta?.thinking === 'string'
			) {
				yield { type: 'thinking', content: delta.thinking };
			} else if (
				deltaType === 'text_delta' &&
				typeof delta?.text === 'string'
			) {
				yield { type: 'text', content: delta.text };
			} else if (
				deltaType === 'input_json_delta' &&
				typeof delta?.partial_json === 'string'
			) {
				currentToolInput += delta.partial_json;
			} else if (deltaType === 'content_block_start') {
				const block = evt?.content_block as Record<string, unknown> | undefined;
				if (block?.type === 'tool_use') {
					currentToolInput = '';
				}
			} else if (deltaType === 'content_block_stop') {
				currentToolInput = '';
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
						const inputSummary = formatToolInput(block.name as string, input);
						logger.info({ tool: block.name, filePath }, 'Tool use');
						yield {
							type: 'tool_start',
							name: block.name as string,
							input: inputSummary,
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
						yield { type: 'tool_end', filePath: savedPath };
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

function formatToolInput(
	name: string,
	input: Record<string, unknown> | undefined,
): string {
	if (!input) return '';
	if (name === 'Bash') return (input.command as string) || '';
	if (name === 'Read' || name === 'Write' || name === 'Edit')
		return (input.file_path as string) || '';
	if (name === 'Glob') return (input.pattern as string) || '';
	if (name === 'Grep') return (input.pattern as string) || '';
	if (name === 'WebFetch') return (input.url as string) || '';
	if (name === 'WebSearch') return (input.query as string) || '';
	if (name.startsWith('mcp__')) return JSON.stringify(input).slice(0, 100);
	return '';
}

const MEDIA_DIR = resolve(getOptionalEnv('DATA_DIR') || '/data', 'media');

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
	mkdirSync(MEDIA_DIR, { recursive: true });
	const ext = mediaType.split('/')[1] || 'png';
	const filename = `screenshot-${Date.now()}.${ext}`;
	const filepath = join(MEDIA_DIR, filename);
	writeFileSync(filepath, Buffer.from(data, 'base64'));
	logger.info({ filepath }, 'Saved screenshot');
	return filepath;
}
