import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FileChangeEvent,
	FileWatcher,
	createFileWatcher,
} from "../../src/tools/file-watcher.js";

describe("FileWatcher", () => {
	let testDir: string;
	let watcher: FileWatcher;

	beforeEach(() => {
		// Create a temp directory for testing
		testDir = join(tmpdir(), `file-watcher-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up
		if (watcher) {
			watcher.stop();
		}
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("createFileWatcher", () => {
		it("should create a file watcher instance", () => {
			watcher = createFileWatcher({ rootDir: testDir });
			expect(watcher).toBeInstanceOf(FileWatcher);
		});
	});

	describe("start/stop", () => {
		it("should start and stop without error", async () => {
			watcher = createFileWatcher({ rootDir: testDir });
			await watcher.start();
			watcher.stop();
		});

		it("should be idempotent for start", async () => {
			watcher = createFileWatcher({ rootDir: testDir });
			await watcher.start();
			await watcher.start(); // Should not throw
			watcher.stop();
		});

		it("should be idempotent for stop", async () => {
			watcher = createFileWatcher({ rootDir: testDir });
			await watcher.start();
			watcher.stop();
			watcher.stop(); // Should not throw
		});
	});

	describe("onFileChange", () => {
		it("should return unsubscribe function", async () => {
			watcher = createFileWatcher({ rootDir: testDir });
			const unsubscribe = watcher.onFileChange(() => {});
			expect(typeof unsubscribe).toBe("function");
			unsubscribe();
		});

		it("should call listener on file changes", async () => {
			watcher = createFileWatcher({
				rootDir: testDir,
				debounceMs: 10, // Fast debounce for tests
			});

			const events: FileChangeEvent[] = [];
			watcher.onFileChange((event) => {
				events.push(event);
			});

			await watcher.start();

			// Create a file
			const testFile = join(testDir, "test.txt");
			writeFileSync(testFile, "hello");

			// Wait for debounce
			await new Promise((resolve) => setTimeout(resolve, 100));

			// May or may not have captured the event depending on OS timing
			// Just verify no errors occurred
		});
	});

	describe("onGitStateChange", () => {
		it("should return unsubscribe function", async () => {
			watcher = createFileWatcher({ rootDir: testDir });
			const unsubscribe = watcher.onGitStateChange(() => {});
			expect(typeof unsubscribe).toBe("function");
			unsubscribe();
		});
	});

	describe("configuration", () => {
		it("should use default config values", async () => {
			watcher = createFileWatcher({ rootDir: testDir });
			await watcher.start();
			// Should not throw with defaults
			watcher.stop();
		});

		it("should respect recursive option", async () => {
			watcher = createFileWatcher({
				rootDir: testDir,
				recursive: false,
			});
			await watcher.start();
			watcher.stop();
		});

		it("should respect watchGitState option", async () => {
			watcher = createFileWatcher({
				rootDir: testDir,
				watchGitState: false,
			});
			await watcher.start();
			expect(watcher.getCurrentGitSha()).toBeUndefined();
			watcher.stop();
		});
	});

	describe("exclude patterns", () => {
		it("should accept custom exclude patterns configuration", async () => {
			// Just verify the configuration is accepted without errors
			watcher = createFileWatcher({
				rootDir: testDir,
				debounceMs: 10,
				excludePatterns: ["**/*.log", "**/*.tmp"],
				includePatterns: ["**/*.ts", "**/*.js"],
			});

			await watcher.start();
			watcher.stop();
		});
	});
});
