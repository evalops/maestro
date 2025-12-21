/**
 * Tool Result Caching System
 *
 * Implements result memoization for idempotent tools to reduce redundant
 * executions. Uses content hashing for result validity and LRU eviction.
 *
 * Environment variables:
 * - COMPOSER_TOOL_CACHE_ENABLED: Enable/disable tool caching (default: true)
 * - COMPOSER_TOOL_CACHE_TTL: Default TTL in seconds (default: 300)
 * - COMPOSER_TOOL_CACHE_MAX_ENTRIES: Maximum cache entries (default: 1000)
 * - COMPOSER_TOOL_CACHE_MAX_BYTES: Maximum cache size in bytes (default: 50MB)
 * - COMPOSER_TOOL_CACHE_MAX_SIZE: Legacy alias for max entries (default: 1000)
 */

import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tool-result-cache");

/**
 * Cache scope determines visibility of cached results.
 */
export type CacheScope = "session" | "user" | "global";

/**
 * Tool cacheability configuration.
 */
export interface ToolCacheConfig {
	/** Whether this tool's results can be cached */
	cacheable: boolean;
	/** TTL for cached results in seconds */
	ttlSeconds: number;
	/** Cache scope */
	scope: CacheScope;
	/** Keys from input to include in cache key (null = all) */
	keyFields?: string[] | null;
	/** Whether results depend on file system state */
	fileSystemDependent?: boolean;
	/** Whether results depend on git state */
	gitStateDependent?: boolean;
}

/**
 * Default cache configurations for built-in tools.
 */
export const DEFAULT_TOOL_CACHE_CONFIGS: Record<string, ToolCacheConfig> = {
	// Read-only tools - highly cacheable
	read: {
		cacheable: true,
		ttlSeconds: 60,
		scope: "session",
		fileSystemDependent: true,
	},
	list: {
		cacheable: true,
		ttlSeconds: 60,
		scope: "session",
		fileSystemDependent: true,
	},
	search: {
		cacheable: true,
		ttlSeconds: 120,
		scope: "session",
		fileSystemDependent: true,
	},
	diff: {
		cacheable: true,
		ttlSeconds: 30,
		scope: "session",
		gitStateDependent: true,
	},
	status: {
		cacheable: true,
		ttlSeconds: 30,
		scope: "session",
		gitStateDependent: true,
	},

	// Mutating tools - not cacheable
	write: { cacheable: false, ttlSeconds: 0, scope: "session" },
	edit: { cacheable: false, ttlSeconds: 0, scope: "session" },
	bash: { cacheable: false, ttlSeconds: 0, scope: "session" },
	notebook_edit: { cacheable: false, ttlSeconds: 0, scope: "session" },

	// External tools - short TTL
	websearch: {
		cacheable: true,
		ttlSeconds: 300,
		scope: "global",
	},
	webfetch: {
		cacheable: true,
		ttlSeconds: 300,
		scope: "global",
	},
	codesearch: {
		cacheable: true,
		ttlSeconds: 600,
		scope: "global",
	},

	// User interaction - not cacheable
	ask_user: { cacheable: false, ttlSeconds: 0, scope: "session" },
	todo: { cacheable: false, ttlSeconds: 0, scope: "session" },
};

/**
 * A cached tool result entry.
 */
interface CacheEntry {
	/** The cached result */
	result: unknown;
	/** When the entry was created */
	createdAt: number;
	/** When the entry was last accessed (for true LRU) */
	lastAccessedAt: number;
	/** When the entry expires */
	expiresAt: number;
	/** Hash of the input arguments */
	inputHash: string;
	/** Tool name */
	toolName: string;
	/** Number of cache hits */
	hitCount: number;
	/** Size estimate in bytes */
	sizeBytes: number;
	/** File modification times when cached (for file-dependent caches) */
	fileMtimes?: Record<string, number>;
	/** Git commit SHA when cached (for git-dependent caches) */
	gitSha?: string;
}

