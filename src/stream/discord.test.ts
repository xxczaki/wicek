import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Message, MessageFlags, type SendableChannels } from 'discord.js';
import type { AgentEvent } from '../claude/events.ts';
import { streamToDiscord } from './discord.ts';

interface SentRecord {
	send: string[];
	edits: string[];
	flags: unknown[];
}

function createMockChannel(): { channel: SendableChannels; sent: SentRecord } {
	const sent: SentRecord = { send: [], edits: [], flags: [] };
	const channel = {
		send: async (payload: unknown) => {
			const content =
				typeof payload === 'string'
					? payload
					: ((payload as { content?: string }).content ?? '');
			sent.send.push(content);
			if (typeof payload === 'object' && payload !== null)
				sent.flags.push((payload as { flags?: unknown }).flags);
			return {
				edit: async (editPayload: unknown) => {
					const editContent =
						typeof editPayload === 'string'
							? editPayload
							: ((editPayload as { content?: string }).content ?? '');
					sent.edits.push(editContent);
				},
			} as unknown as Message;
		},
	} as unknown as SendableChannels;
	return { channel, sent };
}

async function* events(...items: AgentEvent[]): AsyncGenerator<AgentEvent> {
	for (const item of items) yield item;
}

test('emits simple text and captures sessionId from result', async () => {
	const { channel, sent } = createMockChannel();
	const result = await streamToDiscord(
		events(
			{ type: 'text', content: 'hello world' },
			{
				type: 'result',
				sessionId: 's1',
				cost: 0,
				turns: 1,
				text: 'hello world',
			},
		),
		channel,
	);
	assert.equal(result.sessionId, 's1');
	assert.equal(sent.send.length, 1);
	assert.equal(sent.send[0], 'hello world');
});

test('suppresses link embeds on sent messages', async () => {
	const { channel, sent } = createMockChannel();
	await streamToDiscord(
		events(
			{ type: 'text', content: 'see https://github.com/xxczaki/wicek/pull/1' },
			{ type: 'result', sessionId: 's1', cost: 0, turns: 1, text: '' },
		),
		channel,
	);
	assert.equal(sent.send.length, 1);
	assert.equal(sent.flags[0], MessageFlags.SuppressEmbeds);
});

test('splits text that exceeds safe limit across messages', async () => {
	const { channel, sent } = createMockChannel();
	const huge = `${'x'.repeat(1800)}\n${'y'.repeat(500)}`;
	await streamToDiscord(
		events(
			{ type: 'text', content: huge },
			{ type: 'result', sessionId: 's', cost: 0, turns: 1, text: huge },
		),
		channel,
	);
	assert.ok(
		sent.send.length >= 2,
		`expected multiple messages, got ${sent.send.length}`,
	);
	for (const msg of sent.send) {
		assert.ok(msg.length <= 2000, `message length ${msg.length} > 2000`);
	}
});

test('thinking is not rendered to Discord', async () => {
	const { channel, sent } = createMockChannel();
	const longThinking = 'thought line\n'.repeat(300);
	await streamToDiscord(
		events(
			{ type: 'thinking', content: longThinking },
			{ type: 'text', content: 'final answer' },
			{
				type: 'result',
				sessionId: 's',
				cost: 0,
				turns: 1,
				text: 'final answer',
			},
		),
		channel,
	);
	const allMessages = [...sent.send, ...sent.edits];
	for (const msg of allMessages) {
		assert.ok(
			!msg.includes('thought line'),
			`thinking leaked to Discord: ${msg.slice(0, 40)}`,
		);
	}
	assert.equal(allMessages.at(-1) ?? '', 'final answer');
});

test('reports error when stream ends without result', async () => {
	const { channel, sent } = createMockChannel();
	await streamToDiscord(events({ type: 'text', content: 'partial' }), channel);
	const errorMessages = sent.send.filter((m) => m.includes('terminated'));
	assert.equal(errorMessages.length, 1);
});

test('stays silent when stream ends without result but was aborted', async () => {
	const { channel, sent } = createMockChannel();
	const controller = new AbortController();
	controller.abort();
	await streamToDiscord(
		events({ type: 'text', content: 'partial' }),
		channel,
		controller.signal,
	);
	const errorMessages = sent.send.filter((m) => m.includes('terminated'));
	assert.equal(errorMessages.length, 0);
});

test('tool_start after text always lands on a fresh line', async () => {
	const { channel, sent } = createMockChannel();
	await streamToDiscord(
		events(
			{ type: 'text', content: 'Let me check the repos first.' },
			{ type: 'tool_start', name: 'Bash', input: 'gh api repos/foo/bar' },
			{ type: 'result', sessionId: 's', cost: 0, turns: 1, text: '' },
		),
		channel,
	);
	const final = [...sent.send, ...sent.edits].at(-1) ?? '';
	assert.ok(
		!/[^\n]-# /.test(final),
		`tool line must start at column 0, got: ${JSON.stringify(final)}`,
	);
	assert.ok(
		final.includes('\n-# Ran a command'),
		`expected separated compact tool line, got: ${JSON.stringify(final)}`,
	);
	assert.ok(
		!final.includes('gh api'),
		`tool command must not show on the happy path: ${JSON.stringify(final)}`,
	);
});

