import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	AttachmentBuilder,
	EmbedBuilder,
	type Message,
	type MessageCreateOptions,
	MessageFlags,
	type SendableChannels,
} from 'discord.js';
import type { AgentEvent } from '../claude/events.ts';
import type { ReaderAnswer } from '../claude/readers.ts';
import { redactSecrets } from '../claude/secrets.ts';
import logger from '../utils/logger.ts';

interface ToolLine {
	label: string;
	count: number;
	line: string;
}

const SAFE_LIMIT = 1900;
const MAX_FILES_PER_MESSAGE = 10;
const FLUSH_INTERVAL_MS = 1500;
const TOOL_INPUT_LIMIT = 200;
const READER_EMBED_LIMIT = 4000;
const READER_EMBED_COLOR = 0xf0b232;
const PRIVATE_FOOTER = "🔒 Private – Wicek can't see this";

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
	let isThinking = false;
	let gotResult = false;
	let gotError = false;
	let gotReaderAnswer = false;
	const recentTools: string[] = [];
	let lastTool = null as ToolLine | null;
	const posts = new Map<Message, string>();

	async function post(content: string) {
		const message = await sendText(channel, content);
		posts.set(message, content);
		return message;
	}

	async function update(message: Message, content: string) {
		await editText(message, content);
		posts.set(message, content);
	}

	async function flush() {
		if (!buffer) return;

		while (buffer.length > SAFE_LIMIT) {
			const splitAt = findSplitPoint(buffer);
			const chunk = buffer.slice(0, splitAt);
			buffer = buffer.slice(splitAt);
			if (buffer.startsWith('\n')) buffer = buffer.slice(1);
			if (isThinking && !buffer.startsWith('>')) buffer = `> ${buffer}`;

			if (currentMessage) {
				await update(currentMessage, chunk);
			} else {
				await post(chunk);
			}
			currentMessage = null;
		}

		if (!buffer) return;
		if (!currentMessage) {
			currentMessage = await post(buffer);
		} else {
			await update(currentMessage, buffer);
		}
		lastFlush = Date.now();
	}

	async function finalizeCurrent() {
		if (buffer) await flush();
		currentMessage = null;
		buffer = '';
		lastTool = null;
	}

	try {
		for await (const event of events) {
			switch (event.type) {
				case 'thinking':
					break;

				case 'text': {
					lastTool = null;
					if (isThinking) {
						buffer = ensureLineStart(buffer);
						buffer += '\n';
						isThinking = false;
					}
					buffer += event.content;

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

					const label = compactToolLabel(event.name, event.input);
					if (lastTool?.label === label && buffer.endsWith(lastTool.line)) {
						buffer = buffer.slice(0, -lastTool.line.length);
						lastTool.count++;
					} else {
						lastTool = { label, count: 1, line: '' };
					}
					lastTool.line = formatToolLine(lastTool.label, lastTool.count);
					buffer += lastTool.line;

					if (
						!currentMessage ||
						buffer.length > SAFE_LIMIT ||
						Date.now() - lastFlush >= FLUSH_INTERVAL_MS
					)
						await flush();
					break;
				}

				case 'user_message': {
					await finalizeCurrent();
					break;
				}

				case 'reader_answer': {
					await finalizeCurrent();
					await sendReaderAnswer(channel, event);
					gotReaderAnswer = true;
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
		} else if (!currentMessage && !gotReaderAnswer) {
			await sendText(channel, '*(No response)*');
		}

		await attachMentionedFiles(posts);
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
	return channel.send({
		content: redactSecrets(content),
		flags: MessageFlags.SuppressEmbeds,
	});
}

function editText(message: Message, content: string) {
	return message.edit({
		content: redactSecrets(content),
		flags: MessageFlags.SuppressEmbeds,
	});
}

// An embed keeps private text visibly apart from Wicek's, and is sent apart
// from the agent's posts so file paths in it never become attachments.
// Discord builds no link previews from embed text.
export async function sendReaderAnswer(
	target: { send: (options: MessageCreateOptions) => Promise<unknown> },
	{ answer }: Pick<ReaderAnswer, 'answer'>,
) {
	const chunks = splitText(redactSecrets(answer), READER_EMBED_LIMIT);
	for (const [index, chunk] of chunks.entries()) {
		const embed = new EmbedBuilder()
			.setColor(READER_EMBED_COLOR)
			.setDescription(chunk);
		if (index === chunks.length - 1) {
			embed.setFooter({ text: PRIVATE_FOOTER });
		}
		await target.send({ embeds: [embed] });
	}
}

function splitText(text: string, limit: number): string[] {
	const chunks: string[] = [];
	let remaining = text.trim() || '(empty answer)';
	while (remaining.length > limit) {
		const newlineAt = remaining.lastIndexOf('\n', limit);
		const splitAt = newlineAt > limit / 2 ? newlineAt : limit;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).replace(/^\n/, '');
	}
	chunks.push(remaining);
	return chunks;
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

function formatToolLine(label: string, count: number): string {
	return count > 1 ? `-# ${label} ×${count}\n` : `-# ${label}\n`;
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

export async function attachMentionedFiles(posts: Map<Message, string>) {
	const attached = new Set<string>();

	for (const [message, content] of posts) {
		const paths = extractFilePaths(content)
			.filter((path) => !attached.has(path))
			.slice(0, MAX_FILES_PER_MESSAGE);
		if (paths.length === 0) continue;

		for (const path of paths) attached.add(path);
		try {
			await message.edit({
				files: paths.map((path) => new AttachmentBuilder(path)),
			});
		} catch (error) {
			logger.error({ error, paths }, 'Failed to attach files');
		}
	}
}

function extractFilePaths(text: string): string[] {
	const matches = text.match(FILE_PATH_REGEX) || [];
	return [...new Set(matches)].filter(isSendableArtifact);
}
