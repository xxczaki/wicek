export interface ReaderRun {
	answer: string;
	sessionId: string;
}

export interface ReaderSessionsOptions {
	idleMs: number;
	maxSessions: number;
	run: (
		question: string,
		session: { resume?: string; persist: boolean },
	) => Promise<ReaderRun>;
	forget: (sessionId: string) => Promise<void>;
	now?: () => number;
}

interface ReaderSession {
	sessionId: string;
	lastUsedMs: number;
}

const STALE_SESSION_REGEX = /No conversation found with session ID/i;

export class ReaderSessions {
	#sessions = new Map<string, ReaderSession>();
	#options: ReaderSessionsOptions;

	constructor(options: ReaderSessionsOptions) {
		this.#options = options;
	}

	async answer(question: string, conversation?: string): Promise<string> {
		await this.sweep();
		if (!conversation) {
			return (await this.#options.run(question, { persist: false })).answer;
		}

		const resume = this.#sessions.get(conversation)?.sessionId;
		try {
			return (await this.#runAndRemember(question, conversation, resume))
				.answer;
		} catch (error) {
			if (!resume || !STALE_SESSION_REGEX.test(String(error))) throw error;
			this.#sessions.delete(conversation);
			return (await this.#runAndRemember(question, conversation)).answer;
		}
	}

	async sweep() {
		const now = this.#now();
		const byAge = [...this.#sessions].sort(
			([, first], [, second]) => second.lastUsedMs - first.lastUsedMs,
		);
		for (const [index, [conversation, session]] of byAge.entries()) {
			const isIdle = now - session.lastUsedMs > this.#options.idleMs;
			if (!isIdle && index < this.#options.maxSessions) continue;
			this.#sessions.delete(conversation);
			await this.#options.forget(session.sessionId).catch(() => {});
		}
	}

	async #runAndRemember(
		question: string,
		conversation: string,
		resume?: string,
	): Promise<ReaderRun> {
		try {
			const run = await this.#options.run(question, { resume, persist: true });
			this.#remember(conversation, run.sessionId);
			return run;
		} catch (error) {
			if (error instanceof ReaderRunError) {
				this.#remember(conversation, error.sessionId);
			}
			throw error;
		}
	}

	#remember(conversation: string, sessionId: string) {
		this.#sessions.set(conversation, { sessionId, lastUsedMs: this.#now() });
	}

	#now() {
		return this.#options.now?.() ?? Date.now();
	}
}

export class ReaderRunError extends Error {
	sessionId: string;

	constructor(message: string, sessionId: string) {
		super(message);
		this.sessionId = sessionId;
	}
}
