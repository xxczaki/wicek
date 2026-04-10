import { ChannelType, type Client, type Message } from 'discord.js';
import logger from '../../utils/logger.ts';
import {
	extractPromptFromMention,
	isAllowedUser,
	isBotMentioned,
	isDM,
} from '../guards.ts';
import { handleAskMessage } from './ask.ts';

export function attachMessageHandler(client: Client) {
	client.on('messageCreate', async (message: Message) => {
		if (message.author.bot) return;

		logger.info(
			{
				author: message.author.id,
				channelType: message.channel.type,
				partial: message.partial,
			},
			'Incoming message',
		);

		if (!isAllowedUser(message.author.id)) return;

		try {
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
