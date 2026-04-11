import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import logger from '../utils/logger.ts';

const require = createRequire(import.meta.url);

function resolveClaudeBinary(): string {
	const pkgPath = require.resolve('@anthropic-ai/claude-code/package.json');
	return pkgPath.replace('/package.json', '/cli.js');
}

export interface SpawnClaudeOptions {
	prompt: string;
	sessionId?: string;
	signal?: AbortSignal;
}

export interface ClaudeProcess {
	lines: AsyncIterable<string>;
	process: ChildProcess;
}

export function spawnClaude(options: SpawnClaudeOptions): ClaudeProcess {
	const claudeBin = resolveClaudeBinary();

	const args = [
		claudeBin,
		'-p',
		options.prompt,
		'--output-format',
		'stream-json',
		'--verbose',
		'--include-partial-messages',
		'--permission-mode',
		'auto',
		'--chrome',
	];

	if (options.sessionId) {
		args.push('--resume', options.sessionId);
	}

	logger.debug({ sessionId: options.sessionId }, 'Spawning Claude process');

	const child = spawn('node', args, {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, HOME: process.env.HOME },
		signal: options.signal,
	});

	child.stderr?.on('data', (data: Buffer) => {
		const text = data.toString().trim();
		if (text) logger.warn({ stderr: text }, 'Claude stderr');
	});

	child.on('error', (error) => {
		logger.error({ error }, 'Claude process error');
	});

	const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });

	const lines = (async function* () {
		for await (const line of rl) {
			yield line;
		}
	})();

	return { lines, process: child };
}
