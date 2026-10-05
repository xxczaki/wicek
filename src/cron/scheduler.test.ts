import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Client, User } from 'discord.js';
import type { AgentEvent } from '../claude/events.ts';
import { getSession } from '../claude/sessions.ts';
import { type CronJobDef, executeJob } from './scheduler.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'wicek-cron-'));

const job: CronJobDef = {
	name: 'etf-update',
	schedule: '45 17 * * 5',
	prompt: 'Produce the update',
	targetUserId: 'user-1',
};

function createClient() {
	const sent: string[] = [];
	const user = {
		send: async (payload: { content: string }) => {
			sent.push(payload.content);
		},
	} as unknown as User;
	const client = {
		users: { fetch: async () => user },
	} as unknown as Client;
	return { client, sent };
}

function agentWith(...events: AgentEvent[]) {
	return async function* () {
		for (const event of events) yield event;
	};
}

test('notifies the target user when the agent reports an auth error', async () => {
	const { client, sent } = createClient();
	await executeJob(
		job,
		client,
		agentWith({
			type: 'error',
			message:
				'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
		}),
	);

	assert.equal(sent.length, 1);
	assert.match(sent[0], /Job `etf-update` failed/);
	assert.match(sent[0], /OAuth access token has been revoked/);
});

test('treats an empty agent response as a visible failure', async () => {
	const { client, sent } = createClient();
	await executeJob(job, client, agentWith());

	assert.equal(sent.length, 1);
	assert.match(sent[0], /completed without producing a response/);
});

test('delivers a successful scheduled result normally', async () => {
	const { client, sent } = createClient();
	await executeJob(
		job,
		client,
		agentWith({
			type: 'result',
			sessionId: 'session-1',
			cost: 0,
			turns: 1,
			text: 'All good',
		}),
	);

	assert.deepEqual(sent, ['All good']);
});

test('registers the scheduled session for memory consolidation', async () => {
	const { client } = createClient();
	await executeJob(
		job,
		client,
		agentWith({
			type: 'result',
			sessionId: 'session-2',
			cost: 0,
			turns: 1,
			text: 'Done',
		}),
	);

	assert.equal(getSession('cron:etf-update'), 'session-2');
});
