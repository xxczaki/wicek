import type { ChatInputCommandInteraction } from 'discord.js';
import { clearSession } from '../../claude/sessions.ts';
import { contextKey } from './ask.ts';

export async function handleClear(interaction: ChatInputCommandInteraction) {
	const channel = interaction.channel;
	if (!channel) {
		await interaction.reply({
			content: 'Could not resolve channel.',
			flags: ['Ephemeral'],
		});
		return;
	}

	clearSession(contextKey(channel, interaction.user.id));

	await interaction.reply({
		content: 'Context cleared. Next message starts a fresh conversation.',
		flags: ['Ephemeral'],
	});
}
