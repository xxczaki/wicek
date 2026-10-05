import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireAgent, releaseAgent, tryAcquireAgent } from './lock.ts';

test('queued runs wait for the lock and take it in order', async () => {
	assert.equal(tryAcquireAgent(), true);
	assert.equal(tryAcquireAgent(), false);

	const order: string[] = [];
	const first = acquireAgent().then(() => order.push('first'));
	const second = acquireAgent().then(() => order.push('second'));

	releaseAgent();
	await first;
	assert.deepEqual(order, ['first']);
	assert.equal(tryAcquireAgent(), false);

	releaseAgent();
	await second;
	assert.deepEqual(order, ['first', 'second']);

	releaseAgent();
	assert.equal(tryAcquireAgent(), true);
	releaseAgent();
});
