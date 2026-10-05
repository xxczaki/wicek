import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http';
import logger from '../utils/logger.ts';
import { type Authenticator, createAuthenticator } from './auth.ts';
import { type Route, readSecret } from './config.ts';
import {
	runWebSocketCommand,
	type WebSocketCommand,
} from './home-assistant.ts';
import { readBody, requestUpstream } from './upstream.ts';

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const WEBSOCKET_COMMAND_PATH = '/_ws';

const STRIPPED_REQUEST_HEADERS = new Set([
	'authorization',
	'connection',
	'cookie',
	'host',
	'keep-alive',
	'proxy-authorization',
	'transfer-encoding',
	'upgrade',
	'x-api-key',
	'x-csrf-token',
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
	'connection',
	'keep-alive',
	'set-cookie',
	'transfer-encoding',
	'x-csrf-token',
	'x-updated-csrf-token',
]);

export function createRouteServer(route: Route): Server {
	const authenticator = createAuthenticator(route);

	return createServer((request, response) => {
		const startedAt = performance.now();
		const path = new URL(request.url ?? '/', 'http://broker').pathname;

		response.on('finish', () =>
			logger.info(
				{
					route: route.name,
					method: request.method,
					path,
					status: response.statusCode,
					durationMs: Math.round(performance.now() - startedAt),
				},
				'Broker request',
			),
		);

		handle(route, authenticator, request, response, path).catch((error) => {
			logger.warn({ route: route.name, error: error.message }, 'Broker error');
			if (!response.headersSent)
				respondJson(response, 502, { error: error.message });
			else response.destroy();
		});
	});
}

async function handle(
	route: Route,
	authenticator: Authenticator,
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
): Promise<void> {
	const method = request.method ?? 'GET';
	if (route.methods && !route.methods.includes(method)) {
		respondJson(response, 405, {
			error: `${method} is not allowed on ${route.name}`,
		});
		return;
	}

	const body = await readBody(request, MAX_REQUEST_BODY_BYTES);

	if (route.auth.type === 'home-assistant' && path === WEBSOCKET_COMMAND_PATH) {
		const command = JSON.parse(body.toString()) as WebSocketCommand;
		const token = readSecret(route.auth.tokenFile);
		respondJson(
			response,
			200,
			await runWebSocketCommand(route.upstream, token, command),
		);
		return;
	}

	const forward = async () =>
		requestUpstream(route, {
			method,
			path: request.url ?? '/',
			headers: {
				...filterHeaders(request.headers, STRIPPED_REQUEST_HEADERS),
				...(await authenticator.headers()),
				'content-length': String(body.length),
			},
			body,
		});

	let upstreamResponse = await forward();
	if (upstreamResponse.statusCode === 401 && authenticator.refresh) {
		upstreamResponse.resume();
		await authenticator.refresh();
		upstreamResponse = await forward();
	}
	authenticator.observe?.(upstreamResponse);

	response.writeHead(
		upstreamResponse.statusCode ?? 502,
		filterHeaders(upstreamResponse.headers, STRIPPED_RESPONSE_HEADERS),
	);
	response.on('close', () => upstreamResponse.destroy());
	upstreamResponse.pipe(response);
}

function filterHeaders(
	headers: IncomingHttpHeaders,
	stripped: Set<string>,
): IncomingHttpHeaders {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => !stripped.has(name)),
	);
}

function respondJson(
	response: ServerResponse,
	status: number,
	payload: unknown,
) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(payload ?? null));
}
