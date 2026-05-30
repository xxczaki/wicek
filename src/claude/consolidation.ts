import type { Client } from 'discord.js';
import { getEnvList } from '../utils/env.ts';
import logger from '../utils/logger.ts';
import { streamAgent } from './agent.ts';
import { markConsolidated, pendingConsolidation } from './sessions.ts';

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const IDLE_THRESHOLD_MS = 20 * 60 * 1000;
const NO_CHANGES = 'NO_CHANGES';

const CONSOLIDATION_PROMPT = `Review this conversation for durable, non-obvious facts worth keeping long term: user preferences, project decisions, corrections, or stable context.

Update your memory files: read MEMORY.md first, dedupe against existing entries, and update in place instead of appending duplicates. Keep one fact per file.

Then reply with a short summary of the changes – one line each, like "Added <slug>: <hook>" or "Updated <slug>: <what changed>". If nothing is worth saving, reply with exactly ${NO_CHANGES} and nothing else.`;

let sweeping = false;

export function initConsolidation(client: Client) {
	const timer = setInterval(() => {
		sweep(client).catch((error) =>
			logger.error({ error }, 'Memory consolidation sweep failed'),
		);
	}, SWEEP_INTERVAL_MS);
	timer.unref();

	logger.info('Memory consolidation scheduled');
}

async function sweep(client: Client) {
	if (sweeping) return;
	sweeping = true;

	try {
		for (const { key, sessionId } of pendingConsolidation(IDLE_THRESHOLD_MS)) {
			try {
				const summary = await consolidate(sessionId);
				markConsolidated(key);

				if (summary && summary !== NO_CHANGES) {
					await notifyOwner(client, summary);
				}
			} catch (error) {
				logger.error({ error, key }, 'Memory consolidation failed');
			}
		}
	} finally {
		sweeping = false;
	}
}

async function consolidate(sessionId: string): Promise<string> {
	let text = '';
	for await (const event of streamAgent({
		prompt: CONSOLIDATION_PROMPT,
		sessionId,
		model: 'haiku',
	})) {
		if (event.type === 'result') text = event.text;
		else if (event.type === 'error') throw new Error(event.message);
	}
	return text.trim();
}

async function notifyOwner(client: Client, summary: string) {
	const ownerId = getEnvList('ALLOWED_USER_IDS')[0];
	if (!ownerId) return;

	try {
		const user = await client.users.fetch(ownerId);
		await user.send(`**Memory updated**\n${summary}`.slice(0, 1900));
		logger.info({ chars: summary.length }, 'Sent consolidation summary');
	} catch (error) {
		logger.error({ error, ownerId }, 'Failed to send consolidation summary');
	}
}
