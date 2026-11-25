import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { allowedTools, sanitizeCall } from './tools.ts';

describe('browser tools', () => {
	it('lists only allowed tools', () => {
		const tools = ['click', 'evaluate_script', 'take_heapsnapshot', 'fill'].map(
			(name) => ({ name, inputSchema: { type: 'object' } }) as Tool,
		);
		assert.deepEqual(
			allowedTools(tools).map(({ name }) => name),
			['click', 'fill'],
		);
	});

	it('refuses calls to other tools', () => {
		for (const name of [
			'evaluate_script',
			'list_network_requests',
			'upload_file',
		]) {
			assert.equal(sanitizeCall({ name, arguments: {} }), undefined);
		}
	});

	it('drops file paths that would point into the browser pod', () => {
		assert.deepEqual(
			sanitizeCall({
				name: 'take_screenshot',
				arguments: { filePath: '/etc/x.png', fullPage: true },
			}),
			{ name: 'take_screenshot', arguments: { fullPage: true } },
		);
	});
});
