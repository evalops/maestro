/**
 * Cache Invalidation Service
 *
 * Integrates the file watcher with the tool result cache to automatically
 * invalidate cached results when files change.
 *
 * Features:
 * - Automatic invalidation on file changes
 * - Git state tracking for git-dependent caches
 * - Selective invalidation based on file patterns
 * - Manual invalidation API
 */

import { basename, dirname, extname, relative } from "node:path";
import { createLogger } from "../utils/logger.js";
import type {
	FileChangeEvent,
	FileWatcher,
	GitStateChangeEvent,
} from "./file-watcher.js";
import { createFileWatcher } from "./file-watcher.js";
import type { ToolResultCache } from "./tool-result-cache.js";
import { getGlobalToolResultCache } from "./tool-result-cache.js";

const logger = createLogger("cache-invalidation");

/**
 * Cache invalidation configuration.
 */
export interface CacheInvalidationConfig {
	/** Root directory to watch */
	rootDir: string;
	/** Whether to enable file watching */
	enableFileWatch?: boolean;
	/** Whether to enable git state watching */
	enableGitWatch?: boolean;
	/** Debounce delay for file changes */
	debounceMs?: number;
	/** File patterns that should trigger full cache clear */
	fullClearPatterns?: string[];
}

/**
 * Invalidation statistics.
 */
export interface InvalidationStats {
	/** Total file change events */
	fileChangeEvents: number;
	/** Total git state change events */
	gitChangeEvents: number;
	/** Total cache entries invalidated */
	entriesInvalidated: number;
	/** Full cache clears */
	fullClears: number;
	/** Last invalidation timestamp */
	lastInvalidation?: number;
}

/**
 * File extensions that map to specific tool types.
 */
const FILE_TOOL_MAPPING: Record<string, string[]> = {
	// Source files - invalidate read cache
	".ts": ["read", "search", "list"],
	".tsx": ["read", "search", "list"],
	".js": ["read", "search", "list"],
	".jsx": ["read", "search", "list"],
	".py": ["read", "search", "list"],
	".go": ["read", "search", "list"],
	".rs": ["read", "search", "list"],
	".java": ["read", "search", "list"],
	".c": ["read", "search", "list"],
	".cpp": ["read", "search", "list"],
	".h": ["read", "search", "list"],
	".hpp": ["read", "search", "list"],
	// Config files - might affect more
	".json": ["read", "search", "list"],
	".yaml": ["read", "search", "list"],
	".yml": ["read", "search", "list"],
	".toml": ["read", "search", "list"],
	// Markdown/docs
	".md": ["read", "search"],
	".txt": ["read", "search"],
};

/**
 * Patterns that should trigger full cache invalidation.
 */
const FULL_CLEAR_PATTERNS = [
	"package.json",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"tsconfig.json",
	"*.config.js",
	"*.config.ts",
	".gitignore",
];

/**
 * Cache Invalidation Service.
 */
export class CacheInvalidationService {
	private config: Required<CacheInvalidationConfig>;
	private watcher: FileWatcher | null = null;
	private cache: ToolResultCache;
	private stats: InvalidationStats = {
		fileChangeEvents: 0,
		gitChangeEvents: 0,
		entriesInvalidated: 0,
		fullClears: 0,
	};
	private unsubscribeFile?: () => void;
	private unsubscribeGit?: () => void;

	constructor(config: CacheInvalidationConfig, cache?: ToolResultCache) {
		this.config = {
			enableFileWatch: true,
			enableGitWatch: true,
			debounceMs: 100,
			fullClearPatterns: FULL_CLEAR_PATTERNS,
			...config,
		};
		this.cache = cache ?? getGlobalToolResultCache();
	}

	/**
	 * Start the cache invalidation service.
	 */
	async start(): Promise<void> {
		logger.info("Starting cache invalidation service", {
			rootDir: this.config.rootDir,
			enableFileWatch: this.config.enableFileWatch,
			enableGitWatch: this.config.enableGitWatch,
		});

		this.watcher = createFileWatcher({
			rootDir: this.config.rootDir,
			debounceMs: this.config.debounceMs,
			watchGitState: this.config.enableGitWatch,
		});

		if (this.config.enableFileWatch) {
			this.unsubscribeFile = this.watcher.onFileChange((event) => {
				this.handleFileChange(event);
			});
		}

		if (this.config.enableGitWatch) {
			this.unsubscribeGit = this.watcher.onGitStateChange((event) => {
				this.handleGitChange(event);
			});
		}

		await this.watcher.start();

		// Set initial git SHA on cache
		const gitSha = this.watcher.getCurrentGitSha();
		if (gitSha) {
			this.cache.setGitSha(gitSha);
		}
	}

