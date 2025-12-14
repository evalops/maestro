/**
 * Idempotency Manager - Prevent duplicate event processing
 *
 * Supports pluggable storage backends (file or Redis).
 * For enterprise, use Redis for distributed locking across instances.
 *
 * ```typescript
 * const redis = await createRedisBackend({ url: process.env.REDIS_URL });
 * const idempotency = new IdempotencyManager({ storage: redis });
 * ```
 */

import { join } from "node:path";
import * as logger from "./logger.js";
import { FileStorageBackend, type StorageBackend } from "./storage.js";

// ============================================================================
// Types
// ============================================================================

export interface IdempotencyCheckResult {
	shouldProcess: boolean;
	isDuplicate: boolean;
	previousFailed: boolean;
	previousError?: string;
}

interface ProcessedEvent {
	eventId: string;
	eventType: string;
	processedAt: number;
	status: "processing" | "completed" | "failed";
	error?: string;
}

export interface IdempotencyConfig {
	/** TTL for processed events (ms, default: 5 min) */
	ttlMs?: number;
	/** Lock timeout for processing events (ms, default: 30s) */
	lockTimeout?: number;
	/** Custom storage backend (file or Redis) */
	storage?: StorageBackend;
}

const DEFAULT_CONFIG = {
	ttlMs: 5 * 60 * 1000, // 5 minutes
	lockTimeout: 30 * 1000, // 30 seconds
};

// ============================================================================
// IdempotencyManager Class
// ============================================================================

export class IdempotencyManager {
	private storage: StorageBackend;
	private config: typeof DEFAULT_CONFIG;

	constructor(workingDir: string | null, config: IdempotencyConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };

		// Use provided storage or default to file-based
		if (config.storage) {
			this.storage = config.storage;
		} else if (workingDir) {
			this.storage = new FileStorageBackend(join(workingDir, "idempotency"));
		} else {
			// In-memory only (no persistence)
			this.storage = new InMemoryStorage();
		}
	}

	private getKey(eventId: string): string {
		return `event:${eventId}`;
	}

	/**
	 * Check if an event should be processed and lock it
	 * Uses atomic setNX to prevent race conditions in distributed environments
	 */
	async checkAndLock(
		eventId: string,
		eventType: string,
	): Promise<IdempotencyCheckResult> {
		const key = this.getKey(eventId);
		const now = Date.now();

		// Try atomic lock first - if this succeeds, we're the first to process
		const lockAcquired = await this.storage.setNX(
			key,
			{
				eventId,
				eventType,
				processedAt: now,
				status: "processing",
			} as ProcessedEvent,
			this.config.ttlMs,
		);

		if (lockAcquired) {
			// We got the lock - process the event
			return {
				shouldProcess: true,
				isDuplicate: false,
				previousFailed: false,
			};
		}

		// Lock not acquired - check existing record status
		const existing = await this.storage.get<ProcessedEvent>(key);

		if (!existing) {
			// Race condition: record expired between setNX and get
			// Retry the lock acquisition
			const retryLock = await this.storage.setNX(
				key,
				{
					eventId,
					eventType,
					processedAt: now,
					status: "processing",
				} as ProcessedEvent,
				this.config.ttlMs,
			);

			if (retryLock) {
				return {
					shouldProcess: true,
					isDuplicate: false,
					previousFailed: false,
				};
			}

			// Another instance got the lock
			return {
				shouldProcess: false,
				isDuplicate: true,
				previousFailed: false,
			};
		}

		// Already completed - duplicate
		if (existing.status === "completed") {
			return {
				shouldProcess: false,
				isDuplicate: true,
				previousFailed: false,
			};
		}

		// Currently processing - check lock timeout
		if (existing.status === "processing") {
			const elapsed = now - existing.processedAt;
			if (elapsed < this.config.lockTimeout) {
				// Still processing, don't duplicate
				return {
					shouldProcess: false,
					isDuplicate: true,
					previousFailed: false,
				};
			}
			// Lock expired - delete old record and retry
			logger.logWarning(
				"Event lock expired, allowing retry",
				`${eventId} after ${elapsed}ms`,
			);
			await this.storage.delete(key);

			// Try to acquire lock again
			const expiredRetry = await this.storage.setNX(
				key,
				{
					eventId,
					eventType,
					processedAt: now,
					status: "processing",
				} as ProcessedEvent,
				this.config.ttlMs,
			);

			if (expiredRetry) {
				return {
					shouldProcess: true,
					isDuplicate: false,
					previousFailed: false,
				};
			}

			// Another instance got the lock
			return {
				shouldProcess: false,
				isDuplicate: true,
				previousFailed: false,
			};
		}

		// Previously failed - delete and retry with atomic lock
		if (existing.status === "failed") {
			const previousError = existing.error;
			await this.storage.delete(key);

			const failedRetry = await this.storage.setNX(
				key,
				{
					eventId,
					eventType,
					processedAt: now,
					status: "processing",
				} as ProcessedEvent,
				this.config.ttlMs,
			);

			if (failedRetry) {
				return {
					shouldProcess: true,
					isDuplicate: false,
					previousFailed: true,
					previousError,
				};
			}

			// Another instance got the lock
			return {
				shouldProcess: false,
				isDuplicate: true,
				previousFailed: false,
			};
		}

		// Unknown status - treat as duplicate
		return {
			shouldProcess: false,
			isDuplicate: true,
			previousFailed: false,
		};
	}

	/**
	 * Mark an event as successfully completed
	 */
	async markComplete(eventId: string): Promise<void> {
		const key = this.getKey(eventId);
		const existing = await this.storage.get<ProcessedEvent>(key);

		const event: ProcessedEvent = existing
			? { ...existing, status: "completed", processedAt: Date.now() }
			: {
					eventId,
					eventType: "unknown",
					processedAt: Date.now(),
					status: "completed",
				};

		await this.storage.set(key, event, this.config.ttlMs);
	}

	/**
	 * Mark an event as failed (allows retry)
	 */
	async markFailed(eventId: string, error: string): Promise<void> {
		const key = this.getKey(eventId);
		const existing = await this.storage.get<ProcessedEvent>(key);

		const event: ProcessedEvent = existing
			? { ...existing, status: "failed", error, processedAt: Date.now() }
			: {
					eventId,
					eventType: "unknown",
					processedAt: Date.now(),
					status: "failed",
					error,
				};

		await this.storage.set(key, event, this.config.ttlMs);
	}

	/**
	 * Shutdown and flush storage
	 */
	async shutdown(): Promise<void> {
		await this.storage.flush();
	}
}

