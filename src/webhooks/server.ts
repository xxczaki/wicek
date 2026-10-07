import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { type StreamAgentOptions, streamAgent } from '../claude/agent.ts';
import { executeJob, sendDirectMessage } from '../cron/scheduler.ts';
import { sendReaderAnswer } from '../stream/discord.ts';
import { getEnvList, getOptionalEnv } from '../utils/env.ts';
import logger from '../utils/logger.ts';
import { WebhookBatcher } from './batcher.ts';
import { handleReaderCallback, readerCallbackName } from './callback.ts';
import {
	buildGithubPrompt,
	type GithubPayload,
	parseGithubFailure,
	verifyGithubSignature,
} from './github.ts';
import {
	alertKey,
	buildGrafanaPrompt,
	describeAlert,
	type GrafanaPayload,
	partitionAlerts,
	verifyGrafanaAuthorization,
} from './grafana.ts';

const DEFAULT_WEBHOOK_PORT = 8080;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const BATCH_WINDOW_MS = 2 * 60 * 1000;
const FORGET_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

const PROMPT_BUILDERS: Record<string, (lines: string[]) => string> = {
	github: buildGithubPrompt,
	grafana: buildGrafanaPrompt,
};

export function startWebhookServer(client: Client): Server {
	const port = Number(getOptionalEnv('WEBHOOK_PORT') ?? DEFAULT_WEBHOOK_PORT);
	const ownerId = getEnvList('ALLOWED_USER_IDS')[0];

	let runQueue = Promise.resolve();
	const batcher = new WebhookBatcher({
		flush: (topic, lines) => {
			logger.info({ topic, items: lines.length }, 'Queued webhook run');
			const job = {
				name: `webhook-${topic}`,
				prompt: PROMPT_BUILDERS[topic](lines),
				targetUserId: ownerId,
			};
			runQueue = runQueue
				.then(() => executeJob(job, client, runWithoutMcp))
				.catch((error) => logger.error({ error, topic }, 'Webhook run failed'));
		},
		windowMs: BATCH_WINDOW_MS,
		forgetAfterMs: FORGET_AFTER_MS,
		remindAfterMs: REMIND_AFTER_MS,
		statePath: join(getOptionalEnv('DATA_DIR') || '/data', 'webhooks.json'),
	});

	const routes: Record<
		string,
		(request: IncomingMessage, body: Buffer) => number
	> = {
		'/hooks/github': (request, body) => handleGithub(batcher, request, body),
		'/hooks/grafana': (request, body) =>
			handleGrafana(batcher, request, body, (text) =>
				sendDirectMessage(client, ownerId, text).catch((error) =>
					logger.error({ error }, 'Failed to send alert follow-up'),
				),
			),
	};

	const server = createServer((request, response) => {
		const readerName = readerCallbackName(request);
		if (readerName) {
			handleReaderCallback(readerName, request, response, (answer) =>
				client.users
					.fetch(ownerId)
					.then((owner) => sendReaderAnswer(owner, answer)),
			);
			return;
		}

		route(routes, request, response).catch((error) => {
			logger.error({ error, url: request.url }, 'Webhook request failed');
			if (!response.headersSent) respond(response, 500);
		});
	});

	server.listen(port, () => logger.info({ port }, 'Webhook server listening'));
	return server;
}

function runWithoutMcp(options: StreamAgentOptions) {
	return streamAgent({ ...options, withoutMcp: true });
}

async function route(
	routes: Record<string, (request: IncomingMessage, body: Buffer) => number>,
	request: IncomingMessage,
	response: ServerResponse,
) {
	const path = new URL(request.url ?? '/', 'http://localhost').pathname;

	if (path === '/healthz' && request.method === 'GET') {
		respond(response, 200);
		return;
	}

	const handler = routes[path];
	if (!handler) {
		respond(response, 404);
		return;
	}
	if (request.method !== 'POST') {
		respond(response, 405);
		return;
	}

	const body = await readBody(request);
	respond(response, body ? handler(request, body) : 413);
}

function handleGithub(
	batcher: WebhookBatcher,
	request: IncomingMessage,
	body: Buffer,
): number {
	const secret = getOptionalEnv('GITHUB_WEBHOOK_SECRET');
	if (!secret) return 404;

	const signature = header(request, 'x-hub-signature-256');
	if (!verifyGithubSignature(secret, body, signature)) return 401;

	const payload = parseJson<GithubPayload>(body);
	if (!payload) return 400;

	const event = header(request, 'x-github-event');
	const failure = parseGithubFailure(event, payload);
	if (
		failure &&
		batcher.add('github', failure.key, failure.line) === 'queued'
	) {
		logger.info(
			{ event, delivery: header(request, 'x-github-delivery'), ...failure },
			'Queued GitHub failure',
		);
	}
	return 202;
}

function handleGrafana(
	batcher: WebhookBatcher,
	request: IncomingMessage,
	body: Buffer,
	followUp: (text: string) => void,
): number {
	const token = getOptionalEnv('GRAFANA_WEBHOOK_TOKEN');
	if (!token) return 404;

	if (!verifyGrafanaAuthorization(token, header(request, 'authorization'))) {
		return 401;
	}

	const payload = parseJson<GrafanaPayload>(body);
	if (!payload) return 400;

	const { firing, resolved } = partitionAlerts(payload);
	const followUpLines: string[] = [];
	for (const alert of firing) {
		const result = batcher.add(
			'grafana',
			alertKey(alert),
			describeAlert(alert),
		);
		if (result === 'queued') {
			logger.info({ fingerprint: alert.fingerprint }, 'Queued Grafana alert');
		}
		if (result === 'remind') {
			followUpLines.push(`⏰ Still firing: ${describeAlert(alert)}`);
		}
	}

	for (const alert of resolved) {
		if (batcher.forget(alertKey(alert)) === 'handled') {
			followUpLines.push(`✅ Resolved: ${describeAlert(alert)}`);
		}
	}
	if (followUpLines.length > 0) followUp(followUpLines.join('\n'));

	return 202;
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function parseJson<T>(body: Buffer): T | undefined {
	try {
		return JSON.parse(body.toString('utf-8')) as T;
	} catch {
		return undefined;
	}
}

function header(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function respond(response: ServerResponse, status: number) {
	response.writeHead(status, { 'content-type': 'text/plain' });
	response.end(status < 300 ? 'ok' : '');
}
