/**
 * Concurrency Manager
 *
 * Provides a simple semaphore-like mechanism for limiting concurrent operations.
 * When the limit is reached, callers wait in a FIFO queue until a slot is released.
 */

export type ConcurrencySnapshot = {
	max: number;
	active: number;
	queued: number;
};

/**
 * Manages a fixed number of concurrency slots.
 *
 * Operations acquire a slot before proceeding and release it when done.
 * When no slots are available, callers wait in a FIFO queue.
 */
export class ConcurrencyManager {
	private readonly maxSlots: number;
	private activeSlots = 0;
	private readonly waiters: Array<() => void> = [];

	/**
	 * @param maxSlots - Maximum concurrent slots. If <= 0, no limit is enforced.
	 */
	constructor(maxSlots: number) {
		this.maxSlots = maxSlots;
	}

	getSnapshot(): ConcurrencySnapshot {
		return {
			max: this.maxSlots,
			active: this.activeSlots,
			queued: this.waiters.length,
		};
	}

	isEnabled(): boolean {
		return this.maxSlots > 0;
	}

	async acquire(): Promise<void> {
		if (this.maxSlots <= 0) return;
		if (this.activeSlots < this.maxSlots) {
			this.activeSlots += 1;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.activeSlots += 1;
	}

	release(): void {
		if (this.maxSlots <= 0) return;
		this.activeSlots = Math.max(0, this.activeSlots - 1);
		const next = this.waiters.shift();
		if (next) next();
	}

	async withSlot<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	reset(): void {
		this.activeSlots = 0;
		for (const waiter of this.waiters) {
			waiter();
		}
		this.waiters.length = 0;
	}
}

export function createConcurrencyManagerFromEnv(
	envVar: string,
	fallback = 0,
): ConcurrencyManager {
	const value = process.env[envVar];
	const limit = value ? Number.parseInt(value, 10) : fallback;
	return new ConcurrencyManager(Number.isNaN(limit) ? fallback : limit);
}
