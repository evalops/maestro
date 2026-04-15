/**
 * Prompt Caching Manager
 *
 * Implements Anthropic's prompt caching to reduce costs and latency for
 * repeated system prompts and context. Tracks cache-eligible content blocks
 * and monitors cache hit/miss ratios for optimization.
 *
 * Environment variables:
 * - MAESTRO_PROMPT_CACHE_ENABLED: Enable/disable prompt caching (default: true)
 * - MAESTRO_PROMPT_CACHE_MIN_TOKENS: Minimum tokens for caching (default: 1024)
 * - MAESTRO_PROMPT_CACHE_TTL: TTL in seconds for cache entries (default: 300)
 */

import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("prompt-cache");

/**
 * Cache control type for Anthropic API.
 */
export interface CacheControl {
	type: "ephemeral";
}

/**
 * A content block that can be cached.
 */
export interface CacheableBlock {
	/** Unique identifier for this block */
	id: string;
	/** The content to cache */
	content: string;
	/** Estimated token count */
	tokenCount: number;
	/** Whether to apply cache control */
	cacheControl?: CacheControl;
	/** Block type (system, context, etc.) */
	blockType: "system" | "context" | "tools" | "history";
	/** Priority for caching (higher = more likely to cache) */
	priority: number;
}

/**
 * Cache statistics for monitoring.
 */
export interface CacheStats {
	/** Total requests made */
	totalRequests: number;
	/** Requests that hit the cache */
	cacheHits: number;
	/** Requests that missed the cache */
	cacheMisses: number;
	/** Cache hit ratio (0-1) */
	hitRatio: number;
	/** Estimated tokens saved by caching */
	tokensSaved: number;
	/** Estimated cost saved (USD) */
	costSaved: number;
	/** Current cache size in tokens */
	currentCacheSizeTokens: number;
}

/**
 * Configuration for prompt caching.
 */
export interface PromptCacheConfig {
	/** Whether caching is enabled */
	enabled: boolean;
	/** Minimum tokens for a block to be cache-eligible */
	minTokensForCaching: number;
	/** TTL for cache entries in seconds */
	cacheTtlSeconds: number;
	/** Maximum number of blocks to cache per request */
	maxCachedBlocksPerRequest: number;
	/** Cost per million input tokens (for savings calculation) */
	inputCostPerMillionTokens: number;
	/** Cache read cost per million tokens (usually 10% of input cost) */
	cacheReadCostPerMillionTokens: number;
}

const DEFAULT_CONFIG: PromptCacheConfig = {
	enabled: true,
	minTokensForCaching: 1024,
	cacheTtlSeconds: 300, // 5 minutes (Anthropic's minimum)
	maxCachedBlocksPerRequest: 4, // Anthropic allows up to 4 cache breakpoints
	inputCostPerMillionTokens: 3, // Claude 3.5 Sonnet pricing
	cacheReadCostPerMillionTokens: 0.3, // 10% of input cost
};

/**
 * Get prompt cache configuration from environment.
 */
export function getPromptCacheConfig(): PromptCacheConfig {
	const enabled = process.env.MAESTRO_PROMPT_CACHE_ENABLED !== "false";
	const minTokens = Number.parseInt(
		process.env.MAESTRO_PROMPT_CACHE_MIN_TOKENS || "1024",
		10,
	);
	const ttl = Number.parseInt(
		process.env.MAESTRO_PROMPT_CACHE_TTL || "300",
		10,
	);

	return {
		...DEFAULT_CONFIG,
		enabled,
		minTokensForCaching: Number.isNaN(minTokens)
			? DEFAULT_CONFIG.minTokensForCaching
			: Math.max(1024, minTokens), // Anthropic minimum is 1024
		cacheTtlSeconds: Number.isNaN(ttl)
			? DEFAULT_CONFIG.cacheTtlSeconds
			: Math.max(300, ttl), // Anthropic minimum is 5 minutes
	};
}

/**
 * Estimate token count for a string (rough approximation).
 */
export function estimateTokens(text: string): number {
	// Rough estimate: 4 characters per token on average
	return Math.ceil(text.length / 4);
}

