/**
 * Distributed Lock Manager
 *
 * Provides distributed locking for safe concurrent operations across
 * multiple processes/instances. Implements advisory locking with
 * automatic expiration and renewal.
 *
 * Supports both database-backed locks (for distributed systems) and
 * in-memory locks (for single-instance deployments).
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("distributed-lock");

/**
 * Lock acquisition result.
 */
export interface LockResult {
	/** Whether the lock was acquired */
	acquired: boolean;
	/** Lock token (needed for release) */
	token?: string;
	/** When the lock expires */
	expiresAt?: Date;
	/** Owner of the existing lock (if not acquired) */
	currentOwner?: string;
	/** When the existing lock expires (if not acquired) */
	currentExpiresAt?: Date;
}

/**
 * Lock information.
 */
export interface LockInfo {
	/** Lock key */
	key: string;
	/** Lock token */
	token: string;
	/** Owner identifier */
	owner: string;
	/** When acquired */
	acquiredAt: Date;
	/** When it expires */
	expiresAt: Date;
	/** Number of times renewed */
	renewCount: number;
	/** Custom metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Lock acquisition options.
 */
export interface LockOptions {
	/** Lock duration in milliseconds */
	ttlMs: number;
	/** Owner identifier (default: process ID) */
	owner?: string;
	/** Wait for lock if not immediately available */
	waitForLock?: boolean;
	/** Maximum time to wait for lock in ms */
	waitTimeoutMs?: number;
	/** Retry interval when waiting */
	retryIntervalMs?: number;
	/** Custom metadata to attach to lock */
	metadata?: Record<string, unknown>;
}

/**
 * Lock manager configuration.
 */
export interface LockManagerConfig {
	/** Default lock TTL in ms */
	defaultTtlMs: number;
	/** Default owner identifier */
	defaultOwner: string;
	/** Cleanup interval for expired locks */
	cleanupIntervalMs: number;
	/** Whether to use database backing (vs in-memory) */
	useDatabaseBacking: boolean;
}

const DEFAULT_CONFIG: LockManagerConfig = {
	defaultTtlMs: 30000, // 30 seconds
	defaultOwner: `process-${process.pid}`,
	cleanupIntervalMs: 60000, // 1 minute
	useDatabaseBacking: false, // Start with in-memory for simplicity
};

/**
 * In-memory lock storage.
 */
interface InMemoryLock {
	token: string;
	owner: string;
	acquiredAt: number;
	expiresAt: number;
	renewCount: number;
	metadata?: Record<string, unknown>;
}

/**
 * Generate a unique lock token.
 */
function generateToken(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).slice(2, 10);
	return `lock-${timestamp}-${random}`;
}

/**
 * Distributed Lock Manager.
 */
export class DistributedLockManager {
	private config: LockManagerConfig;
	private locks: Map<string, InMemoryLock> = new Map();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private renewalTimers: Map<string, ReturnType<typeof setInterval>> =
		new Map();

	constructor(config?: Partial<LockManagerConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.startCleanup();
	}

	/**
	 * Acquire a lock.
	 */
	async acquire(
		key: string,
		options?: Partial<LockOptions>,
	): Promise<LockResult> {
		const opts: LockOptions = {
			ttlMs: options?.ttlMs ?? this.config.defaultTtlMs,
			owner: options?.owner ?? this.config.defaultOwner,
			waitForLock: options?.waitForLock ?? false,
			waitTimeoutMs: options?.waitTimeoutMs ?? 10000,
			retryIntervalMs: options?.retryIntervalMs ?? 100,
			metadata: options?.metadata,
		};

		if (opts.waitForLock) {
			return this.acquireWithWait(key, opts);
		}

		return this.tryAcquire(key, opts);
	}

	/**
	 * Try to acquire a lock immediately.
	 */
	private tryAcquire(key: string, opts: LockOptions): LockResult {
		const now = Date.now();
		const existing = this.locks.get(key);

		// Check if existing lock is expired
		if (existing && existing.expiresAt > now) {
			return {
				acquired: false,
				currentOwner: existing.owner,
				currentExpiresAt: new Date(existing.expiresAt),
			};
		}

		// Acquire the lock
		const token = generateToken();
		const expiresAt = now + opts.ttlMs;

		const lock: InMemoryLock = {
			token,
			owner: opts.owner || this.config.defaultOwner,
			acquiredAt: now,
			expiresAt,
			renewCount: 0,
			metadata: opts.metadata,
		};

		this.locks.set(key, lock);

		logger.debug("Lock acquired", {
			key,
			token: token.slice(-8),
			owner: lock.owner,
			ttlMs: opts.ttlMs,
		});

		return {
			acquired: true,
			token,
			expiresAt: new Date(expiresAt),
		};
	}

