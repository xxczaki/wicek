import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AgentEvent, parseClaudeStream } from './parse.ts';

async function* linesOf(...lines: string[]): AsyncGenerator<string> {
	for (const line of lines) yield line;
}

async function collect(lines: AsyncIterable<string>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of parseClaudeStream(lines)) events.push(event);
	return events;
}

test('parses thinking_delta into thinking event', async () => {
	const lines = linesOf(
		JSON.stringify({
			type: 'stream_event',
			event: { delta: { type: 'thinking_delta', thinking: 'hmm' } },
		}),
	);
	const events = await collect(lines);
	assert.deepEqual(events, [{ type: 'thinking', content: 'hmm' }]);
});

test('parses text_delta into text event', async () => {
	const lines = linesOf(
		JSON.stringify({
			type: 'stream_event',
			event: { delta: { type: 'text_delta', text: 'hello' } },
		}),
	);
	const events = await collect(lines);
	assert.deepEqual(events, [{ type: 'text', content: 'hello' }]);
});

test('parses tool_use from assistant message', async () => {
	const lines = linesOf(
		JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{
						type: 'tool_use',
						name: 'Read',
						input: { file_path: '/tmp/x.png' },
					},
				],
			},
		}),
	);
	const events = await collect(lines);
	assert.equal(events.length, 1);
	assert.equal(events[0].type, 'tool_start');
	if (events[0].type === 'tool_start') {
		assert.equal(events[0].name, 'Read');
		assert.equal(events[0].filePath, '/tmp/x.png');
		assert.equal(events[0].input, '/tmp/x.png');
	}
});

test('captures session_id from system init and surfaces in result', async () => {
	const lines = linesOf(
		JSON.stringify({
			type: 'system',
			subtype: 'init',
			session_id: 'sess-123',
		}),
		JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.01 }),
	);
	const events = await collect(lines);
	const result = events.find((e) => e.type === 'result');
	assert.ok(result && result.type === 'result');
	assert.equal(result.sessionId, 'sess-123');
	assert.equal(result.text, 'done');
});

test('skips malformed NDJSON lines without crashing', async () => {
	const lines = linesOf(
		'not json at all',
		JSON.stringify({
			type: 'stream_event',
			event: { delta: { type: 'text_delta', text: 'ok' } },
		}),
	);
	const events = await collect(lines);
	assert.deepEqual(events, [{ type: 'text', content: 'ok' }]);
});

test('ignores empty lines', async () => {
	const lines = linesOf(
		'',
		'  ',
		JSON.stringify({
			type: 'stream_event',
			event: { delta: { type: 'text_delta', text: 'x' } },
		}),
	);
	const events = await collect(lines);
	assert.equal(events.length, 1);
});
