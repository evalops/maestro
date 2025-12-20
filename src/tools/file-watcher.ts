/**
 * File Watcher Service
 *
 * Watches for file system changes and emits events for cache invalidation.
 * Uses Node.js fs.watch with debouncing to avoid excessive events.
 *
 * Features:
 * - Watch directories recursively
 * - Debounce rapid changes
 * - Filter by file patterns
 * - Emit events for cache invalidation
 * - Track git state changes
 */

import { exec } from "node:child_process";
import { existsSync, statSync, watch } from "node:fs";
import type { FSWatcher, WatchEventType } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import { createLogger } from "../utils/logger.js";

const execAsync = promisify(exec);
const logger = createLogger("file-watcher");

/**
 * File change event types.
 */
export type FileChangeType = "create" | "modify" | "delete" | "rename";

/**
 * File change event.
 */
export interface FileChangeEvent {
	/** Type of change */
	type: FileChangeType;
	/** Absolute path to the file */
	path: string;
	/** Relative path from watch root */
	relativePath: string;
	/** Timestamp of the change */
	timestamp: number;
	/** Whether this is a directory */
	isDirectory: boolean;
}

/**
 * Git state change event.
 */
export interface GitStateChangeEvent {
	/** Previous git SHA (if known) */
	previousSha?: string;
	/** Current git SHA */
	currentSha: string;
	/** Timestamp */
	timestamp: number;
}

/**
 * File watcher configuration.
 */
export interface FileWatcherConfig {
	/** Root directory to watch */
	rootDir: string;
	/** Whether to watch recursively */
	recursive?: boolean;
	/** File patterns to include (globs) */
	includePatterns?: string[];
	/** File patterns to exclude (globs) */
	excludePatterns?: string[];
	/** Debounce delay in ms */
	debounceMs?: number;
	/** Whether to watch for git state changes */
	watchGitState?: boolean;
	/** Git state poll interval in ms */
	gitPollIntervalMs?: number;
}

/**
 * File change listener.
 */
export type FileChangeListener = (event: FileChangeEvent) => void;

/**
 * Git state change listener.
 */
export type GitStateChangeListener = (event: GitStateChangeEvent) => void;

/**
 * Default excluded patterns (node_modules, .git, etc.)
 */
const DEFAULT_EXCLUDE_PATTERNS = [
	"**/node_modules/**",
	"**/.git/**",
	"**/dist/**",
	"**/build/**",
	"**/.next/**",
	"**/.nuxt/**",
	"**/coverage/**",
	"**/*.log",
	"**/.DS_Store",
	"**/thumbs.db",
];

/**
 * Simple glob pattern matching.
 */
function matchesPattern(path: string, pattern: string): boolean {
	const normalizedPath = path.replace(/\\/g, "/");
	const normalizedPattern = pattern.replace(/\\/g, "/");
	return minimatch(normalizedPath, normalizedPattern, {
		dot: true,
		matchBase: false,
		nobrace: true,
		noext: true,
		nocomment: true,
		nocase: process.platform === "win32",
	});
}

/**
 * Check if a path should be included based on patterns.
 */
function shouldInclude(
	relativePath: string,
	includePatterns?: string[],
	excludePatterns?: string[],
): boolean {
	// Check excludes first
	const allExcludes = [...DEFAULT_EXCLUDE_PATTERNS, ...(excludePatterns ?? [])];
	for (const pattern of allExcludes) {
		if (matchesPattern(relativePath, pattern)) {
			return false;
		}
	}

	// If no include patterns, include everything not excluded
	if (!includePatterns || includePatterns.length === 0) {
		return true;
	}

	// Check includes
	for (const pattern of includePatterns) {
		if (matchesPattern(relativePath, pattern)) {
			return true;
		}
	}

	return false;
}

/**
 * File Watcher Service.
 */
