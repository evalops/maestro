/**
 * Thinking Tag Parser for Reasoning Models
 *
 * Parses and extracts thinking/reasoning content from model responses.
 * Different models use different formats for chain-of-thought reasoning:
 *
 * - DeepSeek R1: `<think>...</think>` tags in responses
 * - Qwen3: `<think>...</think>` tags
 * - Claude: Native thinking blocks via API (handled separately)
 * - Other models: May use `<reasoning>`, `<thought>`, etc.
 *
 * ## Usage
 *
 * ```typescript
 * import { parseThinkingContent, extractThinkingFromStream } from "./thinking-parser.js";
 *
 * // Parse thinking from completed response
 * const result = parseThinkingContent(response, "deepseek-r1");
 * // { thinking: "Let me analyze...", content: "The answer is..." }
 *
 * // Stream processing
 * for await (const chunk of stream) {
 *   const parsed = extractThinkingFromStream(chunk, state);
 *   // parsed.thinking, parsed.content, parsed.state
 * }
 * ```
 */

import { createLogger } from "../../utils/logger.js";

const logger = createLogger("providers:thinking-parser");

/**
 * Models known to use thinking tags
 */
export const THINKING_TAG_MODELS = [
	"deepseek-r1",
	"deepseek-reasoner",
	"qwen3",
	"qwen-3",
	"qwen-qwq",
	"qwq",
	"o1",
	"o1-mini",
	"o1-preview",
	"o3",
	"o3-mini",
];

/**
 * Thinking tag patterns for different model families
 */
interface ThinkingTagConfig {
	/** Opening tag pattern */
	openTag: RegExp;
	/** Closing tag pattern */
	closeTag: RegExp;
	/** Tag names for this config */
	tagNames: string[];
}

const THINKING_TAG_CONFIGS: ThinkingTagConfig[] = [
	// DeepSeek, Qwen style
	{
		openTag: /<think>/gi,
		closeTag: /<\/think>/gi,
		tagNames: ["think"],
	},
	// Alternative tags some models use
	{
		openTag: /<thinking>/gi,
		closeTag: /<\/thinking>/gi,
		tagNames: ["thinking"],
	},
	{
		openTag: /<reasoning>/gi,
		closeTag: /<\/reasoning>/gi,
		tagNames: ["reasoning"],
	},
	{
		openTag: /<thought>/gi,
		closeTag: /<\/thought>/gi,
		tagNames: ["thought"],
	},
	{
		openTag: /<reflection>/gi,
		closeTag: /<\/reflection>/gi,
		tagNames: ["reflection"],
	},
];

/**
 * Parsed thinking content result
 */
export interface ParsedThinkingContent {
	/** Extracted thinking/reasoning content */
	thinking: string | null;
	/** Main response content (with thinking tags removed) */
	content: string;
	/** Tag type that was found (e.g., "think", "reasoning") */
	tagType?: string;
	/** Whether thinking content was truncated */
	truncated?: boolean;
}

/**
 * Stream parsing state
 */
export interface ThinkingStreamState {
	/** Buffer for incomplete content */
	buffer: string;
	/** Whether we're currently inside a thinking tag */
	inThinkingBlock: boolean;
	/** Accumulated thinking content */
	thinkingContent: string;
	/** Accumulated main content */
	mainContent: string;
	/** Which tag type we're parsing */
	activeTagType?: string;
}

/**
 * Check if a model uses thinking tags
 */
export function modelUsesThinkingTags(modelId: string): boolean {
	const normalizedId = modelId.toLowerCase();
	return THINKING_TAG_MODELS.some(
		(m) => normalizedId.includes(m) || normalizedId.startsWith(m),
	);
}

/**
 * Parse thinking content from a complete response
 */
export function parseThinkingContent(
	content: string,
	modelId?: string,
): ParsedThinkingContent {
	let thinking: string | null = null;
	let cleanContent = content;
	let tagType: string | undefined;

	for (const config of THINKING_TAG_CONFIGS) {
		// Reset regex lastIndex
		config.openTag.lastIndex = 0;
		config.closeTag.lastIndex = 0;

		// Check if this tag type exists in content
		const openMatch = config.openTag.exec(content);
		if (!openMatch) continue;

		// Find the closing tag
		config.closeTag.lastIndex = openMatch.index + openMatch[0].length;
		const closeMatch = config.closeTag.exec(content);

		if (closeMatch) {
			// Extract thinking content
			const thinkStart = openMatch.index + openMatch[0].length;
			const thinkEnd = closeMatch.index;
			thinking = content.slice(thinkStart, thinkEnd).trim();

			// Remove thinking block from content
			cleanContent =
				content.slice(0, openMatch.index) +
				content.slice(closeMatch.index + closeMatch[0].length);
			cleanContent = cleanContent.trim();

			tagType = config.tagNames[0];

			logger.debug("Extracted thinking content", {
				modelId,
				tagType,
				thinkingLength: thinking.length,
				contentLength: cleanContent.length,
			});

			break;
		} else {
			// Opening tag without closing - content might be truncated
			// Include everything after opening tag as thinking
			const thinkStart = openMatch.index + openMatch[0].length;
			thinking = content.slice(thinkStart).trim();
			cleanContent = content.slice(0, openMatch.index).trim();
			tagType = config.tagNames[0];

			logger.debug("Extracted partial thinking content (no closing tag)", {
				modelId,
				tagType,
				thinkingLength: thinking.length,
			});

			return {
				thinking,
				content: cleanContent,
				tagType,
				truncated: true,
			};
		}
	}

	return { thinking, content: cleanContent, tagType };
}