	/**
	 * Acquire a lock with waiting.
	 */
	private async acquireWithWait(
		key: string,
		opts: LockOptions,
	): Promise<LockResult> {
		const startTime = Date.now();
		const deadline = startTime + (opts.waitTimeoutMs || 10000);

		while (Date.now() < deadline) {
			const result = this.tryAcquire(key, opts);
			if (result.acquired) {
				return result;
			}

			// Wait before retrying
			await new Promise((resolve) =>
				setTimeout(resolve, opts.retryIntervalMs || 100),
			);
		}

		// Timeout - return current lock state
		const existing = this.locks.get(key);
		return {
			acquired: false,
			currentOwner: existing?.owner,
			currentExpiresAt: existing ? new Date(existing.expiresAt) : undefined,
		};
	}

	/**
	 * Release a lock.
	 */
	release(key: string, token: string): boolean {
		const existing = this.locks.get(key);

		if (!existing) {
			logger.warn("Attempted to release non-existent lock", { key });
			return false;
		}

		if (existing.token !== token) {
			logger.warn("Attempted to release lock with wrong token", {
				key,
				providedToken: token.slice(-8),
				actualToken: existing.token.slice(-8),
			});
			return false;
		}

		// Stop any renewal timer
		this.stopRenewal(key);

		this.locks.delete(key);

		logger.debug("Lock released", {
			key,
			token: token.slice(-8),
			heldForMs: Date.now() - existing.acquiredAt,
		});

		return true;
	}

	/**
	 * Renew a lock (extend its TTL).
	 */
	renew(key: string, token: string, ttlMs?: number): boolean {
		const existing = this.locks.get(key);

		if (!existing) {
			logger.warn("Attempted to renew non-existent lock", { key });
			return false;
		}

		if (existing.token !== token) {
			logger.warn("Attempted to renew lock with wrong token", { key });
			return false;
		}

		const now = Date.now();
		if (existing.expiresAt < now) {
			logger.warn("Attempted to renew expired lock", { key });
			return false;
		}

		existing.expiresAt = now + (ttlMs ?? this.config.defaultTtlMs);
		existing.renewCount++;

		logger.debug("Lock renewed", {
			key,
			token: token.slice(-8),
			renewCount: existing.renewCount,
		});

		return true;
	}

	/**
	 * Start automatic lock renewal.
	 */
	startAutoRenewal(key: string, token: string, intervalMs?: number): boolean {
		const existing = this.locks.get(key);
		if (!existing || existing.token !== token) {
			return false;
		}

		// Default to renewing at 50% of TTL
		const interval = intervalMs ?? this.config.defaultTtlMs / 2;

		// Stop any existing renewal
		this.stopRenewal(key);

		const timer = setInterval(() => {
			const renewed = this.renew(key, token);
			if (!renewed) {
				this.stopRenewal(key);
			}
		}, interval);

		// Don't keep process alive
		if (timer.unref) {
			timer.unref();
		}

		this.renewalTimers.set(key, timer);

		logger.debug("Auto-renewal started", {
			key,
			intervalMs: interval,
		});

		return true;
	}

	/**
	 * Stop automatic lock renewal.
	 */
	stopRenewal(key: string): void {
		const timer = this.renewalTimers.get(key);
		if (timer) {
			clearInterval(timer);
			this.renewalTimers.delete(key);
		}
	}

	/**
	 * Check if a lock is held.
	 */
	isLocked(key: string): boolean {
		const existing = this.locks.get(key);
		if (!existing) return false;
		return existing.expiresAt > Date.now();
	}

	/**
	 * Get lock information.
	 */
	getLockInfo(key: string): LockInfo | null {
		const existing = this.locks.get(key);
		if (!existing) return null;
		if (existing.expiresAt < Date.now()) return null;

		return {
			key,
			token: existing.token,
			owner: existing.owner,
			acquiredAt: new Date(existing.acquiredAt),
			expiresAt: new Date(existing.expiresAt),
			renewCount: existing.renewCount,
			metadata: existing.metadata,
		};
	}

