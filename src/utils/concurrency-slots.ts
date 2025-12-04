/**
 * Concurrency Slot Manager
 *
 * Provides a simple semaphore-like mechanism for limiting concurrent operations.
 * When the limit is reached, callers wait in a FIFO queue until a slot is released.
 *
 * ## Use Cases
 *
 * - Limiting concurrent hook executions
 * - Controlling parallel HTTP requests
 * - Throttling background task spawning
 *
 * ## Example
 *
 * ```typescript
 * const slots = new ConcurrencySlots(3); // Max 3 concurrent
 *
 * async function doWork() {
 *   await slots.acquire();
 *   try {
 *     await expensiveOperation();
 *   } finally {
 *     slots.release();
 *   }
 * }
 *
 * // Or using the helper:
 * await slots.withSlot(async () => {
 *   await expensiveOperation();
 * });
 * ```
 *
 * @module utils/concurrency-slots
 */

/**
 * Manages a fixed number of concurrency slots.
 *
 * Operations acquire a slot before proceeding and release it when done.
 * When no slots are available, callers wait in a FIFO queue.
 */
export class ConcurrencySlots {
	private readonly maxSlots: number;
	private activeSlots = 0;
	private readonly waiters: Array<() => void> = [];

	/**
	 * Create a concurrency slot manager.
	 *
	 * @param maxSlots - Maximum concurrent slots. If <= 0, no limit is enforced.
	 */
	constructor(maxSlots: number) {
		this.maxSlots = maxSlots;
	}

	/**
	 * Get current slot utilization.
	 *
	 * @returns Snapshot of max, active, and queued counts
	 */
	getSnapshot(): { max: number; active: number; queued: number } {
		return {
			max: this.maxSlots,
			active: this.activeSlots,
			queued: this.waiters.length,
		};
	}

	/**
	 * Check if concurrency limiting is enabled.
	 *
	 * @returns true if maxSlots > 0
	 */
	isEnabled(): boolean {
		return this.maxSlots > 0;
	}

	/**
	 * Acquire a slot, waiting if necessary.
	 *
	 * If no limit is set (maxSlots <= 0), returns immediately.
	 * Otherwise, waits until a slot is available.
	 *
	 * @returns Promise that resolves when a slot is acquired
	 */
	async acquire(): Promise<void> {
		if (this.maxSlots <= 0) {
			return;
		}
		if (this.activeSlots < this.maxSlots) {
			this.activeSlots += 1;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.activeSlots += 1;
	}

	/**
	 * Release a previously acquired slot.
	 *
	 * If waiters are queued, the next one is notified.
	 * Safe to call even if no limit is set.
	 */
	release(): void {
		if (this.maxSlots <= 0) {
			return;
		}
		this.activeSlots = Math.max(0, this.activeSlots - 1);
		const next = this.waiters.shift();
		if (next) {
			next();
		}
	}

	/**
	 * Execute an async function with automatic slot management.
	 *
	 * Acquires a slot, runs the function, and releases the slot when done
	 * (even if the function throws).
	 *
	 * @param fn - Async function to execute
	 * @returns Promise resolving to the function's return value
	 */
	async withSlot<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	/**
	 * Reset all slots and clear waiters.
	 *
	 * Useful for testing or shutdown scenarios.
	 * Warning: This may leave pending acquirers stuck if not handled properly.
	 */
	reset(): void {
		this.activeSlots = 0;
		// Resolve all waiters to prevent stuck promises
		for (const waiter of this.waiters) {
			waiter();
		}
		this.waiters.length = 0;
	}
}

/**
 * Create a concurrency slot manager from an environment variable.
 *
 * @param envVar - Environment variable name containing the limit
 * @param fallback - Default limit if env var is not set or invalid (default: 0 = unlimited)
 * @returns ConcurrencySlots instance
 */
export function createConcurrencySlotsFromEnv(
	envVar: string,
	fallback = 0,
): ConcurrencySlots {
	const value = process.env[envVar];
	const limit = value ? Number.parseInt(value, 10) : fallback;
	return new ConcurrencySlots(Number.isNaN(limit) ? fallback : limit);
}
