// Structured user questions
import { askUserTool } from "./ask-user.js";
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
// Fast file finder using fd
import { findTool } from "./find.js";
// GitHub CLI tools (requires gh CLI)
import { ghIssueTool, ghPrTool, ghRepoTool } from "./gh.js";
// Directory listing / globbing
import { listTool } from "./list.js";
// Jupyter notebook editing
import { notebookEditTool } from "./notebook.js";
import { oracleTool } from "./oracle.js";
import { parallelRipgrepTool } from "./parallel-ripgrep.js";
// File reader with range support
import { readTool } from "./read.js";
// Ripgrep-style search
import { searchTool } from "./search.js";
import { statusTool } from "./status.js";
// TodoWrite checklist helper
import { todoTool } from "./todo.js";
import {
	vscodeFindReferencesTool,
	vscodeGetDefinitionTool,
	vscodeGetDiagnosticsTool,
	vscodeReadFileRangeTool,
} from "./vscode.js";
// Exa web content fetching (optional - requires EXA_API_KEY)
import { webfetchTool } from "./webfetch.js";
// Exa web search (optional - requires EXA_API_KEY)
import { websearchTool } from "./websearch.js";
// Free-form file writer (create/overwrite)
import { writeTool } from "./write.js";

export {
	askUserTool,
	type Question,
	type QuestionOption,
	type AskUserInput,
	type AskUserResult,
} from "./ask-user.js";
export { bashTool } from "./bash.js";
export { backgroundTasksTool } from "./background-tasks.js";
export { createBatchTool } from "./batch.js";
export { codesearchTool } from "./codesearch.js";
export { diffTool } from "./diff.js";
export { editTool } from "./edit.js";
export { findTool } from "./find.js";
export { listTool } from "./list.js";
export { notebookEditTool } from "./notebook.js";
export { parallelRipgrepTool } from "./parallel-ripgrep.js";
export { readTool } from "./read.js";
export { searchTool } from "./search.js";
export { todoTool } from "./todo.js";
export { webfetchTool } from "./webfetch.js";
export { websearchTool } from "./websearch.js";
export { writeTool } from "./write.js";
export { statusTool } from "./status.js";
export { ghIssueTool, ghPrTool, ghRepoTool } from "./gh.js";
export { ensureTool, getToolPath } from "./tools-manager.js";

// Create batch tool with all available tools (excluding batch itself)
// Note: GitHub tools are included for read-only operations (list, view)
// but the batch tool will still validate they're not doing mutations
const allTools = [
	readTool,
	listTool,
	oracleTool,
	findTool,
	searchTool,
	parallelRipgrepTool,
	diffTool,
	bashTool,
	backgroundTasksTool,
	editTool,
	writeTool,
	notebookEditTool,
	todoTool,
	askUserTool,
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
	oracleTool,
	findTool,
	searchTool,
	parallelRipgrepTool,
	diffTool,
	bashTool,
	backgroundTasksTool,
	editTool,
	writeTool,
	notebookEditTool,
	todoTool,
	askUserTool,
	websearchTool,
	codesearchTool,
	webfetchTool,
	statusTool,
	// GitHub CLI tools
	ghPrTool,
	ghIssueTool,
	ghRepoTool,
];

// Tool registry for --tools flag filtering
export const toolRegistry: Record<string, (typeof codingTools)[number]> = {
	batch: batchTool,
	read: readTool,
	list: listTool,
	oracle: oracleTool,
	find: findTool,
	search: searchTool,
	parallel_ripgrep: parallelRipgrepTool,
	diff: diffTool,
	bash: bashTool,
	background_tasks: backgroundTasksTool,
	edit: editTool,
	write: writeTool,
	notebook_edit: notebookEditTool,
	todo: todoTool,
	ask_user: askUserTool,
	websearch: websearchTool,
	codesearch: codesearchTool,
	webfetch: webfetchTool,
	status: statusTool,
	gh_pr: ghPrTool,
	gh_issue: ghIssueTool,
	gh_repo: ghRepoTool,
};

// Read-only tools for restricted subagents (Oracle-style)
export const readOnlyToolNames = [
	"batch",
	"read",
	"list",
	"find",
	"search",
	"parallel_ripgrep",
	"diff",
	"status",
] as const;

export function filterTools(
	toolNames: string[],
): (typeof codingTools)[number][] {
	const filtered: (typeof codingTools)[number][] = [];
	for (const name of toolNames) {
		const tool = toolRegistry[name];
		if (tool) {
			filtered.push(tool);
		}
	}
	// Recreate batch tool with only the filtered tools (excluding batch itself)
	const batchableTools = filtered.filter((t) => t.name !== "batch");
	if (filtered.some((t) => t.name === "batch") && batchableTools.length > 0) {
		const filteredBatch = createBatchTool(batchableTools);
		return [filteredBatch, ...batchableTools];
	}
	return filtered;
}

export const vscodeTools = [
	vscodeGetDiagnosticsTool,
	vscodeGetDefinitionTool,
	vscodeFindReferencesTool,
	vscodeReadFileRangeTool,
];

// Tool result caching
export {
	ToolResultCache,
	createToolResultCache,
	getGlobalToolResultCache,
	resetGlobalToolResultCache,
	getToolResultCacheConfig,
	type ToolCacheConfig,
	type ToolCacheStats,
} from "./tool-result-cache.js";

// File watching
export {
	FileWatcher,
	createFileWatcher,
	getGlobalFileWatcher,
	initGlobalFileWatcher,
	resetGlobalFileWatcher,
	type FileChangeEvent,
	type FileChangeType,
	type FileWatcherConfig,
	type GitStateChangeEvent,
} from "./file-watcher.js";

// Cache invalidation
export {
	CacheInvalidationService,
	createCacheInvalidationService,
	getGlobalCacheInvalidation,
	initGlobalCacheInvalidation,
	resetGlobalCacheInvalidation,
	type CacheInvalidationConfig,
	type InvalidationStats,
} from "./cache-invalidation.js";
