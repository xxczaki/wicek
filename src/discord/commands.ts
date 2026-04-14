import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import logger from '../utils/logger.ts';

const ASK_COMMAND = new SlashCommandBuilder()
	.setName('ask')
	.setDescription('Send a prompt to Claude')
	.addStringOption((option) =>
		option.setName('prompt').setDescription('Your prompt').setRequired(true),
	);

const CLEAR_COMMAND = new SlashCommandBuilder()
	.setName('clear')
	.setDescription('Reset conversation context');

const STOP_COMMAND = new SlashCommandBuilder()
	.setName('stop')
	.setDescription('Cancel the current AI operation');

const COMMANDS = [ASK_COMMAND, CLEAR_COMMAND, STOP_COMMAND];

export async function registerCommands(token: string, clientId: string) {
	const rest = new REST({ version: '10' }).setToken(token);

	try {
		logger.info('Registering application commands');

		await rest.put(Routes.applicationCommands(clientId), {
			body: COMMANDS.map((c) => c.toJSON()),
			signal: AbortSignal.timeout(30_000),
		});

		logger.info('Application commands registered');
	} catch (error) {
		logger.error({ error }, 'Failed to register application commands');
	}
}
