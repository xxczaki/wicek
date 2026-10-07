import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import logger from '../utils/logger.ts';

export type BatchFlush = (topic: string, lines: string[]) => void;

export type AddResult = 'queued' | 'remind' | 'duplicate';

export interface WebhookBatcherOptions {
	flush: BatchFlush;
	windowMs: number;
	forgetAfterMs: number;
	remindAfterMs: number;
	statePath?: string;
}

interface SeenEntry {
	seenAtMs: number;
	notifiedAtMs: number;
}

export class WebhookBatcher {
	#pending = new Map<string, Map<string, string>>();
	#seen: Map<string, SeenEntry>;
	#options: WebhookBatcherOptions;

	constructor(options: WebhookBatcherOptions) {
		this.#options = options;
		this.#seen = loadSeen(options.statePath);
	}

	add(topic: string, key: string, line: string): AddResult {
		this.#prune();
		const nowMs = Date.now();

		const seen = this.#seen.get(key);
		if (seen) {
			seen.seenAtMs = nowMs;
			const isReminderDue =
				nowMs - seen.notifiedAtMs >= this.#options.remindAfterMs;
			if (isReminderDue) seen.notifiedAtMs = nowMs;
			this.#save();
			return isReminderDue ? 'remind' : 'duplicate';
		}
		this.#seen.set(key, { seenAtMs: nowMs, notifiedAtMs: nowMs });

		const batch = this.#pending.get(topic);
		if (batch) {
			batch.set(key, line);
			return 'queued';
		}

		this.#pending.set(topic, new Map([[key, line]]));
		setTimeout(() => {
			const lines = [...(this.#pending.get(topic)?.values() ?? [])];
			this.#pending.delete(topic);
			this.#save();
			if (lines.length > 0) this.#options.flush(topic, lines);
		}, this.#options.windowMs).unref();
		return 'queued';
	}

	forget(key: string): 'pending' | 'handled' | undefined {
		if (!this.#seen.delete(key)) return undefined;
		for (const batch of this.#pending.values()) {
			if (batch.delete(key)) return 'pending';
		}
		this.#save();
		return 'handled';
	}

	#prune() {
		const cutoffMs = Date.now() - this.#options.forgetAfterMs;
		for (const [key, entry] of this.#seen) {
			if (entry.seenAtMs < cutoffMs) this.#seen.delete(key);
		}
	}

	#save() {
		const { statePath } = this.#options;
		if (!statePath) return;

		const handled = Object.fromEntries(
			[...this.#seen].filter(([key]) => !this.#isPending(key)),
		);
		const temporaryPath = `${statePath}.tmp`;
		try {
			writeFileSync(temporaryPath, JSON.stringify(handled));
			renameSync(temporaryPath, statePath);
		} catch (error) {
			logger.error({ error }, 'Failed to save webhook dedupe state');
		}
	}

	#isPending(key: string): boolean {
		for (const batch of this.#pending.values()) {
			if (batch.has(key)) return true;
		}
		return false;
	}
}

function loadSeen(statePath: string | undefined): Map<string, SeenEntry> {
	if (!statePath) return new Map();
	try {
		const entries = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<
			string,
			SeenEntry
		>;
		return new Map(Object.entries(entries));
	} catch {
		return new Map();
	}
}
