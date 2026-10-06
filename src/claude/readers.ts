import {
	createSdkMcpServer,
	type McpSdkServerConfigWithInstance,
	tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface ReaderAnswer {
	reader: string;
	answer: string;
}

export interface Reader {
	name: string;
	description: string;
	url: string;
}

const READERS_SERVER_NAME = 'readers';
const READER_TIMEOUT_MS = 5 * 60_000;
const READERS: Reader[] = JSON.parse(process.env.READERS ?? '[]');

export function createReaderMcpServers(
	deliver: (answer: ReaderAnswer) => void,
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
					`Ask an isolated reader a question about data you can't access yourself. The reader posts its answer straight to the user, and you never see it – only whether it was delivered. Include everything the reader needs in the question. Readers:\n${readerList}`,
					{
						reader: z.enum([firstName, ...otherNames]),
						question: z.string().min(1),
					},
					({ reader, question }) => askReader(reader, question, deliver),
				),
			],
		}),
	};
}

export function findReader(name: string): Reader | undefined {
	return READERS.find((reader) => reader.name === name);
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

export function labelReaderAnswer({ reader, answer }: ReaderAnswer): string {
	return `-# 🔒 ${reader} reader · Wicek can't see this message\n${answer}`;
}

async function askReader(
	name: string,
	question: string,
	deliver: (answer: ReaderAnswer) => void,
) {
	const reader = findReader(name);
	if (!reader) return textResult(`Unknown reader ${name}`, true);

	try {
		const answer = await postToReader(reader, '/ask', { question });
		if (answer === undefined) {
			return textResult(`Reader ${name} failed with 404`, true);
		}
		deliver({ reader: name, answer });
		return textResult(
			`The ${name} reader's answer was delivered to the user. You can't see it – if you need something from it, ask the user.`,
			false,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return textResult(`Reader ${name} unreachable: ${message}`, true);
	}
}

function textResult(text: string, isError: boolean) {
	return { content: [{ type: 'text' as const, text }], isError };
}
