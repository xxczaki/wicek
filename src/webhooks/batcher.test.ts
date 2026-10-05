import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebhookBatcher } from './batcher.ts';

const WINDOW_MS = 20;
const DEDUPE_MS = 60_000;

test('collapses a burst into one flush per topic and drops duplicates', async () => {
	const flushes: Array<[string, string[]]> = [];
	const batcher = new WebhookBatcher(
		(topic, lines) => flushes.push([topic, lines]),
		WINDOW_MS,
		DEDUPE_MS,
	);

	assert.equal(batcher.add('github', 'a', 'run a'), true);
	assert.equal(batcher.add('github', 'b', 'run b'), true);
	assert.equal(batcher.add('github', 'a', 'run a again'), false);
	assert.equal(batcher.add('grafana', 'x', 'alert x'), true);

	await sleep(WINDOW_MS * 3);

	assert.deepEqual(flushes, [
		['github', ['run a', 'run b']],
		['grafana', ['alert x']],
	]);
	assert.equal(batcher.add('github', 'a', 'run a later'), false);
});

test('forget reports whether the key was still pending or already handled', async () => {
	const flushes: string[][] = [];
	const batcher = new WebhookBatcher(
		(_topic, lines) => flushes.push(lines),
		WINDOW_MS,
		DEDUPE_MS,
	);

	batcher.add('grafana', 'pending', 'alert pending');
	assert.equal(batcher.forget('pending'), 'pending');
	batcher.add('grafana', 'handled', 'alert handled');
	await sleep(WINDOW_MS * 3);

	assert.deepEqual(flushes, [['alert handled']]);
	assert.equal(batcher.forget('handled'), 'handled');
	assert.equal(batcher.forget('handled'), undefined);
	assert.equal(batcher.forget('unknown'), undefined);
});
