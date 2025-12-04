/**
 * File change tracker for undo/rollback functionality.
 *
 * Tracks file modifications made by tools during a session,
 * enabling granular undo operations beyond git.
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../utils/logger.js";
import type {
	ChangeTrackerState,
	ChangeType,
	Checkpoint,
	FileChange,
	UndoPreview,
} from "./types.js";

const logger = createLogger("undo:tracker");

const DEFAULT_MAX_CHANGES = 100;

/**
 * Generates a unique change ID.
 */
function generateChangeId(): string {
	return `chg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Check if a path is inside a git repository.
 */
function isGitTracked(filePath: string): boolean {
	try {
		const dir = dirname(filePath);
		execSync("git rev-parse --git-dir", {
			cwd: dir,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * File change tracker for session-based undo.
 */
export class ChangeTracker {
	private state: ChangeTrackerState;

	constructor(maxChanges = DEFAULT_MAX_CHANGES) {
		this.state = {
			changes: [],
			checkpoints: [],
			maxChanges,
		};
	}

	/**
	 * Record a file change before it happens.
	 * Call this BEFORE writing/modifying/deleting a file.
	 */
	recordChange(
		path: string,
		type: ChangeType,
		toolName: string,
		toolCallId: string,
		messageId?: string,
	): string {
		// Read current content before change
		let before: string | null = null;
		if (type !== "create" && existsSync(path)) {
			try {
				before = readFileSync(path, "utf-8");
			} catch (error) {
				logger.warn("Failed to read file for undo tracking", {
					path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const change: FileChange = {
			id: generateChangeId(),
			type,
			path,
			before,
			after: null, // Will be set after the change
			toolName,
			toolCallId,
			timestamp: Date.now(),
			isGitTracked: isGitTracked(path),
			messageId,
		};

		this.state.changes.push(change);

		// Trim old changes if over limit
		while (this.state.changes.length > this.state.maxChanges) {
			this.state.changes.shift();
		}

		logger.debug("Recorded change", {
			id: change.id,
			type,
			path,
			toolName,
		});

		return change.id;
	}

	/**
	 * Finalize a change after it completes.
	 * Call this AFTER writing/modifying a file to capture the new content.
	 */
	finalizeChange(changeId: string): void {
		const change = this.state.changes.find((c) => c.id === changeId);
		if (!change) {
			logger.warn("Change not found for finalization", { changeId });
			return;
		}

		if (change.type !== "delete" && existsSync(change.path)) {
			try {
				change.after = readFileSync(change.path, "utf-8");
			} catch (error) {
				logger.warn("Failed to read file after change", {
					path: change.path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Get all changes, optionally filtered.
	 */
	getChanges(options?: {
		toolName?: string;
		sinceTimestamp?: number;
		path?: string;
	}): FileChange[] {
		let changes = [...this.state.changes];

		if (options?.toolName) {
			changes = changes.filter((c) => c.toolName === options.toolName);
		}
		if (options?.sinceTimestamp) {
			const since = options.sinceTimestamp;
			changes = changes.filter((c) => c.timestamp >= since);
		}
		if (options?.path) {
			changes = changes.filter((c) => c.path === options.path);
		}

		return changes;
	}

	/**
	 * Get the last N changes.
	 */
	getLastChanges(count: number): FileChange[] {
		return this.state.changes.slice(-count);
	}

	/**
	 * Preview what would be undone.
	 */
	previewUndo(count: number): UndoPreview {
		const changesToUndo = this.getLastChanges(count).reverse();
		const restores: UndoPreview["restores"] = [];
		const conflicts: UndoPreview["conflicts"] = [];

		for (const change of changesToUndo) {
			// Check for conflicts (file changed externally)
			if (existsSync(change.path)) {
				try {
					const currentContent = readFileSync(change.path, "utf-8");
					if (change.after !== null && currentContent !== change.after) {
						conflicts.push({
							path: change.path,
							reason: "File has been modified since the tracked change",
						});
						continue;
					}
				} catch {
					// File exists but can't be read
				}
			}

			switch (change.type) {
				case "create":
					restores.push({ path: change.path, action: "delete" });
					break;
				case "modify":
					restores.push({ path: change.path, action: "restore" });
					break;
				case "delete":
					restores.push({ path: change.path, action: "recreate" });
					break;
			}
		}

		return {
			changes: changesToUndo,
			restores,
			conflicts,
		};
	}

	/**
	 * Undo the last N changes.
	 * Returns the number of changes successfully undone.
	 */
	undo(
		count: number,
		force = false,
	): {
		undone: number;
		skipped: number;
		errors: string[];
	} {
		const preview = this.previewUndo(count);
		const errors: string[] = [];
		let undone = 0;
		let skipped = 0;

		if (preview.conflicts.length > 0 && !force) {
			return {
				undone: 0,
				skipped: preview.conflicts.length,
				errors: preview.conflicts.map((c) => `${c.path}: ${c.reason}`),
			};
		}

		const changesToUndo = this.getLastChanges(count).reverse();

		for (const change of changesToUndo) {
			try {
				switch (change.type) {
					case "create":
						// Delete the created file
						if (existsSync(change.path)) {
							unlinkSync(change.path);
							undone++;
						} else {
							skipped++;
						}
						break;

					case "modify":
						// Restore previous content
						if (change.before !== null) {
							writeFileSync(change.path, change.before, "utf-8");
							undone++;
						} else {
							skipped++;
							errors.push(`${change.path}: No previous content recorded`);
						}
						break;

					case "delete":
						// Recreate the deleted file
						if (change.before !== null) {
							mkdirSync(dirname(change.path), { recursive: true });
							writeFileSync(change.path, change.before, "utf-8");
							undone++;
						} else {
							skipped++;
							errors.push(`${change.path}: No content to restore`);
						}
						break;
				}

				// Remove the change from tracking
				const idx = this.state.changes.findIndex((c) => c.id === change.id);
				if (idx !== -1) {
					this.state.changes.splice(idx, 1);
				}
			} catch (error) {
				errors.push(
					`${change.path}: ${error instanceof Error ? error.message : String(error)}`,
				);
				skipped++;
			}
		}

		logger.info("Undo complete", { undone, skipped, errors: errors.length });

		return { undone, skipped, errors };
	}

	/**
	 * Create a named checkpoint.
	 */
	createCheckpoint(name: string, description?: string): Checkpoint {
		const lastChange = this.state.changes[this.state.changes.length - 1];
		const checkpoint: Checkpoint = {
			name,
			description,
			timestamp: Date.now(),
			changeId: lastChange?.id ?? "",
			changeCount: this.state.changes.length,
		};

		// Remove existing checkpoint with same name
		this.state.checkpoints = this.state.checkpoints.filter(
			(cp) => cp.name !== name,
		);
		this.state.checkpoints.push(checkpoint);

		logger.info("Checkpoint created", {
			name,
			changeCount: checkpoint.changeCount,
		});

		return checkpoint;
	}

	/**
	 * Get all checkpoints.
	 */
	getCheckpoints(): Checkpoint[] {
		return [...this.state.checkpoints];
	}

	/**
	 * Restore to a checkpoint (undo all changes after it).
	 */
	restoreCheckpoint(
		name: string,
		force = false,
	): {
		undone: number;
		skipped: number;
		errors: string[];
	} {
		const checkpoint = this.state.checkpoints.find((cp) => cp.name === name);
		if (!checkpoint) {
			return {
				undone: 0,
				skipped: 0,
				errors: [`Checkpoint not found: ${name}`],
			};
		}

		// Find how many changes to undo
		const checkpointIdx = this.state.changes.findIndex(
			(c) => c.id === checkpoint.changeId,
		);
		const changesToUndo =
			checkpointIdx === -1
				? this.state.changes.length
				: this.state.changes.length - checkpointIdx - 1;

		if (changesToUndo <= 0) {
			return { undone: 0, skipped: 0, errors: [] };
		}

		return this.undo(changesToUndo, force);
	}

	/**
	 * Clear all tracked changes.
	 */
	clear(): void {
		this.state.changes = [];
		this.state.checkpoints = [];
		logger.info("Change tracker cleared");
	}

	/**
	 * Get tracker statistics.
	 */
	getStats(): {
		totalChanges: number;
		checkpoints: number;
		byTool: Record<string, number>;
		byType: Record<ChangeType, number>;
	} {
		const byTool: Record<string, number> = {};
		const byType: Record<ChangeType, number> = {
			create: 0,
			modify: 0,
			delete: 0,
		};

		for (const change of this.state.changes) {
			byTool[change.toolName] = (byTool[change.toolName] ?? 0) + 1;
			byType[change.type]++;
		}

		return {
			totalChanges: this.state.changes.length,
			checkpoints: this.state.checkpoints.length,
			byTool,
			byType,
		};
	}

	/**
	 * Export state for persistence.
	 */
	export(): ChangeTrackerState {
		return { ...this.state };
	}

	/**
	 * Import state from persistence.
	 */
	import(state: ChangeTrackerState): void {
		this.state = { ...state };
	}
}

// Singleton instance for global tracking
let globalTracker: ChangeTracker | null = null;

export function getChangeTracker(): ChangeTracker {
	if (!globalTracker) {
		globalTracker = new ChangeTracker();
	}
	return globalTracker;
}

export function resetChangeTracker(): void {
	globalTracker = null;
}
