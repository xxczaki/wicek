import {
	ChannelType,
	type ChatInputCommandInteraction,
	type Message,
	type SendableChannels,
} from 'discord.js';
import { parseClaudeStream } from '../../claude/parse.ts';
import { contextKey, getSession, setSession } from '../../claude/sessions.ts';
import { spawnClaude } from '../../claude/spawn.ts';
import { streamToDiscord } from '../../stream/discord.ts';
import logger from '../../utils/logger.ts';

let busy = false;

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
	if (busy) {
		await channel.send("I'm currently handling another request. Please wait.");
		return;
	}

	busy = true;
	try {
		if (channel.isTextBased()) await channel.sendTyping();

		const key = contextKey(ctx);
		const existingSession = getSession(key);
		const controller = new AbortController();

		const { lines } = spawnClaude({
			prompt,
			sessionId: existingSession,
			signal: controller.signal,
		});

		const events = parseClaudeStream(lines);
		const { sessionId } = await streamToDiscord(events, channel);

		if (sessionId) {
			setSession(key, sessionId);
		}
	} catch (error) {
		logger.error({ error }, 'Agent run failed');
		await channel.send('Something went wrong.').catch(() => {});
	} finally {
		busy = false;
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
		await runAgent(prompt, thread, ctx);
		return;
	}

	await runAgent(prompt, message.channel as SendableChannels, ctx);
}
