import { ChannelType, type Message } from 'discord.js';
import { getEnvList } from '../utils/env.ts';

let allowedIds: string[] | undefined;

function getAllowedUserIds(): string[] {
	allowedIds ??= getEnvList('ALLOWED_USER_IDS');
	return allowedIds;
}

export function isAllowedUser(userId: string): boolean {
	return getAllowedUserIds().includes(userId);
}

export function isDM(message: Message): boolean {
	return message.channel.type === ChannelType.DM;
}

export function isBotMentioned(message: Message): boolean {
	return message.mentions.has(message.client.user);
}

export function extractPromptFromMention(message: Message): string {
	return message.content
		.replace(new RegExp(`<@!?${message.client.user.id}>`), '')
		.trim();
}
