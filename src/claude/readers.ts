import {
	createSdkMcpServer,
	type HookCallbackMatcher,
	type HookEvent,
	type HookJSONOutput,
	type McpSdkServerConfigWithInstance,
	tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface ReaderAnswer {
	reader: string;
	answer: string;
	conversation?: string;
}

export interface Reader {
	name: string;
	description: string;
	url: string;
}

const READERS_SERVER_NAME = 'readers';
const ASK_READER_TOOL = `mcp__${READERS_SERVER_NAME}__ask_reader`;
const READER_TIMEOUT_MS = 5 * 60_000;
const READERS: Reader[] = JSON.parse(process.env.READERS ?? '[]');
const lastConversations = new Map<string, string>();

export const READER_HOOKS: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
	PostToolUse: [{ matcher: ASK_READER_TOOL, hooks: [endTurnAfterAnswer] }],
};

export function createReaderMcpServers(
	deliver: (answer: ReaderAnswer) => void,
	conversation?: string,
): Record<string, McpSdkServerConfigWithInstance> {
	const [firstName, ...otherNames] = READERS.map(({ name }) => name);
	if (!firstName) return {};

	const readerList = READERS.map(
		({ name, description }) => `- ${name}: ${description}`,
	).join('\n');

	return {
		[READERS_SERVER_NAME]: createSdkMcpServer({
			name: READERS_SERVER_NAME,
			tools: [
				tool(
					'ask_reader',
					`Ask an isolated reader about data you can't access yourself. The reader posts its answer straight to the user and you never see it. Your turn ends as soon as the answer is delivered, so call this last, after anything else the user asked for.

The reader remembers earlier questions and answers in this conversation. Pass the user's own words verbatim – including corrections and follow-ups – instead of paraphrasing or repeating earlier context. Add only what the reader can't know, like dates or names from earlier in the chat with you. Readers:\n${readerList}`,
					{
						reader: z.enum([firstName, ...otherNames]),
						question: z.string().min(1),
					},
					({ reader, question }) =>
						askReader(reader, question, conversation, deliver),
				),
			],
		}),
	};
}

export function findReader(name: string): Reader | undefined {
	return READERS.find((reader) => reader.name === name);
}

export function lastConversationFor(name: string): string | undefined {
	return lastConversations.get(name);
}

export async function postToReader(
	reader: Reader,
	path: '/ask' | '/callback',
	body: unknown,
): Promise<string | undefined> {
	const response = await fetch(new URL(path, reader.url), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(READER_TIMEOUT_MS),
	});
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`failed with ${response.status}`);
	const { answer } = (await response.json()) as { answer: string };
	return answer;
}

async function askReader(
	name: string,
	question: string,
	conversation: string | undefined,
	deliver: (answer: ReaderAnswer) => void,
) {
	const reader = findReader(name);
	if (!reader) return textResult(`Unknown reader ${name}`, true);
	if (conversation) lastConversations.set(name, conversation);

	try {
		const answer = await postToReader(reader, '/ask', {
			question,
			conversation,
		});
		if (answer === undefined) {
			return textResult(`Reader ${name} failed with 404`, true);
		}
		deliver({ reader: name, answer });
		return textResult(
			`The ${name} reader's answer is shown to the user. You can't see it, and your turn is over.`,
			false,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return textResult(`Reader ${name} unreachable: ${message}`, true);
	}
}

// Failed calls go to PostToolUseFailure, so this only runs once the answer
// was delivered
async function endTurnAfterAnswer(): Promise<HookJSONOutput> {
	return { continue: false, stopReason: 'The reader answered the user' };
}

function textResult(text: string, isError: boolean) {
	return { content: [{ type: 'text' as const, text }], isError };
}
