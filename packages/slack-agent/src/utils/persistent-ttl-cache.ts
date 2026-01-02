/**
 * Persistent TTL Cache - Map with TTL + on-disk persistence
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as logger from "../logger.js";
import { ensureDirSync } from "./fs.js";

interface CacheEntry<V> {
	value: V;
	expiresAt: number;
}

export interface PersistentTtlCacheConfig {
	/** Default TTL in milliseconds (default: 1 hour) */
	defaultTtlMs?: number;
	/** Cleanup interval in milliseconds (default: 5 minutes) */
	cleanupIntervalMs?: number;
	/** Max entries before forced cleanup (default: 10000) */
	maxEntries?: number;
	/** File path to persist cache entries */
	persistPath: string;
	/** Minimum ms between persistence writes */
	persistIntervalMs?: number;
}

const DEFAULT_CONFIG = {
	defaultTtlMs: 60 * 60 * 1000,
	cleanupIntervalMs: 5 * 60 * 1000,
	maxEntries: 10000,
	persistIntervalMs: 5000,
};

export class PersistentTtlCache<K extends string, V> {
	private cache = new Map<K, CacheEntry<V>>();
	private config: Required<PersistentTtlCacheConfig>;
	private lastCleanupMs = 0;
	private lastPersistMs = 0;

	constructor(config: PersistentTtlCacheConfig) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		ensureDirSync(dirname(this.config.persistPath));
		this.load();
	}

	get(key: K): V | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: K, value: V, ttlMs?: number): this {
		const expiresAt = Date.now() + (ttlMs ?? this.config.defaultTtlMs);
		this.cache.set(key, { value, expiresAt });
		this.maybeCleanup();
		this.maybePersist();
		return this;
	}

	has(key: K): boolean {
		const entry = this.cache.get(key);
		if (!entry) return false;
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return false;
		}
		return true;
	}

	delete(key: K): boolean {
		const deleted = this.cache.delete(key);
		if (deleted) {
			this.maybePersist();
		}
		return deleted;
	}

	clear(): void {
		this.cache.clear();
		this.maybePersist(true);
	}

	get size(): number {
		return this.cache.size;
	}

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
		for (const key of expired) {
			this.cache.delete(key);
		}
		return result;
	}

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
		for (const key of expired) {
			this.cache.delete(key);
		}
		return result;
	}

	*[Symbol.iterator](): Iterator<[K, V]> {
		const now = Date.now();
		for (const [key, entry] of this.cache) {
			if (now <= entry.expiresAt) {
				yield [key, entry.value];
			}
		}
	}

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
		if (removed > 0) {
			this.maybePersist(true);
		}
		return removed;
	}

	private maybeCleanup(): void {
		const now = Date.now();
		const intervalPassed =
			now - this.lastCleanupMs > this.config.cleanupIntervalMs;
		const maxExceeded = this.cache.size > this.config.maxEntries;
		if (intervalPassed || maxExceeded) {
			this.cleanup();
		}
	}

	private load(): void {
		if (!existsSync(this.config.persistPath)) return;
		try {
			const raw = readFileSync(this.config.persistPath, "utf-8");
			const data = JSON.parse(raw) as {
				entries?: Array<[K, CacheEntry<V>]>;
			};
			const now = Date.now();
			for (const [key, entry] of data.entries ?? []) {
				if (now <= entry.expiresAt) {
					this.cache.set(key, entry);
				}
			}
		} catch (error) {
			logger.logWarning("Failed to load persistent cache", String(error));
		}
	}

	private maybePersist(force = false): void {
		const now = Date.now();
		if (
			!force &&
			this.config.persistIntervalMs > 0 &&
			now - this.lastPersistMs < this.config.persistIntervalMs
		) {
			return;
		}
		this.lastPersistMs = now;
		try {
			const entries = Array.from(this.cache.entries());
			writeFileSync(
				this.config.persistPath,
				JSON.stringify({ entries }, null, 2),
			);
		} catch (error) {
			logger.logWarning("Failed to persist cache", String(error));
		}
	}
}
