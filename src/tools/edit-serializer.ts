/**
 * Edit Serializer
 *
 * Prevents race conditions when multiple file edits are requested in parallel.
 * Ensures edits to the same file are applied sequentially to avoid conflicts.
 *
 * ## Problem Solved
 *
 * When an agent requests multiple file edits in parallel:
 * 1. Edit A to file.ts: Replace line 10
 * 2. Edit B to file.ts: Replace line 20
 *
 * Without serialization, both edits read the original file simultaneously,
 * and the second write overwrites the first edit.
 *
 * ## Solution
 *
 * - Per-file locks that serialize edits to the same file
 * - Edits to different files proceed in parallel
 * - Timeout handling to prevent deadlocks
 *
 * ## Usage
 *
 * ```typescript
 * import { editSerializer } from "./edit-serializer.js";
 *
 * // Wrap edit operations
 * await editSerializer.withLock(filepath, async () => {
 *   const content = await readFile(filepath);
 *   const modified = applyEdit(content, edit);
 *   await writeFile(filepath, modified);
 * });
 * ```
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("tools:edit-serializer");

/**
 * Lock state for a file
 */
interface FileLock {
	/** Whether the lock is currently held */
	locked: boolean;
	/** Queue of waiters */
	queue: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
		timeoutId: ReturnType<typeof setTimeout>;
	}>;
	/** Last edit timestamp */
	lastEdit: number;
	/** Number of edits processed */
	editCount: number;
}

/**
 * Edit serializer configuration
 */
interface SerializerConfig {
	/** Lock timeout in ms (default: 30000) */
	lockTimeoutMs: number;
	/** Maximum queue length per file (default: 10) */
	maxQueueLength: number;
	/** Cleanup interval for stale locks (default: 60000) */
	cleanupIntervalMs: number;
}

const DEFAULT_CONFIG: SerializerConfig = {
	lockTimeoutMs: 30000,
	maxQueueLength: 10,
	cleanupIntervalMs: 60000,
};

/**
 * Edit serializer for preventing race conditions
 */