/**
 * Cache statistics.
 */
export interface ToolCacheStats {
	/** Total cache lookups */
	totalLookups: number;
	/** Cache hits */
	hits: number;
	/** Cache misses */
	misses: number;
	/** Hit ratio (0-1) */
	hitRatio: number;
	/** Current number of entries */
	entryCount: number;
	/** Estimated memory usage in bytes */
	memorySizeBytes: number;
	/** Number of evictions */
	evictions: number;
	/** Stats per tool */
	byTool: Record<
		string,
		{ lookups: number; hits: number; misses: number; hitRatio: number }
	>;
}

/**
 * Global cache configuration.
 */
export interface ToolResultCacheConfig {
	/** Whether caching is enabled */
	enabled: boolean;
	/** Default TTL in seconds */
	defaultTtlSeconds: number;
	/** Maximum number of cache entries */
	maxEntries: number;
	/** Maximum memory size in bytes */
	maxSizeBytes: number;
	/** Cleanup interval in ms */
	cleanupIntervalMs: number;
}

const DEFAULT_CONFIG: ToolResultCacheConfig = {
	enabled: true,
	defaultTtlSeconds: 300,
	maxEntries: 1000,
	maxSizeBytes: 50 * 1024 * 1024, // 50MB
	cleanupIntervalMs: 60000, // 1 minute
};

/**
 * Get tool cache configuration from environment.
 */
export function getToolResultCacheConfig(): ToolResultCacheConfig {
	const enabled = process.env.COMPOSER_TOOL_CACHE_ENABLED !== "false";
	const ttl = Number.parseInt(process.env.COMPOSER_TOOL_CACHE_TTL || "300", 10);
	const maxEntries = Number.parseInt(
		process.env.COMPOSER_TOOL_CACHE_MAX_ENTRIES ??
			process.env.COMPOSER_TOOL_CACHE_MAX_SIZE ??
			"1000",
		10,
	);
	const maxBytes = Number.parseInt(
		process.env.COMPOSER_TOOL_CACHE_MAX_BYTES ??
			process.env.COMPOSER_TOOL_CACHE_MAX_SIZE_BYTES ??
			`${DEFAULT_CONFIG.maxSizeBytes}`,
		10,
	);

	return {
		...DEFAULT_CONFIG,
		enabled,
		defaultTtlSeconds: Number.isNaN(ttl)
			? DEFAULT_CONFIG.defaultTtlSeconds
			: ttl,
		maxEntries: Number.isNaN(maxEntries)
			? DEFAULT_CONFIG.maxEntries
			: maxEntries,
		maxSizeBytes: Number.isNaN(maxBytes)
			? DEFAULT_CONFIG.maxSizeBytes
			: maxBytes,
	};
}

/**
 * Generate a cache key from tool name and arguments.
 */
function generateCacheKey(
	toolName: string,
	args: Record<string, unknown>,
	scope: CacheScope,
	scopeId?: string,
	keyFields?: string[] | null,
): string {
	// Filter args to key fields if specified
	const keyArgs =
		keyFields === null
			? args
			: keyFields
				? Object.fromEntries(
						Object.entries(args).filter(([k]) => keyFields.includes(k)),
					)
				: args;

	const argsString = JSON.stringify(keyArgs, Object.keys(keyArgs).sort());
	const hash = createHash("sha256")
		.update(`${toolName}:${argsString}`)
		.digest("hex")
		.slice(0, 32);

	const scopePrefix = scopeId ? `${scope}:${scopeId}` : scope;
	return `${scopePrefix}:${toolName}:${hash}`;
}

/**
 * Estimate the size of a value in bytes.
 */
function estimateSize(value: unknown): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "string") return value.length * 2; // UTF-16
	if (typeof value === "number") return 8;
	if (typeof value === "boolean") return 4;
	if (Array.isArray(value)) {
		return value.reduce((sum, item) => sum + estimateSize(item), 0);
	}
	if (typeof value === "object") {
		return Object.entries(value).reduce(
			(sum, [k, v]) => sum + k.length * 2 + estimateSize(v),
			0,
		);
	}
	return JSON.stringify(value).length * 2;
}

