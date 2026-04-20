import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import logger from '../utils/logger.ts';

const require = createRequire(import.meta.url);

export function resolveClaudeBinary(): {
	command: string;
	prefixArgs: string[];
} {
	const pkgPath = require.resolve('@anthropic-ai/claude-code/package.json');
	const pkg = require('@anthropic-ai/claude-code/package.json') as {
		bin?: string | Record<string, string>;
	};
	const binField =
		typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude || 'cli.js';
	const binPath = join(dirname(pkgPath), binField);

	if (binPath.endsWith('.js')) {
		return { command: 'node', prefixArgs: [binPath] };
	}
	return { command: binPath, prefixArgs: [] };
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
	const { command, prefixArgs } = resolveClaudeBinary();

	const args = [
		...prefixArgs,
		'-p',
		options.prompt,
		'--output-format',
		'stream-json',
		'--verbose',
		'--include-partial-messages',
		'--permission-mode',
		'auto',
	];

	if (options.sessionId) {
		args.push('--resume', options.sessionId);
	}

	logger.debug({ sessionId: options.sessionId }, 'Spawning Claude process');

	const child = spawn(command, args, {
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
