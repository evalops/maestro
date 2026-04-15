import { setTimeout as sleep } from "node:timers/promises";

export interface RequestSchedulerOptions {
	serialize?: boolean;
	minMutationDelayMs?: number;
}

export interface ScheduleOptions {
	mutating: boolean;
}

export class RequestScheduler {
	private queue: Promise<void> = Promise.resolve();
	private mutationQueue: Promise<void> = Promise.resolve();
	private lastMutationAt = 0;
	private readonly serialize: boolean;
	private readonly minMutationDelayMs: number;

	constructor(options: RequestSchedulerOptions = {}) {
		this.serialize = options.serialize ?? true;
		this.minMutationDelayMs = options.minMutationDelayMs ?? 1000;
	}

	schedule<T>(fn: () => Promise<T>, options: ScheduleOptions): Promise<T> {
		if (this.serialize) {
			return this.enqueue(this.queue, fn, options.mutating, (next) => {
				this.queue = next;
			});
		}

		if (options.mutating) {
			return this.enqueue(this.mutationQueue, fn, true, (next) => {
				this.mutationQueue = next;
			});
		}

		return fn();
	}

	private enqueue<T>(
		queue: Promise<void>,
		fn: () => Promise<T>,
		mutating: boolean,
		setQueue: (next: Promise<void>) => void,
	): Promise<T> {
		const run = async () => {
			if (mutating) {
				await this.waitForMutationSlot();
			}
			return fn();
		};
		const chained = queue.then(run, run);
		setQueue(
			chained.then(
				() => undefined,
				() => undefined,
			),
		);
		return chained;
	}

	private async waitForMutationSlot(): Promise<void> {
		const now = Date.now();
		const wait = Math.max(
			0,
			this.lastMutationAt + this.minMutationDelayMs - now,
		);
		if (wait > 0) {
			await sleep(wait);
		}
		this.lastMutationAt = Date.now();
	}
}
