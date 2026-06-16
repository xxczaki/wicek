import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	AttachmentBuilder,
	type Message,
	MessageFlags,
	type SendableChannels,
} from 'discord.js';
import type { AgentEvent } from '../claude/events.ts';
import logger from '../utils/logger.ts';

const SAFE_LIMIT = 1900;
const FLUSH_INTERVAL_MS = 1500;
const TOOL_INPUT_LIMIT = 200;

export async function streamToDiscord(
	events: AsyncIterable<AgentEvent>,
	channel: SendableChannels,
	signal?: AbortSignal,
): Promise<{ sessionId: string; resultText: string }> {
	let currentMessage: Message | null = null;
	let buffer = '';
	let lastFlush = 0;
	let sessionId = '';
	let resultText = '';
	let allText = '';
	let isThinking = false;
	let gotResult = false;
	let gotError = false;
	const writtenFiles: string[] = [];
	const recentTools: string[] = [];

	async function flush() {
		if (!buffer) return;

		while (buffer.length > SAFE_LIMIT) {
			const splitAt = findSplitPoint(buffer);
			const chunk = buffer.slice(0, splitAt);
			buffer = buffer.slice(splitAt);
			if (buffer.startsWith('\n')) buffer = buffer.slice(1);
			if (isThinking && !buffer.startsWith('>')) buffer = `> ${buffer}`;

			if (currentMessage) {
				await editText(currentMessage, chunk);
			} else {
				await sendText(channel, chunk);
			}
			currentMessage = null;
		}

		if (!buffer) return;
		if (!currentMessage) {
			currentMessage = await sendText(channel, buffer);
		} else {
			await editText(currentMessage, buffer);
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
					// Internal reasoning — kept off Discord, but still tracked for
					// file-path extraction in the final output.
					allText += event.content;
					break;
				}

				case 'text': {
					if (isThinking) {
						buffer = ensureLineStart(buffer);
						buffer += '\n';
						isThinking = false;
					}
					buffer += event.content;
					allText += event.content;

					if (
						buffer.length > SAFE_LIMIT ||
						Date.now() - lastFlush >= FLUSH_INTERVAL_MS
					)
						await flush();
					break;
				}

				case 'tool_start': {
					buffer = ensureLineStart(buffer);

					// Keep a verbose record for error diagnostics, but render only
					// a compact tool/skill name on the happy path.
					recentTools.push(
						event.input
							? `\`${event.name}\` ${truncate(event.input, TOOL_INPUT_LIMIT)}`
							: `\`${event.name}\``,
					);
					const toolLine = `-# ${compactToolLabel(event.name, event.input)}\n`;

					if (!buffer && !currentMessage) {
						currentMessage = await sendText(channel, toolLine);
						lastFlush = Date.now();
					} else {
						buffer += toolLine;
						if (
							buffer.length > SAFE_LIMIT ||
							Date.now() - lastFlush >= FLUSH_INTERVAL_MS
						)
							await flush();
					}

					if (event.filePath && event.name !== 'Read')
						writtenFiles.push(event.filePath);
					break;
				}

				case 'tool_end': {
					if (event.filePath) writtenFiles.push(event.filePath);
					break;
				}

				case 'result': {
					sessionId = event.sessionId;
					resultText = event.text;
					gotResult = true;
					break;
				}

				case 'error': {
					gotError = true;
					logger.error({ message: event.message }, 'Agent error');
					await finalizeCurrent();
					let detail = `**Error:** ${event.message}`;
					if (recentTools.length > 0) {
						const trail = recentTools
							.slice(-5)
							.map((t) => `-# ${t}`)
							.join('\n');
						detail += `\n\n**What it was doing:**\n${trail}`;
					}
					await sendText(channel, truncate(detail, SAFE_LIMIT));
					return { sessionId, resultText: '' };
				}
			}
		}

		if (!gotResult && !gotError) {
			await finalizeCurrent();
			if (!signal?.aborted) {
				logger.error('Claude process ended without a result event');
				await sendText(
					channel,
					'**Error:** The AI process terminated unexpectedly. Please try again.',
				);
			}
			return { sessionId, resultText: '' };
		}

		if (buffer) {
			await flush();
		} else if (!currentMessage) {
			await sendText(channel, '*(No response)*');
		}

		await sendFileAttachments(channel, allText || resultText, writtenFiles);
	} catch (error) {
		logger.error({ error }, 'Stream-to-Discord failed');
		await sendText(
			channel,
			'Something went wrong while streaming the response.',
		).catch(() => {});
	}

	return { sessionId, resultText };
}

function sendText(channel: SendableChannels, content: string) {
	return channel.send({ content, flags: MessageFlags.SuppressEmbeds });
}

function editText(message: Message, content: string) {
	return message.edit({ content, flags: MessageFlags.SuppressEmbeds });
}

function findSplitPoint(text: string): number {
	const newlineAt = text.lastIndexOf('\n', SAFE_LIMIT);
	return newlineAt > SAFE_LIMIT / 2 ? newlineAt : SAFE_LIMIT;
}

function ensureLineStart(buf: string): string {
	if (!buf || buf.endsWith('\n')) return buf;
	return `${buf}\n`;
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 1)}…`;
}

const TOOL_VERBS: Record<string, string> = {
	Bash: 'Ran a command',
	Read: 'Read a file',
	Write: 'Wrote a file',
	Edit: 'Edited a file',
	Glob: 'Searched for files',
	Grep: 'Searched the code',
	WebFetch: 'Fetched a page',
	WebSearch: 'Searched the web',
};

function compactToolLabel(name: string, input: string): string {
	if (name === 'Skill') return input ? `Used skill: ${input}` : 'Used a skill';
	if (name === 'Task')
		return input ? `Spawned sub-agent: ${input}` : 'Spawned a sub-agent';
	if (name.startsWith('mcp__'))
		return `Used ${name.slice(5).split('__').join(' · ')}`;
	return TOOL_VERBS[name] ?? `Used ${name}`;
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

function isSendableArtifact(path: string): boolean {
	const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
	return (
		SENDABLE_EXTENSIONS.has(ext) &&
		!path.includes('/attachments/') &&
		existsSync(path) &&
		!isInsideGitRepo(path)
	);
}

function isInsideGitRepo(path: string): boolean {
	let dir = dirname(path);
	while (true) {
		if (existsSync(join(dir, '.git'))) return true;
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

function extractFilePaths(text: string): string[] {
	const matches = text.match(FILE_PATH_REGEX) || [];
	return [...new Set(matches)].filter(isSendableArtifact);
}

async function sendFileAttachments(
	channel: SendableChannels,
	text: string,
	writtenFiles: string[],
) {
	const toolFiles = writtenFiles.filter(isSendableArtifact);
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
