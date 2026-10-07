import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
	HookInput,
	SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { READER_HOOKS } from './readers.ts';

test('ends the turn once ask_reader delivered an answer', async () => {
	const [matcher] = READER_HOOKS.PostToolUse ?? [];
	assert.equal(matcher.matcher, 'mcp__readers__ask_reader');

	const [hook] = matcher.hooks;
	const output = (await hook({} as HookInput, 'tool-1', {
		signal: new AbortController().signal,
	})) as SyncHookJSONOutput;
	assert.equal(output.continue, false);
	assert.equal(READER_HOOKS.PostToolUseFailure, undefined);
});