/**
 * Tool Result Cache Manager.
 */
export class ToolResultCache {
	private config: ToolResultCacheConfig;
	private toolConfigs: Map<string, ToolCacheConfig> = new Map();
	private cache: Map<string, CacheEntry> = new Map();
	private stats: ToolCacheStats;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private currentScopeId?: string;
	private currentGitSha?: string;

	constructor(config?: Partial<ToolResultCacheConfig>) {
		this.config = { ...getToolResultCacheConfig(), ...config };
		this.stats = {
			totalLookups: 0,
			hits: 0,
			misses: 0,
			hitRatio: 0,
			entryCount: 0,
			memorySizeBytes: 0,
			evictions: 0,
			byTool: {},
		};

		// Initialize default tool configs
		for (const [tool, cfg] of Object.entries(DEFAULT_TOOL_CACHE_CONFIGS)) {
			this.toolConfigs.set(tool, cfg);
		}

		// Start cleanup timer
		this.startCleanup();
	}

	/**
	 * Set the current session/user scope ID.
	 */
	setScopeId(scopeId: string): void {
		this.currentScopeId = scopeId;
	}

	/**
	 * Set the current git SHA for git-dependent caches.
	 */
	setGitSha(sha: string | undefined): void {
		this.currentGitSha = sha;
	}

	/**
	 * Configure caching for a specific tool.
	 */
	setToolConfig(toolName: string, config: ToolCacheConfig): void {
		this.toolConfigs.set(toolName, config);
	}

	/**
	 * Get cache configuration for a tool.
	 */
	getToolConfig(toolName: string): ToolCacheConfig | undefined {
		return this.toolConfigs.get(toolName);
	}

	/**
	 * Check if a tool is cacheable.
	 */
	isCacheable(toolName: string): boolean {
		if (!this.config.enabled) return false;
		const toolConfig = this.toolConfigs.get(toolName);
		return toolConfig?.cacheable ?? false;
	}

	/**
	 * Get a cached result for a tool call.
	 */
	get<T>(
		toolName: string,
		args: Record<string, unknown>,
	): { hit: true; result: T } | { hit: false } {
		if (!this.config.enabled) {
			return { hit: false };
		}

		const toolConfig = this.toolConfigs.get(toolName);
		if (!toolConfig?.cacheable) {
			return { hit: false };
		}

		const key = generateCacheKey(
			toolName,
			args,
			toolConfig.scope,
			this.currentScopeId,
			toolConfig.keyFields,
		);

		const entry = this.cache.get(key);
		this.updateStats(toolName, false);

		if (!entry) {
			return { hit: false };
		}

		// Check expiration
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			this.stats.memorySizeBytes -= entry.sizeBytes;
			return { hit: false };
		}

		// Check git state dependency
		if (toolConfig.gitStateDependent && entry.gitSha !== this.currentGitSha) {
			this.cache.delete(key);
			this.stats.memorySizeBytes -= entry.sizeBytes;
			return { hit: false };
		}

		// Cache hit!
		entry.hitCount++;
		entry.lastAccessedAt = Date.now();
		this.updateStats(toolName, true);

		logger.debug("Cache hit", {
			tool: toolName,
			key: key.slice(-16),
			hitCount: entry.hitCount,
		});

