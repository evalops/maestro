import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CacheInvalidationService,
	createCacheInvalidationService,
	getGlobalCacheInvalidation,
	initGlobalCacheInvalidation,
	resetGlobalCacheInvalidation,
} from "../../src/tools/cache-invalidation.js";
import type { ToolResultCache } from "../../src/tools/tool-result-cache.js";

// Mock the file watcher
vi.mock("../../src/tools/file-watcher.js", () => ({
	createFileWatcher: vi.fn(() => ({
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn(),
		onFileChange: vi.fn(() => vi.fn()),
		onGitStateChange: vi.fn(() => vi.fn()),
		getCurrentGitSha: vi.fn(() => "abc123"),
	})),
}));

// Mock the tool result cache
vi.mock("../../src/tools/tool-result-cache.js", () => ({
	getGlobalToolResultCache: vi.fn(() => ({
		clear: vi.fn(),
		setGitSha: vi.fn(),
		invalidate: vi.fn(() => 0),
		invalidateGitCaches: vi.fn(() => 0),
		invalidateFileSystemCaches: vi.fn(() => 0),
	})),
}));

describe("cache-invalidation", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "cache-invalidation-test-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		resetGlobalCacheInvalidation();
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("CacheInvalidationService", () => {
		it("creates service with default config", () => {
			const service = createCacheInvalidationService({ rootDir: testDir });
			expect(service).toBeInstanceOf(CacheInvalidationService);
		});

		it("starts and stops service", async () => {
			const service = createCacheInvalidationService({ rootDir: testDir });
			await service.start();
			service.stop();
		});

		it("returns empty stats on creation", () => {
			const service = createCacheInvalidationService({ rootDir: testDir });
			const stats = service.getStats();
			expect(stats.fileChangeEvents).toBe(0);
			expect(stats.gitChangeEvents).toBe(0);
			expect(stats.entriesInvalidated).toBe(0);
			expect(stats.fullClears).toBe(0);
		});

		it("invalidates file manually", async () => {
			const mockCache: ToolResultCache = {
				clear: vi.fn(),
				setGitSha: vi.fn(),
				invalidate: vi.fn(() => 1),
				invalidateGitCaches: vi.fn(() => 0),
				invalidateFileSystemCaches: vi.fn(() => 0),
			} as unknown as ToolResultCache;

			const service = createCacheInvalidationService(
				{ rootDir: testDir },
				mockCache,
			);
			const invalidated = service.invalidateFile(join(testDir, "test.ts"));
			expect(invalidated).toBe(1);
		});

		it("clears all cache manually", async () => {
			const mockCache: ToolResultCache = {
				clear: vi.fn(),
				setGitSha: vi.fn(),
				invalidate: vi.fn(() => 0),
				invalidateGitCaches: vi.fn(() => 0),
				invalidateFileSystemCaches: vi.fn(() => 0),
			} as unknown as ToolResultCache;

			const service = createCacheInvalidationService(
				{ rootDir: testDir },
				mockCache,
			);
			service.clearAll();

			expect(mockCache.clear).toHaveBeenCalled();
			expect(service.getStats().fullClears).toBe(1);
		});

		it("respects enableFileWatch config", async () => {
			const service = createCacheInvalidationService({
				rootDir: testDir,
				enableFileWatch: false,
			});
			await service.start();
			service.stop();
		});

		it("respects enableGitWatch config", async () => {
			const service = createCacheInvalidationService({
				rootDir: testDir,
				enableGitWatch: false,
			});
			await service.start();
			service.stop();
		});

		it("uses custom debounceMs", () => {
			const service = createCacheInvalidationService({
				rootDir: testDir,
				debounceMs: 500,
			});
			expect(service).toBeInstanceOf(CacheInvalidationService);
		});

		it("uses custom fullClearPatterns", () => {
			const service = createCacheInvalidationService({
				rootDir: testDir,
				fullClearPatterns: ["custom.config.js"],
			});
			expect(service).toBeInstanceOf(CacheInvalidationService);
		});
	});

	describe("global service", () => {
		it("initializes global service", async () => {
			const service = await initGlobalCacheInvalidation(testDir);
			expect(service).toBeInstanceOf(CacheInvalidationService);
		});

		it("returns global service after init", async () => {
			await initGlobalCacheInvalidation(testDir);
			const service = getGlobalCacheInvalidation();
			expect(service).toBeInstanceOf(CacheInvalidationService);
		});

		it("returns null before init", () => {
			const service = getGlobalCacheInvalidation();
			expect(service).toBeNull();
		});

		it("resets global service", async () => {
			await initGlobalCacheInvalidation(testDir);
			resetGlobalCacheInvalidation();
			expect(getGlobalCacheInvalidation()).toBeNull();
		});

		it("replaces existing global service on reinit", async () => {
			const service1 = await initGlobalCacheInvalidation(testDir);
			const service2 = await initGlobalCacheInvalidation(testDir);
			expect(service2).toBeInstanceOf(CacheInvalidationService);
		});
	});

	describe("file type mapping", () => {
		it("invalidates TypeScript files correctly", async () => {
			const mockCache: ToolResultCache = {
				clear: vi.fn(),
				setGitSha: vi.fn(),
				invalidate: vi.fn(() => 1),
				invalidateGitCaches: vi.fn(() => 0),
				invalidateFileSystemCaches: vi.fn(() => 0),
			} as unknown as ToolResultCache;

			const service = createCacheInvalidationService(
				{ rootDir: testDir },
				mockCache,
			);
			service.invalidateFile(join(testDir, "component.ts"));

			// Should invalidate read and search caches
			expect(mockCache.invalidate).toHaveBeenCalled();
		});

		it("invalidates JavaScript files correctly", async () => {
			const mockCache: ToolResultCache = {
				clear: vi.fn(),
				setGitSha: vi.fn(),
				invalidate: vi.fn(() => 1),
				invalidateGitCaches: vi.fn(() => 0),
				invalidateFileSystemCaches: vi.fn(() => 0),
			} as unknown as ToolResultCache;

			const service = createCacheInvalidationService(
				{ rootDir: testDir },
				mockCache,
			);
			service.invalidateFile(join(testDir, "script.js"));

			expect(mockCache.invalidate).toHaveBeenCalled();
		});

		it("invalidates Python files correctly", async () => {
			const mockCache: ToolResultCache = {
				clear: vi.fn(),
				setGitSha: vi.fn(),
				invalidate: vi.fn(() => 1),
				invalidateGitCaches: vi.fn(() => 0),
				invalidateFileSystemCaches: vi.fn(() => 0),
			} as unknown as ToolResultCache;

			const service = createCacheInvalidationService(
				{ rootDir: testDir },
				mockCache,
			);
			service.invalidateFile(join(testDir, "script.py"));

			expect(mockCache.invalidate).toHaveBeenCalled();
		});

		it("handles unknown file types", async () => {
			const mockCache: ToolResultCache = {
				clear: vi.fn(),
				setGitSha: vi.fn(),
				invalidate: vi.fn(() => 0),
				invalidateGitCaches: vi.fn(() => 0),
				invalidateFileSystemCaches: vi.fn(() => 1),
			} as unknown as ToolResultCache;

			const service = createCacheInvalidationService(
				{ rootDir: testDir },
				mockCache,
			);
			service.invalidateFile(join(testDir, "data.xyz"));

			// Unknown file types should invalidate all file system caches
			expect(mockCache.invalidateFileSystemCaches).toHaveBeenCalled();
		});
	});
});
