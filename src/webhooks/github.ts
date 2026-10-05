import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';
const RENOVATE_BRANCH_PREFIX = 'renovate/';

interface PullRequestRef {
	number: number;
}

interface CheckSuite {
	conclusion: string | null;
	head_branch: string | null;
	head_sha: string;
	pull_requests?: PullRequestRef[];
}

export interface GithubPayload {
	action?: string;
	repository?: { full_name: string; default_branch: string };
	workflow_run?: CheckSuite & { name: string; html_url: string };
	check_suite?: CheckSuite;
	check_run?: {
		name: string;
		conclusion: string | null;
		html_url: string;
		check_suite: CheckSuite;
	};
}

export interface GithubFailure {
	key: string;
	line: string;
}

export function verifyGithubSignature(
	secret: string,
	body: Buffer,
	signature: string | undefined,
): boolean {
	if (!signature?.startsWith(SIGNATURE_PREFIX)) return false;
	const expected = createHmac('sha256', secret).update(body).digest();
	const received = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'hex');
	return (
		received.length === expected.length && timingSafeEqual(received, expected)
	);
}

export function parseGithubFailure(
	event: string | undefined,
	payload: GithubPayload,
): GithubFailure | undefined {
	const repository = payload.repository;
	if (payload.action !== 'completed' || !repository) return undefined;
	const repo = repository.full_name;

	if (event === 'workflow_run' && payload.workflow_run) {
		const run = payload.workflow_run;
		const branch = run.head_branch ?? '';
		const watched =
			branch === repository.default_branch || isRenovateBranch(branch);
		if (run.conclusion !== 'failure' || !watched) return undefined;
		return {
			key: `${repo}@${run.head_sha}`,
			line: `${repo} – workflow "${run.name}" failed on \`${branch}\`${describePullRequests(repo, run.pull_requests)}: ${run.html_url}`,
		};
	}

	const suite =
		event === 'check_suite'
			? payload.check_suite
			: event === 'check_run'
				? payload.check_run?.check_suite
				: undefined;
	const conclusion =
		event === 'check_run'
			? payload.check_run?.conclusion
			: payload.check_suite?.conclusion;
	if (!suite || conclusion !== 'failure') return undefined;
	if (!isRenovateBranch(suite.head_branch ?? '')) return undefined;

	const check =
		event === 'check_run' && payload.check_run
			? `check "${payload.check_run.name}" failed: ${payload.check_run.html_url}`
			: 'check suite failed';
	return {
		key: `${repo}@${suite.head_sha}`,
		line: `${repo} – Renovate branch \`${suite.head_branch}\`${describePullRequests(repo, suite.pull_requests)} ${check}`,
	};
}

export function buildGithubPrompt(lines: string[]): string {
	return [
		'Use the repo-maintenance subagent to handle these CI failures reported by GitHub webhooks:',
		...lines.map((line) => `- ${line}`),
		'',
		'Scope the work to exactly these repos and runs/PRs – this is not a full sweep. For each one, read the failed logs (`gh run view --log-failed`), diagnose, and fix only safe, well-understood cases via a PR (or a follow-up commit on the Renovate PR branch). Never merge, never force-push, never push to main.',
		'If a failure is clearly transient (runner or network flake), re-run the failed jobs once instead of changing code. If a fix you pushed earlier on the same branch already failed, report it for review instead of trying again.',
		'End with one Discord-formatted line per item: ✅ already green, 🔧 fixed (PR link), 🔁 re-run, or ⚠️ needs review (what is wrong).',
	].join('\n');
}

function isRenovateBranch(branch: string): boolean {
	return branch.startsWith(RENOVATE_BRANCH_PREFIX);
}

function describePullRequests(
	repo: string,
	pullRequests: PullRequestRef[] | undefined,
): string {
	if (!pullRequests?.length) return '';
	const links = pullRequests.map(
		({ number }) => `https://github.com/${repo}/pull/${number}`,
	);
	return ` (PR ${links.join(', ')})`;
}
