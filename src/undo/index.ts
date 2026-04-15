/**
 * Undo/Rollback module.
 *
 * Provides file change tracking and undo operations beyond git.
 *
 * @example
 * ```typescript
 * import { getChangeTracker } from "./undo";
 *
 * const tracker = getChangeTracker();
 *
 * // Before making a change
 * const changeId = tracker.recordChange(
 *   "/path/to/file.ts",
 *   "modify",
 *   "edit",
 *   "tool-call-123"
 * );
 *
 * // After the change completes
 * tracker.finalizeChange(changeId);
 *
 * // Later: undo the last 3 changes
 * const result = tracker.undo(3);
 * ```
 */

export {
	ChangeTracker,
	getChangeTracker,
	resetChangeTracker,
} from "./tracker.js";

export type {
	FileChange,
	ChangeType,
	Checkpoint,
	UndoPreview,
	ChangeTrackerState,
} from "./types.js";
