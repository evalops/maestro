/**
 * Tool name constants and categories.
 *
 * This module provides centralized tool name definitions used across
 * the tool system. Separated from index.ts to avoid circular dependencies.
 */

/**
 * Names of tools that are read-only (safe to run in read-only mode).
 *
 * Read-only tools cannot:
 * - Modify files or directories
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

export type ReadOnlyToolName = (typeof readOnlyToolNames)[number];
