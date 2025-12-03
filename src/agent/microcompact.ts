/**
 * Microcompact - Lightweight context reduction for tool results.
 *
 * Unlike full compaction which summarizes the entire conversation,
 * microcompact only reduces the size of older tool results while
 * preserving the conversation structure. This is useful for:
 *
 * - Reducing context when approaching token limits
 * - Keeping recent tool results detailed while summarizing older ones
 * - Maintaining conversation flow without losing context
 *
 * Inspired by Claude Code's microcompact patterns.
 */

import { createLogger } from "../utils/logger.js";
import type {
	AppMessage,
	ImageContent,
	TextContent,
	ToolResultMessage,
} from "./types.js";

type ContentPart = TextContent | ImageContent;

const logger = createLogger("microcompact");

/**
 * Configuration for microcompact behavior.
 */
export interface MicrocompactConfig {
	/** Number of recent tool results to keep fully detailed */
	keepRecentCount: number;
	/** Maximum length for truncated tool results */
	truncatedResultLength: number;
	/** Whether to add a note indicating truncation */
	addTruncationNote: boolean;
	/** Tool names that should never be truncated */
	protectedTools: string[];
	/** Minimum result length to consider for truncation */
	minLengthToTruncate: number;
}

/**
 * Statistics from a microcompact operation.
 */
export interface MicrocompactStats {
	/** Number of tool results processed */
	toolResultsProcessed: number;
	/** Number of tool results truncated */
	toolResultsTruncated: number;
	/** Number of tool results skipped (protected or too short) */
	toolResultsSkipped: number;
	/** Estimated tokens saved */
	estimatedTokensSaved: number;
	/** Original total characters */
	originalCharacters: number;
	/** Final total characters */
	finalCharacters: number;
}

const DEFAULT_CONFIG: MicrocompactConfig = {
	keepRecentCount: 5,
	truncatedResultLength: 200,
	addTruncationNote: true,
	protectedTools: ["Read", "Write", "Edit"], // Keep file operations detailed
	minLengthToTruncate: 500,
};

/**
 * Get microcompact configuration from environment.
 */
export function getMicrocompactConfig(): MicrocompactConfig {
	const keepRecentCount = Number.parseInt(
		process.env.COMPOSER_MICROCOMPACT_KEEP_RECENT || "5",
		10,
	);
	const truncatedResultLength = Number.parseInt(
		process.env.COMPOSER_MICROCOMPACT_TRUNCATE_LENGTH || "200",
		10,
	);
	const protectedToolsEnv = process.env.COMPOSER_MICROCOMPACT_PROTECTED_TOOLS;
	const protectedTools = protectedToolsEnv
		? protectedToolsEnv.split(",").map((t) => t.trim())
		: DEFAULT_CONFIG.protectedTools;

	return {
		...DEFAULT_CONFIG,
		keepRecentCount: Number.isNaN(keepRecentCount)
			? DEFAULT_CONFIG.keepRecentCount
			: Math.max(1, keepRecentCount),
		truncatedResultLength: Number.isNaN(truncatedResultLength)
			? DEFAULT_CONFIG.truncatedResultLength
			: Math.max(50, truncatedResultLength),
		protectedTools,
	};
}

/**
 * Check if a tool result should be protected from truncation.
 */
function isProtectedTool(
	toolName: string,
	config: MicrocompactConfig,
): boolean {
	return config.protectedTools.some(
		(protected_) =>
			toolName.toLowerCase().includes(protected_.toLowerCase()) ||
			protected_.toLowerCase().includes(toolName.toLowerCase()),
	);
}

/**
 * Extract text content from a tool result message.
 */
