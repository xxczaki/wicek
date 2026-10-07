import {
	ChannelType,
	type ChatInputCommandInteraction,
	type Message,
	type SendableChannels,
} from 'discord.js';
import { type AgentEvent, streamAgent } from '../../claude/agent.ts';
import { AgentInbox } from '../../claude/inbox.ts';
import { contextKey, getSession, setSession } from '../../claude/sessions.ts';
import { streamToDiscord } from '../../stream/discord.ts';
import logger from '../../utils/logger.ts';
import {
	buildPromptWithAttachments,
	downloadAttachments,
} from '../attachments.ts';

const TYPING_INTERVAL_MS = 8_000;

const inboxes = new Map<string, AgentInbox>();
let activeController: AbortController | null = null;
let runQueue: Promise<void> = Promise.resolve();
let queuedRunCount = 0;

export function stopAgent(): boolean {
	if (!activeController) return false;
	activeController.abort();
	return true;
}

function getContextFromMessage(message: Message) {
	return {
		isDM: message.channel.type === ChannelType.DM,
		userId: message.author.id,
		threadId:
			message.channel.type === ChannelType.PublicThread
				? message.channel.id
				: undefined,
		channelId: message.channel.id,
	};
}

async function runAgent(
	prompt: string,
	channel: SendableChannels,
	ctx: ReturnType<typeof getContextFromMessage>,
) {
	const key = contextKey(ctx);
	if (inboxes.get(key)?.push(prompt)) {
		logger.info({ key }, 'Steered running agent');
		return;
	}

	const inbox = new AgentInbox();
	inboxes.set(key, inbox);

	const previousRun = runQueue;
	let releaseQueue = () => {};
	runQueue = new Promise((resolve) => {
		releaseQueue = resolve;
	});

	if (queuedRunCount++ > 0) {
		await channel
			.send("Queued – I'll start once the current task is done.")
			.catch(() => {});
	}

	await previousRun;

	const typingInterval = channel.isTextBased()
		? setInterval(() => {
				channel.sendTyping().catch(() => {});
			}, TYPING_INTERVAL_MS)
		: undefined;
	const controller = new AbortController();
	activeController = controller;

	try {
		if (channel.isTextBased()) await channel.sendTyping();

		const events = streamAgent({
			prompt,
			sessionId: getSession(key),
			conversation: key,
			abortController: controller,
			inbox,
		});

		const { sessionId } = await streamToDiscord(
			closeInboxWhenDone(events, inbox),
			channel,
			controller.signal,
		);

		if (sessionId) {
			setSession(key, sessionId);
		}
	} catch (error) {
		if (!controller.signal.aborted) {
			logger.error({ error }, 'Agent run failed');
			await channel.send('Something went wrong.').catch(() => {});
		}
	} finally {
		if (typingInterval) clearInterval(typingInterval);
		inbox.close();
		if (inboxes.get(key) === inbox) inboxes.delete(key);
		activeController = null;
		queuedRunCount--;
		releaseQueue();
	}

	const undelivered = inbox.takePending();
	if (undelivered.length > 0 && !controller.signal.aborted) {
		await runAgent(undelivered.join('\n\n'), channel, ctx);
	}
}

async function* closeInboxWhenDone(
	events: AsyncIterable<AgentEvent>,
	inbox: AgentInbox,
): AsyncGenerator<AgentEvent> {
	try {
		yield* events;
	} finally {
		inbox.close();
	}
}

export async function handleAskInteraction(
	interaction: ChatInputCommandInteraction,
) {
	const prompt = interaction.options.getString('prompt', true);
	await interaction.deferReply();

	const channel = interaction.channel;
	if (!channel) {
		await interaction.editReply('Could not resolve channel.');
		return;
	}

	if (channel.type === ChannelType.GuildText) {
		const thread = await channel.threads.create({
			name: prompt.slice(0, 100),
			autoArchiveDuration: 60,
		});

		await interaction.editReply(`Continuing in ${thread}`);

		const ctx = {
			isDM: false,
			userId: interaction.user.id,
			threadId: thread.id,
			channelId: channel.id,
		};
		await runAgent(prompt, thread, ctx);
		return;
	}

	const ctx = {
		isDM: channel.type === ChannelType.DM,
		userId: interaction.user.id,
		threadId:
			channel.type === ChannelType.PublicThread ? channel.id : undefined,
		channelId: channel.id,
	};

	await interaction.deleteReply();
	await runAgent(prompt, channel as SendableChannels, ctx);
}

export async function handleAskMessage(message: Message, prompt: string) {
	if (!('send' in message.channel)) return;

	let fullPrompt = prompt;
	if (message.attachments.size > 0) {
		const paths = await downloadAttachments(message.attachments);
		fullPrompt = buildPromptWithAttachments(prompt, paths);
	}

	const ctx = getContextFromMessage(message);

	if (
		!ctx.isDM &&
		!ctx.threadId &&
		message.channel.type === ChannelType.GuildText
	) {
		const thread = await message.channel.threads.create({
			name: prompt.slice(0, 100),
			autoArchiveDuration: 60,
			startMessage: message,
		});
		ctx.threadId = thread.id;
		await runAgent(fullPrompt, thread, ctx);
		return;
	}

	await runAgent(fullPrompt, message.channel as SendableChannels, ctx);
}
