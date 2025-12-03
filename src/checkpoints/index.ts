/**
 * File Checkpointing System
 *
 * Provides undo/redo functionality for file changes made during agent sessions.
 *
 * ## Overview
 *
 * The checkpointing system automatically takes snapshots of files before they
 * are modified by tools (Write, Edit, Bash, NotebookEdit). These snapshots
 * enable users to undo changes if something goes wrong.
 *
 * ## Usage
 *
 * ```typescript
 * import { initCheckpointService, getCheckpointService } from './checkpoints';
 *
 * // Initialize at session start
 * initCheckpointService(process.cwd());
 *
 * // Later, undo the last change
 * const service = getCheckpointService();
 * if (service?.canUndo()) {
 *   const result = service.undo();
 *   console.log(result.message);
 * }
 * ```
 *
 * ## Configuration
 *
 * The checkpointing system can be configured or disabled:
 *
 * - Set `COMPOSER_DISABLE_FILE_CHECKPOINTING=1` to disable checkpointing
 * - Configure trigger tools and exclude patterns via CheckpointConfig
 *
 * ## How It Works
 *
 * 1. A PreToolUse hook is registered for file-modifying tools
 * 2. Before each operation, the current file content is snapshotted
 * 3. Snapshots are stored in memory (optionally persisted to disk)
 * 4. Users can undo/redo changes via slash commands
 *
 * @module checkpoints
 */

// Types
export type {
	Checkpoint,
	CheckpointConfig,
	CheckpointEvent,
	CheckpointEventListener,
	CheckpointStoreOptions,
	FileSnapshot,
	RestoreResult,
} from "./types.js";

export { DEFAULT_CHECKPOINT_CONFIG } from "./types.js";

// Store
export { CheckpointStore, createCheckpointStore } from "./store.js";

// Service
export {
	CheckpointService,
	disposeCheckpointService,
	getCheckpointService,
	initCheckpointService,
} from "./service.js";
