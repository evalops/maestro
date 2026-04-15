/**
 * Provider-Aware Context Overflow Detection
 *
 * This utility keeps the ergonomic error/string API used by callers in this
 * layer while delegating provider-specific overflow matching to the canonical
 * implementation in `src/agent/context-overflow.ts`.
 *
 * @module utils/context-overflow
 */

import {
	isOverflowErrorMessage,
	parseOverflowDetails,
} from "../agent/context-overflow.js";
import type { Api, Model, Usage } from "../agent/types.js";

/**
 * Determines if an error indicates context overflow.
 *
 * Checks the error message against provider-specific patterns to identify
 * context window overflow errors. This is critical for the ContextHandoffManager
 * to distinguish overflow (which requires compaction) from other errors
 * (which might be retryable).
 *
 * @param error - The error to check (Error object or string)
 * @param model - Optional model information (for future provider-specific logic)
 * @returns True if the error indicates context overflow
 *
 * @example
 * ```typescript
 * try {
 *   await sendPrompt(largeContext);
 * } catch (error) {
 *   if (isContextOverflow(error)) {
 *     // Trigger context compaction
 *     await compactContext();
 *   } else {
 *     // Handle other errors
 *     throw error;
 *   }
 * }
 * ```
 */
export function isContextOverflow(
	error: Error | string | null | undefined,
	_model?: Model<Api>,
): boolean {
	if (!error) {
		return false;
	}

	const message = typeof error === "string" ? error : error.message || "";

	if (!message) {
		return false;
	}

	return isOverflowErrorMessage(message);
}

/**
 * Detects "silent overflow" where the model truncates without error.
 *
 * Some providers (notably z.ai/xAI) return a success response but silently
 * truncate the context when it exceeds the model's limit. This function
 * detects such cases by comparing the actual input tokens against the
 * model's documented context window.
 *
 * The total input is calculated as: input + cacheRead + cacheWrite (all count
 * toward context)
 *
 * @param usage - Usage statistics from the response
 * @param model - Model information including contextWindow limit
 * @returns True if usage exceeds the model's context window
 *
 * @example
 * ```typescript
 * const response = await chat.send(messages);
 *
 * if (isSilentOverflow(response.usage, model)) {
 *   // Model silently truncated - context compaction needed
 *   await compactContext();
 * }
 * ```
 */
export function isSilentOverflow(
	usage: Usage | undefined,
	model: Model<Api> | undefined,
): boolean {
	if (!usage || !model || !model.contextWindow) {
		return false;
	}

	// Total input tokens = regular input + cache read/write tokens
	const totalInputTokens =
		(usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);

	// Check if total input exceeds the model's context window
	return totalInputTokens > model.contextWindow;
}

/**
 * Gets a human-readable explanation for a context overflow error.
 *
 * Provides context-specific guidance based on the error type and model.
 *
 * @param error - The overflow error
 * @param model - The model that generated the error
 * @returns A user-friendly explanation with actionable advice
 *
 * @example
 * ```typescript
 * const explanation = explainOverflow(error, model);
 * console.error(explanation);
 * // "Context overflow: Your prompt (150K tokens) exceeds GPT-4's limit (128K tokens).
 * //  Try: Remove old messages, summarize conversation, or switch to Claude (200K limit)"
 * ```
 */
export function explainOverflow(
	error: Error | string,
	model?: Model<Api>,
): string {
	const message = (typeof error === "string" ? error : error.message).trim();
	const parsed = parseOverflowDetails(message);

	if (!model) {
		return `Context overflow: ${message}. Try reducing message history or using a model with a larger context window.`;
	}

	if (parsed?.requestedTokens && parsed?.maxTokens) {
		return `Context overflow for ${model.name}: Your prompt (${parsed.requestedTokens.toLocaleString()} tokens) exceeds the limit (${parsed.maxTokens.toLocaleString()} tokens). Try: (1) Remove old messages, (2) Summarize conversation history, or (3) Switch to a model with larger context.`;
	}

	return `Context overflow for ${model.name}: ${message}. The model limit is ${model.contextWindow?.toLocaleString()} tokens. Try: (1) Remove old messages, (2) Summarize conversation history, or (3) Switch to a model with larger context.`;
}
