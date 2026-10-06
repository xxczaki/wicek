import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import logger from '../utils/logger.ts';

export type AgentEvent =
	| { type: 'thinking'; content: string }
	| { type: 'text'; content: string }
	| { type: 'tool_start'; name: string; input: string }
	| { type: 'reader_answer'; reader: string; answer: string }
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
		case 'result': {
			if (message.subtype !== 'success') {
				const details = message.errors.filter(Boolean).join('\n');
				return [
					{
						type: 'error',
						message:
							details ||
							`Agent stopped with ${message.subtype.replaceAll('_', ' ')}`,
					},
				];
			}
			return [
				{
					type: 'result',
					sessionId: message.session_id,
					cost: message.total_cost_usd,
					turns: message.num_turns,
					text: message.result,
				},
			];
		}
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

		logger.info({ tool: name }, 'Tool use');
		events.push({
			type: 'tool_start',
			name,
			input: formatToolInput(name, input),
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
	if (name === 'Skill')
		return (
			(input.command as string) ||
			(input.name as string) ||
			(input.skill as string) ||
			''
		);
	if (name === 'Task') return (input.subagent_type as string) || '';
	if (name.startsWith('mcp__')) return JSON.stringify(input).slice(0, 100);
	return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
