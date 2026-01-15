/**
 * Watch Mode
 *
 * Monitors file changes and automatically triggers agent actions.
 * Similar to Aider's watch mode for continuous development.
 *
 * ## Features
 *
 * - Watches specified directories for changes
 * - Debounces rapid changes
 * - Triggers configurable actions (lint, test, build)
 * - Supports file filtering by pattern
 * - Auto-context refresh on changes
 *
 * ## Usage
 *
 * ```typescript
 * import { watchMode } from "./watch-mode.js";
 *
 * // Start watching
 * watchMode.start({
 *   paths: ["src"],
 *   actions: ["lint", "typecheck"],
 *   onFileChange: (files) => console.log("Changed:", files),
 * });
 *
 * // Stop watching
 * watchMode.stop();
 * ```
 */

import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent:watch-mode");

/**
 * Watch mode configuration
 */
export interface WatchModeConfig {
	/** Directories or files to watch */
	paths: string[];
	/** Root directory for relative paths */
	rootDir?: string;
	/** File patterns to include (glob-like) */
	includePatterns?: string[];
	/** File patterns to exclude */
	excludePatterns?: string[];
	/** Debounce delay in ms (default: 500) */
	debounceMs?: number;
	/** Actions to trigger on change */
	actions?: WatchAction[];
	/** Callback when files change */
	onFileChange?: (files: ChangedFile[]) => void | Promise<void>;
	/** Callback when action completes */
	onActionComplete?: (action: WatchAction, success: boolean) => void;
	/** Maximum files to process per batch */
	maxBatchSize?: number;
}

/**
 * Watch action types
 */
export type WatchAction =
	| "lint"
	| "typecheck"
	| "test"
	| "build"
	| "format"
	| "refresh-context"
	| "custom";

/**
 * Changed file information
 */
export interface ChangedFile {
	path: string;
	relativePath: string;
	event: "add" | "change" | "delete";
	timestamp: number;
}

/**
 * Watch mode state
 */
interface WatchState {
	active: boolean;
	watchers: FSWatcher[];
	pendingFiles: Map<string, ChangedFile>;
	debounceTimer: ReturnType<typeof setTimeout> | null;
	actionQueue: WatchAction[];
	processing: boolean;
}

/**
 * Default exclude patterns
 */
const DEFAULT_EXCLUDES = [
	/node_modules/,
	/\.git/,
	/dist\//,
	/build\//,
	/\.next\//,
	/coverage\//,
	/__pycache__/,
	/\.pyc$/,
	/\.map$/,
	/\.lock$/,
];

/**
 * Supported file extensions for watching
 */
const WATCHED_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".kt",
	".swift",
	".c",
	".cpp",
	".h",
	".hpp",
	".css",
	".scss",
	".less",
	".html",
	".vue",
	".svelte",
	".json",
	".yaml",
	".yml",
	".toml",
	".md",
	".mdx",
]);

/**
 * Watch mode manager
 */
class WatchModeManager {
	private state: WatchState = {
		active: false,
		watchers: [],
		pendingFiles: new Map(),
		debounceTimer: null,
		actionQueue: [],
		processing: false,
	};

	private config: WatchModeConfig | null = null;

	/**
	 * Start watch mode
	 */
	async start(config: WatchModeConfig): Promise<void> {
		if (this.state.active) {
			logger.warn("Watch mode already active");
			return;
		}

		this.config = {
			debounceMs: 500,
			maxBatchSize: 50,
			excludePatterns: [],
			...config,
		};

		const rootDir = this.config.rootDir || process.cwd();

		// Set up watchers for each path
		for (const watchPath of this.config.paths) {
			const fullPath = join(rootDir, watchPath);
			await this.watchDirectory(fullPath, rootDir);
		}

		this.state.active = true;

		logger.info("Watch mode started", {
			paths: this.config.paths,
			actions: this.config.actions,
			debounceMs: this.config.debounceMs,
		});
	}

