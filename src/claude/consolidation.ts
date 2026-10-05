import type { Client } from 'discord.js';
import { getEnvList } from '../utils/env.ts';
import logger from '../utils/logger.ts';
import { streamAgent } from './agent.ts';
import { markConsolidated, pendingConsolidation } from './sessions.ts';

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const NO_CHANGES = 'NO_CHANGES';

const CONSOLIDATION_PROMPT = `Memory pass. Transcripts are deleted after about 30 days, so memory is the only long-term record. Look for durable, non-obvious knowledge in this conversation:
- Environment: devices, hosts, network layout, services, accounts, and where things live
- Procedures learned the hard way: what failed, what worked, exact commands and API quirks
- User preferences, decisions, and corrections

Reconcile instead of appending:
1. Read MEMORY.md and every memory file related to what you learned.
2. Rewrite each touched file as a whole so it reads as one current, consistent note. Never add a paragraph that contradicts an earlier one.
3. When facts conflict, keep the newest evidence. Delete facts this conversation proved wrong or stale, and delete files with nothing true left.
4. Every [[link]] in a touched file must point to an existing memory – fix or remove dangling ones.
5. Keep MEMORY.md at one line per existing file.

Skip one-off task details and anything the repo, CLAUDE.md, or a single command already tells you.

Reply with one line per change, like "Added <slug>: <hook>", "Updated <slug>: <what changed>", or "Removed <slug>: <why>". If nothing changed, reply with exactly ${NO_CHANGES} and nothing else.`;

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
		const summaries: string[] = [];
		for (const { key, sessionId } of pendingConsolidation(IDLE_THRESHOLD_MS)) {
			try {
				const summary = await consolidate(sessionId);
				markConsolidated(key);

				if (summary && summary !== NO_CHANGES) summaries.push(summary);
			} catch (error) {
				logger.error({ error, key }, 'Memory consolidation failed');
			}
		}

		if (summaries.length > 0) {
			await notifyOwner(client, summaries.join('\n'));
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
		model: 'sonnet',
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
