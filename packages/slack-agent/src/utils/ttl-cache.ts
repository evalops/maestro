/**
 * TTL Cache - Map with automatic expiration
 *
 * Provides a Map-like interface with automatic entry expiration
 * and periodic cleanup to prevent memory leaks.
 */

interface CacheEntry<V> {
	value: V;
	expiresAt: number;
}

export interface TtlCacheConfig {
	/** Default TTL in milliseconds (default: 1 hour) */
	defaultTtlMs?: number;
	/** Cleanup interval in milliseconds (default: 5 minutes) */
	cleanupIntervalMs?: number;
	/** Max entries before forced cleanup (default: 10000) */
	maxEntries?: number;
}

const DEFAULT_CONFIG: Required<TtlCacheConfig> = {
	defaultTtlMs: 60 * 60 * 1000, // 1 hour
	cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
	maxEntries: 10000,
};

/**
 * A Map with TTL support and automatic cleanup
 */
export class TtlCache<K, V> {
	private cache = new Map<K, CacheEntry<V>>();
	private config: Required<TtlCacheConfig>;
	private lastCleanupMs = 0;

	constructor(config: TtlCacheConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Get a value from the cache (returns undefined if expired or not found)
	 */
	get(key: K): V | undefined {
		const entry = this.cache.get(key);
		if (!entry) {
			return undefined;
		}

		// Check if expired
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return undefined;
		}

		return entry.value;
	}

	/**
	 * Set a value in the cache with optional custom TTL
	 */
	set(key: K, value: V, ttlMs?: number): this {
		const expiresAt = Date.now() + (ttlMs ?? this.config.defaultTtlMs);
		this.cache.set(key, { value, expiresAt });

		// Trigger cleanup if needed
		this.maybeCleanup();

		return this;
	}

	/**
	 * Check if a key exists and is not expired
	 */
	has(key: K): boolean {
		const entry = this.cache.get(key);
		if (!entry) {
			return false;
		}

		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return false;
		}

		return true;
	}

	/**
	 * Delete an entry from the cache
	 */
	delete(key: K): boolean {
		return this.cache.delete(key);
	}

	/**
	 * Clear all entries from the cache
	 */
	clear(): void {
		this.cache.clear();
	}

	/**
	 * Get the number of entries (includes potentially expired entries)
	 */
	get size(): number {
		return this.cache.size;
	}

	/**
	 * Get all valid entries as an array (also cleans up expired entries)
	 */
	entries(): Array<[K, V]> {
		const now = Date.now();
		const result: Array<[K, V]> = [];
		const expired: K[] = [];

		for (const [key, entry] of this.cache) {
			if (now <= entry.expiresAt) {
				result.push([key, entry.value]);
			} else {
				expired.push(key);
			}
		}

		// Clean up expired entries found during iteration
		for (const key of expired) {
			this.cache.delete(key);
		}

		return result;
	}

	/**
	 * Get all valid values as an array (also cleans up expired entries)
	 */
	values(): V[] {
		const now = Date.now();
		const result: V[] = [];
		const expired: K[] = [];

		for (const [key, entry] of this.cache) {
			if (now <= entry.expiresAt) {
				result.push(entry.value);
			} else {
				expired.push(key);
			}
		}

		// Clean up expired entries found during iteration
		for (const key of expired) {
			this.cache.delete(key);
		}

		return result;
	}

	/**
	 * Iterate over valid entries (note: does not clean up during iteration
	 * to avoid mutating the map while iterating via generator)
	 */
	*[Symbol.iterator](): Iterator<[K, V]> {
		const now = Date.now();
		for (const [key, entry] of this.cache) {
			if (now <= entry.expiresAt) {
				yield [key, entry.value];
			}
		}
	}

	/**
	 * Force cleanup of expired entries
	 */
	cleanup(): number {
		const now = Date.now();
		let removed = 0;

		for (const [key, entry] of this.cache) {
			if (now > entry.expiresAt) {
				this.cache.delete(key);
				removed++;
			}
		}

		this.lastCleanupMs = now;
		return removed;
	}

	/**
	 * Run cleanup if interval has passed or max entries exceeded
	 */
	private maybeCleanup(): void {
		const now = Date.now();
		const intervalPassed =
			now - this.lastCleanupMs > this.config.cleanupIntervalMs;
		const maxExceeded = this.cache.size > this.config.maxEntries;

		if (intervalPassed || maxExceeded) {
			this.cleanup();
		}
	}
}