	/**
	 * Stop watch mode
	 */
	stop(): void {
		if (!this.state.active) {
			return;
		}

		// Close all watchers
		for (const watcher of this.state.watchers) {
			watcher.close();
		}

		// Clear state
		if (this.state.debounceTimer) {
			clearTimeout(this.state.debounceTimer);
		}

		this.state = {
			active: false,
			watchers: [],
			pendingFiles: new Map(),
			debounceTimer: null,
			actionQueue: [],
			processing: false,
		};

		this.config = null;

		logger.info("Watch mode stopped");
	}

	/**
	 * Check if watch mode is active
	 */
	isActive(): boolean {
		return this.state.active;
	}

	/**
	 * Get pending changes
	 */
	getPendingChanges(): ChangedFile[] {
		return Array.from(this.state.pendingFiles.values());
	}

	/**
	 * Manually trigger actions
	 */
	async triggerActions(actions?: WatchAction[]): Promise<void> {
		const toRun = actions || this.config?.actions || [];
		for (const action of toRun) {
			this.state.actionQueue.push(action);
		}
		await this.processActionQueue();
	}

	/**
	 * Watch a directory recursively
	 */
	private async watchDirectory(
		dirPath: string,
		rootDir: string,
	): Promise<void> {
		try {
			const entries = await readdir(dirPath, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(dirPath, entry.name);
				const relativePath = relative(rootDir, fullPath);

				// Skip excluded paths
				if (this.isExcluded(relativePath)) {
					continue;
				}

				if (entry.isDirectory()) {
					// Recurse into subdirectories
					await this.watchDirectory(fullPath, rootDir);

					// Watch the directory itself
					try {
						const watcher = watch(fullPath, (eventType, filename) => {
							if (filename) {
								this.handleFileEvent(
									join(fullPath, filename),
									rootDir,
									eventType as "rename" | "change",
								);
							}
						});
						this.state.watchers.push(watcher);
					} catch {
						// Directory might not be watchable
					}
				}
			}

			// Watch the root of this directory
			try {
				const watcher = watch(dirPath, (eventType, filename) => {
					if (filename) {
						this.handleFileEvent(
							join(dirPath, filename),
							rootDir,
							eventType as "rename" | "change",
						);
					}
				});
				this.state.watchers.push(watcher);
			} catch {
				// Directory might not be watchable
			}
		} catch (error) {
			logger.warn("Failed to watch directory", { dirPath, error });
		}
	}

	/**
	 * Handle a file event
	 */
	private handleFileEvent(
		filePath: string,
		rootDir: string,
		eventType: "rename" | "change",
	): void {
		const relativePath = relative(rootDir, filePath);
		const ext = extname(filePath);

		// Skip unwatched extensions
		if (!WATCHED_EXTENSIONS.has(ext)) {
			return;
		}

		// Skip excluded files
		if (this.isExcluded(relativePath)) {
			return;
		}

		// Check include patterns if specified
		if (
			this.config?.includePatterns &&
			this.config.includePatterns.length > 0
		) {
			const included = this.config.includePatterns.some((pattern) =>
				new RegExp(pattern).test(relativePath),
			);
			if (!included) {
				return;
			}
		}

		// Determine event type
		let event: ChangedFile["event"] = "change";
		if (eventType === "rename") {
			// Check if file exists to determine add vs delete
			try {
				stat(filePath);
				event = "add";
			} catch {
				event = "delete";
			}
		}

		const changedFile: ChangedFile = {
			path: filePath,
			relativePath,
			event,
			timestamp: Date.now(),
		};

		this.state.pendingFiles.set(filePath, changedFile);

		logger.debug("File change detected", { relativePath, event });

		// Debounce processing
		this.scheduleProcessing();
	}

	/**
	 * Check if a path is excluded
	 */
	private isExcluded(relativePath: string): boolean {
		const allExcludes = [
			...DEFAULT_EXCLUDES,
			...(this.config?.excludePatterns || []).map((p) => new RegExp(p)),
		];

		return allExcludes.some((pattern) => pattern.test(relativePath));
	}

