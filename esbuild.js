import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const esbuildPluginPino = require('esbuild-plugin-pino');

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node24',
	plugins: [esbuildPluginPino({ transports: [] })],
	minify: true,
	sourcemap: true,
};

await Promise.all([
	esbuild.build({
		...sharedOptions,
		entryPoints: ['src/index.ts'],
		external: [
			'discord.js',
			'@anthropic-ai/claude-agent-sdk',
			'pino',
			'node-cron',
		],
		outdir: 'dist',
	}),
	esbuild.build({
		...sharedOptions,
		entryPoints: { broker: 'src/broker/index.ts' },
		format: 'cjs',
		outExtension: { '.js': '.cjs' },
		outdir: 'dist/broker',
	}),
]);
