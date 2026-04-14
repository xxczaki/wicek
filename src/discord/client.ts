import {
	ActivityType,
	Client,
	GatewayIntentBits,
	Partials,
	PresenceUpdateStatus,
} from 'discord.js';
import { getOptionalEnv } from '../utils/env.ts';

export function createClient(): Client {
	const version = getOptionalEnv('APP_VERSION');
	const status = version ? `Running wicek ${version}` : 'Ready';

	return new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessages,
		],
		partials: [
			Partials.Channel,
			Partials.Message,
			Partials.User,
			Partials.GuildMember,
		],
		presence: {
			activities: [{ name: status, type: ActivityType.Custom }],
			status: PresenceUpdateStatus.Online,
		},
	});
}
