import http, {
	type IncomingMessage,
	type OutgoingHttpHeaders,
} from 'node:http';
import https from 'node:https';
import type { Route } from './config.ts';

export interface UpstreamRequest {
	method: string;
	path: string;
	headers: OutgoingHttpHeaders;
	body?: Buffer;
}

export function requestUpstream(
	route: Route,
	request: UpstreamRequest,
): Promise<IncomingMessage> {
	const url = new URL(route.upstream);
	const target = new URL(request.path, 'http://broker');
	url.pathname = target.pathname;
	url.search = target.search;
	const transport = url.protocol === 'https:' ? https : http;

	return new Promise((resolve, reject) => {
		const outgoing = transport.request(
			url,
			{
				method: request.method,
				headers: request.headers,
				rejectUnauthorized: !route.insecureTls,
			},
			resolve,
		);
		outgoing.on('error', reject);
		outgoing.end(request.body);
	});
}

export async function readBody(
	stream: IncomingMessage,
	limitBytes: number,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of stream) {
		size += chunk.length;
		if (size > limitBytes) throw new Error('Body too large');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
