import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

const PNG_BASE64 = Buffer.from('fake png').toString('base64');
const DATA_DIRECTORY = await mkdtemp(join(tmpdir(), 'wicek-data-'));
process.env.DATA_DIR = DATA_DIRECTORY;
const { saveScreenshot } = await import('./screenshots.ts');

describe('saveScreenshot', () => {
	it('ignores screenshots without a file path', async () => {
		assert.deepEqual(await saveScreenshot(hookInput({}, [])), {});
	});

	it('refuses paths outside the outbox and tmp directories', async () => {
		const output = await saveScreenshot(
			hookInput({ filePath: '/etc/passwd' }, imageResponse()),
		);
		assert.match(additionalContext(output), /not saved/);
	});

	it('refuses paths that escape the allowed directories', async () => {
		const output = await saveScreenshot(
			hookInput(
				{ filePath: join(DATA_DIRECTORY, 'outbox/../../etc/x.png') },
				imageResponse(),
			),
		);
		assert.match(additionalContext(output), /not saved/);
	});

	it('writes the returned image to the requested path', async () => {
		const filePath = join(DATA_DIRECTORY, 'outbox', 'page.png');
		await mkdir(join(DATA_DIRECTORY, 'outbox'), { recursive: true });
		try {
			for (const response of [imageResponse(), { content: imageResponse() }]) {
				const output = await saveScreenshot(hookInput({ filePath }, response));
				assert.match(additionalContext(output), /saved to/);
				assert.equal((await readFile(filePath)).toString('base64'), PNG_BASE64);
			}
		} finally {
			await rm(DATA_DIRECTORY, { recursive: true, force: true });
		}
	});
});

function imageResponse() {
	return [
		{ type: 'text', text: 'Took a screenshot' },
		{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
	];
}

function hookInput(toolInput: object, toolResponse: unknown): HookInput {
	return {
		hook_event_name: 'PostToolUse',
		tool_name: 'mcp__account-browser__take_screenshot',
		tool_input: toolInput,
		tool_response: toolResponse,
		tool_use_id: 'tool-1',
		session_id: 'session-1',
		transcript_path: '/tmp/transcript.jsonl',
		cwd: '/app',
	} as HookInput;
}

function additionalContext(output: object): string {
	return (
		(output as { hookSpecificOutput?: { additionalContext?: string } })
			.hookSpecificOutput?.additionalContext ?? ''
	);
}
