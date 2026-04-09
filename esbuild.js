import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const esbuildPluginPino = require('esbuild-plugin-pino');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
	entryPoints: ['src/index.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node24',
	external: [
		'discord.js',
		'@anthropic-ai/claude-code',
		'pino',
		'node-cron',
	],
	plugins: [esbuildPluginPino({ transports: [] })],
	outdir: 'dist',
	minify: true,
	sourcemap: true,
};

await esbuild.build(buildOptions);
