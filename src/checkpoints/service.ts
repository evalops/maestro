/**
 * Checkpoint Service
 *
 * Integrates with the hook system to automatically create checkpoints
 * before file-modifying operations.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { registerHook } from "../hooks/config.js";
import type { HookInput, PreToolUseHookInput } from "../hooks/types.js";
import { createLogger } from "../utils/logger.js";
import { type CheckpointStore, createCheckpointStore } from "./store.js";
import { type CheckpointConfig, DEFAULT_CHECKPOINT_CONFIG } from "./types.js";

const logger = createLogger("checkpoints:service");

/**
 * Normalize a relative path to POSIX-style separators for glob matching.
 */
function normalizeRelPath(relPath: string): string {
	return relPath.split(sep).join("/");
}

/**
 * Extract file paths from tool input based on tool name.
 */
function extractFilePaths(
	toolName: string,
	toolInput: Record<string, unknown>,
): string[] {
	const paths: string[] = [];

	switch (toolName) {
		case "Write":
		case "Edit":
		case "Read": {
			const filePath = toolInput.file_path;
			if (typeof filePath === "string") {
				paths.push(filePath);
			}
			break;
		}

		case "NotebookEdit": {
			const notebookPath = toolInput.notebook_path;
			if (typeof notebookPath === "string") {
				paths.push(notebookPath);
			}
			break;
		}

		case "Bash": {
			// Try to extract file paths from bash commands
			const command = toolInput.command;
			if (typeof command === "string") {
				// Look for common file-writing patterns
				const writePatterns = [
					// echo/cat redirects: > file, >> file
					/(?:>|>>)\s*["']?([^\s"'|;&]+)["']?/g,
					// cp/mv destination
					/(?:cp|mv)\s+(?:-[a-z]+\s+)*(?:"[^"]+"|'[^']+'|[^\s]+)\s+["']?([^\s"'|;&]+)["']?/g,
					// touch
					/touch\s+["']?([^\s"'|;&]+)["']?/g,
					// rm (for tracking deletions)
					/rm\s+(?:-[a-z]+\s+)*["']?([^\s"'|;&]+)["']?/g,
					// tee
					/tee\s+(?:-[a-z]+\s+)*["']?([^\s"'|;&]+)["']?/g,
				];

				for (const pattern of writePatterns) {
					const regex = new RegExp(pattern.source, pattern.flags);
					for (
						let match = regex.exec(command);
						match !== null;
						match = regex.exec(command)
					) {
						if (match[1] && !match[1].startsWith("-")) {
							paths.push(match[1]);
						}
					}
				}
			}
			break;
		}

		case "MultiEdit": {
			const edits = toolInput.edits;
			if (Array.isArray(edits)) {
				for (const edit of edits) {
					if (
						typeof edit === "object" &&
						edit !== null &&
						"file_path" in edit
					) {
						const filePath = (edit as { file_path: unknown }).file_path;
						if (typeof filePath === "string") {
							paths.push(filePath);
						}
					}
				}
			}
			break;
		}
	}

	return paths;
}

/**
 * Check if a tool should trigger a checkpoint.
 */
function shouldCheckpoint(toolName: string, config: CheckpointConfig): boolean {
	if (!config.enabled) {
		return false;
	}

	// Check if tool is in the trigger list
	if (!config.triggerTools.includes(toolName)) {
		return false;
	}

	// Bash only triggers checkpoints if it looks like a write operation
	if (toolName === "Bash") {
		return true; // We'll filter by extracted paths
	}

	return true;
}

/**
 * Check if a file should be excluded from checkpointing.
 */
function shouldExcludeFile(
	filePath: string,
	config: CheckpointConfig,
): boolean {
	return config.excludePatterns.some((pattern) =>
		minimatch(filePath, pattern, { dot: true }),
	);
}

/**
 * Checkpoint service that manages automatic checkpointing.
 */
export class CheckpointService {
	private store: CheckpointStore;
	private config: CheckpointConfig;
	private unregisterHook: (() => void) | null = null;
	private enabled: boolean;
	private cwd: string;
	private cwdReal: string;

	constructor(cwd: string, config?: Partial<CheckpointConfig>) {
		this.config = { ...DEFAULT_CHECKPOINT_CONFIG, ...config };
		this.enabled =
			this.config.enabled && !process.env.COMPOSER_DISABLE_FILE_CHECKPOINTING;
		this.cwd = cwd;
		this.cwdReal = (() => {
			try {
				return realpathSync(cwd);
			} catch {
				return cwd;
			}
		})();

		this.store = createCheckpointStore({
			cwd: this.cwdReal,
			maxCheckpoints: 50,
			persistToDisk: false, // In-memory by default for performance
			maxFileSize: this.config.maxFileSize,
		});

		if (this.enabled) {
			this.registerHooks();
		}

		logger.debug("Checkpoint service initialized", {
			enabled: this.enabled,
			triggerTools: this.config.triggerTools,
		});
	}

	/**
	 * Register hooks for automatic checkpointing.
	 */
	private registerHooks(): void {
		this.unregisterHook = registerHook(
			"PreToolUse",
			{
				type: "callback",
				callback: async (input: HookInput) => {
					const preToolInput = input as PreToolUseHookInput;
					this.handlePreToolUse(preToolInput);
					return null; // Don't block or modify the tool call
				},
			},
			"*", // Match all tools, we'll filter internally
		);
	}

