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

import { isAbsolute, resolve } from "node:path";
import type {
	AgentTool,
	ToolAnnotations,
	ToolSourceMetadata,
} from "../agent/types.js";

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
	"apply_patch",
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
	_source?: ToolSourceMetadata,
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

export function isParallelSafeTool(
	toolName: string,
	annotations?: ToolAnnotations,
	source?: ToolSourceMetadata,
): boolean {
	if (isReadOnlyTool(toolName, annotations, source)) {
		return true;
	}
	if (annotations?.destructiveHint === true) {
		return false;
	}
	return source?.type === "mcp" && source.supportsParallelToolCalls === true;
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
	const toolMetadata = new Map<
		string,
		{ annotations?: ToolAnnotations; source?: ToolSourceMetadata }
	>();
	for (const tool of tools) {
		toolMetadata.set(tool.name, {
			annotations: tool.annotations,
			source: tool.source,
		});
	}

	// Check if all tools are read-only
	const allReadOnly = toolCalls.every((call) => {
		const metadata = toolMetadata.get(call.name);
		return isReadOnlyTool(call.name, metadata?.annotations, metadata?.source);
	});

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
	const toolMetadata = new Map<
		string,
		{ annotations?: ToolAnnotations; source?: ToolSourceMetadata }
	>();
	for (const tool of tools) {
		toolMetadata.set(tool.name, {
			annotations: tool.annotations,
			source: tool.source,
		});
	}

	const readOnly: T[] = [];
	const write: T[] = [];

	for (const call of toolCalls) {
		const metadata = toolMetadata.get(call.name);
		if (isReadOnlyTool(call.name, metadata?.annotations, metadata?.source)) {
			readOnly.push(call);
		} else {
			write.push(call);
		}
	}

	return { readOnly, write };
}

export interface PathScopedMutation {
	paths: string[];
	source: "annotation" | "known_tool";
	argumentKeys?: string[];
}

const PATH_SCOPED_MUTATION_TOOLS = new Set([
	"apply_patch",
	"write",
	"Write",
	"edit",
	"Edit",
	"MultiEdit",
	"notebook_edit",
	"NotebookEdit",
]);

const PATH_ARGUMENT_KEYS = new Set([
	"file",
	"file_path",
	"filePath",
	"files",
	"path",
	"paths",
	"target",
	"targets",
	"target_path",
	"targetPath",
	"notebook_path",
	"notebookPath",
	"output_path",
	"outputPath",
]);

const PATH_ARGUMENT_CONTAINER_KEYS = new Set([
	"edits",
	"operations",
	"patches",
]);

const PATCH_ARGUMENT_KEYS = new Set(["patch", "patch_text", "patchText"]);

function normalizeMutationPath(
	value: string,
	cwd = process.cwd(),
): string | undefined {
	const input = value.trim().replace(/\\/g, "/");
	if (!input || /[*?[\]{}]/u.test(input)) {
		return undefined;
	}
	const basePath = cwd.replace(/\\/g, "/");
	let normalized = (
		isAbsolute(input) ? resolve(input) : resolve(basePath, input)
	)
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/");
	normalized = normalized.toLowerCase();
	if (normalized.length > 1) {
		normalized = normalized.replace(/\/$/u, "");
	}
	return normalized || undefined;
}

function collectPathArgumentValues(
	value: unknown,
	paths: string[],
	cwd: string,
	matchedKeys: Set<string>,
	stringIsPath: boolean,
): void {
	if (typeof value === "string") {
		if (stringIsPath) {
			const path = normalizeMutationPath(value, cwd);
			if (path) {
				paths.push(path);
			}
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectPathArgumentValues(entry, paths, cwd, matchedKeys, stringIsPath);
		}
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, nested] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (PATH_ARGUMENT_KEYS.has(key)) {
				matchedKeys.add(key);
				collectPathArgumentValues(nested, paths, cwd, matchedKeys, true);
				continue;
			}
			if (PATCH_ARGUMENT_KEYS.has(key)) {
				matchedKeys.add(key);
				collectPatchHeaderPaths(nested, paths, cwd, matchedKeys);
				continue;
			}
			if (PATH_ARGUMENT_CONTAINER_KEYS.has(key)) {
				matchedKeys.add(key);
				collectPathArgumentValues(nested, paths, cwd, matchedKeys, false);
			}
		}
	}
}

function collectPatchHeaderPaths(
	value: unknown,
	paths: string[],
	cwd: string,
	matchedKeys: Set<string>,
): void {
	if (typeof value === "string") {
		for (const match of value.matchAll(
			/^\*\*\* (?:Update File|Add File|Delete File|Move to):\s+(.+)$/gmu,
		)) {
			const rawPath = match[1]?.trim();
			if (!rawPath) continue;
			const path = normalizeMutationPath(rawPath, cwd);
			if (path) {
				paths.push(path);
				matchedKeys.add("patch");
			}
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectPatchHeaderPaths(entry, paths, cwd, matchedKeys);
		}
		return;
	}
	if (value && typeof value === "object") {
		collectPathArgumentValues(value, paths, cwd, matchedKeys, false);
	}
}

export function getPathScopedMutation(
	toolCall: { name: string; arguments?: unknown },
	tool?: AgentTool,
	cwd = process.cwd(),
): PathScopedMutation | undefined {
	const annotations = tool?.annotations;
	const source =
		annotations?.pathScopedMutationHint === true ? "annotation" : "known_tool";
	const isPathScopedTool =
		annotations?.pathScopedMutationHint === true ||
		PATH_SCOPED_MUTATION_TOOLS.has(tool?.name ?? toolCall.name);
	if (!isPathScopedTool || annotations?.readOnlyHint === true) {
		return undefined;
	}
	const args =
		toolCall.arguments &&
		typeof toolCall.arguments === "object" &&
		!Array.isArray(toolCall.arguments)
			? (toolCall.arguments as Record<string, unknown>)
			: undefined;
	if (!args) {
		return undefined;
	}
	const paths: string[] = [];
	const matchedKeys = new Set<string>();
	for (const [key, value] of Object.entries(args)) {
		if (PATH_ARGUMENT_KEYS.has(key)) {
			matchedKeys.add(key);
			collectPathArgumentValues(value, paths, cwd, matchedKeys, true);
			continue;
		}
		if (PATCH_ARGUMENT_KEYS.has(key)) {
			matchedKeys.add(key);
			collectPatchHeaderPaths(value, paths, cwd, matchedKeys);
			continue;
		}
		if (PATH_ARGUMENT_CONTAINER_KEYS.has(key)) {
			matchedKeys.add(key);
			collectPathArgumentValues(value, paths, cwd, matchedKeys, false);
		}
	}
	const uniquePaths = [...new Set(paths)];
	return uniquePaths.length > 0
		? { paths: uniquePaths, source, argumentKeys: [...matchedKeys].sort() }
		: undefined;
}

export function pathScopesOverlap(
	left: PathScopedMutation,
	right: PathScopedMutation,
): boolean {
	return left.paths.some((leftPath) =>
		right.paths.some(
			(rightPath) =>
				leftPath === rightPath ||
				leftPath.startsWith(`${rightPath}/`) ||
				rightPath.startsWith(`${leftPath}/`),
		),
	);
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
