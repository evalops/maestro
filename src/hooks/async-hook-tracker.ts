import type { HookEventType } from "./types.js";

export interface AsyncHookProcess {
	processId: string;
	hookEvent: HookEventType;
	hookName: string;
	command: string;
	startedAt: number;
}

export class AsyncHookTracker {
	private readonly processes = new Map<string, AsyncHookProcess>();
	private readonly now: () => number;
	private readonly maxAgeMs: number;

	constructor(options?: { now?: () => number; maxAgeMs?: number }) {
		this.now = options?.now ?? Date.now;
		this.maxAgeMs = options?.maxAgeMs ?? 10 * 60 * 1000;
	}

	getCount(): number {
		return this.processes.size;
	}

	track(process: Omit<AsyncHookProcess, "startedAt">): void {
		this.processes.set(process.processId, {
			...process,
			startedAt: this.now(),
		});
	}

	markCompleted(processId: string): boolean {
		return this.processes.delete(processId);
	}

	cleanup(): { removed: number; remaining: number; maxAgeMs: number } {
		const now = this.now();
		let removed = 0;

		for (const [id, proc] of this.processes) {
			if (now - proc.startedAt > this.maxAgeMs) {
				this.processes.delete(id);
				removed += 1;
			}
		}

		return {
			removed,
			remaining: this.processes.size,
			maxAgeMs: this.maxAgeMs,
		};
	}
}
