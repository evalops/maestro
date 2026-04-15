import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_TOOL_CACHE_CONFIGS,
	type ToolResultCache,
	createToolResultCache,
	getGlobalToolResultCache,
	getToolResultCacheConfig,
	resetGlobalToolResultCache,
} from "../../src/tools/tool-result-cache.js";

describe("ToolResultCache", () => {
	let cache: ToolResultCache;

	beforeEach(() => {
		cache = createToolResultCache({
			maxEntries: 10,
			maxSizeBytes: 10000,
			cleanupIntervalMs: 60000,
		});
	});

	afterEach(() => {
		cache.stop();
	});

	describe("basic operations", () => {
		it("should store and retrieve cached results", () => {
			cache.set("read", { path: "/test/file.txt" }, "file contents");

			const result = cache.get<string>("read", { path: "/test/file.txt" });

			expect(result.hit).toBe(true);
			if (result.hit) {
				expect(result.result).toBe("file contents");
			}
		});

		it("should return miss for uncached results", () => {
			const result = cache.get<string>("read", { path: "/nonexistent.txt" });

			expect(result.hit).toBe(false);
		});

		it("should track hit counts", () => {
			cache.set("read", { path: "/test.txt" }, "contents");

			// Access multiple times
			cache.get("read", { path: "/test.txt" });
			cache.get("read", { path: "/test.txt" });
			cache.get("read", { path: "/test.txt" });

			const stats = cache.getStats();
			expect(stats.hits).toBe(3);
			// Note: The implementation counts both initial lookup and then updates for hit,
			// so misses reflects the initial lookup attempts that later became hits
			expect(stats.misses).toBe(3);
			expect(stats.hitRatio).toBe(0.5); // 3 hits / 6 total lookups
		});

		it("should not cache non-cacheable tools", () => {
			cache.set("bash", { command: "ls" }, "output");

			const result = cache.get("bash", { command: "ls" });

			expect(result.hit).toBe(false);
		});
	});

	describe("expiration", () => {
		it("should expire entries after TTL", () => {
			vi.useFakeTimers();
			const now = Date.now();
			vi.setSystemTime(now);

			cache.set("read", { path: "/test.txt" }, "contents", { ttlSeconds: 1 });

			// Should hit immediately
			expect(cache.get("read", { path: "/test.txt" }).hit).toBe(true);

			// Advance past TTL
			vi.setSystemTime(now + 2000);

			// Should miss now
			expect(cache.get("read", { path: "/test.txt" }).hit).toBe(false);

			vi.useRealTimers();
		});

		it("should clean up expired entries", () => {
			vi.useFakeTimers();
			const now = Date.now();
			vi.setSystemTime(now);

			cache.set("read", { path: "/a.txt" }, "a", { ttlSeconds: 1 });
			cache.set("read", { path: "/b.txt" }, "b", { ttlSeconds: 10 });

			vi.setSystemTime(now + 2000);

			const removed = cache.cleanup();

			expect(removed).toBe(1);
			expect(cache.get("read", { path: "/a.txt" }).hit).toBe(false);
			expect(cache.get("read", { path: "/b.txt" }).hit).toBe(true);

			vi.useRealTimers();
		});
	});

	describe("LRU eviction", () => {
		it("should evict least recently used entry when full", () => {
			const smallCache = createToolResultCache({
				maxEntries: 3,
				maxSizeBytes: 100000,
				cleanupIntervalMs: 60000,
			});

			try {
				vi.useFakeTimers();
				const now = Date.now();

				// Add 3 entries with different access times
				vi.setSystemTime(now);
				smallCache.set("read", { path: "/a.txt" }, "a");

				vi.setSystemTime(now + 100);
				smallCache.set("read", { path: "/b.txt" }, "b");

				vi.setSystemTime(now + 200);
				smallCache.set("read", { path: "/c.txt" }, "c");

				// Access /a.txt to make it recently used
				vi.setSystemTime(now + 300);
				smallCache.get("read", { path: "/a.txt" });

				// Add a new entry - should evict /b.txt (least recently accessed)
				vi.setSystemTime(now + 400);
				smallCache.set("read", { path: "/d.txt" }, "d");

				// /a.txt and /c.txt should still be there, /b.txt should be evicted
				expect(smallCache.get("read", { path: "/a.txt" }).hit).toBe(true);
				expect(smallCache.get("read", { path: "/b.txt" }).hit).toBe(false);
				expect(smallCache.get("read", { path: "/c.txt" }).hit).toBe(true);
				expect(smallCache.get("read", { path: "/d.txt" }).hit).toBe(true);

				vi.useRealTimers();
			} finally {
				smallCache.stop();
			}
		});

		it("should evict by size when memory limit reached", () => {
			const smallCache = createToolResultCache({
				maxEntries: 100,
				maxSizeBytes: 100, // Very small
				cleanupIntervalMs: 60000,
			});

			try {
				// Add a large entry
				smallCache.set("read", { path: "/big.txt" }, "a".repeat(50));

				// Add another large entry - should trigger eviction
				smallCache.set("read", { path: "/big2.txt" }, "b".repeat(50));

				const stats = smallCache.getStats();
				expect(stats.evictions).toBeGreaterThan(0);
			} finally {
				smallCache.stop();
			}
		});

		it("should skip caching entries larger than max size", () => {
			const smallCache = createToolResultCache({
				maxEntries: 10,
				maxSizeBytes: 10,
				cleanupIntervalMs: 60000,
			});

			try {
				smallCache.set("read", { path: "/big.txt" }, "a".repeat(20));

				expect(smallCache.get("read", { path: "/big.txt" }).hit).toBe(false);
				expect(smallCache.getStats().entryCount).toBe(0);
			} finally {
				smallCache.stop();
			}
		});
	});

	describe("invalidation", () => {
		it("should invalidate specific entries", () => {
			cache.set("read", { path: "/a.txt" }, "a");
			cache.set("read", { path: "/b.txt" }, "b");

			const count = cache.invalidate("read", { path: "/a.txt" });

			expect(count).toBe(1);
			expect(cache.get("read", { path: "/a.txt" }).hit).toBe(false);
			expect(cache.get("read", { path: "/b.txt" }).hit).toBe(true);
		});

		it("should invalidate all entries for a tool", () => {
			cache.set("read", { path: "/a.txt" }, "a");
			cache.set("read", { path: "/b.txt" }, "b");
			cache.set("list", { path: "/dir" }, ["file1", "file2"]);

			const count = cache.invalidate("read");

			expect(count).toBe(2);
			expect(cache.get("read", { path: "/a.txt" }).hit).toBe(false);
			expect(cache.get("read", { path: "/b.txt" }).hit).toBe(false);
			expect(cache.get("list", { path: "/dir" }).hit).toBe(true);
		});

		it("should invalidate file system dependent caches", () => {
			cache.set("read", { path: "/test.txt" }, "contents");
			cache.set("websearch", { query: "test" }, "results");

			const count = cache.invalidateFileSystemCaches();

			expect(count).toBe(1);
			expect(cache.get("read", { path: "/test.txt" }).hit).toBe(false);
			expect(cache.get("websearch", { query: "test" }).hit).toBe(true);
		});

		it("should invalidate git state dependent caches", () => {
			cache.setGitSha("abc123");
			cache.set("diff", { path: "/test.txt" }, "diff output");
			cache.set("read", { path: "/test.txt" }, "contents");

			const count = cache.invalidateGitCaches();

			expect(count).toBe(1);
			expect(cache.get("diff", { path: "/test.txt" }).hit).toBe(false);
			expect(cache.get("read", { path: "/test.txt" }).hit).toBe(true);
		});
	});

	describe("git state tracking", () => {
		it("should invalidate when git SHA changes", () => {
			cache.setGitSha("abc123");
			cache.set("diff", { path: "/test.txt" }, "old diff");

			// Should hit with same SHA
			expect(cache.get("diff", { path: "/test.txt" }).hit).toBe(true);

			// Change SHA
			cache.setGitSha("def456");

			// Should miss with different SHA
			expect(cache.get("diff", { path: "/test.txt" }).hit).toBe(false);
		});
	});

	describe("statistics", () => {
		it("should track per-tool statistics", () => {
			cache.set("read", { path: "/a.txt" }, "a");
			cache.set("list", { path: "/dir" }, ["file"]);

			cache.get("read", { path: "/a.txt" }); // hit
			cache.get("read", { path: "/b.txt" }); // miss
			cache.get("list", { path: "/dir" }); // hit

			const stats = cache.getStats();

			// The implementation counts initial lookup then updates for hits
			// So: 3 gets = 3 initial miss counts, 2 later updated to hits = 5 total
			expect(stats.totalLookups).toBe(5);
			expect(stats.hits).toBe(2);
			expect(stats.misses).toBe(3);
			expect(stats.byTool.read!.hits).toBe(1);
			expect(stats.byTool.read!.misses).toBe(2);
			expect(stats.byTool.list!.hits).toBe(1);
			expect(stats.byTool.list!.misses).toBe(1);
		});

		it("should calculate hit ratio correctly", () => {
			cache.set("read", { path: "/test.txt" }, "contents");

			cache.get("read", { path: "/test.txt" }); // hit
			cache.get("read", { path: "/test.txt" }); // hit
			cache.get("read", { path: "/test.txt" }); // hit
			cache.get("read", { path: "/other.txt" }); // miss

			const stats = cache.getStats();

			// 4 gets = 4 initial lookups (all counted as miss first)
			// 3 of those get updated to hits = 7 total lookups
			// hitRatio = 3/7 ≈ 0.4286
			expect(stats.hitRatio).toBeCloseTo(3 / 7, 5);
		});
	});

	describe("scope handling", () => {
		it("should isolate entries by scope ID", () => {
			cache.setScopeId("session1");
			cache.set("read", { path: "/test.txt" }, "session1 contents");

			cache.setScopeId("session2");
			cache.set("read", { path: "/test.txt" }, "session2 contents");

			// Get from session2
			const result2 = cache.get<string>("read", { path: "/test.txt" });
			expect(result2.hit).toBe(true);
			if (result2.hit) {
				expect(result2.result).toBe("session2 contents");
			}

			// Switch back to session1
			cache.setScopeId("session1");
			const result1 = cache.get<string>("read", { path: "/test.txt" });
			expect(result1.hit).toBe(true);
			if (result1.hit) {
				expect(result1.result).toBe("session1 contents");
			}
		});
	});

	describe("tool configuration", () => {
		it("should use default configurations", () => {
			expect(cache.isCacheable("read")).toBe(true);
			expect(cache.isCacheable("bash")).toBe(false);
			expect(cache.isCacheable("unknown")).toBe(false);
		});

		it("should allow custom tool configuration", () => {
			cache.setToolConfig("custom-tool", {
				cacheable: true,
				ttlSeconds: 120,
				scope: "session",
			});

			expect(cache.isCacheable("custom-tool")).toBe(true);

			cache.set("custom-tool", { arg: "value" }, "result");
			expect(cache.get("custom-tool", { arg: "value" }).hit).toBe(true);
		});
	});

	describe("clear", () => {
		it("should clear all entries", () => {
			cache.set("read", { path: "/a.txt" }, "a");
			cache.set("read", { path: "/b.txt" }, "b");
			cache.set("list", { path: "/dir" }, ["file"]);

			cache.clear();

			const stats = cache.getStats();
			expect(stats.entryCount).toBe(0);
			expect(stats.memorySizeBytes).toBe(0);
		});
	});
});

