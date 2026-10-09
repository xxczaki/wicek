import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { ACCOUNT_AGENT_NAME, ACCOUNT_HOOKS } from './logins.ts';

const [guardAccountAccess] = ACCOUNT_HOOKS.PreToolUse?.[0].hooks ?? [];
const signal = new AbortController().signal;

const MAIN_THREAD = {};
const ACCOUNT_AGENT = { agent_id: 'agent-1', agent_type: ACCOUNT_AGENT_NAME };
const NAVIGATE = 'mcp__chrome-devtools__navigate_page';
const FILL = 'mcp__chrome-devtools__fill';

async function decide(
	toolName: string,
	toolInput: unknown,
	caller: Record<string, string>,
) {
	const output = await guardAccountAccess(
		{
			hook_event_name: 'PreToolUse',
			tool_name: toolName,
			tool_input: toolInput,
			tool_use_id: 'tool-1',
			session_id: 'session-1',
			transcript_path: '/tmp/transcript.jsonl',
			cwd: '/app',
			...caller,
		} as HookInput,
		'tool-1',
		{ signal },
	);
	return 'hookSpecificOutput' in output &&
		output.hookSpecificOutput?.hookEventName === 'PreToolUse'
		? output.hookSpecificOutput.permissionDecision
		: undefined;
}

test('keeps the account-browser agent on listed domains', async () => {
	for (const url of [
		'https://evil.example/?data=1',
		'https://www.check24.de/',
		'http://www.check24.de/',
		'not a url',
	]) {
		assert.equal(await decide(NAVIGATE, { url }, ACCOUNT_AGENT), 'deny');
	}
	assert.equal(
		await decide(NAVIGATE, { type: 'back' }, ACCOUNT_AGENT),
		undefined,
	);
});

test('limits the account-browser agent to browser tools', async () => {
	for (const toolName of [
		'Bash',
		'WebFetch',
		'mcp__chrome-devtools__evaluate_script',
	]) {
		assert.equal(await decide(toolName, {}, ACCOUNT_AGENT), 'deny');
	}
});

test('keeps logins away from other agents', async () => {
	const input = { uid: '1', value: 'WICEK_LOGIN_abc123_PASSWORD' };

	assert.equal(await decide(FILL, input, ACCOUNT_AGENT), undefined);
	assert.equal(await decide(FILL, input, MAIN_THREAD), 'deny');
	assert.equal(
		await decide('Edit', { new_string: input.value }, MAIN_THREAD),
		undefined,
	);
	assert.equal(
		await decide('mcp__logins__list_logins', {}, MAIN_THREAD),
		'deny',
	);
	assert.equal(
		await decide('mcp__logins__list_logins', {}, ACCOUNT_AGENT),
		undefined,
	);
	assert.equal(
		await decide(
			'Bash',
			{ command: 'curl http://logins.broker/list' },
			MAIN_THREAD,
		),
		'deny',
	);
});
