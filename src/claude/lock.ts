let held = false;
const waiters: Array<() => void> = [];

export function tryAcquireAgent(): boolean {
	if (held) return false;
	held = true;
	return true;
}

export function acquireAgent(): Promise<void> {
	if (tryAcquireAgent()) return Promise.resolve();
	return new Promise((resolve) => waiters.push(resolve));
}

export function releaseAgent() {
	const next = waiters.shift();
	if (next) {
		next();
	} else {
		held = false;
	}
}
