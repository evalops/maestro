/**
 * Auto-Compaction System
 *
 * Automatically triggers conversation compaction when context window usage
 * exceeds configured thresholds. Inspired by Claude Code's auto-compaction.
 *
 * Environment variables:
 * - MAESTRO_AUTOCOMPACT_PCT: Percentage threshold to trigger (default: 85)
 * - MAESTRO_AUTOCOMPACT_ENABLED: Enable/disable auto-compaction (default: true)
 * - MAESTRO_AUTOCOMPACT_MIN_MESSAGES: Minimum messages before compacting (default: 10)
 */

import { createLogger } from "../utils/logger.js";
import { convertAppMessageToLlm } from "./custom-messages.js";
import type { Api, AppMessage, Model } from "./types.js";

const logger = createLogger("auto-compaction");

/**
 * Configuration for auto-compaction behavior.
 */
export interface AutoCompactionConfig {
	/** Whether auto-compaction is enabled */
	enabled: boolean;
	/** Percentage of context window to trigger compaction (0-100) */
	thresholdPercent: number;
	/** Minimum number of messages before compaction is considered */
	minMessages: number;
	/** Number of recent messages to always keep */
	keepRecentCount: number;
	/** Callback when compaction is recommended */
	onCompactionRecommended?: (stats: CompactionStats) => void;
}

/**
 * Statistics about context window usage.
 */
export interface CompactionStats {
	/** Total tokens used in current context */
	totalTokens: number;
	/** Model's context window size */
	contextWindow: number;
	/** Percentage of context window used */
	usagePercent: number;
	/** Number of messages in conversation */
	messageCount: number;
	/** Whether compaction is recommended */
	shouldCompact: boolean;
	/** Reason for recommendation */
	reason?: string;
}

const DEFAULT_CONFIG: AutoCompactionConfig = {
	enabled: true,
	thresholdPercent: 85,
	minMessages: 10,
	keepRecentCount: 6,
};

/**
 * Parse configuration from environment variables.
 */
export function getAutoCompactionConfig(): AutoCompactionConfig {
	const enabled = process.env.MAESTRO_AUTOCOMPACT_ENABLED !== "false";
	const thresholdPercent = Number.parseInt(
		process.env.MAESTRO_AUTOCOMPACT_PCT || "85",
		10,
	);
	const minMessages = Number.parseInt(
		process.env.MAESTRO_AUTOCOMPACT_MIN_MESSAGES || "10",
		10,
	);

	return {
		...DEFAULT_CONFIG,
		enabled,
		thresholdPercent: Number.isNaN(thresholdPercent)
			? DEFAULT_CONFIG.thresholdPercent
			: Math.min(100, Math.max(50, thresholdPercent)),
		minMessages: Number.isNaN(minMessages)
			? DEFAULT_CONFIG.minMessages
			: Math.max(5, minMessages),
	};
}

/**
 * Estimate token count for a message.
 * Uses a simple heuristic: ~4 characters per token.
 */
function estimateMessageTokens(message: AppMessage): number {
	let charCount = 0;
	const llmMessage = convertAppMessageToLlm(message);
	if (!llmMessage) {
		return 0;
	}

	if (typeof llmMessage.content === "string") {
		charCount = llmMessage.content.length;
	} else if (Array.isArray(llmMessage.content)) {
		for (const part of llmMessage.content) {
			if (part.type === "text") {
				charCount += part.text.length;
			} else if (part.type === "thinking") {
				charCount += part.thinking.length;
			} else if (part.type === "toolCall") {
				charCount += JSON.stringify(part.arguments).length + part.name.length;
			}
		}
	}

	// Rough estimate: 4 characters per token
	return Math.ceil(charCount / 4);
}

/**
 * Calculate context window usage statistics.
 */
export function calculateContextUsage(
	messages: AppMessage[],
	model: Model<Api>,
	systemPromptTokens = 0,
): CompactionStats {
	let totalTokens = systemPromptTokens;

	for (const message of messages) {
		// Use actual usage if available (from assistant messages)
		if (message.role === "assistant" && message.usage) {
			totalTokens += message.usage.input + message.usage.output;
		} else {
			totalTokens += estimateMessageTokens(message);
		}
	}

	const contextWindow = model.contextWindow || 128000;
	const usagePercent = (totalTokens / contextWindow) * 100;

	return {
		totalTokens,
		contextWindow,
		usagePercent,
		messageCount: messages.length,
		shouldCompact: false,
		reason: undefined,
	};
}

