/**
 * Checkpoint Store
 *
 * Manages the storage, retrieval, and restoration of file checkpoints.
 * Supports both in-memory and disk-persisted checkpoints.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "../utils/logger.js";
import type {
	Checkpoint,
	CheckpointEvent,
	CheckpointEventListener,
	CheckpointStoreOptions,
	FileSnapshot,
	RestoreResult,
} from "./types.js";

const logger = createLogger("checkpoints:store");

/**
 * Generates a unique checkpoint ID.
 */
function generateCheckpointId(): string {
	return `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Checkpoint store for managing file snapshots and undo/redo operations.
 */
export class CheckpointStore {
	private checkpoints: Checkpoint[] = [];
	private redoStack: Checkpoint[] = [];
	private currentIndex = -1;
	private options: Required<CheckpointStoreOptions>;
	private listeners: Set<CheckpointEventListener> = new Set();

	constructor(options: CheckpointStoreOptions) {
		this.options = {
			maxCheckpoints: options.maxCheckpoints ?? 50,
			persistToDisk: options.persistToDisk ?? false,
			persistDir:
				options.persistDir ?? join(options.cwd, ".composer", "checkpoints"),
			cwd: options.cwd,
			maxFileSize: options.maxFileSize ?? 1024 * 1024,
		};

		if (this.options.persistToDisk) {
			this.loadFromDisk();
		}
	}

	/**
	 * Add an event listener.
	 */
	addEventListener(listener: CheckpointEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Emit an event to all listeners.
	 */
	private emit(event: CheckpointEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("Checkpoint event listener error", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Take a snapshot of a file.
	 */
	snapshotFile(filePath: string): FileSnapshot | null {
		try {
			const existed = existsSync(filePath);
			let content: string | null = null;

			if (existed) {
				const stats = statSync(filePath);
				if (stats.size > this.options.maxFileSize) {
					// Skip files over configured limit
					logger.debug("Skipping large file for checkpoint", {
						filePath,
						size: stats.size,
					});
					return null;
				}
				content = readFileSync(filePath, "utf-8");
			}

			return {
				path: filePath,
				content,
				existed,
				timestamp: Date.now(),
			};
		} catch (error) {
			logger.warn("Failed to snapshot file", {
				filePath,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Create a new checkpoint before a file operation.
	 */
	createCheckpoint(
		toolName: string,
		toolCallId: string,
		filePaths: string[],
		description?: string,
	): Checkpoint | null {
		const snapshots: FileSnapshot[] = [];

		for (const filePath of filePaths) {
			const snapshot = this.snapshotFile(filePath);
			if (snapshot) {
				snapshots.push(snapshot);
			}
		}

		if (snapshots.length === 0) {
			logger.debug("No files to checkpoint", { toolName, filePaths });
			return null;
		}

		const checkpoint: Checkpoint = {
			id: generateCheckpointId(),
			description: description ?? `Before ${toolName} operation`,
			toolName,
			toolCallId,
			snapshots,
			timestamp: Date.now(),
		};

		// Clear redo stack when new checkpoint is created
		this.redoStack = [];

		// Add checkpoint
		this.checkpoints.push(checkpoint);
		this.currentIndex = this.checkpoints.length - 1;

		// Enforce max checkpoints
		if (this.checkpoints.length > this.options.maxCheckpoints) {
			const removed = this.checkpoints.shift();
			this.currentIndex--;
			logger.debug("Removed old checkpoint", { removedId: removed?.id });
		}

		// Persist if enabled
		if (this.options.persistToDisk) {
			this.saveToDisk();
		}

		this.emit({ type: "checkpoint_created", checkpoint });

		logger.debug("Checkpoint created", {
			id: checkpoint.id,
			toolName,
			fileCount: snapshots.length,
		});

		return checkpoint;
	}

	/**
	 * Restore files to a specific checkpoint.
	 */
	restoreToCheckpoint(checkpointId: string): RestoreResult {
		const checkpointIndex = this.checkpoints.findIndex(
			(cp) => cp.id === checkpointId,
		);

		if (checkpointIndex === -1) {
			return {
				success: false,
				restoredFiles: [],
				failedFiles: [
					{ path: "", error: `Checkpoint ${checkpointId} not found` },
				],
				checkpoint: { id: checkpointId } as Checkpoint,
			};
		}

		const checkpoint = this.checkpoints[checkpointIndex];
		if (!checkpoint) {
			return {
				success: false,
				restoredFiles: [],
				failedFiles: [
					{ path: "", error: `Checkpoint ${checkpointId} not found` },
				],
				checkpoint: { id: checkpointId } as Checkpoint,
			};
		}
		const restoredFiles: string[] = [];
		const failedFiles: Array<{ path: string; error: string }> = [];

		// Snapshot current state before restore (for redo)
		const currentSnapshots: FileSnapshot[] = [];
		for (const snapshot of checkpoint.snapshots) {
			const currentSnapshot = this.snapshotFile(snapshot.path);
			if (currentSnapshot) {
				currentSnapshots.push(currentSnapshot);
			}
		}

		// Push current state to redo stack
		if (currentSnapshots.length > 0) {
			this.redoStack.push({
				id: generateCheckpointId(),
				description: "Before undo",
				toolName: "undo",
				toolCallId: "",
				snapshots: currentSnapshots,
				timestamp: Date.now(),
			});
		}

		// Restore each file
		for (const snapshot of checkpoint.snapshots) {
			try {
				if (snapshot.existed && snapshot.content !== null) {
					// Restore file content
					const dir = dirname(snapshot.path);
					if (!existsSync(dir)) {
						mkdirSync(dir, { recursive: true });
					}
					writeFileSync(snapshot.path, snapshot.content, "utf-8");
					restoredFiles.push(snapshot.path);
				} else if (!snapshot.existed && existsSync(snapshot.path)) {
					// File was created after checkpoint - delete it
					unlinkSync(snapshot.path);
					restoredFiles.push(snapshot.path);
				}
			} catch (error) {
				failedFiles.push({
					path: snapshot.path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Update current index
		this.currentIndex = checkpointIndex - 1;

		// Remove checkpoints after the restored one
		this.checkpoints = this.checkpoints.slice(0, checkpointIndex);

		const result: RestoreResult = {
			success: failedFiles.length === 0,
			restoredFiles,
			failedFiles,
			checkpoint,
		};

		this.emit({ type: "checkpoint_restored", result });

		logger.info("Checkpoint restored", {
			checkpointId,
			restoredCount: restoredFiles.length,
			failedCount: failedFiles.length,
		});

		return result;
	}

	/**
	 * Undo the last operation (restore to previous checkpoint).
	 */
	undo(): RestoreResult | null {
		if (this.checkpoints.length === 0) {
			logger.debug("Nothing to undo");
			return null;
		}

		const lastCheckpoint = this.checkpoints[this.checkpoints.length - 1];
		if (!lastCheckpoint) {
			return null;
		}
		return this.restoreToCheckpoint(lastCheckpoint.id);
	}

	/**
	 * Redo a previously undone operation.
	 */
	redo(): RestoreResult | null {
		if (this.redoStack.length === 0) {
			logger.debug("Nothing to redo");
			return null;
		}

		const redoCheckpoint = this.redoStack.pop();
		if (!redoCheckpoint) {
			return null;
		}
		const restoredFiles: string[] = [];
		const failedFiles: Array<{ path: string; error: string }> = [];

		// Restore each file from redo checkpoint
		for (const snapshot of redoCheckpoint.snapshots) {
			try {
				if (snapshot.existed && snapshot.content !== null) {
					const dir = dirname(snapshot.path);
					if (!existsSync(dir)) {
						mkdirSync(dir, { recursive: true });
					}
					writeFileSync(snapshot.path, snapshot.content, "utf-8");
					restoredFiles.push(snapshot.path);
				} else if (!snapshot.existed && existsSync(snapshot.path)) {
					unlinkSync(snapshot.path);
					restoredFiles.push(snapshot.path);
				}
			} catch (error) {
				failedFiles.push({
					path: snapshot.path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const result: RestoreResult = {
			success: failedFiles.length === 0,
			restoredFiles,
			failedFiles,
			checkpoint: redoCheckpoint,
		};

		this.emit({ type: "checkpoint_restored", result });

		return result;
	}

	/**
	 * Get all checkpoints.
	 */
	getCheckpoints(): Checkpoint[] {
		return [...this.checkpoints];
	}

	/**
	 * Get checkpoint by ID.
	 */
	getCheckpoint(id: string): Checkpoint | undefined {
		return this.checkpoints.find((cp) => cp.id === id);
	}

	/**
	 * Get the current checkpoint index.
	 */
	getCurrentIndex(): number {
		return this.currentIndex;
	}

	/**
	 * Check if undo is available.
	 */
	canUndo(): boolean {
		return this.checkpoints.length > 0;
	}

	/**
	 * Check if redo is available.
	 */
	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/**
	 * Clear all checkpoints.
	 */
	clear(): void {
		const count = this.checkpoints.length;
		this.checkpoints = [];
		this.redoStack = [];
		this.currentIndex = -1;

		if (this.options.persistToDisk) {
			this.saveToDisk();
		}

		this.emit({ type: "checkpoint_cleared", count });
	}

	/**
	 * Save checkpoints to disk.
	 */
	private saveToDisk(): void {
		try {
			const dir = this.options.persistDir;
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}

			const data = {
				checkpoints: this.checkpoints,
				redoStack: this.redoStack,
				currentIndex: this.currentIndex,
				savedAt: Date.now(),
			};

			writeFileSync(
				join(dir, "checkpoints.json"),
				JSON.stringify(data, null, 2),
				"utf-8",
			);
		} catch (error) {
			logger.warn("Failed to save checkpoints to disk", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Load checkpoints from disk.
	 */
	private loadFromDisk(): void {
		try {
			const filePath = join(this.options.persistDir, "checkpoints.json");
			if (!existsSync(filePath)) {
				return;
			}

			const data = JSON.parse(readFileSync(filePath, "utf-8"));
			this.checkpoints = data.checkpoints ?? [];
			this.redoStack = data.redoStack ?? [];
			this.currentIndex = data.currentIndex ?? -1;

			logger.debug("Loaded checkpoints from disk", {
				count: this.checkpoints.length,
			});
		} catch (error) {
			logger.warn("Failed to load checkpoints from disk", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Create a checkpoint store instance.
 */
export function createCheckpointStore(
	options: CheckpointStoreOptions,
): CheckpointStore {
	return new CheckpointStore(options);
}
