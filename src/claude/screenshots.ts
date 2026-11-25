import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
	HookCallbackMatcher,
	HookEvent,
	HookInput,
	HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import logger from '../utils/logger.ts';

const SCREENSHOT_TOOL = 'mcp__account-browser__take_screenshot';
const DATA_DIRECTORY = process.env.DATA_DIR ?? '/data';
const SCREENSHOT_DIRECTORIES = ['outbox', 'tmp'].map((name) =>
	join(DATA_DIRECTORY, name),
);

export const SCREENSHOT_HOOKS: Partial<
	Record<HookEvent, HookCallbackMatcher[]>
> = {
	PostToolUse: [{ matcher: SCREENSHOT_TOOL, hooks: [saveScreenshot] }],
};

export async function saveScreenshot(
	input: HookInput,
): Promise<HookJSONOutput> {
	if (input.hook_event_name !== 'PostToolUse') return {};

	const filePath = requestedPath(input.tool_input);
	if (!filePath) return {};
	if (!isAllowedPath(filePath)) {
		return context(
			`Screenshot not saved: paths must be under ${SCREENSHOT_DIRECTORIES.join(' or ')}`,
		);
	}

	const image = imageData(input.tool_response);
	if (!image) return context('Screenshot not saved: no image was returned');

	try {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, Buffer.from(image, 'base64'));
		return context(`Screenshot saved to ${filePath}`);
	} catch (error) {
		logger.warn({ err: error, filePath }, 'Could not save screenshot');
		return context(`Screenshot not saved: ${String(error)}`);
	}
}

function requestedPath(toolInput: unknown): string | undefined {
	if (typeof toolInput !== 'object' || toolInput === null) return undefined;
	if (!('filePath' in toolInput)) return undefined;
	return typeof toolInput.filePath === 'string'
		? resolve(toolInput.filePath)
		: undefined;
}

function isAllowedPath(filePath: string): boolean {
	return SCREENSHOT_DIRECTORIES.some((directory) =>
		filePath.startsWith(`${directory}/`),
	);
}

function imageData(toolResponse: unknown): string | undefined {
	const content = Array.isArray(toolResponse)
		? toolResponse
		: typeof toolResponse === 'object' &&
				toolResponse !== null &&
				'content' in toolResponse &&
				Array.isArray(toolResponse.content)
			? toolResponse.content
			: [];
	const image = content.find(
		(block: unknown) =>
			typeof block === 'object' &&
			block !== null &&
			'type' in block &&
			block.type === 'image' &&
			'data' in block &&
			typeof block.data === 'string',
	);
	return image?.data;
}

function context(text: string): HookJSONOutput {
	return {
		hookSpecificOutput: {
			hookEventName: 'PostToolUse',
			additionalContext: text,
		},
	};
}