test('consecutive text events stream without inserted newlines', async () => {
	const { channel, sent } = createMockChannel();
	await streamToDiscord(
		events(
			{ type: 'text', content: 'Hello ' },
			{ type: 'text', content: 'world' },
			{
				type: 'result',
				sessionId: 's',
				cost: 0,
				turns: 1,
				text: 'Hello world',
			},
		),
		channel,
	);
	const final = [...sent.send, ...sent.edits].at(-1) ?? '';
	assert.equal(final, 'Hello world');
});

test('tool lines use small-text prefix, not blockquote', async () => {
	const { channel, sent } = createMockChannel();
	await streamToDiscord(
		events(
			{ type: 'tool_start', name: 'Read', input: '/tmp/x.txt' },
			{ type: 'result', sessionId: 's', cost: 0, turns: 1, text: '' },
		),
		channel,
	);
	const final = [...sent.send, ...sent.edits].at(-1) ?? '';
	assert.ok(
		final.startsWith('-# '),
		`expected -# prefix for tool, got: ${JSON.stringify(final)}`,
	);
	assert.ok(!final.startsWith('> '), 'tool lines must not use > blockquote');
});

test('tool input is not shown on the happy path (compact name only)', async () => {
	const { channel, sent } = createMockChannel();
	const longInput = 'a'.repeat(500);
	await streamToDiscord(
		events(
			{ type: 'tool_start', name: 'Bash', input: longInput },
			{ type: 'result', sessionId: 's', cost: 0, turns: 1, text: '' },
		),
		channel,
	);
	const final = [...sent.send, ...sent.edits].at(-1) ?? '';
	assert.ok(
		!final.includes('aaaa'),
		`tool input leaked: ${JSON.stringify(final.slice(0, 60))}`,
	);
	assert.ok(
		final.includes('-# Ran a command'),
		`expected compact Bash label, got: ${JSON.stringify(final)}`,
	);
});

test('Skill renders as the skill name', async () => {
	const { channel, sent } = createMockChannel();
	await streamToDiscord(
		events(
			{ type: 'tool_start', name: 'Skill', input: 'apple-calendar' },
			{ type: 'result', sessionId: 's', cost: 0, turns: 1, text: '' },
		),
		channel,
	);
	const final = [...sent.send, ...sent.edits].at(-1) ?? '';
	assert.ok(
		final.includes('-# Used skill: apple-calendar'),
		`expected skill name, got: ${JSON.stringify(final)}`,
	);
});

test('mcp tool names are prettified', async () => {
	const { channel, sent } = createMockChannel();
	await streamToDiscord(
		events(
			{
				type: 'tool_start',
				name: 'mcp__home-assistant__HassTurnOff',
				input: '{}',
			},
			{ type: 'result', sessionId: 's', cost: 0, turns: 1, text: '' },
		),
		channel,
	);
	const final = [...sent.send, ...sent.edits].at(-1) ?? '';
	assert.ok(
		final.includes('-# Used home-assistant · HassTurnOff'),
		`expected prettified mcp label, got: ${JSON.stringify(final)}`,
	);
});

test('thinking before text is dropped, leaving just the answer', async () => {
	const { channel, sent } = createMockChannel();
	await streamToDiscord(
		events(
			{ type: 'thinking', content: 'pondering' },
			{ type: 'text', content: 'answer' },
			{ type: 'result', sessionId: 's', cost: 0, turns: 1, text: 'answer' },
		),
		channel,
	);
	const final = [...sent.send, ...sent.edits].at(-1) ?? '';
	assert.equal(final, 'answer');
});

test('error event is reported and stops the stream', async () => {
	const { channel, sent } = createMockChannel();
	await streamToDiscord(
		events(
			{ type: 'text', content: 'before' },
			{ type: 'error', message: 'boom' },
			{ type: 'text', content: 'after' },
		),
		channel,
	);
	const errorMessage = sent.send.find((m) => m.includes('**Error:**'));
	assert.ok(errorMessage);
	assert.ok(errorMessage.includes('boom'));
});

test('error includes the recent tool trail with full input', async () => {
	const { channel, sent } = createMockChannel();
	await streamToDiscord(
		events(
			{ type: 'tool_start', name: 'Bash', input: 'gh api repos/foo/bar' },
			{ type: 'error', message: 'boom' },
		),
		channel,
	);
	const errorMessage = sent.send.find((m) => m.includes('**Error:**'));
	assert.ok(errorMessage);
	assert.ok(
		errorMessage.includes('What it was doing'),
		`expected activity trail, got: ${JSON.stringify(errorMessage)}`,
	);
	assert.ok(
		errorMessage.includes('gh api repos/foo/bar'),
		`expected full command in error trail, got: ${JSON.stringify(errorMessage)}`,
	);
});