	/**
	 * Handle PreToolUse hook to create checkpoints.
	 */
	private handlePreToolUse(input: PreToolUseHookInput): void {
		const {
			tool_name: toolName,
			tool_call_id: toolCallId,
			tool_input: toolInput,
		} = input;

		if (!shouldCheckpoint(toolName, this.config)) {
			return;
		}

		const rawPaths = extractFilePaths(
			toolName,
			toolInput as Record<string, unknown>,
		);

		if (rawPaths.length === 0) {
			return;
		}

		// Resolve to absolute paths and contain to workspace
		const resolvedPaths = rawPaths.map((p) =>
			isAbsolute(p) ? resolve(p) : resolve(this.cwdReal, p),
		);

		const realPaths = resolvedPaths
			.map((p) => {
				try {
					return realpathSync(p);
				} catch {
					// File may not exist yet (e.g., about to be created) — keep the resolved path
					return p;
				}
			})
			.filter((p): p is string => Boolean(p));

		const containedPaths = realPaths.filter((p) => {
			const pNorm = process.platform === "win32" ? p.toLowerCase() : p;
			const cwdNorm =
				process.platform === "win32"
					? this.cwdReal.toLowerCase()
					: this.cwdReal;

			if (!(pNorm === cwdNorm || pNorm.startsWith(`${cwdNorm}${sep}`))) {
				return false;
			}

			const rel = relative(this.cwdReal, p);
			if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
				return false;
			}

			return true;
		});

		const uniquePaths = Array.from(new Set(containedPaths));

		// Filter out excluded files
		const checkpointPaths = uniquePaths.filter((path) => {
			const rel = relative(this.cwdReal, path) || ".";
			const normalizedRel = normalizeRelPath(rel);
			return !shouldExcludeFile(normalizedRel, this.config);
		});

		if (checkpointPaths.length === 0) {
			return;
		}

		// Create description based on tool and files
		const fileList =
			checkpointPaths.length === 1
				? checkpointPaths[0]
				: `${checkpointPaths.length} files`;
		const description = `Before ${toolName}: ${fileList}`;

		this.store.createCheckpoint(
			toolName,
			toolCallId,
			checkpointPaths,
			description,
		);
	}

	/**
	 * Undo the last file operation.
	 */
	undo(): { success: boolean; message: string; files?: string[] } {
		if (!this.enabled) {
			return { success: false, message: "Checkpointing is disabled" };
		}

		if (!this.store.canUndo()) {
			return { success: false, message: "Nothing to undo" };
		}

		const result = this.store.undo();
		if (!result) {
			return { success: false, message: "Undo failed" };
		}

		if (result.success) {
			return {
				success: true,
				message: `Restored ${result.restoredFiles.length} file(s) to state before "${result.checkpoint.description}"`,
				files: result.restoredFiles,
			};
		}

		return {
			success: false,
			message: `Partial restore: ${result.failedFiles.length} file(s) failed`,
			files: result.restoredFiles,
		};
	}

	/**
	 * Redo a previously undone operation.
	 */
	redo(): { success: boolean; message: string; files?: string[] } {
		if (!this.enabled) {
			return { success: false, message: "Checkpointing is disabled" };
		}

		if (!this.store.canRedo()) {
			return { success: false, message: "Nothing to redo" };
		}

		const result = this.store.redo();
		if (!result) {
			return { success: false, message: "Redo failed" };
		}

		if (result.success) {
			return {
				success: true,
				message: `Restored ${result.restoredFiles.length} file(s)`,
				files: result.restoredFiles,
			};
		}

		return {
			success: false,
			message: `Partial restore: ${result.failedFiles.length} file(s) failed`,
			files: result.restoredFiles,
		};
	}

	/**
	 * Get checkpoint history.
	 */
	getHistory(): Array<{
		id: string;
		description: string;
		timestamp: number;
		fileCount: number;
	}> {
		return this.store.getCheckpoints().map((cp) => ({
			id: cp.id,
			description: cp.description,
			timestamp: cp.timestamp,
			fileCount: cp.snapshots.length,
		}));
	}

	/**
	 * Restore to a specific checkpoint.
	 */
	restoreTo(checkpointId: string): {
		success: boolean;
		message: string;
		files?: string[];
	} {
		if (!this.enabled) {
			return { success: false, message: "Checkpointing is disabled" };
		}

		const result = this.store.restoreToCheckpoint(checkpointId);

		if (result.success) {
			return {
				success: true,
				message: `Restored ${result.restoredFiles.length} file(s) to checkpoint "${result.checkpoint.description}"`,
				files: result.restoredFiles,
			};
		}

		return {
			success: false,
			message: `Restore failed: ${result.failedFiles.map((f) => f.error).join(", ")}`,
		};
	}

	/**
	 * Check if undo is available.
	 */
	canUndo(): boolean {
		return this.enabled && this.store.canUndo();
	}

	/**
	 * Check if redo is available.
	 */
	canRedo(): boolean {
		return this.enabled && this.store.canRedo();
	}

	/**
	 * Check if checkpointing is enabled.
	 */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Clear all checkpoints.
	 */
	clear(): void {
		this.store.clear();
	}

	/**
	 * Dispose of the service.
	 */
	dispose(): void {
		if (this.unregisterHook) {
			this.unregisterHook();
			this.unregisterHook = null;
		}
	}
}

// Singleton instance
let instance: CheckpointService | null = null;

/**
 * Initialize the checkpoint service.
 */
export function initCheckpointService(
	cwd: string,
	config?: Partial<CheckpointConfig>,
): CheckpointService {
	if (instance) {
		instance.dispose();
	}
	instance = new CheckpointService(cwd, config);
	return instance;
}

/**
 * Get the checkpoint service instance.
 */
export function getCheckpointService(): CheckpointService | null {
	return instance;
}

/**
 * Dispose of the checkpoint service.
 */
export function disposeCheckpointService(): void {
	if (instance) {
		instance.dispose();
		instance = null;
	}
}
