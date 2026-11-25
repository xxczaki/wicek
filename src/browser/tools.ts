import type { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';

export const ALLOWED_TOOLS = new Set([
	'click',
	'close_page',
	'drag',
	'emulate',
	'fill',
	'fill_form',
	'handle_dialog',
	'hover',
	'list_pages',
	'navigate_page',
	'new_page',
	'press_key',
	'resize_page',
	'select_page',
	'take_screenshot',
	'take_snapshot',
	'type_text',
	'wait_for',
]);

// Paths would point into the account browser pod. Wicek saves screenshots itself (see screenshots.ts).
const LOCAL_PATH_ARGUMENT = 'filePath';

export function allowedTools(tools: Tool[]): Tool[] {
	return tools.filter((tool) => ALLOWED_TOOLS.has(tool.name));
}

export function sanitizeCall(
	params: CallToolRequest['params'],
): CallToolRequest['params'] | undefined {
	if (!ALLOWED_TOOLS.has(params.name)) return undefined;
	const { [LOCAL_PATH_ARGUMENT]: _path, ...args } = params.arguments ?? {};
	return { ...params, arguments: args };
}