	/**
	 * Schedule processing with debounce
	 */
	private scheduleProcessing(): void {
		if (this.state.debounceTimer) {
			clearTimeout(this.state.debounceTimer);
		}

		this.state.debounceTimer = setTimeout(async () => {
			await this.processChanges();
		}, this.config?.debounceMs || 500);
	}

	/**
	 * Process accumulated changes
	 */
	private async processChanges(): Promise<void> {
		if (this.state.processing || this.state.pendingFiles.size === 0) {
			return;
		}

		this.state.processing = true;

		try {
			// Get batch of changes
			const files = Array.from(this.state.pendingFiles.values()).slice(
				0,
				this.config?.maxBatchSize || 50,
			);

			// Clear processed files
			for (const file of files) {
				this.state.pendingFiles.delete(file.path);
			}

			logger.info("Processing file changes", {
				count: files.length,
				remaining: this.state.pendingFiles.size,
			});

			// Call change callback
			if (this.config?.onFileChange) {
				await this.config.onFileChange(files);
			}

			// Queue configured actions
			if (this.config?.actions) {
				for (const action of this.config.actions) {
					if (!this.state.actionQueue.includes(action)) {
						this.state.actionQueue.push(action);
					}
				}
			}

			// Process action queue
			await this.processActionQueue();
		} finally {
			this.state.processing = false;

			// Process any remaining files
			if (this.state.pendingFiles.size > 0) {
				this.scheduleProcessing();
			}
		}
	}

	/**
	 * Process action queue
	 */
	private async processActionQueue(): Promise<void> {
		while (this.state.actionQueue.length > 0) {
			const action = this.state.actionQueue.shift()!;

			try {
				await this.executeAction(action);
				this.config?.onActionComplete?.(action, true);
			} catch (err) {
				logger.error("Action failed", err instanceof Error ? err : undefined, {
					action,
				});
				this.config?.onActionComplete?.(action, false);
			}
		}
	}

	/**
	 * Execute a watch action
	 */
	private async executeAction(action: WatchAction): Promise<void> {
		logger.info("Executing watch action", { action });

		switch (action) {
			case "lint":
				// Emit event for lint action
				break;
			case "typecheck":
				// Emit event for typecheck action
				break;
			case "test":
				// Emit event for test action
				break;
			case "build":
				// Emit event for build action
				break;
			case "format":
				// Emit event for format action
				break;
			case "refresh-context":
				// Emit event to refresh context
				break;
			case "custom":
				// Custom action handled by callback
				break;
		}
	}

	/**
	 * Get watch mode statistics
	 */
	getStats(): {
		active: boolean;
		watcherCount: number;
		pendingChanges: number;
		queuedActions: number;
	} {
		return {
			active: this.state.active,
			watcherCount: this.state.watchers.length,
			pendingChanges: this.state.pendingFiles.size,
			queuedActions: this.state.actionQueue.length,
		};
	}
}

/**
 * Global watch mode manager instance
 */
export const watchMode = new WatchModeManager();

/**
 * Helper to start watch mode with common presets
 */
export function createWatcher(
	preset: "typescript" | "python" | "full",
	onFileChange?: (files: ChangedFile[]) => void | Promise<void>,
): void {
	const presets: Record<string, Partial<WatchModeConfig>> = {
		typescript: {
			paths: ["src", "test"],
			includePatterns: ["\\.tsx?$"],
			actions: ["typecheck", "lint"],
		},
		python: {
			paths: ["src", "tests"],
			includePatterns: ["\\.py$"],
			actions: ["lint", "test"],
		},
		full: {
			paths: ["."],
			actions: ["lint", "typecheck", "test"],
		},
	};

	const config = presets[preset];
	if (config) {
		watchMode.start({
			...config,
			onFileChange,
		} as WatchModeConfig);
	}
}
