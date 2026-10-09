import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export class AgentInbox {
	#pending: string[] = [];
	#deliveredCount = 0;
	#isClosed = false;
	#wake: (() => void) | null = null;

	get hasPending() {
		return this.#pending.length > 0;
	}

	push(text: string): boolean {
		if (this.#isClosed) return false;
		this.#pending.push(text);
		this.#notify();
		return true;
	}

	close() {
		this.#isClosed = true;
		this.#notify();
	}

	takePending(): string[] {
		return this.#pending.splice(0);
	}

	takeDeliveredCount(): number {
		const count = this.#deliveredCount;
		this.#deliveredCount = 0;
		return count;
	}

	async *messages(initialPrompt: string): AsyncGenerator<SDKUserMessage> {
		yield toUserMessage(initialPrompt);

		while (true) {
			const text = this.#pending.shift();
			if (text !== undefined) {
				this.#deliveredCount++;
				yield toUserMessage(text, 'next');
				continue;
			}
			if (this.#isClosed) return;
			await new Promise<void>((resolve) => {
				this.#wake = resolve;
			});
		}
	}

	#notify() {
		const wake = this.#wake;
		this.#wake = null;
		wake?.();
	}
}

function toUserMessage(
	text: string,
	priority?: SDKUserMessage['priority'],
): SDKUserMessage {
	return {
		type: 'user',
		message: { role: 'user', content: text },
		parent_tool_use_id: null,
		...(priority && { priority }),
	};
}