function getToolResultText(message: ToolResultMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (Array.isArray(message.content)) {
		return message.content
			.filter(
				(part): part is ContentPart & { type: "text" } => part.type === "text",
			)
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

/**
 * Truncate text to a maximum length with optional note.
 */
function truncateText(
	text: string,
	maxLength: number,
	addNote: boolean,
): string {
	if (text.length <= maxLength) {
		return text;
	}

	const truncated = text.slice(0, maxLength).trim();
	const suffix = addNote
		? `\n\n[... ${text.length - maxLength} characters truncated by microcompact ...]`
		: "...";

	return truncated + suffix;
}

/**
 * Create a truncated version of a tool result message.
 */
function truncateToolResult(
	message: ToolResultMessage,
	config: MicrocompactConfig,
): ToolResultMessage {
	const originalText = getToolResultText(message);

	if (originalText.length < config.minLengthToTruncate) {
		return message;
	}

	const truncatedText = truncateText(
		originalText,
		config.truncatedResultLength,
		config.addTruncationNote,
	);

	// Create new message with truncated content
	const newContent: ContentPart[] = [
		{
			type: "text",
			text: truncatedText,
		},
	];

	return {
		...message,
		content: newContent,
	};
}

/**
 * Collect all tool result indices from messages.
 */
function collectToolResultIndices(messages: AppMessage[]): number[] {
	const indices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "toolResult") {
			indices.push(i);
		}
	}
	return indices;
}

/**
 * Get the tool name for a tool result by finding its matching tool call.
 */
function getToolNameForResult(
	messages: AppMessage[],
	toolResultIndex: number,
): string | null {
	const toolResult = messages[toolResultIndex] as ToolResultMessage;
	const toolCallId = toolResult.toolCallId;

	// Search backwards for the matching tool call
	for (let i = toolResultIndex - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === "toolCall" && part.id === toolCallId) {
					return part.name;
				}
			}
		}
	}

	return null;
}

/**
 * Apply microcompact to a conversation, truncating older tool results.
 *
 * @param messages - The conversation messages
 * @param config - Configuration options
 * @returns Object with new messages array and statistics
 */
export function microcompact(
	messages: AppMessage[],
	config: MicrocompactConfig = getMicrocompactConfig(),
): { messages: AppMessage[]; stats: MicrocompactStats } {
	const toolResultIndices = collectToolResultIndices(messages);
	const stats: MicrocompactStats = {
		toolResultsProcessed: toolResultIndices.length,
		toolResultsTruncated: 0,
		toolResultsSkipped: 0,
		estimatedTokensSaved: 0,
		originalCharacters: 0,
		finalCharacters: 0,
	};

	if (toolResultIndices.length <= config.keepRecentCount) {
		// Not enough tool results to truncate
		return { messages: [...messages], stats };
	}

	// Indices to truncate (older ones)
	const indicesToTruncate = toolResultIndices.slice(
		0,
		toolResultIndices.length - config.keepRecentCount,
	);

	const newMessages = messages.map((message, index) => {
		if (!indicesToTruncate.includes(index)) {
			return message;
		}

		const toolResult = message as ToolResultMessage;
		const toolName = getToolNameForResult(messages, index);
		const originalText = getToolResultText(toolResult);
		stats.originalCharacters += originalText.length;

		// Check if tool is protected
		if (toolName && isProtectedTool(toolName, config)) {
			stats.toolResultsSkipped++;
			stats.finalCharacters += originalText.length;
			return message;
		}

		// Check if too short to truncate
		if (originalText.length < config.minLengthToTruncate) {
			stats.toolResultsSkipped++;
			stats.finalCharacters += originalText.length;
			return message;
		}

		// Truncate the result
		const truncated = truncateToolResult(toolResult, config);
		const truncatedText = getToolResultText(truncated);
		stats.finalCharacters += truncatedText.length;
		stats.toolResultsTruncated++;

		return truncated;
	});

	// Estimate tokens saved (roughly 4 chars per token)
	const charsSaved = stats.originalCharacters - stats.finalCharacters;
	stats.estimatedTokensSaved = Math.floor(charsSaved / 4);

	logger.debug("Microcompact complete", {
		truncated: stats.toolResultsTruncated,
		skipped: stats.toolResultsSkipped,
		tokensSaved: stats.estimatedTokensSaved,
	});

	return { messages: newMessages, stats };
}