export class EditSerializer {
	private locks = new Map<string, FileLock>();
	private config: SerializerConfig = DEFAULT_CONFIG;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config?: Partial<SerializerConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.startCleanup();
	}

	/**
	 * Execute a function with an exclusive lock on a file
	 */
	async withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
		await this.acquireLock(filepath);
		try {
			const result = await fn();
			this.updateStats(filepath);
			return result;
		} finally {
			this.releaseLock(filepath);
		}
	}

	/**
	 * Acquire a lock for a file
	 */
	private async acquireLock(filepath: string): Promise<void> {
		let lock = this.locks.get(filepath);

		if (!lock) {
			lock = {
				locked: false,
				queue: [],
				lastEdit: 0,
				editCount: 0,
			};
			this.locks.set(filepath, lock);
		}

		// If not locked, acquire immediately
		if (!lock.locked) {
			lock.locked = true;
			logger.debug("Lock acquired immediately", { filepath });
			return;
		}

		// Check queue length
		if (lock.queue.length >= this.config.maxQueueLength) {
			throw new Error(
				`Edit queue full for ${filepath}. Max ${this.config.maxQueueLength} pending edits.`,
			);
		}

		// Wait in queue
		return new Promise<void>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				// Remove from queue on timeout
				const idx = lock!.queue.findIndex((w) => w.resolve === resolve);
				if (idx >= 0) {
					lock!.queue.splice(idx, 1);
				}
				reject(
					new Error(
						`Lock timeout for ${filepath} after ${this.config.lockTimeoutMs}ms`,
					),
				);
			}, this.config.lockTimeoutMs);

			lock!.queue.push({ resolve, reject, timeoutId });

			logger.debug("Waiting for lock", {
				filepath,
				queuePosition: lock!.queue.length,
			});
		});
	}

	/**
	 * Release a lock for a file
	 */
	private releaseLock(filepath: string): void {
		const lock = this.locks.get(filepath);
		if (!lock) return;

		// If queue is empty, just unlock
		if (lock.queue.length === 0) {
			lock.locked = false;
			logger.debug("Lock released, no waiters", { filepath });
			return;
		}

		// Pass lock to next waiter
		const next = lock.queue.shift()!;
		clearTimeout(next.timeoutId);

		logger.debug("Lock passed to next waiter", {
			filepath,
			remainingQueue: lock.queue.length,
		});

		// Resolve the next waiter (they now hold the lock)
		next.resolve();
	}

	/**
	 * Update statistics for a file
	 */
	private updateStats(filepath: string): void {
		const lock = this.locks.get(filepath);
		if (lock) {
			lock.lastEdit = Date.now();
			lock.editCount++;
		}
	}

	/**
	 * Check if a file is currently locked
	 */
	isLocked(filepath: string): boolean {
		const lock = this.locks.get(filepath);
		return lock?.locked ?? false;
	}

	/**
	 * Get queue length for a file
	 */
	getQueueLength(filepath: string): number {
		const lock = this.locks.get(filepath);
		return lock?.queue.length ?? 0;
	}

	/**
	 * Start periodic cleanup of stale locks
	 */
	private startCleanup(): void {
		if (this.cleanupTimer) return;

		this.cleanupTimer = setInterval(() => {
			this.cleanupStaleLocks();
		}, this.config.cleanupIntervalMs);
	}

	/**
	 * Stop periodic cleanup
	 */
	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	/**
	 * Clean up stale locks (no activity for 5+ minutes)
	 */
	private cleanupStaleLocks(): void {
		const staleThreshold = Date.now() - 5 * 60 * 1000;
		let cleaned = 0;

		for (const [filepath, lock] of Array.from(this.locks.entries())) {
			if (
				!lock.locked &&
				lock.queue.length === 0 &&
				lock.lastEdit < staleThreshold
			) {
				this.locks.delete(filepath);
				cleaned++;
			}
		}

		if (cleaned > 0) {
			logger.debug("Cleaned up stale locks", { cleaned });
		}
	}

	/**
	 * Get serializer statistics
	 */
	getStats(): {
		activeLocks: number;
		totalEdits: number;
		filesTracked: number;
		lockedFiles: string[];
	} {
		let activeLocks = 0;
		let totalEdits = 0;
		const lockedFiles: string[] = [];

		for (const [filepath, lock] of Array.from(this.locks.entries())) {
			totalEdits += lock.editCount;
			if (lock.locked) {
				activeLocks++;
				lockedFiles.push(filepath);
			}
		}

		return {
			activeLocks,
			totalEdits,
			filesTracked: this.locks.size,
			lockedFiles,
		};
	}

	/**
	 * Force release all locks (use with caution)
	 */
	forceReleaseAll(): void {
		for (const [, lock] of Array.from(this.locks.entries())) {
			// Reject all waiters
			for (const waiter of lock.queue) {
				clearTimeout(waiter.timeoutId);
				waiter.reject(new Error("Lock force released"));
			}
			lock.queue = [];
			lock.locked = false;
		}

		logger.warn("All locks force released");
	}

	/**
	 * Reset the serializer
	 */
	reset(): void {
		this.forceReleaseAll();
		this.locks.clear();
		logger.info("Edit serializer reset");
	}
}

/**
 * Global edit serializer instance
 */
export const editSerializer = new EditSerializer();

/**
 * Decorator for serialized file operations
 */
export function serialized(filepath: string) {
	return <T>(
		_target: unknown,
		_propertyKey: string,
		descriptor: TypedPropertyDescriptor<(...args: unknown[]) => Promise<T>>,
	): TypedPropertyDescriptor<(...args: unknown[]) => Promise<T>> => {
		const originalMethod = descriptor.value!;

		descriptor.value = async function (...args: unknown[]): Promise<T> {
			return editSerializer.withLock(filepath, () =>
				originalMethod.apply(this, args),
			);
		};

		return descriptor;
	};
}

/**
 * Batch multiple edits to the same file
 */
export async function batchEdits<T>(
	filepath: string,
	edits: Array<() => Promise<T>>,
): Promise<T[]> {
	return editSerializer.withLock(filepath, async () => {
		const results: T[] = [];
		for (const edit of edits) {
			results.push(await edit());
		}
		return results;
	});
}
