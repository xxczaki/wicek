import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { type BatchFlush, WebhookBatcher } from './batcher.ts';

const WINDOW_MS = 20;
const HOUR_MS = 60 * 60 * 1000;

test('collapses a burst into one flush per topic and drops duplicates', async () => {
	const flushes: Array<[string, string[]]> = [];
	const batcher = createBatcher((topic, lines) => flushes.push([topic, lines]));

	assert.equal(batcher.add('github', 'a', 'run a'), 'queued');
	assert.equal(batcher.add('github', 'b', 'run b'), 'queued');
	assert.equal(batcher.add('github', 'a', 'run a again'), 'duplicate');
	assert.equal(batcher.add('grafana', 'x', 'alert x'), 'queued');

	await sleep(WINDOW_MS * 3);

	assert.deepEqual(flushes, [
		['github', ['run a', 'run b']],
		['grafana', ['alert x']],
	]);
	assert.equal(batcher.add('github', 'a', 'run a later'), 'duplicate');
});

test('forget reports whether the key was still pending or already handled', async () => {
	const flushes: string[][] = [];
	const batcher = createBatcher((_topic, lines) => flushes.push(lines));

	batcher.add('grafana', 'pending', 'alert pending');
	assert.equal(batcher.forget('pending'), 'pending');
	batcher.add('grafana', 'handled', 'alert handled');
	await sleep(WINDOW_MS * 3);

	assert.deepEqual(flushes, [['alert handled']]);
	assert.equal(batcher.forget('handled'), 'handled');
	assert.equal(batcher.forget('handled'), undefined);
	assert.equal(batcher.forget('unknown'), undefined);
});

test('reminds about a repeated key only once per reminder interval', (context) => {
	context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
	const batcher = createBatcher(() => {});

	assert.equal(batcher.add('grafana', 'x', 'alert x'), 'queued');
	context.mock.timers.tick(4 * HOUR_MS);
	assert.equal(batcher.add('grafana', 'x', 'alert x'), 'duplicate');
	context.mock.timers.tick(20 * HOUR_MS);
	assert.equal(batcher.add('grafana', 'x', 'alert x'), 'remind');
	context.mock.timers.tick(4 * HOUR_MS);
	assert.equal(batcher.add('grafana', 'x', 'alert x'), 'duplicate');
});

test('forgets keys that stop repeating', (context) => {
	context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
	const batcher = createBatcher(() => {});

	batcher.add('grafana', 'x', 'alert x');
	context.mock.timers.tick(49 * HOUR_MS);
	assert.equal(batcher.add('grafana', 'x', 'alert x'), 'queued');
});

test('keeps handled keys across restarts but not pending ones', async () => {
	const statePath = join(mkdtempSync(join(tmpdir(), 'batcher-')), 'state.json');
	const flush = mock.fn<BatchFlush>();
	const first = createBatcher(flush, statePath);

	first.add('grafana', 'handled', 'alert handled');
	await sleep(WINDOW_MS * 3);
	first.add('grafana', 'pending', 'alert pending');

	assert.deepEqual(Object.keys(JSON.parse(readFileSync(statePath, 'utf-8'))), [
		'handled',
	]);
	const second = createBatcher(flush, statePath);
	assert.equal(second.add('grafana', 'handled', 'alert handled'), 'duplicate');
	assert.equal(second.add('grafana', 'pending', 'alert pending'), 'queued');
});

function createBatcher(flush: BatchFlush, statePath?: string) {
	return new WebhookBatcher({
		flush,
		windowMs: WINDOW_MS,
		forgetAfterMs: 48 * HOUR_MS,
		remindAfterMs: 24 * HOUR_MS,
		statePath,
	});
}
