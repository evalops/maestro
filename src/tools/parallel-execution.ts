/**
 * Parallel Execution - Optimized concurrent tool execution for read-only operations
 *
 * This module provides utilities for safely increasing concurrency when executing
 * read-only tools. Read-only tools can run in parallel without risk of conflicts,
 * enabling significant latency improvements for batch operations.
 *
 * ## Read-Only Tools
 *
 * Tools are considered read-only if they:
 * - Do not modify files or system state
 * - Are idempotent (same input = same output)
 * - Have no side effects on external systems
 *
 * Examples: read, list, find, search, diff, status
 *
 * ## Usage
 *
 * ```typescript
 * import { isReadOnlyTool, getOptimalConcurrency } from './parallel-execution.js';
 *
 * const tools = [readTool, listTool, findTool];
 * const allReadOnly = tools.every(t => isReadOnlyTool(t.name));
 * const concurrency = getOptimalConcurrency(tools, baseConcurrency);
 * ```
 *
 * @module tools/parallel-execution
 */

import type { AgentTool, ToolAnnotations } from "../agent/types.js";

/**
 * Set of known read-only tool names.
 *
 * These tools are safe to execute in parallel because they:
 * - Only read data, never modify it
 * - Have no side effects
 * - Are idempotent
 */
export const READ_ONLY_TOOLS = new Set([
	// File reading
	"Read",
	"read",
	// Directory listing
	"LS",
	"list",
	// File finding
	"Glob",
	"find",
	// Content search
	"Grep",
	"search",
	"parallel_ripgrep",
	// Git operations (read-only)
	"diff",
	// System info
	"status",
	// Document extraction
	"extract_document",
	// VS Code read operations
	"vscode_get_definition",
	"vscode_find_references",
	"vscode_get_diagnostics",
	"vscode_read_file_range",
	// JetBrains read operations
	"jetbrains_get_definition",
	"jetbrains_find_references",
	"jetbrains_get_diagnostics",
	"jetbrains_read_file_range",
	// LSP operations (read-only)
	"LSP",
]);

/**
 * Set of known write/mutating tool names.
 *
 * These tools modify state and should not run concurrently with
 * operations on the same resources.
 */
export const WRITE_TOOLS = new Set([
	"write",
	"Write",
	"edit",
	"Edit",
	"MultiEdit",
	"notebook_edit",
	"NotebookEdit",
	"bash",
	"Bash",
	"background_tasks",
]);

/**
 * Check if a tool is read-only based on its name or annotations.
 *
 * @param toolName - Name of the tool
 * @param annotations - Optional tool annotations
 * @returns true if the tool is read-only
 */
export function isReadOnlyTool(
	toolName: string,
	annotations?: ToolAnnotations,
): boolean {
	// Check explicit annotation first
	if (annotations?.readOnlyHint === true) {
		return true;
	}
	if (annotations?.readOnlyHint === false) {
		return false;
	}

	// Fall back to known tool lists
	return READ_ONLY_TOOLS.has(toolName);
}

/**
 * Check if a tool is a write/mutating operation.
 *
 * @param toolName - Name of the tool
 * @param annotations - Optional tool annotations
 * @returns true if the tool modifies state
 */
export function isWriteTool(
	toolName: string,
	annotations?: ToolAnnotations,
): boolean {
	// Check explicit annotation
	if (annotations?.destructiveHint === true) {
		return true;
	}

	return WRITE_TOOLS.has(toolName);
}

/**
 * Configuration for parallel execution optimization.
 */
export interface ParallelExecutionConfig {
	/** Base concurrency limit (default: 2) */
	baseConcurrency?: number;
	/** Maximum concurrency for read-only batches (default: 8) */
	maxReadOnlyConcurrency?: number;
	/** Whether to enable parallel optimization (default: true) */
	enabled?: boolean;
}

/**
 * Get the optimal concurrency level for a batch of tool calls.
 *
 * When all tools in a batch are read-only, we can safely increase
 * concurrency to improve latency. Write operations force serialization.
 *
 * @param toolCalls - Array of tool calls to analyze
 * @param tools - Tool definitions (for annotation lookup)
 * @param config - Parallel execution configuration
 * @returns Optimal concurrency level for this batch
 */
export function getOptimalConcurrency(
	toolCalls: Array<{ name: string }>,
	tools: AgentTool[],
	config?: ParallelExecutionConfig,
): number {
	const baseConcurrency = config?.baseConcurrency ?? 2;
	const maxReadOnlyConcurrency = config?.maxReadOnlyConcurrency ?? 8;
	const enabled = config?.enabled ?? true;

	if (!enabled || toolCalls.length === 0) {
		return baseConcurrency;
	}

	// Build a map of tool names to annotations
	const toolAnnotations = new Map<string, ToolAnnotations | undefined>();
	for (const tool of tools) {
		toolAnnotations.set(tool.name, tool.annotations);
	}

	// Check if all tools are read-only
	const allReadOnly = toolCalls.every((call) =>
		isReadOnlyTool(call.name, toolAnnotations.get(call.name)),
	);

	if (allReadOnly) {
		// Safe to use higher concurrency
		return Math.min(maxReadOnlyConcurrency, toolCalls.length);
	}

	// Has write operations - use base concurrency
	return baseConcurrency;
}

/**
 * Partition tool calls into read-only and write batches.
 *
 * This enables executing all read-only operations in parallel first,
 * then executing write operations with appropriate ordering.
 *
 * @param toolCalls - Array of tool calls
 * @param tools - Tool definitions
 * @returns Object with readOnly and write arrays
 */
export function partitionToolCalls<T extends { name: string }>(
	toolCalls: T[],
	tools: AgentTool[],
): { readOnly: T[]; write: T[] } {
	const toolAnnotations = new Map<string, ToolAnnotations | undefined>();
	for (const tool of tools) {
		toolAnnotations.set(tool.name, tool.annotations);
	}

	const readOnly: T[] = [];
	const write: T[] = [];

	for (const call of toolCalls) {
		if (isReadOnlyTool(call.name, toolAnnotations.get(call.name))) {
			readOnly.push(call);
		} else {
			write.push(call);
		}
	}

	return { readOnly, write };
}

/**
 * Add read-only annotation to a tool definition.
 *
 * Use this to mark custom tools as read-only for parallel execution.
 *
 * @param tool - Tool definition to annotate
 * @returns Tool with readOnlyHint annotation
 */
export function markReadOnly<T extends AgentTool>(tool: T): T {
	return {
		...tool,
		annotations: {
			...tool.annotations,
			readOnlyHint: true,
		},
	};
}

/**
 * Add write/destructive annotation to a tool definition.
 *
 * @param tool - Tool definition to annotate
 * @returns Tool with destructiveHint annotation
 */
export function markDestructive<T extends AgentTool>(tool: T): T {
	return {
		...tool,
		annotations: {
			...tool.annotations,
			destructiveHint: true,
		},
	};
}