/**
 * Generate a content hash for cache key generation.
 */
function generateContentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Prompt Cache Manager for optimizing LLM requests.
 */
export class PromptCacheManager {
	private config: PromptCacheConfig;
	private stats: CacheStats;
	private blockRegistry: Map<
		string,
		{ block: CacheableBlock; lastUsed: number; useCount: number }
	> = new Map();
	private lastCacheHashes: Set<string> = new Set();

	constructor(config?: Partial<PromptCacheConfig>) {
		this.config = { ...getPromptCacheConfig(), ...config };
		this.stats = {
			totalRequests: 0,
			cacheHits: 0,
			cacheMisses: 0,
			hitRatio: 0,
			tokensSaved: 0,
			costSaved: 0,
			currentCacheSizeTokens: 0,
		};
	}

	/**
	 * Register a content block for potential caching.
	 */
	registerBlock(block: Omit<CacheableBlock, "id">): CacheableBlock {
		const hash = generateContentHash(block.content);
		const id = `${block.blockType}-${hash}`;

		const fullBlock: CacheableBlock = {
			...block,
			id,
			cacheControl:
				block.tokenCount >= this.config.minTokensForCaching
					? { type: "ephemeral" }
					: undefined,
		};

		const existing = this.blockRegistry.get(id);
		if (existing) {
			existing.lastUsed = Date.now();
			existing.useCount++;
		} else {
			this.blockRegistry.set(id, {
				block: fullBlock,
				lastUsed: Date.now(),
				useCount: 1,
			});
		}

		return fullBlock;
	}

	/**
	 * Create a cacheable system prompt block.
	 */
	createSystemBlock(content: string): CacheableBlock {
		return this.registerBlock({
			content,
			tokenCount: estimateTokens(content),
			blockType: "system",
			priority: 100, // Highest priority
		});
	}

	/**
	 * Create a cacheable context block (e.g., file contents, documentation).
	 */
	createContextBlock(content: string, priority = 50): CacheableBlock {
		return this.registerBlock({
			content,
			tokenCount: estimateTokens(content),
			blockType: "context",
			priority,
		});
	}

	/**
	 * Create a cacheable tools definition block.
	 */
	createToolsBlock(toolsJson: string): CacheableBlock {
		return this.registerBlock({
			content: toolsJson,
			tokenCount: estimateTokens(toolsJson),
			blockType: "tools",
			priority: 90, // High priority (tools rarely change)
		});
	}

	/**
	 * Select blocks to cache for a request, respecting limits.
	 */
	selectBlocksForCaching(blocks: CacheableBlock[]): CacheableBlock[] {
		if (!this.config.enabled) {
			return blocks.map((b) => ({ ...b, cacheControl: undefined }));
		}

		// Filter to cache-eligible blocks and sort by priority
		const eligible = blocks
			.filter((b) => b.tokenCount >= this.config.minTokensForCaching)
			.sort((a, b) => b.priority - a.priority);

		// Take top N blocks for caching
		const toCacheIds = new Set(
			eligible.slice(0, this.config.maxCachedBlocksPerRequest).map((b) => b.id),
		);

		return blocks.map((b) => ({
			...b,
			cacheControl: toCacheIds.has(b.id) ? { type: "ephemeral" } : undefined,
		}));
	}

	/**
	 * Process response and update cache statistics.
	 */
	recordCacheResult(usage: {
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		inputTokens: number;
	}): void {
		this.stats.totalRequests++;

		const cacheRead = usage.cacheReadTokens || 0;
		const cacheWrite = usage.cacheWriteTokens || 0;

		if (cacheRead > 0) {
			this.stats.cacheHits++;
			this.stats.tokensSaved += cacheRead;

			// Calculate cost savings (cache reads are 10% of input cost)
			const regularCost =
				(cacheRead / 1_000_000) * this.config.inputCostPerMillionTokens;
			const cacheCost =
				(cacheRead / 1_000_000) * this.config.cacheReadCostPerMillionTokens;
			this.stats.costSaved += regularCost - cacheCost;
		} else if (cacheWrite > 0) {
			this.stats.cacheMisses++;
		}

		// Update hit ratio
		if (this.stats.totalRequests > 0) {
			this.stats.hitRatio = this.stats.cacheHits / this.stats.totalRequests;
		}

		// Update current cache size estimate
		this.stats.currentCacheSizeTokens = cacheWrite;

		logger.debug("Cache result recorded", {
			cacheRead,
			cacheWrite,
			hitRatio: this.stats.hitRatio.toFixed(2),
			totalSaved: this.stats.costSaved.toFixed(4),
		});
	}

