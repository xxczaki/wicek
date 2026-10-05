import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { MAIL_AGENT_NAME, MAIL_AGENTS, MAIL_HOOKS } from './mail.ts';

const [guardMailAccess] = MAIL_HOOKS.PreToolUse?.[0].hooks ?? [];
const signal = new AbortController().signal;

const MAIN_THREAD = {};
const MAIL_AGENT = { agent_id: 'agent-1', agent_type: MAIL_AGENT_NAME };
const OTHER_AGENT = { agent_id: 'agent-2', agent_type: 'general-purpose' };

function preToolUse(
	toolName: string,
	toolInput: unknown,
	caller: Record<string, string>,
): HookInput {
	return {
		hook_event_name: 'PreToolUse',
		tool_name: toolName,
		tool_input: toolInput,
		tool_use_id: 'tool-1',
		session_id: 'session-1',
		transcript_path: '/tmp/transcript.jsonl',
		cwd: '/app',
		...caller,
	} as HookInput;
}

async function decide(
	toolName: string,
	toolInput: unknown,
	caller: Record<string, string>,
) {
	const output = await guardMailAccess(
		preToolUse(toolName, toolInput, caller),
		'tool-1',
		{ signal },
	);
	return 'hookSpecificOutput' in output &&
		output.hookSpecificOutput?.hookEventName === 'PreToolUse'
		? output.hookSpecificOutput.permissionDecision
		: undefined;
}

test('lets only the mail-reader agent use the mail tools', async () => {
	const search = 'mcp__mail__search_messages';

	assert.equal(await decide(search, { from: 'alice' }, MAIL_AGENT), undefined);
	assert.equal(await decide(search, { from: 'alice' }, MAIN_THREAD), 'deny');
	assert.equal(await decide(search, { from: 'alice' }, OTHER_AGENT), 'deny');
	assert.equal(
		await decide(search, {}, { agent_type: MAIL_AGENT_NAME }),
		'deny',
	);
});

test('keeps the mail-reader agent away from every other tool', async () => {
	for (const toolName of ['Bash', 'WebFetch', 'Write', 'Agent', 'mcp__x__y']) {
		assert.equal(await decide(toolName, {}, MAIL_AGENT), 'deny');
	}
});

test('lets the mail-reader agent hand its report back', async () => {
	assert.equal(
		await decide('SubagentHandback', { result: 'summary' }, MAIL_AGENT),
		undefined,
	);
});

test('blocks other tools from reaching the mail gateway directly', async () => {
	assert.equal(
		await decide(
			'Bash',
			{ command: 'curl -s http://IMAP.broker/search' },
			MAIN_THREAD,
		),
		'deny',
	);
	assert.equal(
		await decide(
			'WebFetch',
			{ url: 'http://imap.broker/message' },
			OTHER_AGENT,
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

test('gives the mail-reader agent nothing but the read-only mail tools', () => {
	assert.deepEqual(MAIL_AGENTS[MAIL_AGENT_NAME].tools, [
		'mcp__mail__list_folders',
		'mcp__mail__search_messages',
		'mcp__mail__read_message',
	]);
});
