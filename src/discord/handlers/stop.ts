import type { ChatInputCommandInteraction } from 'discord.js';
import { stopAgent } from './ask.ts';

export async function handleStop(interaction: ChatInputCommandInteraction) {
	const stopped = stopAgent();

	await interaction.reply({
		content: stopped
			? 'Stopped.'
			: 'Nothing is running.',
		flags: ['Ephemeral'],
	});
}
