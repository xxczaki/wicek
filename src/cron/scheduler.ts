import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { type ScheduledTask, schedule, validate } from 'node-cron';
import { streamAgent } from '../claude/agent.ts';
import { setSession } from '../claude/sessions.ts';
import { sendDirectMessage } from '../stream/discord.ts';
import logger from '../utils/logger.ts';

export interface JobDef {
	name: string;
	prompt: string;
	targetUserId: string;
}

export interface CronJobDef extends JobDef {
	schedule: string;
	timezone?: string;
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

export async function executeJob(
	job: JobDef,
	client: Client,
	agent: typeof streamAgent = streamAgent,
) {
	logger.info({ name: job.name }, 'Executing job');

	let failure: string | undefined;
	let text = '';

	try {
		const events = agent({ prompt: job.prompt });

		for await (const event of events) {
			if (event.type === 'text') {
				text += event.content;
			} else if (event.type === 'result') {
				setSession(`cron:${job.name}`, event.sessionId);
				if (event.text) text = event.text;
			} else if (event.type === 'error') {
				failure = event.message;
				break;
			}
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}

	if (!failure && !text) {
		failure = 'The agent completed without producing a response.';
	}
	if (failure) logger.error({ name: job.name, reason: failure }, 'Job failed');

	try {
		await sendDirectMessage(
			client,
			job.targetUserId,
			failure ? describeFailure(job, failure) : text,
		);
		logger.info({ name: job.name, failed: Boolean(failure) }, 'Job delivered');
	} catch (error) {
		logger.error({ error, name: job.name }, 'Job delivery failed');
	}
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

function describeFailure(job: JobDef, reason: string): string {
	return [
		`⚠️ Job \`${job.name}\` failed.`,
		'',
		reason,
		'',
		'No result was delivered. Check Wicek authentication and logs.',
	].join('\n');
}
