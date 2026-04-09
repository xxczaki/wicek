import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import { clearSession, contextKey } from '../../claude/sessions.ts';

export async function handleClear(interaction: ChatInputCommandInteraction) {
	const channel = interaction.channel;
	if (!channel) {
		await interaction.reply({
			content: 'Could not resolve channel.',
			ephemeral: true,
		});
		return;
	}

	const key = contextKey({
		isDM: channel.type === ChannelType.DM,
		userId: interaction.user.id,
		threadId:
			channel.type === ChannelType.PublicThread ? channel.id : undefined,
		channelId: channel.id,
	});

	clearSession(key);

	await interaction.reply({
		content: 'Context cleared. Next message starts a fresh conversation.',
		ephemeral: true,
	});
}
