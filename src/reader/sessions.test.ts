import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReaderRunError, ReaderSessions } from './sessions.ts';

const IDLE_MS = 1000;

function createSessions(options: { maxSessions?: number } = {}) {
	let nowMs = 0;
	let nextId = 0;
	const runs: Array<{ question: string; resume?: string; persist: boolean }> =
		[];
	const forgotten: string[] = [];
	const known = new Set<string>();
	const sessions = new ReaderSessions({
		idleMs: IDLE_MS,
		maxSessions: options.maxSessions ?? 10,
		now: () => nowMs,
		run: async (question, { resume, persist }) => {
			runs.push({ question, resume, persist });
			if (resume && !known.has(resume)) {
				throw new Error(`No conversation found with session ID: ${resume}`);
			}
			const sessionId = resume ?? `session-${++nextId}`;
			known.add(sessionId);
			if (question === 'fail') throw new ReaderRunError('max turns', sessionId);
			return { answer: `answer to ${question}`, sessionId };
		},
		forget: async (sessionId) => {
			forgotten.push(sessionId);
			known.delete(sessionId);
		},
	});
	return {
		sessions,
		runs,
		forgotten,
		known,
		advance: (ms: number) => {
			nowMs += ms;
		},
	};
}

test('resumes the session of the same conversation only', async () => {
	const { sessions, runs } = createSessions();
	await sessions.answer('trip costs?', 'thread:1');
	await sessions.answer('the second hotel is Hanwen', 'thread:1');
	await sessions.answer('balance?', 'thread:2');
	await sessions.answer('one-off', undefined);

	assert.deepEqual(
		runs.map(({ resume, persist }) => ({ resume, persist })),
		[
			{ resume: undefined, persist: true },
			{ resume: 'session-1', persist: true },
			{ resume: undefined, persist: true },
			{ resume: undefined, persist: false },
		],
	);
});

test('keeps the session after a failed run and starts fresh when it is gone', async () => {
	const { sessions, runs, known } = createSessions();
	await assert.rejects(sessions.answer('fail', 'dm:1'));
	await sessions.answer('try again', 'dm:1');
	assert.equal(runs[1].resume, 'session-1');

	known.clear();
	assert.equal(
		await sessions.answer('still there?', 'dm:1'),
		'answer to still there?',
	);
	assert.deepEqual(
		runs.slice(2).map(({ resume }) => resume),
		['session-1', undefined],
	);
});

test('forgets idle sessions and the oldest beyond the limit', async () => {
	const { sessions, runs, forgotten, advance } = createSessions({
		maxSessions: 2,
	});
	await sessions.answer('a', 'thread:a');
	advance(10);
	await sessions.answer('b', 'thread:b');
	advance(10);
	await sessions.answer('c', 'thread:c');
	await sessions.sweep();
	assert.deepEqual(forgotten, ['session-1']);

	advance(IDLE_MS + 1);
	await sessions.answer('b again', 'thread:b');
	assert.deepEqual(forgotten.sort(), ['session-1', 'session-2', 'session-3']);
	assert.equal(runs.at(-1)?.resume, undefined);
});
