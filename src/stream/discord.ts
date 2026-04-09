import type { Message, SendableChannels } from 'discord.js';
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

					// Split if approaching Discord's limit
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

						// Send tool status as a separate update if we have no content yet
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

		// Final flush
		if (buffer) {
			await flushBuffer();
		} else if (!currentMessage) {
			// Claude returned no text (unlikely but handle gracefully)
			await channel.send('*(No response)*');
		}
	} catch (error) {
		logger.error({ error }, 'Stream-to-Discord failed');
		await channel
			.send('Something went wrong while streaming the response.')
			.catch(() => {});
	}

	return { sessionId, resultText };
}
