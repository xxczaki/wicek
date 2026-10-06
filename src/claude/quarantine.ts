import type { HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export const SUBAGENT_HANDBACK_TOOL = 'SubagentHandback';

export function deny(reason: string): HookJSONOutput {
	return {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason,
		},
	};
}

export function mentions(toolInput: unknown, needle: string): boolean {
	return (JSON.stringify(toolInput) ?? '').toLowerCase().includes(needle);
}

export function textResult(text: string, isError: boolean) {
	return { content: [{ type: 'text' as const, text }], isError };
}