export class FileWatcher {
	private config: Required<FileWatcherConfig>;
	private watchers: Map<string, FSWatcher> = new Map();
	private fileListeners: Set<FileChangeListener> = new Set();
	private gitListeners: Set<GitStateChangeListener> = new Set();
	private pendingChanges: Map<
		string,
		{ type: WatchEventType; timer: NodeJS.Timeout }
	> = new Map();
	private currentGitSha?: string;
	private gitPollTimer?: NodeJS.Timeout;
	private isRunning = false;

	constructor(config: FileWatcherConfig) {
		this.config = {
			recursive: true,
			includePatterns: [],
			excludePatterns: [],
			debounceMs: 100,
			watchGitState: true,
			gitPollIntervalMs: 5000,
			...config,
		};
	}

	/**
	 * Start watching for file changes.
	 */
	async start(): Promise<void> {
		if (this.isRunning) {
			return;
		}

		const { rootDir, recursive, watchGitState } = this.config;

		if (!existsSync(rootDir)) {
			logger.warn("Root directory does not exist", { rootDir });
			return;
		}

		this.isRunning = true;
		logger.info("Starting file watcher", { rootDir, recursive });

		try {
			// Start watching the root directory
			this.watchDirectory(rootDir);

			// Start git state polling if enabled
			if (watchGitState) {
				await this.startGitPolling();
			}
		} catch (error) {
			logger.error(
				"Failed to start file watcher",
				error instanceof Error ? error : new Error(String(error)),
			);
			this.stop();
			throw error;
		}
	}

	/**
	 * Stop watching.
	 */
	stop(): void {
		if (!this.isRunning) {
			return;
		}

		logger.info("Stopping file watcher");
		this.isRunning = false;

		// Clear all watchers
		for (const [path, watcher] of this.watchers) {
			try {
				watcher.close();
			} catch {
				// Ignore close errors
			}
		}
		this.watchers.clear();

		// Clear pending changes
		for (const { timer } of this.pendingChanges.values()) {
			clearTimeout(timer);
		}
		this.pendingChanges.clear();

		// Stop git polling
		if (this.gitPollTimer) {
			clearInterval(this.gitPollTimer);
			this.gitPollTimer = undefined;
		}
	}

	/**
	 * Add a file change listener.
	 */
	onFileChange(listener: FileChangeListener): () => void {
		this.fileListeners.add(listener);
		return () => this.fileListeners.delete(listener);
	}

	/**
	 * Add a git state change listener.
	 */
	onGitStateChange(listener: GitStateChangeListener): () => void {
		this.gitListeners.add(listener);
		return () => this.gitListeners.delete(listener);
	}

	/**
	 * Get the current git SHA.
	 */
	getCurrentGitSha(): string | undefined {
		return this.currentGitSha;
	}

	/**
	 * Watch a directory.
	 */
	private watchDirectory(dirPath: string): void {
		if (this.watchers.has(dirPath)) {
			return;
		}

		try {
			const watcher = watch(
				dirPath,
				{ recursive: this.config.recursive },
				(eventType, filename) => {
					if (filename) {
						this.handleWatchEvent(eventType, dirPath, filename);
					}
				},
			);

			watcher.on("error", (error) => {
				logger.warn("Watcher error", { dirPath, error });
			});

			this.watchers.set(dirPath, watcher);
		} catch (error) {
			logger.warn("Failed to watch directory", { dirPath, error });
		}
	}

	/**
	 * Handle a watch event with debouncing.
	 */
	private handleWatchEvent(
		eventType: WatchEventType,
		dirPath: string,
		filename: string,
	): void {
		const fullPath = join(dirPath, filename);
		const relativePath = relative(this.config.rootDir, fullPath);

		// Check if should include
		if (
			!shouldInclude(
				relativePath,
				this.config.includePatterns,
				this.config.excludePatterns,
			)
		) {
			return;
		}

		// Debounce
		const existing = this.pendingChanges.get(fullPath);
		if (existing) {
			clearTimeout(existing.timer);
		}

		const timer = setTimeout(() => {
			this.pendingChanges.delete(fullPath);
			this.emitFileChange(fullPath, relativePath, eventType);
		}, this.config.debounceMs);

		this.pendingChanges.set(fullPath, { type: eventType, timer });
	}