/**
 * Check if auto-compaction should be triggered.
 */
export function shouldAutoCompact(
	messages: AppMessage[],
	model: Model<Api>,
	config: AutoCompactionConfig = getAutoCompactionConfig(),
	systemPromptTokens = 0,
): CompactionStats {
	if (!config.enabled) {
		return {
			...calculateContextUsage(messages, model, systemPromptTokens),
			shouldCompact: false,
			reason: "Auto-compaction disabled",
		};
	}

	const stats = calculateContextUsage(messages, model, systemPromptTokens);

	// Check message count threshold
	if (stats.messageCount < config.minMessages) {
		return {
			...stats,
			shouldCompact: false,
			reason: `Not enough messages (${stats.messageCount} < ${config.minMessages})`,
		};
	}

	// Check context window threshold
	if (stats.usagePercent >= config.thresholdPercent) {
		logger.info("Auto-compaction threshold reached", {
			usagePercent: stats.usagePercent.toFixed(1),
			threshold: config.thresholdPercent,
			messageCount: stats.messageCount,
		});

		return {
			...stats,
			shouldCompact: true,
			reason: `Context usage ${stats.usagePercent.toFixed(1)}% exceeds ${config.thresholdPercent}% threshold`,
		};
	}

	return {
		...stats,
		shouldCompact: false,
		reason: `Context usage ${stats.usagePercent.toFixed(1)}% below ${config.thresholdPercent}% threshold`,
	};
}

/**
 * Auto-compaction monitor that tracks context usage over time.
 */
export class AutoCompactionMonitor {
	private config: AutoCompactionConfig;
	private lastCheckTime = 0;
	private lastStats: CompactionStats | null = null;
	private compactionCount = 0;

	constructor(config?: Partial<AutoCompactionConfig>) {
		this.config = { ...getAutoCompactionConfig(), ...config };
	}

	/**
	 * Update configuration.
	 */
	setConfig(config: Partial<AutoCompactionConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Get current configuration.
	 */
	getConfig(): AutoCompactionConfig {
		return { ...this.config };
	}

	/**
	 * Check context usage and determine if compaction is needed.
	 * Rate-limited to avoid excessive checks.
	 */
	check(
		messages: AppMessage[],
		model: Model<Api>,
		systemPromptTokens = 0,
	): CompactionStats {
		const now = Date.now();
		const minInterval = 5000; // Check at most every 5 seconds

		// Rate limit checks
		if (this.lastStats && now - this.lastCheckTime < minInterval) {
			return this.lastStats;
		}

		this.lastCheckTime = now;
		this.lastStats = shouldAutoCompact(
			messages,
			model,
			this.config,
			systemPromptTokens,
		);

		if (this.lastStats.shouldCompact && this.config.onCompactionRecommended) {
			this.config.onCompactionRecommended(this.lastStats);
		}

		return this.lastStats;
	}

	/**
	 * Record that a compaction was performed.
	 */
	recordCompaction(): void {
		this.compactionCount++;
		this.lastStats = null; // Force recheck after compaction
		logger.info("Compaction recorded", {
			totalCompactions: this.compactionCount,
		});
	}

	/**
	 * Get compaction statistics.
	 */
	getStats(): { compactionCount: number; lastStats: CompactionStats | null } {
		return {
			compactionCount: this.compactionCount,
			lastStats: this.lastStats,
		};
	}

	/**
	 * Get warning thresholds for UI display.
	 */
	getWarningThresholds(): { warning: number; critical: number } {
		return {
			warning: this.config.thresholdPercent - 10, // Warning at threshold - 10%
			critical: this.config.thresholdPercent,
		};
	}
}

/**
 * Create a default auto-compaction monitor.
 */
export function createAutoCompactionMonitor(
	config?: Partial<AutoCompactionConfig>,
): AutoCompactionMonitor {
	return new AutoCompactionMonitor(config);
}