/**
 * Create initial stream parsing state
 */
export function createThinkingStreamState(): ThinkingStreamState {
	return {
		buffer: "",
		inThinkingBlock: false,
		thinkingContent: "",
		mainContent: "",
		activeTagType: undefined,
	};
}

/**
 * Process a stream chunk and extract thinking content
 *
 * @param chunk - New content chunk
 * @param state - Current parsing state (will be mutated)
 * @returns Parsed content from this chunk
 */
export function processThinkingStreamChunk(
	chunk: string,
	state: ThinkingStreamState,
): { thinking: string; content: string } {
	state.buffer += chunk;

	let thinking = "";
	let content = "";

	// Process buffer looking for tags
	while (state.buffer.length > 0) {
		if (state.inThinkingBlock) {
			// Look for closing tag
			for (const config of THINKING_TAG_CONFIGS) {
				if (state.activeTagType && !config.tagNames.includes(state.activeTagType)) {
					continue;
				}

				config.closeTag.lastIndex = 0;
				const closeMatch = config.closeTag.exec(state.buffer);

				if (closeMatch) {
					// Found closing tag
					thinking += state.buffer.slice(0, closeMatch.index);
					state.thinkingContent += state.buffer.slice(0, closeMatch.index);
					state.buffer = state.buffer.slice(closeMatch.index + closeMatch[0].length);
					state.inThinkingBlock = false;
					state.activeTagType = undefined;
					break;
				}
			}

			if (state.inThinkingBlock) {
				// No closing tag found yet - buffer might have partial tag
				// Keep last 20 chars in buffer to catch split tags
				if (state.buffer.length > 20) {
					thinking += state.buffer.slice(0, -20);
					state.thinkingContent += state.buffer.slice(0, -20);
					state.buffer = state.buffer.slice(-20);
				}
				break;
			}
		} else {
			// Look for opening tag
			let foundOpen = false;
			for (const config of THINKING_TAG_CONFIGS) {
				config.openTag.lastIndex = 0;
				const openMatch = config.openTag.exec(state.buffer);

				if (openMatch) {
					// Found opening tag
					content += state.buffer.slice(0, openMatch.index);
					state.mainContent += state.buffer.slice(0, openMatch.index);
					state.buffer = state.buffer.slice(openMatch.index + openMatch[0].length);
					state.inThinkingBlock = true;
					state.activeTagType = config.tagNames[0];
					foundOpen = true;
					break;
				}
			}

			if (!foundOpen) {
				// No opening tag found - buffer might have partial tag
				// Keep last 15 chars in buffer
				if (state.buffer.length > 15) {
					content += state.buffer.slice(0, -15);
					state.mainContent += state.buffer.slice(0, -15);
					state.buffer = state.buffer.slice(-15);
				}
				break;
			}
		}
	}

	return { thinking, content };
}

/**
 * Finalize stream parsing and return any remaining content
 */
export function finalizeThinkingStream(
	state: ThinkingStreamState,
): { thinking: string; content: string } {
	let thinking = "";
	let content = "";

	if (state.inThinkingBlock) {
		// Unclosed thinking block - treat remaining buffer as thinking
		thinking = state.buffer;
		state.thinkingContent += state.buffer;
	} else {
		// Remaining buffer is regular content
		content = state.buffer;
		state.mainContent += state.buffer;
	}

	state.buffer = "";

	return { thinking, content };
}

/**
 * Format thinking content for display
 * Optionally truncates long thinking content
 */
export function formatThinkingForDisplay(
	thinking: string,
	maxLength: number = 2000,
): string {
	if (!thinking) return "";

	if (thinking.length <= maxLength) {
		return thinking;
	}

	// Truncate with ellipsis
	return thinking.slice(0, maxLength) + "\n...[truncated]";
}

/**
 * Check if content appears to contain thinking tags
 */
export function containsThinkingTags(content: string): boolean {
	return THINKING_TAG_CONFIGS.some((config) => {
		config.openTag.lastIndex = 0;
		return config.openTag.test(content);
	});
}
