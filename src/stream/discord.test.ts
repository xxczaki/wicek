import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, SendableChannels } from 'discord.js';
import type { AgentEvent } from '../claude/parse.ts';
import { streamToDiscord } from './discord.ts';

interface SentRecord {
	send: string[];
	edits: string[];
}

function createMockChannel(): { channel: SendableChannels; sent: SentRecord } {
	const sent: SentRecord = { send: [], edits: [] };
	const channel = {
		send: async (payload: unknown) => {
			const content =
				typeof payload === 'string'
					? payload
					: ((payload as { content?: string }).content ?? '');
			sent.send.push(content);
			return {
				edit: async (newContent: string) => {
					sent.edits.push(newContent);
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

test('very long thinking block stays under Discord limit and keeps quote prefix', async () => {
	const { channel, sent } = createMockChannel();
	const longThinking = 'thought line\n'.repeat(300);
	await streamToDiscord(
		events(
			{ type: 'thinking', content: longThinking },
			{ type: 'result', sessionId: 's', cost: 0, turns: 1, text: '' },
		),
		channel,
	);
	const allMessages = [...sent.send, ...sent.edits];
	for (const msg of allMessages) {
		assert.ok(msg.length <= 2000, `message length ${msg.length} > 2000`);
	}
	const nonEmpty = allMessages.filter((m) => m.length > 0);
	for (const msg of nonEmpty) {
		assert.ok(
			msg.startsWith('>'),
			`quote continuation missing: ${msg.slice(0, 40)}`,
		);
	}
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
