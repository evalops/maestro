export interface QueuedPrompt {
	id: number;
	text: string;
	createdAt: number;
}

export type PromptQueueEvent =
	| {
			type: "enqueue";
			entry: QueuedPrompt;
			willRunImmediately: boolean;
			pendingCount: number;
	  }
	| { type: "start"; entry: QueuedPrompt }
	| { type: "finish"; entry: QueuedPrompt }
	| { type: "cancel"; entry: QueuedPrompt }
	| { type: "error"; entry: QueuedPrompt; error: unknown };

export interface PromptQueueSnapshot {
	active?: QueuedPrompt;
	pending: QueuedPrompt[];
}

export class PromptQueue {
	private pending: QueuedPrompt[] = [];
	private active: QueuedPrompt | null = null;
	private nextId = 1;
	private listeners = new Set<(event: PromptQueueEvent) => void>();

	constructor(
		private readonly runner: (text: string) => Promise<void>,
		private readonly onRunnerError?: (error: unknown) => void,
	) {}

	enqueue(text: string): QueuedPrompt {
		const entry: QueuedPrompt = {
			id: this.nextId++,
			text,
			createdAt: Date.now(),
		};
		const willRunImmediately = !this.active && this.pending.length === 0;
		this.pending.push(entry);
		this.emit({
			type: "enqueue",
			entry,
			willRunImmediately,
			pendingCount: this.pending.length,
		});
		void this.process();
		return entry;
	}

	cancel(id: number): QueuedPrompt | null {
		const index = this.pending.findIndex((entry) => entry.id === id);
		if (index === -1) {
			return null;
		}
		const [entry] = this.pending.splice(index, 1);
		this.emit({ type: "cancel", entry });
		return entry;
	}

	/**
	 * Cancel all pending prompts in the queue.
	 * @param options.silent - When true, suppresses cancel event emissions.
	 *                        Useful for internal state cleanup (e.g., interrupt restore)
	 *                        where external notifications are not needed.
	 * @returns Array of cancelled prompt entries
	 */
	cancelAll(options?: { silent?: boolean }): QueuedPrompt[] {
		const cancelled = [...this.pending];
		this.pending = [];
		if (!options?.silent) {
			for (const entry of cancelled) {
				this.emit({ type: "cancel", entry });
			}
		}
		return cancelled;
	}

	getSnapshot(): PromptQueueSnapshot {
		return {
			active: this.active ?? undefined,
			pending: [...this.pending],
		};
	}

	/**
	 * Clears the currently active prompt without emitting events.
	 * Note: This method does not emit events by design.
	 */
	clearActive(): void {
		this.active = null;
	}

	subscribe(listener: (event: PromptQueueEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private async process(): Promise<void> {
		if (this.active || this.pending.length === 0) {
			return;
		}
		const next = this.pending.shift();
		if (!next) {
			return;
		}
		this.active = next;
		this.emit({ type: "start", entry: next });
		try {
			await this.runner(next.text);
			this.emit({ type: "finish", entry: next });
		} catch (error) {
			if (this.onRunnerError) {
				this.onRunnerError(error);
			}
			this.emit({ type: "error", entry: next, error });
		} finally {
			this.active = null;
			await this.process();
		}
	}

	private emit(event: PromptQueueEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}
