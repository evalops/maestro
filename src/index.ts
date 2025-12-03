export { main } from "./main.js";
export { SessionManager } from "./session/manager.js";
export {
	askUserTool,
	bashTool,
	backgroundTasksTool,
	codingTools,
	editTool,
	notebookEditTool,
	readTool,
	todoTool,
	writeTool,
	// Tool result caching
	ToolResultCache,
	createToolResultCache,
	getGlobalToolResultCache,
} from "./tools/index.js";
export {
	recordEvaluationResult,
	recordToolExecution,
} from "./telemetry.js";

// SDK tool types for external consumers
export * from "./sdk-tools.js";

// Distributed lock manager for concurrent operations
export {
	DistributedLockManager,
	createLockManager,
	getGlobalLockManager,
	resetGlobalLockManager,
	withLock,
	type LockResult,
	type LockInfo,
	type LockOptions,
	type LockManagerConfig,
} from "./db/distributed-lock-manager.js";
