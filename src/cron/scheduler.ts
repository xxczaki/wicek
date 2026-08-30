import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Client, MessageFlags, type User } from 'discord.js';
import { type ScheduledTask, schedule, validate } from 'node-cron';
import { streamAgent } from '../claude/agent.ts';
import logger from '../utils/logger.ts';

export interface CronJobDef {
	name: string;
	schedule: string;
	timezone?: string;
	prompt: string;
	targetUserId: string;
}

const tasks: ScheduledTask[] = [];

function loadCronConfig(configPath: string): CronJobDef[] {
	try {
		const raw = readFileSync(configPath, 'utf-8');
		return JSON.parse(raw) as CronJobDef[];
	} catch (error) {
		logger.warn({ error, configPath }, 'Failed to load cron config');
		return [];
	}
}

const FAILURE_DETAIL_LIMIT = 1_600;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function notifyFailure(user: User, job: CronJobDef, reason: string) {
	const detail =
		reason.length > FAILURE_DETAIL_LIMIT
			? `${reason.slice(0, FAILURE_DETAIL_LIMIT)}…`
			: reason;
	const content = [
		`⚠️ Scheduled job \`${job.name}\` failed.`,
		'',
		detail,
		'',
		'No scheduled result was delivered. Check Wicek authentication and logs.',
	].join('\n');

	try {
		await user.send({ content, flags: MessageFlags.SuppressEmbeds });
		logger.info({ name: job.name }, 'Cron job failure notification delivered');
	} catch (error) {
		logger.error(
			{ error, name: job.name },
			'Failed to deliver cron job failure notification',
		);
	}
}

export async function executeJob(
	job: CronJobDef,
	client: Client,
	agent: typeof streamAgent = streamAgent,
) {
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

	let failure: string | undefined;
	let text = '';

	try {
		const events = agent({ prompt: job.prompt });

		for await (const event of events) {
			if (event.type === 'text') {
				text += event.content;
			} else if (event.type === 'result' && event.text) {
				text = event.text;
			} else if (event.type === 'error') {
				failure = event.message;
				break;
			}
		}
	} catch (error) {
		failure = errorMessage(error);
	}

	if (!failure && !text) {
		failure = 'The agent completed without producing a response.';
	}

	if (failure) {
		logger.error({ name: job.name, reason: failure }, 'Cron job failed');
		await notifyFailure(user, job, failure);
		return;
	}

	try {
		const chunks = splitMessage(text);
		for (const chunk of chunks) {
			await user.send({
				content: chunk,
				flags: MessageFlags.SuppressEmbeds,
			});
		}
		logger.info({ name: job.name, chars: text.length }, 'Cron job delivered');
	} catch (error) {
		logger.error({ error, name: job.name }, 'Cron job delivery failed');
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
		if (!validate(job.schedule)) {
			logger.error(
				{ name: job.name, schedule: job.schedule },
				'Invalid cron schedule',
			);
			continue;
		}

		const task = schedule(
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
