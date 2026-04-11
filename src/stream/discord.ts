import { existsSync } from 'node:fs';
import {
	AttachmentBuilder,
	type Message,
	type SendableChannels,
} from 'discord.js';
import type { AgentEvent } from '../claude/parse.ts';
import logger from '../utils/logger.ts';

const SAFE_LIMIT = 1900;
const FLUSH_INTERVAL_MS = 1500;

export async function streamToDiscord(
	events: AsyncIterable<AgentEvent>,
	channel: SendableChannels,
): Promise<{ sessionId: string; resultText: string }> {
	let currentMessage: Message | null = null;
	let buffer = '';
	let lastFlush = 0;
	let sessionId = '';
	let resultText = '';
	let allText = '';
	let isThinking = false;
	const writtenFiles: string[] = [];

	async function flush() {
		if (!buffer) return;
		if (!currentMessage) {
			currentMessage = await channel.send(buffer);
		} else {
			await currentMessage.edit(buffer);
		}
		lastFlush = Date.now();
	}

	async function finalizeCurrent() {
		if (buffer) await flush();
		currentMessage = null;
		buffer = '';
	}

	try {
		for await (const event of events) {
			switch (event.type) {
				case 'thinking': {
					if (!isThinking && event.content.trim()) {
						if (buffer && !buffer.endsWith('\n')) buffer += '\n';
						buffer += '> ';
						isThinking = true;
					}
					buffer += event.content.replaceAll('\n', '\n> ');
					allText += event.content;

					if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) await flush();
					break;
				}

				case 'text': {
					if (isThinking) {
						buffer += '\n\n';
						isThinking = false;
					}
					buffer += event.content;
					allText += event.content;

					if (buffer.length > SAFE_LIMIT) {
						const splitAt = findSplitPoint(buffer);
						const chunk = buffer.slice(0, splitAt);
						buffer = buffer.slice(splitAt);

						if (currentMessage) {
							await currentMessage.edit(chunk);
						} else {
							await channel.send(chunk);
						}
						currentMessage = null;
					} else if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
						await flush();
					}
					break;
				}

				case 'tool_start': {
					if (isThinking) {
						buffer += '\n\n';
						isThinking = false;
					}

					const label = event.input
						? `\`${event.name}\` ${event.input}`
						: `\`${event.name}\``;
					const toolLine = `> ${label}\n`;

					if (!buffer && !currentMessage) {
						currentMessage = await channel.send(toolLine);
						lastFlush = Date.now();
					} else {
						buffer += toolLine;
						if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) await flush();
					}

					if (event.filePath) writtenFiles.push(event.filePath);
					break;
				}

				case 'tool_end': {
					if (event.filePath) writtenFiles.push(event.filePath);
					break;
				}

				case 'result': {
					sessionId = event.sessionId;
					resultText = event.text;
					break;
				}

				case 'error': {
					logger.error({ message: event.message }, 'Agent error');
					await finalizeCurrent();
					await channel.send(`**Error:** ${event.message}`);
					return { sessionId, resultText: '' };
				}
			}
		}

		if (buffer) {
			await flush();
		} else if (!currentMessage) {
			await channel.send('*(No response)*');
		}

		await sendFileAttachments(channel, allText || resultText, writtenFiles);
	} catch (error) {
		logger.error({ error }, 'Stream-to-Discord failed');
		await channel
			.send('Something went wrong while streaming the response.')
			.catch(() => {});
	}

	return { sessionId, resultText };
}

function findSplitPoint(text: string): number {
	const newlineAt = text.lastIndexOf('\n', SAFE_LIMIT);
	return newlineAt > SAFE_LIMIT / 2 ? newlineAt : SAFE_LIMIT;
}

const FILE_PATH_REGEX =
	/(?:\/[\w./-]+\.(?:png|jpg|jpeg|gif|webp|svg|pdf|csv|json|txt|md|html))/gi;

const SENDABLE_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.svg',
	'.pdf',
	'.csv',
	'.json',
	'.txt',
	'.md',
	'.html',
]);

function extractFilePaths(text: string): string[] {
	const matches = text.match(FILE_PATH_REGEX) || [];
	return [...new Set(matches)].filter((path) => {
		const ext = path.slice(path.lastIndexOf('.'));
		return SENDABLE_EXTENSIONS.has(ext) && existsSync(path);
	});
}

async function sendFileAttachments(
	channel: SendableChannels,
	text: string,
	writtenFiles: string[],
) {
	const toolFiles = writtenFiles.filter((p) => existsSync(p));
	const paths = toolFiles.length > 0 ? toolFiles : extractFilePaths(text);
	const uniquePaths = [...new Set(paths)];

	if (uniquePaths.length === 0) return;

	const attachments = uniquePaths.map((p) => new AttachmentBuilder(p));
	try {
		await channel.send({ files: attachments });
	} catch (error) {
		logger.error(
			{ error, paths: uniquePaths },
			'Failed to send file attachments',
		);
	}
}
