/**
 * Tool Registry - Central index of all available tools.
 *
 * This module serves as the main entry point for all tool definitions in Composer.
 * It organizes tools into logical groups and provides utilities for filtering and
 * accessing tools by name.
 *
 * ## Tool Categories
 *
 * **Core File Operations:**
 * - read: Read file contents (text, images, PDFs, notebooks)
 * - write: Create or overwrite files
 * - edit: Structured find/replace editing
 * - list: Directory listing and globbing
 * - find: Fast file finder using fd
 *
 * **Search & Navigation:**
 * - search: Ripgrep-style content search
 * - parallel_ripgrep: Parallelized search for large codebases
 * - codesearch: Exa Code API integration (optional)
 *
 * **Shell & System:**
 * - bash: Shell command execution
 * - background_tasks: Long-running process management
 * - status: System and session status
 *
 * **Git & GitHub:**
 * - diff: Git diff inspection
 * - gh_pr/gh_issue/gh_repo: GitHub CLI integration
 *
 * **AI & Automation:**
 * - oracle: Sub-agent for complex reasoning
 * - todo: Task list management
 * - ask_user: Structured user prompts
 *
 * **Web:**
 * - websearch: Web search (requires EXA_API_KEY)
 * - webfetch: Fetch and parse web content
 *
 * **VS Code Integration:**
 * - vscode tools: IDE features when running in VS Code context
 */

// =============================================================================
// Tool Imports - Organized by category
// =============================================================================

// User interaction tools
import { askUserTool } from "./ask-user.js";
import { backgroundTasksTool } from "./background-tasks.js";

// Shell execution with cwd tracking and safety checks
import { bashTool } from "./bash.js";

// External API integrations (optional - requires API keys)
import { codesearchTool } from "./codesearch.js";

// Git operations
import { diffTool } from "./diff.js";

// File manipulation
import { editTool } from "./edit.js";
import { extractDocumentTool } from "./extract-document.js";
import { findTool } from "./find.js";
import { listTool } from "./list.js";
import { notebookEditTool } from "./notebook.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";

// GitHub CLI integration (requires gh CLI installed)
import { ghIssueTool, ghPrTool, ghRepoTool } from "./gh.js";

// Search tools
import { parallelRipgrepTool } from "./parallel-ripgrep.js";
import { searchTool } from "./search.js";

// AI and automation
import { oracleTool } from "./oracle.js";
import { statusTool } from "./status.js";
import { todoTool } from "./todo.js";

// VS Code IDE integration
import {
	vscodeFindReferencesTool,
	vscodeGetDefinitionTool,
	vscodeGetDiagnosticsTool,
	vscodeReadFileRangeTool,
} from "./vscode.js";

// Web tools (optional - requires EXA_API_KEY)
import { webfetchTool } from "./webfetch.js";
import { websearchTool } from "./websearch.js";

export {
	askUserTool,
	type Question,
	type QuestionOption,
	type AskUserInput,
	type AskUserResult,
} from "./ask-user.js";
export { bashTool } from "./bash.js";
export { backgroundTasksTool } from "./background-tasks.js";
export { codesearchTool } from "./codesearch.js";
export { diffTool } from "./diff.js";
export { editTool } from "./edit.js";
export { extractDocumentTool } from "./extract-document.js";
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

// =============================================================================
// Tool Collections
// =============================================================================

/**
 * Complete set of coding tools available to the agent.
 *
 * This array defines the default tool set used in interactive sessions.
 * Tools are ordered roughly by frequency of use, though order doesn't
 * affect functionality.
 */
export const codingTools = [
	// File reading and navigation (most common)
	readTool,
	listTool,
	oracleTool,
	findTool,
	extractDocumentTool,
	// Search capabilities
	searchTool,
	parallelRipgrepTool,
	// Git operations
	diffTool,
	// Shell access
	bashTool,
	backgroundTasksTool,
	// File modification
	editTool,
	writeTool,
	notebookEditTool,
	// Workflow tools
	todoTool,
	askUserTool,
	// Web and external services
	websearchTool,
	codesearchTool,
	webfetchTool,
	// System info
	statusTool,
	// GitHub CLI tools
	ghPrTool,
	ghIssueTool,
	ghRepoTool,
];

/**
 * Tool registry mapping tool names to tool instances.
 *
 * Used by the --tools CLI flag to filter available tools.
 * Keys are the canonical tool names used in configuration.
 */
export const toolRegistry: Record<string, (typeof codingTools)[number]> = {
	read: readTool,
	list: listTool,
	oracle: oracleTool,
	find: findTool,
	extract_document: extractDocumentTool,
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

/**
 * Read-only tool names for restricted contexts.
 *
 * These tools are safe to use in subagents (like Oracle) that should
 * only observe the codebase without making changes. They cannot:
 * - Write or edit files
 * - Execute shell commands
 * - Make external API calls
 */
export const readOnlyToolNames = [
	"read",
	"list",
	"find",
	"search",
	"parallel_ripgrep",
	"diff",
	"status",
] as const;

/**
 * Filter tools by name from the registry.
 *
 * Used to create custom tool sets based on user configuration
 * or security requirements.
 *
 * @param toolNames - Array of tool names to include
 * @returns Array of matching tool instances
 */
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
	return filtered;
}

/**
 * VS Code-specific tools for IDE integration.
 *
 * These tools provide IDE features when running in VS Code context:
 * - Language server diagnostics
 * - Go-to-definition
 * - Find references
 * - Smart file range reading
 *
 * Only included when a VS Code client is connected.
 */
export const vscodeTools = [
	vscodeGetDiagnosticsTool,
	vscodeGetDefinitionTool,
	vscodeFindReferencesTool,
	vscodeReadFileRangeTool,
];

// =============================================================================
// Performance Infrastructure
// =============================================================================

/**
 * Tool result caching - Caches expensive tool results to avoid redundant work.
 * Particularly useful for read and search operations on unchanged files.
 */
export {
	ToolResultCache,
	createToolResultCache,
	getGlobalToolResultCache,
	resetGlobalToolResultCache,
	getToolResultCacheConfig,
	type ToolCacheConfig,
	type ToolCacheStats,
} from "./tool-result-cache.js";

/**
 * File watching - Monitors filesystem changes to trigger cache invalidation.
 * Supports both file changes and git state changes (branch switches, etc.).
 */
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

/**
 * Cache invalidation - Coordinates cache clearing when files change.
 * Links file watcher events to tool result cache invalidation.
 */
export {
	CacheInvalidationService,
	createCacheInvalidationService,
	getGlobalCacheInvalidation,
	initGlobalCacheInvalidation,
	resetGlobalCacheInvalidation,
	type CacheInvalidationConfig,
	type InvalidationStats,
} from "./cache-invalidation.js";
