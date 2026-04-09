import type { Client, Interaction } from 'discord.js';
import logger from '../../utils/logger.ts';
import { isAllowedUser } from '../guards.ts';
import { handleAskInteraction } from './ask.ts';
import { handleClear } from './clear.ts';

export function attachInteractionHandler(client: Client) {
	client.on('interactionCreate', async (interaction: Interaction) => {
		if (!interaction.isChatInputCommand()) return;
		if (!isAllowedUser(interaction.user.id)) {
			await interaction.reply({
				content: 'You are not authorized to use this bot.',
				ephemeral: true,
			});
			return;
		}

		try {
			switch (interaction.commandName) {
				case 'ask':
					await handleAskInteraction(interaction);
					break;
				case 'clear':
					await handleClear(interaction);
					break;
				default:
					await interaction.reply({
						content: 'Unknown command.',
						ephemeral: true,
					});
			}
		} catch (error) {
			logger.error(
				{ error, command: interaction.commandName },
				'Command handler failed',
			);
			const reply =
				interaction.deferred || interaction.replied
					? interaction.editReply.bind(interaction)
					: interaction.reply.bind(interaction);
			await reply({ content: 'Something went wrong.' }).catch(() => {});
		}
	});
}