		return { hit: true, result: entry.result as T };
	}

	/**
	 * Store a result in the cache.
	 */
	set(
		toolName: string,
		args: Record<string, unknown>,
		result: unknown,
		options?: { ttlSeconds?: number; fileMtimes?: Record<string, number> },
	): void {
		if (!this.config.enabled) return;

		const toolConfig = this.toolConfigs.get(toolName);
		if (!toolConfig?.cacheable) return;

		const key = generateCacheKey(
			toolName,
			args,
			toolConfig.scope,
			this.currentScopeId,
			toolConfig.keyFields,
		);

		const ttl = options?.ttlSeconds ?? toolConfig.ttlSeconds;
		const now = Date.now();
		const sizeBytes = estimateSize(result);

		if (sizeBytes > this.config.maxSizeBytes) {
			logger.debug("Skipping cache entry larger than max size", {
				tool: toolName,
				size: sizeBytes,
				maxSize: this.config.maxSizeBytes,
			});
			return;
		}

		// Check if we need to evict entries
		this.ensureCapacity(sizeBytes);

		const entry: CacheEntry = {
			result,
			createdAt: now,
			lastAccessedAt: now,
			expiresAt: now + ttl * 1000,
			inputHash: key,
			toolName,
			hitCount: 0,
			sizeBytes,
			fileMtimes: options?.fileMtimes,
			gitSha: toolConfig.gitStateDependent ? this.currentGitSha : undefined,
		};

		// Remove old entry if exists
		const oldEntry = this.cache.get(key);
		if (oldEntry) {
			this.stats.memorySizeBytes -= oldEntry.sizeBytes;
		}

		this.cache.set(key, entry);
		this.stats.memorySizeBytes += sizeBytes;
		this.stats.entryCount = this.cache.size;

		logger.debug("Cached result", {
			tool: toolName,
			key: key.slice(-16),
			ttl,
			size: sizeBytes,
		});
	}

	/**
	 * Invalidate cache entries for a tool.
	 */
	invalidate(toolName: string, args?: Record<string, unknown>): number {
		let invalidated = 0;

		if (args) {
			// Invalidate specific entry
			const toolConfig = this.toolConfigs.get(toolName);
			if (toolConfig) {
				const key = generateCacheKey(
					toolName,
					args,
					toolConfig.scope,
					this.currentScopeId,
					toolConfig.keyFields,
				);
				const entry = this.cache.get(key);
				if (entry) {
					this.stats.memorySizeBytes -= entry.sizeBytes;
					this.cache.delete(key);
					invalidated = 1;
				}
			}
		} else {
			// Invalidate all entries for tool
			for (const [key, entry] of this.cache) {
				if (entry.toolName === toolName) {
					this.stats.memorySizeBytes -= entry.sizeBytes;
					this.cache.delete(key);
					invalidated++;
				}
			}
		}

		if (invalidated > 0) {
			this.stats.entryCount = this.cache.size;
			logger.debug("Invalidated cache entries", {
				tool: toolName,
				invalidated,
			});
		}

		return invalidated;
	}

	/**
	 * Invalidate all file-system dependent caches.
	 */
	invalidateFileSystemCaches(): number {
		let invalidated = 0;

		for (const [key, entry] of this.cache) {
			const toolConfig = this.toolConfigs.get(entry.toolName);
			if (toolConfig?.fileSystemDependent) {
				this.stats.memorySizeBytes -= entry.sizeBytes;
				this.cache.delete(key);
				invalidated++;
			}
		}

		if (invalidated > 0) {
			this.stats.entryCount = this.cache.size;
			logger.info("Invalidated file system caches", { invalidated });
		}

		return invalidated;
	}

	/**
	 * Invalidate all git-state dependent caches.
	 */
	invalidateGitCaches(): number {
		let invalidated = 0;

		for (const [key, entry] of this.cache) {
			const toolConfig = this.toolConfigs.get(entry.toolName);
			if (toolConfig?.gitStateDependent) {
				this.stats.memorySizeBytes -= entry.sizeBytes;
				this.cache.delete(key);
				invalidated++;
			}
		}

		if (invalidated > 0) {
			this.stats.entryCount = this.cache.size;
			logger.info("Invalidated git caches", { invalidated });
		}

		return invalidated;
	}

	/**
	 * Clear all cache entries.
	 */
	clear(): void {
		this.cache.clear();
		this.stats.entryCount = 0;
		this.stats.memorySizeBytes = 0;
		logger.info("Cache cleared");
	}

	/**
	 * Get cache statistics.
	 */
	getStats(): ToolCacheStats {
		return { ...this.stats, byTool: { ...this.stats.byTool } };
	}

	/**
	 * Update statistics.
	 */
	private updateStats(toolName: string, hit: boolean): void {
		this.stats.totalLookups++;
		if (hit) {
			this.stats.hits++;
		} else {
			this.stats.misses++;
		}

		this.stats.hitRatio =
			this.stats.totalLookups > 0
				? this.stats.hits / this.stats.totalLookups
				: 0;

		// Per-tool stats
		if (!this.stats.byTool[toolName]) {
			this.stats.byTool[toolName] = {
				lookups: 0,
				hits: 0,
				misses: 0,
				hitRatio: 0,
			};
		}
		const toolStats = this.stats.byTool[toolName];
		toolStats.lookups++;
		if (hit) {
			toolStats.hits++;
		} else {
			toolStats.misses++;
		}
		toolStats.hitRatio =
			toolStats.lookups > 0 ? toolStats.hits / toolStats.lookups : 0;
	}

	/**
	 * Ensure cache has capacity for new entry.
	 */
	private ensureCapacity(requiredBytes: number): void {
		// Evict by count
		while (this.cache.size >= this.config.maxEntries) {
			this.evictLRU();
		}

		// Evict by size
		while (
			this.stats.memorySizeBytes + requiredBytes > this.config.maxSizeBytes &&
			this.cache.size > 0
		) {
			this.evictLRU();
		}
	}

	/**
	 * Evict least recently used entry.
	 */
	private evictLRU(): void {
		let oldestKey: string | null = null;
		let oldestTime = Number.POSITIVE_INFINITY;

		for (const [key, entry] of this.cache) {
			// True LRU: evict the entry that was accessed least recently
			if (entry.lastAccessedAt < oldestTime) {
				oldestTime = entry.lastAccessedAt;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			const entry = this.cache.get(oldestKey);
			if (entry) {
				this.stats.memorySizeBytes -= entry.sizeBytes;
			}
			this.cache.delete(oldestKey);
			this.stats.evictions++;
			this.stats.entryCount = this.cache.size;
		}
	}

	/**
	 * Start periodic cleanup.
	 */
	private startCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}

		this.cleanupTimer = setInterval(() => {
			this.cleanup();
		}, this.config.cleanupIntervalMs);

		// Don't keep process alive
		if (this.cleanupTimer.unref) {
			this.cleanupTimer.unref();
		}
	}

	/**
	 * Clean up expired entries.
	 */
	cleanup(): number {
		const now = Date.now();
		let removed = 0;

		for (const [key, entry] of this.cache) {
			if (now > entry.expiresAt) {
				this.stats.memorySizeBytes -= entry.sizeBytes;
				this.cache.delete(key);
				removed++;
			}
		}

		if (removed > 0) {
			this.stats.entryCount = this.cache.size;
			logger.debug("Cleaned up expired entries", { removed });
		}

		return removed;
	}

	/**
	 * Stop the cache (clear timer).
	 */
	stop(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}
}

/**
 * Create a default tool result cache.
 */
export function createToolResultCache(
	config?: Partial<ToolResultCacheConfig>,
): ToolResultCache {
	return new ToolResultCache(config);
}

/**
 * Global shared cache instance.
 */
let globalCache: ToolResultCache | null = null;

/**
 * Get or create the global tool result cache.
 */
export function getGlobalToolResultCache(): ToolResultCache {
	if (!globalCache) {
		globalCache = createToolResultCache();
	}
	return globalCache;
}

/**
 * Reset the global cache (for testing).
 */
export function resetGlobalToolResultCache(): void {
	if (globalCache) {
		globalCache.stop();
		globalCache = null;
	}
}
