export type BatchFlush = (topic: string, lines: string[]) => void;

export class WebhookBatcher {
	#pending = new Map<string, Map<string, string>>();
	#seenAtMs = new Map<string, number>();
	#flush: BatchFlush;
	#windowMs: number;
	#dedupeMs: number;

	constructor(flush: BatchFlush, windowMs: number, dedupeMs: number) {
		this.#flush = flush;
		this.#windowMs = windowMs;
		this.#dedupeMs = dedupeMs;
	}

	add(topic: string, key: string, line: string): boolean {
		this.#prune();
		if (this.#seenAtMs.has(key)) return false;
		this.#seenAtMs.set(key, Date.now());

		const batch = this.#pending.get(topic);
		if (batch) {
			batch.set(key, line);
			return true;
		}

		this.#pending.set(topic, new Map([[key, line]]));
		setTimeout(() => {
			const lines = [...(this.#pending.get(topic)?.values() ?? [])];
			this.#pending.delete(topic);
			if (lines.length > 0) this.#flush(topic, lines);
		}, this.#windowMs).unref();
		return true;
	}

	forget(key: string): 'pending' | 'handled' | undefined {
		if (!this.#seenAtMs.delete(key)) return undefined;
		for (const batch of this.#pending.values()) {
			if (batch.delete(key)) return 'pending';
		}
		return 'handled';
	}

	#prune() {
		const cutoffMs = Date.now() - this.#dedupeMs;
		for (const [key, seenAtMs] of this.#seenAtMs) {
			if (seenAtMs < cutoffMs) this.#seenAtMs.delete(key);
		}
	}
}
