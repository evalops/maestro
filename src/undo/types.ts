/**
 * Undo/Rollback system type definitions.
 *
 * Tracks file changes during a session for granular undo operations.
 */

export type ChangeType = "create" | "modify" | "delete";

export interface FileChange {
	/** Unique identifier for this change */
	id: string;
	/** Type of change */
	type: ChangeType;
	/** Absolute file path */
	path: string;
	/** File content before change (null for create) */
	before: string | null;
	/** File content after change (null for delete) */
	after: string | null;
	/** Tool that made the change */
	toolName: string;
	/** Tool call ID */
	toolCallId: string;
	/** Timestamp of change */
	timestamp: number;
	/** Whether this file is tracked by git */
	isGitTracked: boolean;
	/** Associated message ID if available */
	messageId?: string;
}

export interface Checkpoint {
	/** Checkpoint name */
	name: string;
	/** Description */
	description?: string;
	/** Timestamp when checkpoint was created */
	timestamp: number;
	/** Change ID at checkpoint (all changes after this can be undone) */
	changeId: string;
	/** Number of changes at this point */
	changeCount: number;
}

export interface UndoPreview {
	/** Changes that would be undone */
	changes: FileChange[];
	/** Files that would be restored */
	restores: Array<{
		path: string;
		action: "restore" | "delete" | "recreate";
	}>;
	/** Conflicts (file changed externally) */
	conflicts: Array<{
		path: string;
		reason: string;
	}>;
}

export interface ChangeTrackerState {
	/** All tracked changes, oldest first */
	changes: FileChange[];
	/** Named checkpoints */
	checkpoints: Checkpoint[];
	/** Maximum changes to keep */
	maxChanges: number;
}
