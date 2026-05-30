import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { type AgentEvent, mapSdkMessage } from './events.ts';

function map(message: unknown): AgentEvent[] {
	return mapSdkMessage(message as SDKMessage);
}

test('maps a thinking_delta stream event to a thinking event', () => {
	const events = map({
		type: 'stream_event',
		event: {
			type: 'content_block_delta',
			delta: { type: 'thinking_delta', thinking: 'hmm' },
		},
	});
	assert.deepEqual(events, [{ type: 'thinking', content: 'hmm' }]);
});

test('maps a text_delta stream event to a text event', () => {
	const events = map({
		type: 'stream_event',
		event: {
			type: 'content_block_delta',
			delta: { type: 'text_delta', text: 'hello' },
		},
	});
	assert.deepEqual(events, [{ type: 'text', content: 'hello' }]);
});

test('ignores stream deltas that are not text or thinking', () => {
	const events = map({
		type: 'stream_event',
		event: {
			type: 'content_block_delta',
			delta: { type: 'input_json_delta', partial_json: '{"a":' },
		},
	});
	assert.deepEqual(events, []);
});

test('maps tool_use blocks from an assistant message to tool_start events', () => {
	const events = map({
		type: 'assistant',
		message: {
			content: [
				{ type: 'text', text: 'let me look' },
				{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x.png' } },
			],
		},
	});
	assert.equal(events.length, 1);
	assert.equal(events[0].type, 'tool_start');
	if (events[0].type === 'tool_start') {
		assert.equal(events[0].name, 'Read');
		assert.equal(events[0].filePath, '/tmp/x.png');
		assert.equal(events[0].input, '/tmp/x.png');
	}
});

test('summarizes Bash tool input as the command', () => {
	const events = map({
		type: 'assistant',
		message: {
			content: [
				{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
			],
		},
	});
	assert.equal(events[0].type, 'tool_start');
	if (events[0].type === 'tool_start') assert.equal(events[0].input, 'ls -la');
});

test('maps tool_result blocks from a user message to tool_end events', () => {
	const events = map({
		type: 'user',
		message: {
			content: [{ type: 'tool_result', content: 'done' }],
		},
	});
	assert.deepEqual(events, [{ type: 'tool_end', filePath: undefined }]);
});

test('maps a successful result to a result event with session and cost', () => {
	const events = map({
		type: 'result',
		subtype: 'success',
		session_id: 'sess-123',
		result: 'done',
		total_cost_usd: 0.01,
		num_turns: 3,
	});
	assert.deepEqual(events, [
		{
			type: 'result',
			sessionId: 'sess-123',
			cost: 0.01,
			turns: 3,
			text: 'done',
		},
	]);
});

test('maps an error result to a result event with the session preserved', () => {
	const events = map({
		type: 'result',
		subtype: 'error_max_turns',
		session_id: 'sess-456',
		total_cost_usd: 0.02,
		num_turns: 10,
	});
	assert.deepEqual(events, [
		{
			type: 'result',
			sessionId: 'sess-456',
			cost: 0.02,
			turns: 10,
			text: '',
		},
	]);
});

test('ignores system and other message types', () => {
	assert.deepEqual(map({ type: 'system', subtype: 'init' }), []);
	assert.deepEqual(map({ type: 'rate_limit_event' }), []);
});