// ============================================================================
// In-Memory Storage (for testing or no persistence)
// ============================================================================

class InMemoryStorage implements StorageBackend {
	private data = new Map<string, { value: unknown; expiresAt?: number }>();

	async get<T>(key: string): Promise<T | null> {
		const entry = this.data.get(key);
		if (!entry) return null;
		if (entry.expiresAt && Date.now() > entry.expiresAt) {
			this.data.delete(key);
			return null;
		}
		return entry.value as T;
	}

	async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
		this.data.set(key, {
			value,
			expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
		});
	}

	async setNX<T>(key: string, value: T, ttlMs?: number): Promise<boolean> {
		// Check if key exists (and not expired)
		const existing = this.data.get(key);
		if (existing) {
			if (!existing.expiresAt || Date.now() <= existing.expiresAt) {
				return false; // Key exists, don't overwrite
			}
			// Expired - delete it
			this.data.delete(key);
		}
		// Set the new value
		this.data.set(key, {
			value,
			expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
		});
		return true;
	}

	async delete(key: string): Promise<boolean> {
		return this.data.delete(key);
	}

	async exists(key: string): Promise<boolean> {
		return this.data.has(key);
	}

	async keys(pattern: string): Promise<string[]> {
		const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
		return Array.from(this.data.keys()).filter((k) => regex.test(k));
	}

	async flush(): Promise<void> {
		this.data.clear();
	}
}

// ============================================================================
// Helper: Wrap handler with idempotency
// ============================================================================

/**
 * Wrap an event handler with idempotency checking
 */
export function withIdempotency<T extends { id?: string; eventId?: string }>(
	manager: IdempotencyManager,
	handler: (event: T) => Promise<void>,
	getEventId: (event: T) => string = (e) => e.id ?? e.eventId ?? "",
): (event: T) => Promise<{
	processed: boolean;
	skipped: boolean;
	error?: string;
}> {
	return async (event: T) => {
		const eventId = getEventId(event);
		if (!eventId) {
			// No event ID, process anyway
			await handler(event);
			return { processed: true, skipped: false };
		}

		const check = await manager.checkAndLock(eventId, "event");

		if (!check.shouldProcess) {
			return {
				processed: false,
				skipped: true,
			};
		}

		try {
			await handler(event);
			await manager.markComplete(eventId);
			return { processed: true, skipped: false };
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			await manager.markFailed(eventId, errorMessage);
			return { processed: false, skipped: false, error: errorMessage };
		}
	};
}
