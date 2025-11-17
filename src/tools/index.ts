// Shell execution (bash -lc) with support for cwd tracking during bash mode
import { bashTool } from "./bash.js";
// Parallel tool execution for reads/searches/listings
import { createBatchTool } from "./batch.js";
// Git diff inspection (workspace/staged/custom ranges)
import { diffTool } from "./diff.js";
// Structured find/replace editing
import { editTool } from "./edit.js";
// Directory listing / globbing
import { listTool } from "./list.js";
// File reader with range support
import { readTool } from "./read.js";
// Ripgrep-style search
import { searchTool } from "./search.js";
// TodoWrite checklist helper
import { todoTool } from "./todo.js";
// Free-form file writer (create/overwrite)
import { writeTool } from "./write.js";

export { createBatchTool } from "./batch.js";
export { bashTool } from "./bash.js";
export { diffTool } from "./diff.js";
export { editTool } from "./edit.js";
export { listTool } from "./list.js";
export { readTool } from "./read.js";
export { searchTool } from "./search.js";
export { todoTool } from "./todo.js";
export { writeTool } from "./write.js";

// Create batch tool with all available tools (excluding batch itself)
const allTools = [
	readTool,
	listTool,
	searchTool,
	diffTool,
	bashTool,
	editTool,
	writeTool,
	todoTool,
];

export const batchTool = createBatchTool(allTools);

export const codingTools = [
	batchTool,
	readTool,
	listTool,
	searchTool,
	diffTool,
	bashTool,
	editTool,
	writeTool,
	todoTool,
];