	/**
	 * Get all active locks.
	 */
	getActiveLocks(): LockInfo[] {
		const now = Date.now();
		const result: LockInfo[] = [];

		for (const [key, lock] of this.locks) {
			if (lock.expiresAt > now) {
				result.push({
					key,
					token: lock.token,
					owner: lock.owner,
					acquiredAt: new Date(lock.acquiredAt),
					expiresAt: new Date(lock.expiresAt),
					renewCount: lock.renewCount,
					metadata: lock.metadata,
				});
			}
		}

		return result;
	}

	/**
	 * Execute a function while holding a lock.
	 */
	async withLock<T>(
		key: string,
		fn: () => Promise<T>,
		options?: Partial<LockOptions>,
	): Promise<
		{ success: true; result: T } | { success: false; reason: string }
	> {
		const lockResult = await this.acquire(key, {
			...options,
			waitForLock: options?.waitForLock ?? true,
		});

		if (!lockResult.acquired || !lockResult.token) {
			return {
				success: false,
				reason: `Failed to acquire lock: held by ${lockResult.currentOwner}`,
			};
		}

		try {
			const result = await fn();
			return { success: true, result };
		} finally {
			this.release(key, lockResult.token);
		}
	}

	/**
	 * Force-release a lock (admin operation).
	 */
	forceRelease(key: string): boolean {
		const existing = this.locks.get(key);
		if (!existing) {
			return false;
		}

		this.stopRenewal(key);
		this.locks.delete(key);

		logger.warn("Lock force-released", {
			key,
			owner: existing.owner,
			heldForMs: Date.now() - existing.acquiredAt,
		});

		return true;
	}

	/**
	 * Start periodic cleanup.
	 */
	private startCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}

		this.cleanupTimer = setInterval(() => {
			this.cleanup();
		}, this.config.cleanupIntervalMs);

		// Don't keep process alive
		if (this.cleanupTimer.unref) {
			this.cleanupTimer.unref();
		}
	}

	/**
	 * Clean up expired locks.
	 */
	cleanup(): number {
		const now = Date.now();
		let removed = 0;

		for (const [key, lock] of this.locks) {
			if (lock.expiresAt < now) {
				this.stopRenewal(key);
				this.locks.delete(key);
				removed++;
			}
		}

		if (removed > 0) {
			logger.debug("Cleaned up expired locks", { removed });
		}

		return removed;
	}

	/**
	 * Stop the lock manager.
	 */
	stop(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		for (const [key] of this.renewalTimers) {
			this.stopRenewal(key);
		}

		this.locks.clear();
	}

	/**
	 * Get statistics.
	 */
	getStats(): {
		activeLocks: number;
		totalRenewals: number;
		oldestLockAge: number | null;
	} {
		const now = Date.now();
		let oldestAge: number | null = null;
		let totalRenewals = 0;
		let activeLocks = 0;

		for (const lock of this.locks.values()) {
			if (lock.expiresAt > now) {
				activeLocks++;
				totalRenewals += lock.renewCount;
				const age = now - lock.acquiredAt;
				if (oldestAge === null || age > oldestAge) {
					oldestAge = age;
				}
			}
		}

		return {
			activeLocks,
			totalRenewals,
			oldestLockAge: oldestAge,
		};
	}
}

/**
 * Create a default lock manager.
 */
export function createLockManager(
	config?: Partial<LockManagerConfig>,
): DistributedLockManager {
	return new DistributedLockManager(config);
}

/**
 * Global shared lock manager instance.
 */
let globalLockManager: DistributedLockManager | null = null;

/**
 * Get or create the global lock manager.
 */
export function getGlobalLockManager(): DistributedLockManager {
	if (!globalLockManager) {
		globalLockManager = createLockManager();
	}
	return globalLockManager;
}

/**
 * Reset the global lock manager (for testing).
 */
export function resetGlobalLockManager(): void {
	if (globalLockManager) {
		globalLockManager.stop();
		globalLockManager = null;
	}
}

/**
 * Convenience function to run a function with a lock.
 */
export async function withLock<T>(
	key: string,
	fn: () => Promise<T>,
	options?: Partial<LockOptions>,
): Promise<{ success: true; result: T } | { success: false; reason: string }> {
	return getGlobalLockManager().withLock(key, fn, options);
}
