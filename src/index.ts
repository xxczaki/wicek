import { flushSessions } from './claude/sessions.ts';
import { initCronScheduler, stopCronScheduler } from './cron/scheduler.ts';
import { createClient } from './discord/client.ts';
import { registerCommands } from './discord/commands.ts';
import { attachInteractionHandler } from './discord/handlers/interaction.ts';
import { attachMessageHandler } from './discord/handlers/message.ts';
import { getEnv } from './utils/env.ts';
import logger from './utils/logger.ts';

const token = getEnv('DISCORD_TOKEN');
const clientId = getEnv('CLIENT_ID');

// Register slash commands
await registerCommands(token, clientId);

// Create and configure the Discord client
const client = createClient();

client.once('ready', (c) => {
	logger.info({ user: c.user.tag }, 'Bot ready');
	initCronScheduler(client);
});

// Attach event handlers
attachInteractionHandler(client);
attachMessageHandler(client);

// Login
await client.login(token);

// Graceful shutdown
function shutdown(signal: string) {
	logger.info({ signal }, 'Shutting down');
	stopCronScheduler();
	flushSessions();
	client.destroy();
	process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
