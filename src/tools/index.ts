import { backgroundTasksTool } from "./background-tasks.js";
// Shell execution (bash -lc) with support for cwd tracking during bash mode
import { bashTool } from "./bash.js";
// Parallel tool execution for reads/searches/listings
import { createBatchTool } from "./batch.js";
// Exa Code API for programming context (optional - requires EXA_API_KEY)
import { codesearchTool } from "./codesearch.js";
// Git diff inspection (workspace/staged/custom ranges)
import { diffTool } from "./diff.js";
// Structured find/replace editing
import { editTool } from "./edit.js";
// GitHub CLI tools (requires gh CLI)
import { ghIssueTool, ghPrTool, ghRepoTool } from "./gh.js";
// Directory listing / globbing
import { listTool } from "./list.js";
// File reader with range support
import { readTool } from "./read.js";
// Ripgrep-style search
import { searchTool } from "./search.js";
import { statusTool } from "./status.js";
// TodoWrite checklist helper
import { todoTool } from "./todo.js";
// Exa web content fetching (optional - requires EXA_API_KEY)
import { webfetchTool } from "./webfetch.js";
// Exa web search (optional - requires EXA_API_KEY)
import { websearchTool } from "./websearch.js";
// Free-form file writer (create/overwrite)
import { writeTool } from "./write.js";

export { bashTool } from "./bash.js";
export { backgroundTasksTool } from "./background-tasks.js";
export { createBatchTool } from "./batch.js";
export { codesearchTool } from "./codesearch.js";
export { diffTool } from "./diff.js";
export { editTool } from "./edit.js";
export { listTool } from "./list.js";
export { readTool } from "./read.js";
export { searchTool } from "./search.js";
export { todoTool } from "./todo.js";
export { webfetchTool } from "./webfetch.js";
export { websearchTool } from "./websearch.js";
export { writeTool } from "./write.js";
export { statusTool } from "./status.js";
export { ghIssueTool, ghPrTool, ghRepoTool } from "./gh.js";

// Create batch tool with all available tools (excluding batch itself)
// Note: GitHub tools are included for read-only operations (list, view)
// but the batch tool will still validate they're not doing mutations
const allTools = [
	readTool,
	listTool,
	searchTool,
	diffTool,
	bashTool,
	backgroundTasksTool,
	editTool,
	writeTool,
	todoTool,
	websearchTool,
	codesearchTool,
	webfetchTool,
	statusTool,
	ghPrTool,
	ghIssueTool,
	ghRepoTool,
];

export const batchTool = createBatchTool(allTools);

export const codingTools = [
	batchTool,
	readTool,
	listTool,
	searchTool,
	diffTool,
	bashTool,
	backgroundTasksTool,
	editTool,
	writeTool,
	todoTool,
	websearchTool,
	codesearchTool,
	webfetchTool,
	statusTool,
	// GitHub CLI tools
	ghPrTool,
	ghIssueTool,
	ghRepoTool,
];
