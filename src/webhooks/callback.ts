import type { IncomingMessage, ServerResponse } from 'node:http';
import {
	findReader,
	postToReader,
	type ReaderAnswer,
} from '../claude/readers.ts';
import logger from '../utils/logger.ts';

const CALLBACK_PATH_REGEX = /^\/hooks\/callback\/([\w-]+)$/;
const MAX_CALLBACK_PARAMS_BYTES = 4096;
const RECEIVED_PAGE = `<!doctype html><meta charset="utf-8"><title>Wicek</title><p>Received. The result will arrive in Discord – you can close this tab.</p>`;

export function readerCallbackName(request: IncomingMessage) {
	if (request.method !== 'GET') return undefined;
	const path = new URL(request.url ?? '/', 'http://localhost').pathname;
	return CALLBACK_PATH_REGEX.exec(path)?.[1];
}

// Public: anyone can call this, so it never reflects input and only reaches
// the model when the reader confirms the state it saved for a pending redirect
export function handleReaderCallback(
	readerName: string,
	request: IncomingMessage,
	response: ServerResponse,
	deliver: (answer: ReaderAnswer) => Promise<void>,
) {
	const reader = findReader(readerName);
	if (!reader) {
		response.writeHead(404).end();
		return;
	}

	response.writeHead(200, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
		'referrer-policy': 'no-referrer',
	});
	response.end(RECEIVED_PAGE);

	const url = new URL(request.url ?? '/', 'http://localhost');
	const params = Object.fromEntries(url.searchParams);
	if (JSON.stringify(params).length > MAX_CALLBACK_PARAMS_BYTES) return;

	postToReader(reader, '/callback', { params })
		.then((answer) => {
			if (answer === undefined) {
				logger.warn({ reader: readerName }, 'Callback without a pending state');
				return;
			}
			return deliver({ reader: readerName, answer });
		})
		.catch((error) =>
			logger.error(
				{ err: error, reader: readerName },
				'Reader callback failed',
			),
		);
}
