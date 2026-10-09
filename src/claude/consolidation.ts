import type { Client } from 'discord.js';
import { getOwnerId } from '../discord/guards.ts';
import { sendDirectMessage } from '../stream/discord.ts';
import logger from '../utils/logger.ts';
import { streamAgent } from './agent.ts';
import { markConsolidated, pendingConsolidation } from './sessions.ts';

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const NO_CHANGES = 'NO_CHANGES';

const CONSOLIDATION_PROMPT = `Memory pass. Save what this conversation taught you, following the Memory section in CLAUDE.md. Read MEMORY.md and every memory file related to what you learned first.

Reply with one line per change, like "Added <slug>: <hook>", "Updated <slug>: <what changed>", or "Removed <slug>: <why>". If nothing changed, reply with exactly ${NO_CHANGES} and nothing else.`;

let isSweeping = false;

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
	if (isSweeping) return;
	isSweeping = true;

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
		isSweeping = false;
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
	const ownerId = getOwnerId();
	if (!ownerId) return;

	try {
		await sendDirectMessage(client, ownerId, `**Memory updated**\n${summary}`);
		logger.info({ chars: summary.length }, 'Sent consolidation summary');
	} catch (error) {
		logger.error({ error, ownerId }, 'Failed to send consolidation summary');
	}
}
