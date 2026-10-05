import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { agentEnv, REDACTION_HOOKS, redactSecrets } from './secrets.ts';

process.env.GRAFANA_API_KEY = 'glc_supersecretvalue';
process.env.UNIFI_PASSWORD = 'pa"ss\\word123';
process.env.DISCORD_TOKEN = 'discord-token-value';

const [redactToolOutput] = REDACTION_HOOKS.PostToolUse?.[0].hooks ?? [];
const signal = new AbortController().signal;

function postToolUse(toolResponse: unknown): HookInput {
	return {
		hook_event_name: 'PostToolUse',
		tool_name: 'Bash',
		tool_input: {},
		tool_response: toolResponse,
		tool_use_id: 'tool-1',
		session_id: 'session-1',
		transcript_path: '/tmp/transcript.jsonl',
		cwd: '/app',
	} as HookInput;
}

test('redacts secret values from plain text', () => {
	assert.equal(
		redactSecrets('key=glc_supersecretvalue done'),
		'key=[redacted] done',
	);
});

test('rewrites tool output that contains a secret, including JSON-escaped ones', async () => {
	const result = await redactToolOutput(
		postToolUse({
			stdout:
				'GRAFANA_API_KEY=glc_supersecretvalue\nUNIFI_PASSWORD=pa"ss\\word123',
		}),
		'tool-1',
		{ signal },
	);
	assert.deepEqual(result, {
		hookSpecificOutput: {
			hookEventName: 'PostToolUse',
			updatedToolOutput: {
				stdout: 'GRAFANA_API_KEY=[redacted]\nUNIFI_PASSWORD=[redacted]',
			},
		},
	});
});

test('leaves tool output without secrets untouched', async () => {
	const result = await redactToolOutput(
		postToolUse({ stdout: 'all clear' }),
		'tool-1',
		{ signal },
	);
	assert.deepEqual(result, {});
});

test('hides bot-only tokens from the agent environment', () => {
	const env = agentEnv();
	assert.equal(env.DISCORD_TOKEN, undefined);
	assert.equal(env.GRAFANA_API_KEY, 'glc_supersecretvalue');
});
