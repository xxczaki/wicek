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

interface Reader {
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
					`Ask an isolated reader a question about data you can't access yourself. The reader posts its answer straight to the user, and you never see it – only whether it was delivered. Include everything the reader needs in the question, e.g. a code the user pasted. Readers:\n${readerList}`,
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

async function askReader(
	name: string,
	question: string,
	deliver: (answer: ReaderAnswer) => void,
) {
	const reader = READERS.find((candidate) => candidate.name === name);
	if (!reader) return textResult(`Unknown reader ${name}`, true);

	try {
		const response = await fetch(new URL('/ask', reader.url), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ question }),
			signal: AbortSignal.timeout(READER_TIMEOUT_MS),
		});
		if (!response.ok) {
			return textResult(`Reader ${name} failed with ${response.status}`, true);
		}
		const { answer } = (await response.json()) as { answer: string };
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
