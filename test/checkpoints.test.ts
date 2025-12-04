/**
 * Tests for the File Checkpointing System
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Checkpoint,
	type CheckpointConfig,
	type CheckpointEvent,
	type CheckpointStore,
	DEFAULT_CHECKPOINT_CONFIG,
	type FileSnapshot,
	createCheckpointStore,
} from "../src/checkpoints/index.js";

// Create a unique temp directory for each test
function createTempDir(): string {
	const dir = join(
		tmpdir(),
		`checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// Clean up temp directory
function cleanupTempDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

describe("Checkpoint System", () => {
	describe("CheckpointStore", () => {
		let tempDir: string;
		let store: CheckpointStore;

		beforeEach(() => {
			tempDir = createTempDir();
			store = createCheckpointStore({ cwd: tempDir });
		});

		afterEach(() => {
			cleanupTempDir(tempDir);
		});

		describe("snapshotFile", () => {
			it("should snapshot existing file content", () => {
				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "original content", "utf-8");

				const snapshot = store.snapshotFile(filePath);

				expect(snapshot).not.toBeNull();
				expect(snapshot?.path).toBe(filePath);
				expect(snapshot?.content).toBe("original content");
				expect(snapshot?.existed).toBe(true);
			});

			it("should snapshot non-existent file", () => {
				const filePath = join(tempDir, "nonexistent.txt");

				const snapshot = store.snapshotFile(filePath);

				expect(snapshot).not.toBeNull();
				expect(snapshot?.path).toBe(filePath);
				expect(snapshot?.content).toBeNull();
				expect(snapshot?.existed).toBe(false);
			});

			it("should skip files larger than 1MB", () => {
				const filePath = join(tempDir, "large.txt");
				// Create a file larger than 1MB
				writeFileSync(filePath, "x".repeat(1024 * 1024 + 100), "utf-8");

				const snapshot = store.snapshotFile(filePath);

				expect(snapshot).toBeNull();
			});
		});

		describe("createCheckpoint", () => {
			it("should create checkpoint with file snapshots", () => {
				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "content", "utf-8");

				const checkpoint = store.createCheckpoint(
					"Write",
					"call-123",
					[filePath],
					"Test checkpoint",
				);

				expect(checkpoint).not.toBeNull();
				expect(checkpoint?.toolName).toBe("Write");
				expect(checkpoint?.toolCallId).toBe("call-123");
				expect(checkpoint?.description).toBe("Test checkpoint");
				expect(checkpoint?.snapshots).toHaveLength(1);
				expect(checkpoint?.snapshots[0].content).toBe("content");
			});

			it("should return null when no files can be snapshotted", () => {
				const checkpoint = store.createCheckpoint("Write", "call-123", [
					join(tempDir, "nonexistent-dir", "file.txt"),
				]);

				// Non-existent files in non-existent directories should still create snapshots
				// Actually, let's test with large files
				const largePath = join(tempDir, "large.txt");
				writeFileSync(largePath, "x".repeat(1024 * 1024 + 100), "utf-8");

				const checkpoint2 = store.createCheckpoint("Write", "call-456", [
					largePath,
				]);

				expect(checkpoint2).toBeNull();
			});

			it("should clear redo stack when new checkpoint is created", () => {
				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "v1", "utf-8");
				store.createCheckpoint("Write", "call-1", [filePath]);

				writeFileSync(filePath, "v2", "utf-8");
				store.createCheckpoint("Write", "call-2", [filePath]);

				// Undo to restore v1
				store.undo();
				expect(store.canRedo()).toBe(true);

				// Create new checkpoint - should clear redo
				writeFileSync(filePath, "v3", "utf-8");
				store.createCheckpoint("Write", "call-3", [filePath]);

				expect(store.canRedo()).toBe(false);
			});

			it("should emit checkpoint_created event", () => {
				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "content", "utf-8");

				let emittedEvent: CheckpointEvent | null = null;
				store.addEventListener((event) => {
					emittedEvent = event as { type: string; checkpoint?: Checkpoint };
				});

				store.createCheckpoint("Write", "call-123", [filePath]);

				expect(emittedEvent).not.toBeNull();
				// biome-ignore lint/style/noNonNullAssertion: Validated by expect above
				expect(emittedEvent!.type).toBe("checkpoint_created");
				// biome-ignore lint/style/noNonNullAssertion: Validated by expect above
				expect(emittedEvent!.checkpoint?.toolName).toBe("Write");
			});
		});

		describe("undo/redo", () => {
			it("should undo file changes", () => {
				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "original", "utf-8");

				// Create checkpoint before change
				store.createCheckpoint("Write", "call-1", [filePath]);

				// Simulate file change
				writeFileSync(filePath, "modified", "utf-8");
				expect(readFileSync(filePath, "utf-8")).toBe("modified");

				// Undo
				const result = store.undo();

				expect(result?.success).toBe(true);
				expect(result?.restoredFiles).toContain(filePath);
				expect(readFileSync(filePath, "utf-8")).toBe("original");
			});

			it("should redo previously undone changes", () => {
				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "original", "utf-8");

				store.createCheckpoint("Write", "call-1", [filePath]);
				writeFileSync(filePath, "modified", "utf-8");

				// Undo
				store.undo();
				expect(readFileSync(filePath, "utf-8")).toBe("original");

				// Redo
				const result = store.redo();

				expect(result?.success).toBe(true);
				expect(readFileSync(filePath, "utf-8")).toBe("modified");
			});

			it("should return null when nothing to undo", () => {
				const result = store.undo();
				expect(result).toBeNull();
			});

			it("should return null when nothing to redo", () => {
				const result = store.redo();
				expect(result).toBeNull();
			});

			it("should handle multiple undo operations", () => {
				const filePath = join(tempDir, "test.txt");

				// v1
				writeFileSync(filePath, "v1", "utf-8");
				store.createCheckpoint("Write", "call-1", [filePath]);

				// v2
				writeFileSync(filePath, "v2", "utf-8");
				store.createCheckpoint("Write", "call-2", [filePath]);

				// v3
				writeFileSync(filePath, "v3", "utf-8");
				store.createCheckpoint("Write", "call-3", [filePath]);

				// Current state is v3
				writeFileSync(filePath, "v4", "utf-8");

				// Undo to v3
				store.undo();
				expect(readFileSync(filePath, "utf-8")).toBe("v3");

				// Undo to v2
				store.undo();
				expect(readFileSync(filePath, "utf-8")).toBe("v2");

				// Undo to v1
				store.undo();
				expect(readFileSync(filePath, "utf-8")).toBe("v1");
			});

			it("should handle undo of file creation", () => {
				const filePath = join(tempDir, "new-file.txt");

				// Checkpoint before file exists
				store.createCheckpoint("Write", "call-1", [filePath]);

				// Create the file
				writeFileSync(filePath, "new content", "utf-8");
				expect(existsSync(filePath)).toBe(true);

				// Undo - should delete the file
				store.undo();
				expect(existsSync(filePath)).toBe(false);
			});
		});

		describe("restoreToCheckpoint", () => {
			it("should restore to specific checkpoint", () => {
				const filePath = join(tempDir, "test.txt");

				writeFileSync(filePath, "v1", "utf-8");
				const cp1 = store.createCheckpoint("Write", "call-1", [filePath]);

				writeFileSync(filePath, "v2", "utf-8");
				store.createCheckpoint("Write", "call-2", [filePath]);

				writeFileSync(filePath, "v3", "utf-8");
				store.createCheckpoint("Write", "call-3", [filePath]);

				writeFileSync(filePath, "v4", "utf-8");

				// Restore directly to cp1
				expect(cp1).toBeDefined();
				if (!cp1) throw new Error("cp1 should be defined");
				const result = store.restoreToCheckpoint(cp1.id);

				expect(result.success).toBe(true);
				expect(readFileSync(filePath, "utf-8")).toBe("v1");
			});

			it("should return error for non-existent checkpoint", () => {
				const result = store.restoreToCheckpoint("nonexistent-id");

				expect(result.success).toBe(false);
				expect(result.failedFiles[0].error).toContain("not found");
			});
		});

		describe("getCheckpoints", () => {
			it("should return all checkpoints", () => {
				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "content", "utf-8");

				store.createCheckpoint("Write", "call-1", [filePath]);
				store.createCheckpoint("Edit", "call-2", [filePath]);
				store.createCheckpoint("Bash", "call-3", [filePath]);

				const checkpoints = store.getCheckpoints();

				expect(checkpoints).toHaveLength(3);
				expect(checkpoints[0].toolName).toBe("Write");
				expect(checkpoints[1].toolName).toBe("Edit");
				expect(checkpoints[2].toolName).toBe("Bash");
			});
		});

		describe("clear", () => {
			it("should clear all checkpoints", () => {
				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "content", "utf-8");

				store.createCheckpoint("Write", "call-1", [filePath]);
				store.createCheckpoint("Edit", "call-2", [filePath]);

				expect(store.getCheckpoints()).toHaveLength(2);

				store.clear();

				expect(store.getCheckpoints()).toHaveLength(0);
				expect(store.canUndo()).toBe(false);
				expect(store.canRedo()).toBe(false);
			});
		});

		describe("maxCheckpoints", () => {
			it("should enforce maximum checkpoints limit", () => {
				const store2 = createCheckpointStore({
					cwd: tempDir,
					maxCheckpoints: 3,
				});
				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "content", "utf-8");

				store2.createCheckpoint("Write", "call-1", [filePath]);
				store2.createCheckpoint("Write", "call-2", [filePath]);
				store2.createCheckpoint("Write", "call-3", [filePath]);
				store2.createCheckpoint("Write", "call-4", [filePath]);

				const checkpoints = store2.getCheckpoints();

				expect(checkpoints).toHaveLength(3);
				expect(checkpoints[0].toolCallId).toBe("call-2"); // First one was removed
			});
		});

		describe("persistence", () => {
			it("should persist checkpoints to disk when enabled", () => {
				const persistDir = join(tempDir, ".composer", "checkpoints");
				const store2 = createCheckpointStore({
					cwd: tempDir,
					persistToDisk: true,
					persistDir,
				});

				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "content", "utf-8");

				store2.createCheckpoint("Write", "call-1", [filePath]);

				expect(existsSync(join(persistDir, "checkpoints.json"))).toBe(true);
			});

			it("should load checkpoints from disk", () => {
				const persistDir = join(tempDir, ".composer", "checkpoints");
				const filePath = join(tempDir, "test.txt");
				writeFileSync(filePath, "content", "utf-8");

				// Create and persist
				const store2 = createCheckpointStore({
					cwd: tempDir,
					persistToDisk: true,
					persistDir,
				});
				store2.createCheckpoint("Write", "call-1", [filePath]);

				// Load in new instance
				const store3 = createCheckpointStore({
					cwd: tempDir,
					persistToDisk: true,
					persistDir,
				});

				expect(store3.getCheckpoints()).toHaveLength(1);
				expect(store3.getCheckpoints()[0].toolCallId).toBe("call-1");
			});
		});
	});

	describe("DEFAULT_CHECKPOINT_CONFIG", () => {
		it("should have sensible defaults", () => {
			expect(DEFAULT_CHECKPOINT_CONFIG.enabled).toBe(true);
			expect(DEFAULT_CHECKPOINT_CONFIG.triggerTools).toContain("Write");
			expect(DEFAULT_CHECKPOINT_CONFIG.triggerTools).toContain("Edit");
			expect(DEFAULT_CHECKPOINT_CONFIG.triggerTools).toContain("Bash");
			expect(DEFAULT_CHECKPOINT_CONFIG.excludePatterns).toContain(
				"**/node_modules/**",
			);
			expect(DEFAULT_CHECKPOINT_CONFIG.maxFileSize).toBe(1024 * 1024);
		});
	});
});