	/**
	 * Stop the service.
	 */
	stop(): void {
		logger.info("Stopping cache invalidation service");

		if (this.unsubscribeFile) {
			this.unsubscribeFile();
			this.unsubscribeFile = undefined;
		}

		if (this.unsubscribeGit) {
			this.unsubscribeGit();
			this.unsubscribeGit = undefined;
		}

		if (this.watcher) {
			this.watcher.stop();
			this.watcher = null;
		}
	}

	/**
	 * Get invalidation statistics.
	 */
	getStats(): InvalidationStats {
		return { ...this.stats };
	}

	/**
	 * Manually invalidate cache for a specific file.
	 */
	invalidateFile(filePath: string): number {
		const relativePath = relative(this.config.rootDir, filePath);
		return this.invalidateByPath(relativePath);
	}

	/**
	 * Manually trigger full cache clear.
	 */
	clearAll(): void {
		logger.info("Manual full cache clear");
		this.cache.clear();
		this.stats.fullClears++;
		this.stats.lastInvalidation = Date.now();
	}

	/**
	 * Handle a file change event.
	 */
	private handleFileChange(event: FileChangeEvent): void {
		this.stats.fileChangeEvents++;

		const { relativePath, type } = event;

		logger.debug("Processing file change", { relativePath, type });

		// Check if this should trigger a full clear
		if (this.shouldFullClear(relativePath)) {
			logger.info("File change triggers full cache clear", { relativePath });
			this.cache.clear();
			this.stats.fullClears++;
			this.stats.lastInvalidation = Date.now();
			return;
		}

		// Selective invalidation based on file type
		const invalidated = this.invalidateByPath(relativePath);
		if (invalidated > 0) {
			this.stats.entriesInvalidated += invalidated;
			this.stats.lastInvalidation = Date.now();
		}
	}

	/**
	 * Handle a git state change event.
	 */
	private handleGitChange(event: GitStateChangeEvent): void {
		this.stats.gitChangeEvents++;

		logger.info("Git state changed", {
			from: event.previousSha?.slice(0, 8),
			to: event.currentSha.slice(0, 8),
		});

		// Update cache git SHA
		this.cache.setGitSha(event.currentSha);

		// Invalidate git-dependent caches
		const invalidated = this.cache.invalidateGitCaches();
		if (invalidated > 0) {
			this.stats.entriesInvalidated += invalidated;
			this.stats.lastInvalidation = Date.now();
		}
	}

	/**
	 * Check if a path should trigger full cache clear.
	 */
	private shouldFullClear(relativePath: string): boolean {
		const filename = basename(relativePath) || relativePath;

		for (const pattern of this.config.fullClearPatterns) {
			if (pattern.includes("*")) {
				// Simple glob matching
				const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
				if (regex.test(filename)) {
					return true;
				}
			} else if (filename === pattern) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Invalidate cache entries by file path.
	 */
	private invalidateByPath(relativePath: string): number {
		const ext = extname(relativePath).toLowerCase();
		const toolsToInvalidate = FILE_TOOL_MAPPING[ext];

		if (!toolsToInvalidate) {
			// Unknown file type - invalidate all file system dependent caches
			return this.cache.invalidateFileSystemCaches();
		}

		let totalInvalidated = 0;

		// Invalidate specific cache entries that might have used this file
		// For read tool: invalidate entries with matching path
		if (toolsToInvalidate.includes("read")) {
			totalInvalidated += this.cache.invalidate("read", {
				file_path: relativePath,
			});
			// Also try with absolute path patterns
			totalInvalidated += this.cache.invalidate("read", {
				path: relativePath,
			});
		}

		// For list tool: invalidate entries for the directory
		if (toolsToInvalidate.includes("list")) {
			const dir = dirname(relativePath);
			totalInvalidated += this.cache.invalidate("list", { path: dir });
		}

		// For search: invalidate all search caches (too hard to track which searches hit this file)
		if (toolsToInvalidate.includes("search")) {
			totalInvalidated += this.cache.invalidate("search");
		}

		return totalInvalidated;
	}
}

/**
 * Create a cache invalidation service.
 */
export function createCacheInvalidationService(
	config: CacheInvalidationConfig,
	cache?: ToolResultCache,
): CacheInvalidationService {
	return new CacheInvalidationService(config, cache);
}

/**
 * Global cache invalidation service instance.
 */
let globalService: CacheInvalidationService | null = null;

/**
 * Initialize the global cache invalidation service.
 */
export async function initGlobalCacheInvalidation(
	rootDir: string,
	config?: Partial<CacheInvalidationConfig>,
): Promise<CacheInvalidationService> {
	if (globalService) {
		globalService.stop();
	}
	globalService = createCacheInvalidationService({ rootDir, ...config });
	await globalService.start();
	return globalService;
}

/**
 * Get the global cache invalidation service.
 */
export function getGlobalCacheInvalidation(): CacheInvalidationService | null {
	return globalService;
}

/**
 * Stop and reset the global service.
 */
export function resetGlobalCacheInvalidation(): void {
	if (globalService) {
		globalService.stop();
		globalService = null;
	}
}
