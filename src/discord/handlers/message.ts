import { ChannelType, type Client } from 'discord.js';
import logger from '../../utils/logger.ts';
import {
	extractPromptFromMention,
	isAllowedUser,
	isBotMentioned,
	isDM,
} from '../guards.ts';
import { handleAskMessage } from './ask.ts';

interface RawMessageData {
	id: string;
	channel_id: string;
	guild_id?: string;
	author: { id: string; bot?: boolean };
	content: string;
}

export function attachMessageHandler(client: Client) {
	// Workaround: discord.js v14 does not emit messageCreate for DMs on Node.js 24.
	// Use the raw gateway event and fetch the Message object manually.
	client.on('raw', async (packet: { t: string; d: RawMessageData }) => {
		if (packet.t !== 'MESSAGE_CREATE') return;

		const data = packet.d;
		if (data.author.bot) return;
		if (!isAllowedUser(data.author.id)) return;

		try {
			const channel = await client.channels.fetch(data.channel_id);
			if (!channel || !('messages' in channel)) return;

			const message = await channel.messages.fetch(data.id);

			logger.info(
				{
					author: message.author.id,
					channelType: message.channel.type,
				},
				'Incoming message',
			);

			if (isDM(message)) {
				await handleAskMessage(message, message.content);
				return;
			}

			if (isBotMentioned(message)) {
				const prompt = extractPromptFromMention(message);
				if (!prompt) return;
				await handleAskMessage(message, prompt);
				return;
			}

			if (
				message.channel.type === ChannelType.PublicThread &&
				message.channel.ownerId === client.user?.id
			) {
				await handleAskMessage(message, message.content);
			}
		} catch (error) {
			logger.error({ error }, 'Message handler failed');
		}
	});
}
