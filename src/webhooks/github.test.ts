import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
	type GithubPayload,
	parseGithubFailure,
	verifyGithubSignature,
} from './github.ts';

const SECRET = 'test-secret';
const repository = { full_name: 'xxczaki/wicek', default_branch: 'main' };

function sign(body: Buffer, secret = SECRET) {
	return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function workflowRun(
	headBranch: string,
	conclusion: string,
	action = 'completed',
): GithubPayload {
	return {
		action,
		repository,
		workflow_run: {
			name: 'CI',
			html_url: 'https://github.com/xxczaki/wicek/actions/runs/1',
			conclusion,
			head_branch: headBranch,
			head_sha: 'abc123',
			pull_requests: [],
		},
	};
}

function checkSuite(headBranch: string | null, conclusion: string) {
	return {
		action: 'completed',
		repository,
		check_suite: {
			conclusion,
			head_branch: headBranch,
			head_sha: 'def456',
			pull_requests: [{ number: 42 }],
		},
	};
}

test('accepts a valid signature', () => {
	const body = Buffer.from('{"zen":"Keep it logically awesome."}');
	assert.equal(verifyGithubSignature(SECRET, body, sign(body)), true);
});

test('rejects a missing, malformed, or wrong signature', () => {
	const body = Buffer.from('{"action":"completed"}');
	assert.equal(verifyGithubSignature(SECRET, body, undefined), false);
	assert.equal(verifyGithubSignature(SECRET, body, 'sha1=abc'), false);
	assert.equal(verifyGithubSignature(SECRET, body, 'sha256=abc'), false);
	assert.equal(verifyGithubSignature(SECRET, body, sign(body, 'other')), false);
	assert.equal(
		verifyGithubSignature(SECRET, Buffer.from('{}'), sign(body)),
		false,
	);
});

test('acts on failed workflow runs on the default branch', () => {
	const failure = parseGithubFailure(
		'workflow_run',
		workflowRun('main', 'failure'),
	);
	assert.equal(failure?.key, 'xxczaki/wicek@abc123');
	assert.match(failure?.line ?? '', /workflow "CI" failed on `main`/);
	assert.match(failure?.line ?? '', /actions\/runs\/1/);
});

test('acts on failed workflow runs on Renovate branches', () => {
	const failure = parseGithubFailure(
		'workflow_run',
		workflowRun('renovate/pnpm-12.x', 'failure'),
	);
	assert.ok(failure);
});

test('ignores successful, in-progress, and unrelated-branch workflow runs', () => {
	for (const payload of [
		workflowRun('main', 'success'),
		workflowRun('main', 'cancelled'),
		workflowRun('main', 'failure', 'requested'),
		workflowRun('feat/webhooks', 'failure'),
		workflowRun('maintenance/fix-lockfile', 'failure'),
	]) {
		assert.equal(parseGithubFailure('workflow_run', payload), undefined);
	}
});

test('acts on failing check suites on Renovate PRs only', () => {
	const failure = parseGithubFailure(
		'check_suite',
		checkSuite('renovate/node-24.x', 'failure'),
	);
	assert.equal(failure?.key, 'xxczaki/wicek@def456');
	assert.match(failure?.line ?? '', /pull\/42/);

	assert.equal(
		parseGithubFailure('check_suite', checkSuite('main', 'failure')),
		undefined,
	);
	assert.equal(
		parseGithubFailure('check_suite', checkSuite(null, 'failure')),
		undefined,
	);
	assert.equal(
		parseGithubFailure(
			'check_suite',
			checkSuite('renovate/node-24.x', 'success'),
		),
		undefined,
	);
});

test('acts on failing check runs on Renovate PRs', () => {
	const { check_suite: suite, ...rest } = checkSuite(
		'renovate/node-24.x',
		'neutral',
	);
	const failure = parseGithubFailure('check_run', {
		...rest,
		check_run: {
			name: 'lint',
			conclusion: 'failure',
			html_url: 'https://github.com/xxczaki/wicek/runs/9',
			check_suite: suite,
		},
	});
	assert.match(failure?.line ?? '', /check "lint" failed/);
	assert.equal(failure?.key, 'xxczaki/wicek@def456');
});

test('ignores other events', () => {
	assert.equal(parseGithubFailure('ping', { repository }), undefined);
	assert.equal(
		parseGithubFailure('push', workflowRun('main', 'failure')),
		undefined,
	);
});