/**
 * Check if microcompact would be beneficial for the given messages.
 */
export function shouldMicrocompact(
	messages: AppMessage[],
	config: MicrocompactConfig,
	contextUsagePercent: number,
): boolean {
	const toolResultIndices = collectToolResultIndices(messages);

	// Need enough tool results to truncate
	if (toolResultIndices.length <= config.keepRecentCount) {
		return false;
	}

	// Only microcompact when context is getting full (> 60%)
	if (contextUsagePercent < 60) {
		return false;
	}

	// Check if truncating would actually save space
	let potentialSavings = 0;
	const indicesToCheck = toolResultIndices.slice(
		0,
		toolResultIndices.length - config.keepRecentCount,
	);

	for (const index of indicesToCheck) {
		const toolResult = messages[index] as ToolResultMessage;
		const toolName = getToolNameForResult(messages, index);
		const text = getToolResultText(toolResult);

		// Skip protected tools and short results
		if (toolName && isProtectedTool(toolName, config)) {
			continue;
		}
		if (text.length < config.minLengthToTruncate) {
			continue;
		}

		potentialSavings += text.length - config.truncatedResultLength;
	}

	// Only worthwhile if we'd save at least 1000 tokens (~4000 chars)
	return potentialSavings > 4000;
}

/**
 * Microcompact monitor for tracking and recommending microcompaction.
 */
export class MicrocompactMonitor {
	private config: MicrocompactConfig;
	private lastMicrocompactTime = 0;
	private microcompactCount = 0;
	private totalTokensSaved = 0;

	constructor(config?: Partial<MicrocompactConfig>) {
		this.config = { ...getMicrocompactConfig(), ...config };
	}

	/**
	 * Update configuration.
	 */
	setConfig(config: Partial<MicrocompactConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Get current configuration.
	 */
	getConfig(): MicrocompactConfig {
		return { ...this.config };
	}

	/**
	 * Check if microcompact should be performed.
	 */
	shouldRun(messages: AppMessage[], contextUsagePercent: number): boolean {
		const now = Date.now();
		const minInterval = 30000; // At most every 30 seconds

		if (now - this.lastMicrocompactTime < minInterval) {
			return false;
		}

		return shouldMicrocompact(messages, this.config, contextUsagePercent);
	}

	/**
	 * Run microcompact and update statistics.
	 */
	run(messages: AppMessage[]): {
		messages: AppMessage[];
		stats: MicrocompactStats;
	} {
		const result = microcompact(messages, this.config);

		if (result.stats.toolResultsTruncated > 0) {
			this.lastMicrocompactTime = Date.now();
			this.microcompactCount++;
			this.totalTokensSaved += result.stats.estimatedTokensSaved;

			logger.info("Microcompact performed", {
				truncated: result.stats.toolResultsTruncated,
				tokensSaved: result.stats.estimatedTokensSaved,
				totalSaved: this.totalTokensSaved,
			});
		}

		return result;
	}

	/**
	 * Get monitor statistics.
	 */
	getStats(): {
		microcompactCount: number;
		totalTokensSaved: number;
		lastMicrocompactTime: number;
	} {
		return {
			microcompactCount: this.microcompactCount,
			totalTokensSaved: this.totalTokensSaved,
			lastMicrocompactTime: this.lastMicrocompactTime,
		};
	}

	/**
	 * Reset statistics.
	 */
	reset(): void {
		this.lastMicrocompactTime = 0;
		this.microcompactCount = 0;
		this.totalTokensSaved = 0;
	}
}

/**
 * Create a microcompact monitor.
 */
export function createMicrocompactMonitor(
	config?: Partial<MicrocompactConfig>,
): MicrocompactMonitor {
	return new MicrocompactMonitor(config);
}
