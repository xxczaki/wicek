import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentInbox } from './inbox.ts';

test('yields the prompt, then pushed messages, until closed', async () => {
	const inbox = new AgentInbox();
	const messages = inbox.messages('first');

	assert.equal((await messages.next()).value?.message.content, 'first');

	const nextMessage = messages.next();
	assert.equal(inbox.push('second'), true);
	const second = (await nextMessage).value;
	assert.equal(second?.message.content, 'second');
	assert.equal(second?.priority, 'next');
	assert.equal(inbox.takeDeliveredCount(), 1);
	assert.equal(inbox.takeDeliveredCount(), 0);

	const end = messages.next();
	inbox.close();
	assert.equal((await end).done, true);
	assert.equal(inbox.push('too late'), false);
});

test('keeps messages that were never delivered', () => {
	const inbox = new AgentInbox();
	inbox.push('queued');
	inbox.close();
	assert.deepEqual(inbox.takePending(), ['queued']);
});