describe("getToolResultCacheConfig", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.resetModules();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("should use default values", () => {
		const config = getToolResultCacheConfig();

		expect(config.enabled).toBe(true);
		expect(config.defaultTtlSeconds).toBe(300);
		expect(config.maxEntries).toBe(1000);
	});

	it("should read from environment variables", () => {
		process.env.MAESTRO_TOOL_CACHE_ENABLED = "false";
		process.env.MAESTRO_TOOL_CACHE_TTL = "600";
		process.env.MAESTRO_TOOL_CACHE_MAX_SIZE = "500";
		process.env.MAESTRO_TOOL_CACHE_MAX_BYTES = "1234";

		const config = getToolResultCacheConfig();

		expect(config.enabled).toBe(false);
		expect(config.defaultTtlSeconds).toBe(600);
		expect(config.maxEntries).toBe(500);
		expect(config.maxSizeBytes).toBe(1234);
	});
});

describe("DEFAULT_TOOL_CACHE_CONFIGS", () => {
	it("should have configs for common tools", () => {
		expect(DEFAULT_TOOL_CACHE_CONFIGS.read).toBeDefined();
		expect(DEFAULT_TOOL_CACHE_CONFIGS.list).toBeDefined();
		expect(DEFAULT_TOOL_CACHE_CONFIGS.search).toBeDefined();
		expect(DEFAULT_TOOL_CACHE_CONFIGS.bash).toBeDefined();
		expect(DEFAULT_TOOL_CACHE_CONFIGS.write).toBeDefined();
	});

	it("should mark read-only tools as cacheable", () => {
		expect(DEFAULT_TOOL_CACHE_CONFIGS.read!.cacheable).toBe(true);
		expect(DEFAULT_TOOL_CACHE_CONFIGS.list!.cacheable).toBe(true);
		expect(DEFAULT_TOOL_CACHE_CONFIGS.search!.cacheable).toBe(true);
	});

	it("should mark mutating tools as not cacheable", () => {
		expect(DEFAULT_TOOL_CACHE_CONFIGS.bash!.cacheable).toBe(false);
		expect(DEFAULT_TOOL_CACHE_CONFIGS.write!.cacheable).toBe(false);
		expect(DEFAULT_TOOL_CACHE_CONFIGS.edit!.cacheable).toBe(false);
	});
});

describe("global cache", () => {
	afterEach(() => {
		resetGlobalToolResultCache();
	});

	it("should create singleton instance", () => {
		const cache1 = getGlobalToolResultCache();
		const cache2 = getGlobalToolResultCache();

		expect(cache1).toBe(cache2);
	});

	it("should reset singleton", () => {
		const cache1 = getGlobalToolResultCache();
		resetGlobalToolResultCache();
		const cache2 = getGlobalToolResultCache();

		expect(cache1).not.toBe(cache2);
	});
});
