import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
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

export function mapSdkMessage(message: SDKMessage): AgentEvent[] {
	switch (message.type) {
		case 'stream_event':
			return mapStreamDelta(message.event);
		case 'assistant':
			return mapToolStarts(message.message.content);
		case 'user':
			return mapToolEnds(message.message.content);
		case 'result':
			return [
				{
					type: 'result',
					sessionId: message.session_id,
					cost: message.total_cost_usd,
					turns: message.num_turns,
					text: message.subtype === 'success' ? message.result : '',
				},
			];
		default:
			return [];
	}
}

function mapStreamDelta(event: unknown): AgentEvent[] {
	const delta =
		isRecord(event) && isRecord(event.delta) ? event.delta : undefined;
	if (!delta) return [];

	if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
		return [{ type: 'thinking', content: delta.thinking }];
	}
	if (delta.type === 'text_delta' && typeof delta.text === 'string') {
		return [{ type: 'text', content: delta.text }];
	}
	return [];
}

function mapToolStarts(content: unknown): AgentEvent[] {
	if (!Array.isArray(content)) return [];

	const events: AgentEvent[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== 'tool_use') continue;

		const name = typeof block.name === 'string' ? block.name : '';
		const input = isRecord(block.input) ? block.input : undefined;
		const filePath =
			typeof input?.file_path === 'string' ? input.file_path : undefined;

		logger.info({ tool: name, filePath }, 'Tool use');
		events.push({
			type: 'tool_start',
			name,
			input: formatToolInput(name, input),
			filePath,
		});
	}
	return events;
}

function mapToolEnds(content: unknown): AgentEvent[] {
	if (!Array.isArray(content)) return [];

	const events: AgentEvent[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== 'tool_result') continue;
		events.push({
			type: 'tool_end',
			filePath: extractImageFromToolResult(block),
		});
	}
	return events;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
