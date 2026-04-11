import { existsSync } from 'node:fs';
import {
	AttachmentBuilder,
	type Message,
	type SendableChannels,
} from 'discord.js';
import type { AgentEvent } from '../claude/parse.ts';
import logger from '../utils/logger.ts';

const SAFE_LIMIT = 1900;
const EDIT_INTERVAL_MS = 1500;

const TOOL_LABELS: Record<string, string> = {
	WebSearch: 'Searching the web',
	WebFetch: 'Fetching a page',
	Read: 'Reading a file',
	Edit: 'Editing a file',
	Write: 'Writing a file',
	Bash: 'Running a command',
	Glob: 'Finding files',
	Grep: 'Searching code',
	Agent: 'Delegating to a subagent',
};

function toolLabel(name: string): string {
	return TOOL_LABELS[name] || `Using ${name}`;
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

async function sendFileAttachments(channel: SendableChannels, text: string) {
	const paths = extractFilePaths(text);
	if (paths.length === 0) return;

	const attachments = paths.map((p) => new AttachmentBuilder(p));
	try {
		await channel.send({ files: attachments });
	} catch (error) {
		logger.error({ error, paths }, 'Failed to send file attachments');
	}
}

export async function streamToDiscord(
	events: AsyncIterable<AgentEvent>,
	channel: SendableChannels,
): Promise<{ sessionId: string; resultText: string }> {
	let currentMessage: Message | null = null;
	let buffer = '';
	let lastEdit = 0;
	let sessionId = '';
	let resultText = '';

	async function flushBuffer() {
		if (!buffer) return;
		if (!currentMessage) {
			currentMessage = await channel.send(buffer);
		} else {
			await currentMessage.edit(buffer);
		}
		lastEdit = Date.now();
	}

	try {
		for await (const event of events) {
			switch (event.type) {
				case 'text': {
					buffer += event.content;

					if (buffer.length > SAFE_LIMIT) {
						const splitPoint = buffer.lastIndexOf('\n', SAFE_LIMIT);
						const cutAt = splitPoint > SAFE_LIMIT / 2 ? splitPoint : SAFE_LIMIT;
						const chunk = buffer.slice(0, cutAt);
						buffer = buffer.slice(cutAt);

						if (currentMessage) {
							await currentMessage.edit(chunk);
						} else {
							currentMessage = await channel.send(chunk);
						}
						currentMessage = null;
					} else if (Date.now() - lastEdit >= EDIT_INTERVAL_MS) {
						await flushBuffer();
					}
					break;
				}

				case 'tool': {
					if (event.status === 'start' && event.name) {
						const status = `> ${toolLabel(event.name)}...`;

						if (!buffer && !currentMessage) {
							currentMessage = await channel.send(status);
							lastEdit = Date.now();
						}
					}
					break;
				}

				case 'result': {
					sessionId = event.sessionId;
					resultText = event.text;
					break;
				}

				case 'error': {
					logger.error({ message: event.message }, 'Agent error');
					if (currentMessage) {
						await currentMessage.edit(
							buffer
								? `${buffer}\n\n**Error:** ${event.message}`
								: `**Error:** ${event.message}`,
						);
					} else {
						await channel.send(`**Error:** ${event.message}`);
					}
					return { sessionId, resultText: '' };
				}
			}
		}

		if (buffer) {
			await flushBuffer();
		} else if (!currentMessage) {
			await channel.send('*(No response)*');
		}

		await sendFileAttachments(channel, resultText);
	} catch (error) {
		logger.error({ error }, 'Stream-to-Discord failed');
		await channel
			.send('Something went wrong while streaming the response.')
			.catch(() => {});
	}

	return { sessionId, resultText };
}
