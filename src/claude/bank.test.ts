import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import {
	BANK_AGENT_NAME,
	BANK_AGENTS,
	BANK_HOOKS,
	extractCode,
} from './bank.ts';

const [guardBankAccess] = BANK_HOOKS.PreToolUse?.[0].hooks ?? [];
const signal = new AbortController().signal;

const MAIN_THREAD = {};
const BANK_AGENT = { agent_id: 'agent-1', agent_type: BANK_AGENT_NAME };
const OTHER_AGENT = { agent_id: 'agent-2', agent_type: 'mail-reader' };

async function decide(
	toolName: string,
	toolInput: unknown,
	caller: Record<string, string>,
) {
	const output = await guardBankAccess(
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

test('lets only the bank-reader agent use the bank tools', async () => {
	const transactions = 'mcp__bank__get_transactions';
	const input = { date_from: '2026-10-01' };

	assert.equal(await decide(transactions, input, BANK_AGENT), undefined);
	assert.equal(await decide(transactions, input, MAIN_THREAD), 'deny');
	assert.equal(await decide(transactions, input, OTHER_AGENT), 'deny');
	assert.equal(
		await decide(transactions, input, { agent_type: BANK_AGENT_NAME }),
		'deny',
	);
});

test('keeps the bank-reader agent away from every other tool', async () => {
	for (const toolName of ['Bash', 'Read', 'WebFetch', 'Agent', 'mcp__x__y']) {
		assert.equal(await decide(toolName, {}, BANK_AGENT), 'deny');
	}
	assert.equal(await decide('SubagentHandback', {}, BANK_AGENT), undefined);
});

test('blocks other tools from calling the bank API directly', async () => {
	assert.equal(
		await decide(
			'Bash',
			{ command: 'curl -s https://API.enablebanking.com/aspsps' },
			MAIN_THREAD,
		),
		'deny',
	);
	assert.equal(
		await decide(
			'Bash',
			{ command: 'curl -s https://example.com' },
			MAIN_THREAD,
		),
		undefined,
	);
});

test('gives the bank-reader agent only the bank tools', () => {
	assert.deepEqual(BANK_AGENTS[BANK_AGENT_NAME].tools, [
		'mcp__bank__connection_status',
		'mcp__bank__start_connection',
		'mcp__bank__complete_connection',
		'mcp__bank__get_balances',
		'mcp__bank__get_transactions',
	]);
});

test('accepts a pasted code or the whole redirect URL', () => {
	assert.equal(extractCode(' abc-123 '), 'abc-123');
	assert.equal(
		extractCode('https://parsify.eu/?state=xyz&code=abc-123'),
		'abc-123',
	);
});