	/**
	 * Emit a file change event.
	 */
	private emitFileChange(
		fullPath: string,
		relativePath: string,
		eventType: WatchEventType,
	): void {
		let changeType: FileChangeType;
		let isDirectory = false;

		try {
			const stats = statSync(fullPath);
			isDirectory = stats.isDirectory();
			changeType = eventType === "rename" ? "modify" : "modify";
		} catch {
			// File doesn't exist - it was deleted
			changeType = "delete";
		}

		const event: FileChangeEvent = {
			type: changeType,
			path: fullPath,
			relativePath,
			timestamp: Date.now(),
			isDirectory,
		};

		logger.debug("File change detected", {
			type: changeType,
			path: relativePath,
		});

		for (const listener of this.fileListeners) {
			try {
				listener(event);
			} catch (error) {
				logger.error(
					"Error in file change listener",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
	}

	/**
	 * Start polling for git state changes.
	 */
	private async startGitPolling(): Promise<void> {
		// Get initial SHA
		this.currentGitSha = await this.getGitSha();

		this.gitPollTimer = setInterval(async () => {
			try {
				const newSha = await this.getGitSha();
				if (newSha && newSha !== this.currentGitSha) {
					const previousSha = this.currentGitSha;
					this.currentGitSha = newSha;

					const event: GitStateChangeEvent = {
						previousSha,
						currentSha: newSha,
						timestamp: Date.now(),
					};

					logger.debug("Git state changed", {
						previousSha,
						currentSha: newSha,
					});

					for (const listener of this.gitListeners) {
						try {
							listener(event);
						} catch (error) {
							logger.error(
								"Error in git state listener",
								error instanceof Error ? error : new Error(String(error)),
							);
						}
					}
				}
			} catch {
				// Git command failed - not a git repo or other issue
			}
		}, this.config.gitPollIntervalMs);

		// Don't keep process alive
		if (this.gitPollTimer.unref) {
			this.gitPollTimer.unref();
		}

		// Don't keep process alive
		if (this.gitPollTimer.unref) {
			this.gitPollTimer.unref();
		}
	}

	/**
	 * Get the current git SHA.
	 */
	private async getGitSha(): Promise<string | undefined> {
		try {
			const { stdout } = await execAsync("git rev-parse HEAD", {
				cwd: this.config.rootDir,
			});
			return stdout.trim();
		} catch {
			return undefined;
		}
	}
}

/**
 * Create a file watcher.
 */
export function createFileWatcher(config: FileWatcherConfig): FileWatcher {
	return new FileWatcher(config);
}

/**
 * Global file watcher instance.
 */
let globalWatcher: FileWatcher | null = null;

/**
 * Get or create the global file watcher.
 */
export function getGlobalFileWatcher(rootDir?: string): FileWatcher {
	if (!globalWatcher && rootDir) {
		globalWatcher = createFileWatcher({ rootDir });
	}
	if (!globalWatcher) {
		throw new Error("Global file watcher not initialized - provide rootDir");
	}
	return globalWatcher;
}

/**
 * Initialize the global file watcher.
 */
export async function initGlobalFileWatcher(
	rootDir: string,
	config?: Partial<FileWatcherConfig>,
): Promise<FileWatcher> {
	if (globalWatcher) {
		globalWatcher.stop();
	}
	globalWatcher = createFileWatcher({ rootDir, ...config });
	await globalWatcher.start();
	return globalWatcher;
}

/**
 * Stop and reset the global file watcher.
 */
export function resetGlobalFileWatcher(): void {
	if (globalWatcher) {
		globalWatcher.stop();
		globalWatcher = null;
	}
}
