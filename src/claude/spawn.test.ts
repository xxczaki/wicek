import assert from 'node:assert/strict';
import { accessSync, constants, existsSync } from 'node:fs';
import { test } from 'node:test';
import { resolveClaudeBinary } from './spawn.ts';

test('resolveClaudeBinary points at a file that exists', () => {
	const { command, prefixArgs } = resolveClaudeBinary();
	const binaryPath = prefixArgs.length > 0 ? prefixArgs[0] : command;

	assert.ok(binaryPath, 'binary path is set');
	assert.ok(existsSync(binaryPath), `binary not found at ${binaryPath}`);
});

test('resolved binary is executable or passed to node', () => {
	const { command, prefixArgs } = resolveClaudeBinary();

	if (command === 'node') {
		assert.ok(prefixArgs[0].endsWith('.js'), 'node gets a .js file');
	} else {
		accessSync(command, constants.X_OK);
	}
});
