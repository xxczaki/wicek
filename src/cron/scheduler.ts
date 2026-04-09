import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, User } from 'discord.js';
import cron from 'node-cron';
import { parseClaudeStream } from '../claude/parse.ts';
import { spawnClaude } from '../claude/spawn.ts';
import logger from '../utils/logger.ts';

interface CronJobDef {
	name: string;
	schedule: string;
	timezone?: string;
	prompt: string;
	targetUserId: string;
}

const tasks: cron.ScheduledTask[] = [];

function loadCronConfig(configPath: string): CronJobDef[] {
	try {
		const raw = readFileSync(configPath, 'utf-8');
		return JSON.parse(raw) as CronJobDef[];
	} catch (error) {
		logger.warn({ error, configPath }, 'Failed to load cron config');
		return [];
	}
}

async function executeJob(job: CronJobDef, client: Client) {
	logger.info({ name: job.name }, 'Executing cron job');

	let user: User;
	try {
		user = await client.users.fetch(job.targetUserId);
	} catch (error) {
		logger.error(
			{ error, userId: job.targetUserId },
			'Failed to fetch target user',
		);
		return;
	}

	try {
		const { lines } = spawnClaude({ prompt: job.prompt });
		const events = parseClaudeStream(lines);

		let text = '';
		for await (const event of events) {
			if (event.type === 'text') {
				text += event.content;
			} else if (event.type === 'result' && event.text) {
				text = event.text;
			} else if (event.type === 'error') {
				logger.error(
					{ name: job.name, message: event.message },
					'Cron job agent error',
				);
				return;
			}
		}

		if (text) {
			// Split into 2000-char chunks for Discord DM
			const chunks = splitMessage(text);
			for (const chunk of chunks) {
				await user.send(chunk);
			}
			logger.info({ name: job.name, chars: text.length }, 'Cron job delivered');
		}
	} catch (error) {
		logger.error({ error, name: job.name }, 'Cron job execution failed');
	}
}

function splitMessage(text: string, limit = 2000): string[] {
	if (text.length <= limit) return [text];

	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= limit) {
			chunks.push(remaining);
			break;
		}
		const splitPoint = remaining.lastIndexOf('\n', limit);
		const cutAt = splitPoint > limit / 2 ? splitPoint : limit;
		chunks.push(remaining.slice(0, cutAt));
		remaining = remaining.slice(cutAt);
	}
	return chunks;
}

export function initCronScheduler(client: Client, configPath?: string) {
	const path = configPath || join(process.cwd(), 'cron.json');
	const jobs = loadCronConfig(path);

	if (jobs.length === 0) {
		logger.info('No cron jobs configured');
		return;
	}

	for (const job of jobs) {
		if (!cron.validate(job.schedule)) {
			logger.error(
				{ name: job.name, schedule: job.schedule },
				'Invalid cron schedule',
			);
			continue;
		}

		const task = cron.schedule(
			job.schedule,
			() => {
				executeJob(job, client).catch((error) => {
					logger.error({ error, name: job.name }, 'Cron execution error');
				});
			},
			{
				timezone: job.timezone || 'UTC',
			},
		);

		tasks.push(task);
		logger.info(
			{ name: job.name, schedule: job.schedule, timezone: job.timezone },
			'Scheduled cron job',
		);
	}
}

export function stopCronScheduler() {
	for (const task of tasks) {
		task.stop();
	}
	tasks.length = 0;
}
