import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/utils/ttl-cache.js";

describe("TtlCache", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("basic operations", () => {
		it("stores and retrieves values", () => {
			const cache = new TtlCache<string, number>();

			cache.set("key1", 100);
			cache.set("key2", 200);

			expect(cache.get("key1")).toBe(100);
			expect(cache.get("key2")).toBe(200);
		});

		it("returns undefined for missing keys", () => {
			const cache = new TtlCache<string, number>();

			expect(cache.get("nonexistent")).toBeUndefined();
		});

		it("overwrites existing values", () => {
			const cache = new TtlCache<string, number>();

			cache.set("key", 100);
			expect(cache.get("key")).toBe(100);

			cache.set("key", 200);
			expect(cache.get("key")).toBe(200);
		});

		it("deletes entries", () => {
			const cache = new TtlCache<string, number>();

			cache.set("key", 100);
			expect(cache.has("key")).toBe(true);

			const deleted = cache.delete("key");

			expect(deleted).toBe(true);
			expect(cache.has("key")).toBe(false);
			expect(cache.get("key")).toBeUndefined();
		});

		it("returns false when deleting nonexistent key", () => {
			const cache = new TtlCache<string, number>();

			expect(cache.delete("nonexistent")).toBe(false);
		});

		it("clears all entries", () => {
			const cache = new TtlCache<string, number>();

			cache.set("key1", 100);
			cache.set("key2", 200);
			expect(cache.size).toBe(2);

			cache.clear();

			expect(cache.size).toBe(0);
			expect(cache.get("key1")).toBeUndefined();
		});
	});

	describe("TTL behavior", () => {
		it("expires entries after default TTL", () => {
			const cache = new TtlCache<string, number>({
				defaultTtlMs: 1000, // 1 second
			});

			cache.set("key", 100);
			expect(cache.get("key")).toBe(100);

			// Advance time past TTL
			vi.advanceTimersByTime(1001);

			expect(cache.get("key")).toBeUndefined();
			expect(cache.has("key")).toBe(false);
		});

		it("respects custom TTL per entry", () => {
			const cache = new TtlCache<string, number>({
				defaultTtlMs: 10000, // 10 seconds default
			});

			cache.set("short", 100, 500); // 500ms TTL
			cache.set("default", 200); // 10s TTL

			vi.advanceTimersByTime(600);

			expect(cache.get("short")).toBeUndefined(); // Expired
			expect(cache.get("default")).toBe(200); // Still valid
		});

		it("keeps entries valid until TTL expires", () => {
			const cache = new TtlCache<string, number>({
				defaultTtlMs: 1000,
			});

			cache.set("key", 100);

			vi.advanceTimersByTime(999);
			expect(cache.get("key")).toBe(100); // Still valid

			vi.advanceTimersByTime(2);
			expect(cache.get("key")).toBeUndefined(); // Now expired
		});
	});

	describe("iteration", () => {
		it("returns entries as array", () => {
			const cache = new TtlCache<string, number>();

			cache.set("a", 1);
			cache.set("b", 2);

			const entries = cache.entries();

			expect(entries).toHaveLength(2);
			expect(entries).toContainEqual(["a", 1]);
			expect(entries).toContainEqual(["b", 2]);
		});

		it("returns values as array", () => {
			const cache = new TtlCache<string, number>();

			cache.set("a", 1);
			cache.set("b", 2);

			const values = cache.values();

			expect(values).toHaveLength(2);
			expect(values).toContain(1);
			expect(values).toContain(2);
		});

		it("filters out expired entries during iteration", () => {
			const cache = new TtlCache<string, number>({
				defaultTtlMs: 1000,
			});

			cache.set("expired", 1, 500);
			cache.set("valid", 2);

			vi.advanceTimersByTime(600);

			expect(cache.entries()).toEqual([["valid", 2]]);
			expect(cache.values()).toEqual([2]);
		});

		it("cleans up expired entries during entries() call", () => {
			const cache = new TtlCache<string, number>({
				defaultTtlMs: 1000,
				cleanupIntervalMs: 10000, // Long interval to prevent auto-cleanup
			});

			cache.set("expired1", 1, 500);
			cache.set("expired2", 2, 500);
			cache.set("valid", 3);

			vi.advanceTimersByTime(600);

			// Before calling entries(), size includes expired entries
			expect(cache.size).toBe(3);

			// entries() should clean up expired entries
			cache.entries();

			// After calling entries(), expired entries should be removed
			expect(cache.size).toBe(1);
		});

		it("cleans up expired entries during values() call", () => {
			const cache = new TtlCache<string, number>({
				defaultTtlMs: 1000,
				cleanupIntervalMs: 10000, // Long interval to prevent auto-cleanup
			});

			cache.set("expired", 1, 500);
			cache.set("valid", 2);

			vi.advanceTimersByTime(600);

			expect(cache.size).toBe(2);

			// values() should clean up expired entries
			cache.values();

			expect(cache.size).toBe(1);
		});

		it("supports for..of iteration", () => {
			const cache = new TtlCache<string, number>();

			cache.set("a", 1);
			cache.set("b", 2);

			const collected: Array<[string, number]> = [];
			for (const entry of cache) {
				collected.push(entry);
			}

			expect(collected).toHaveLength(2);
		});
	});

	describe("cleanup", () => {
		it("removes expired entries on cleanup", () => {
			const cache = new TtlCache<string, number>({
				defaultTtlMs: 1000,
				cleanupIntervalMs: 10000, // Long interval to prevent auto-cleanup
			});

			cache.set("expired", 1, 500);
			cache.set("valid", 2);

			vi.advanceTimersByTime(600);

			// Internal map still has both entries
			expect(cache.size).toBe(2);

			const removed = cache.cleanup();

			expect(removed).toBe(1);
			expect(cache.size).toBe(1);
		});

		it("triggers cleanup when max entries exceeded", () => {
			const cache = new TtlCache<string, number>({
				defaultTtlMs: 10000,
				cleanupIntervalMs: 10000,
				maxEntries: 3,
			});

			// Add some entries that will expire
			cache.set("a", 1, 100);
			cache.set("b", 2, 100);
			vi.advanceTimersByTime(200);

			// Now add entries exceeding max
			cache.set("c", 3);
			cache.set("d", 4); // This should trigger cleanup

			// The expired entries should be removed
			expect(cache.size).toBe(2); // Only c and d remain
		});

		it("triggers cleanup on interval", () => {
			const cache = new TtlCache<string, number>({
				defaultTtlMs: 500,
				cleanupIntervalMs: 1000,
			});

			cache.set("a", 1);
			vi.advanceTimersByTime(600); // Entry expired

			// First set after cleanup interval should trigger cleanup
			vi.advanceTimersByTime(500);
			cache.set("b", 2); // Triggers cleanup

			expect(cache.size).toBe(1); // Only b remains
		});
	});

	describe("chaining", () => {
		it("set returns the cache for chaining", () => {
			const cache = new TtlCache<string, number>();

			const result = cache.set("a", 1).set("b", 2).set("c", 3);

			expect(result).toBe(cache);
			expect(cache.size).toBe(3);
		});
	});
});
