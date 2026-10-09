import type {
	HookCallbackMatcher,
	HookEvent,
	HookInput,
	HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';

const HIDDEN_FROM_AGENT = [
	'DISCORD_TOKEN',
	'GITHUB_WEBHOOK_SECRET',
	'GRAFANA_WEBHOOK_TOKEN',
];

const SECRET_ENV_NAMES = [...HIDDEN_FROM_AGENT, 'CLAUDE_CODE_OAUTH_TOKEN'];

const MIN_SECRET_LENGTH = 8;
const REDACTED = '[redacted]';

export function agentEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	for (const name of HIDDEN_FROM_AGENT) delete env[name];
	return env;
}

export function redactSecrets(text: string): string {
	let redacted = text;
	for (const secret of secretValues()) {
		redacted = redacted.replaceAll(secret, REDACTED);
		redacted = redacted.replaceAll(
			JSON.stringify(secret).slice(1, -1),
			REDACTED,
		);
	}
	return redacted;
}

export const REDACTION_HOOKS: Partial<
	Record<HookEvent, HookCallbackMatcher[]>
> = {
	PostToolUse: [{ hooks: [redactToolOutput] }],
};

async function redactToolOutput(input: HookInput): Promise<HookJSONOutput> {
	if (input.hook_event_name !== 'PostToolUse') return {};

	const serialized = JSON.stringify(input.tool_response);
	if (serialized === undefined) return {};

	const redacted = redactSecrets(serialized);
	if (redacted === serialized) return {};

	return {
		hookSpecificOutput: {
			hookEventName: 'PostToolUse',
			updatedToolOutput: JSON.parse(redacted),
		},
	};
}

function secretValues(): string[] {
	return SECRET_ENV_NAMES.flatMap((name) => {
		const value = process.env[name];
		return value && value.length >= MIN_SECRET_LENGTH ? [value] : [];
	});
}
