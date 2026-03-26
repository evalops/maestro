/**
 * File Checkpointing System Types
 *
 * Enables undo/redo of file changes made during agent sessions.
 * Snapshots are taken before destructive operations (Write, Edit, Bash writes).
 */

/**
 * A snapshot of a single file's content at a point in time.
 */
export interface FileSnapshot {
	/** Absolute path to the file */
	path: string;
	/** File content at snapshot time, or null if file didn't exist */
	content: string | null;
	/** Whether the file existed at snapshot time */
	existed: boolean;
	/** Timestamp when snapshot was taken */
	timestamp: number;
}

/**
 * A checkpoint represents the state of all tracked files at a point in time.
 * Created before each tool execution that modifies files.
 */
export interface Checkpoint {
	/** Unique identifier for this checkpoint */
	id: string;
	/** Human-readable description of what triggered this checkpoint */
	description: string;
	/** Tool that triggered this checkpoint (e.g., "Write", "Edit", "Bash") */
	toolName: string;
	/** Tool call ID that triggered this checkpoint */
	toolCallId: string;
	/** Snapshots of all files that will be/were modified */
	snapshots: FileSnapshot[];
	/** Timestamp when checkpoint was created */
	timestamp: number;
	/** Index in the conversation where this checkpoint was created */
	conversationIndex?: number;
}

/**
 * Result of a restore operation.
 */
export interface RestoreResult {
	/** Whether the restore succeeded */
	success: boolean;
	/** Files that were restored */
	restoredFiles: string[];
	/** Files that failed to restore */
	failedFiles: Array<{ path: string; error: string }>;
	/** The checkpoint that was restored to */
	checkpoint: Checkpoint;
}

/**
 * Options for the checkpoint store.
 */
export interface CheckpointStoreOptions {
	/** Maximum number of checkpoints to keep in memory */
	maxCheckpoints?: number;
	/** Whether to persist checkpoints to disk */
	persistToDisk?: boolean;
	/** Directory to persist checkpoints to (default: .maestro/checkpoints) */
	persistDir?: string;
	/** Working directory for the project */
	cwd: string;
	/** Maximum file size to snapshot (in bytes) */
	maxFileSize?: number;
}

/**
 * Configuration for checkpoint behavior.
 */
export interface CheckpointConfig {
	/** Whether checkpointing is enabled */
	enabled: boolean;
	/** Tools that should trigger checkpoints */
	triggerTools: string[];
	/** File patterns to exclude from checkpointing */
	excludePatterns: string[];
	/** Maximum file size to snapshot (in bytes) */
	maxFileSize: number;
}

/**
 * Default checkpoint configuration.
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
	enabled: true,
	triggerTools: ["Write", "Edit", "Bash", "NotebookEdit"],
	excludePatterns: [
		"**/node_modules/**",
		"**/.git/**",
		"**/dist/**",
		"**/build/**",
		"**/*.lock",
		"**/package-lock.json",
		"**/bun.lockb",
	],
	maxFileSize: 1024 * 1024, // 1MB
};

/**
 * Events emitted by the checkpoint system.
 */
export type CheckpointEvent =
	| { type: "checkpoint_created"; checkpoint: Checkpoint }
	| { type: "checkpoint_restored"; result: RestoreResult }
	| { type: "checkpoint_cleared"; count: number };

/**
 * Listener for checkpoint events.
 */
export type CheckpointEventListener = (event: CheckpointEvent) => void;