	/**
	 * Get current cache statistics.
	 */
	getStats(): CacheStats {
		return { ...this.stats };
	}

	/**
	 * Reset cache statistics.
	 */
	resetStats(): void {
		this.stats = {
			totalRequests: 0,
			cacheHits: 0,
			cacheMisses: 0,
			hitRatio: 0,
			tokensSaved: 0,
			costSaved: 0,
			currentCacheSizeTokens: 0,
		};
	}

	/**
	 * Get block usage statistics for optimization.
	 */
	getBlockUsageStats(): Array<{
		id: string;
		blockType: string;
		tokenCount: number;
		useCount: number;
		lastUsed: Date;
	}> {
		return Array.from(this.blockRegistry.values())
			.map((entry) => ({
				id: entry.block.id,
				blockType: entry.block.blockType,
				tokenCount: entry.block.tokenCount,
				useCount: entry.useCount,
				lastUsed: new Date(entry.lastUsed),
			}))
			.sort((a, b) => b.useCount - a.useCount);
	}

	/**
	 * Clean up old block entries.
	 */
	cleanup(maxAgeMs = 3600000): number {
		const cutoff = Date.now() - maxAgeMs;
		let removed = 0;

		for (const [id, entry] of this.blockRegistry) {
			if (entry.lastUsed < cutoff) {
				this.blockRegistry.delete(id);
				removed++;
			}
		}

		if (removed > 0) {
			logger.info("Cleaned up old cache entries", { removed });
		}

		return removed;
	}

	/**
	 * Format system prompt with cache control markers.
	 * Returns an array of content blocks for Anthropic API.
	 */
	formatSystemPromptForCaching(
		basePrompt: string,
		additionalContext?: string[],
	): Array<{ type: "text"; text: string; cache_control?: CacheControl }> {
		const blocks: Array<{
			type: "text";
			text: string;
			cache_control?: CacheControl;
		}> = [];

		// Main system prompt block
		const systemBlock = this.createSystemBlock(basePrompt);
		blocks.push({
			type: "text",
			text: systemBlock.content,
			cache_control: systemBlock.cacheControl,
		});

		// Additional context blocks
		if (additionalContext) {
			for (let i = 0; i < additionalContext.length; i++) {
				const contextBlock = this.createContextBlock(
					additionalContext[i]!,
					50 - i, // Decreasing priority
				);
				blocks.push({
					type: "text",
					text: contextBlock.content,
					cache_control: contextBlock.cacheControl,
				});
			}
		}

		// Only apply cache control to top blocks
		const selected = this.selectBlocksForCaching(
			blocks.map((b, i) => ({
				id: `block-${i}`,
				content: b.text,
				tokenCount: estimateTokens(b.text),
				blockType: i === 0 ? ("system" as const) : ("context" as const),
				priority: 100 - i,
			})),
		);

		return blocks.map((b, i) => ({
			...b,
			cache_control: selected[i]?.cacheControl,
		}));
	}

	/**
	 * Check if caching is enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Get configuration.
	 */
	getConfig(): PromptCacheConfig {
		return { ...this.config };
	}

	/**
	 * Update configuration.
	 */
	setConfig(config: Partial<PromptCacheConfig>): void {
		this.config = { ...this.config, ...config };
	}
}

/**
 * Create a default prompt cache manager.
 */
export function createPromptCacheManager(
	config?: Partial<PromptCacheConfig>,
): PromptCacheManager {
	return new PromptCacheManager(config);
}
