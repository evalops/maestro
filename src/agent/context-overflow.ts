/**
 * Context Overflow Detection
 *
 * Detects context window overflow errors from different LLM providers.
 * When the input exceeds a model's context window, providers return
 * different error messages. This module provides unified detection.
 *
 * ## Provider Coverage
 *
 * **Reliable detection (error message patterns):**
 * - Anthropic: "prompt is too long: X tokens > Y maximum"
 * - OpenAI: "exceeds the context window"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - Cerebras/Mistral: 400/413 status code (no body)
 * - OpenRouter: "maximum context length is X tokens"
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 *
 * **Unreliable detection:**
 * - z.ai: Sometimes accepts overflow silently (use contextWindow param)
 * - Ollama: Silently truncates input (not detectable)
 *
 * @module agent/context-overflow
 */

import type { AssistantMessage } from "./types.js";

/**
 * Regex patterns to detect context overflow errors from different providers.
 * Each pattern is designed to match provider-specific error messages.
 */
const OVERFLOW_PATTERNS = [
	// Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
	/prompt is too long/i,

	// OpenAI (Completions & Responses API): "Your input exceeds the context window"
	/exceeds the context window/i,

	// Google Gemini: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
	/input token count.*exceeds the maximum/i,

	// xAI (Grok): "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
	/maximum prompt length is \d+/i,

	// Groq: "Please reduce the length of the messages or completion"
	/reduce the length of the messages/i,

	// OpenRouter (all backends): "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
	/maximum context length is \d+ tokens/i,

	// llama.cpp server: "the request exceeds the available context size, try increasing it"
	/exceeds the available context size/i,

	// LM Studio: "tokens to keep from the initial prompt is greater than the context length"
	/greater than the context length/i,

	// Generic fallbacks for other providers
	/context length exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
	/context window.*exceeded/i,
	/maximum.*tokens.*exceeded/i,
];

/**
 * Check if an assistant message represents a context overflow error.
 *
 * This handles two cases:
 * 1. Error-based overflow: Provider returns stopReason "error" with a
 *    specific error message pattern.
 * 2. Silent overflow: Some providers (z.ai) accept overflow requests and
 *    return successfully. For these, check if usage.input exceeds contextWindow.
 *
 * @param message - The assistant message to check
 * @param contextWindow - Optional context window size for detecting silent overflow
 * @returns true if the message indicates a context overflow
 *
 * @example
 * ```typescript
 * const response = await runAgent(messages, model);
 * if (isContextOverflow(response, model.contextWindow)) {
 *   // Trigger compaction
 *   await compactMessages(messages);
 * }
 * ```
 */
export function isContextOverflow(
	message: AssistantMessage,
	contextWindow?: number,
): boolean {
	// Case 1: Check error message patterns
	if (message.stopReason === "error" && message.errorMessage) {
		const errorMsg = message.errorMessage;
		// Check known provider patterns
		if (OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMsg))) {
			return true;
		}

		// Cerebras and Mistral return 400/413 with no body
		// Match patterns like "400 status code (no body)" or "413 (no body)"
		if (/^4(00|13)\s*(status code)?\s*\(no body\)/i.test(errorMsg)) {
			return true;
		}
	}

	// Case 2: Silent overflow detection (z.ai style)
	// Some providers accept overflow requests but return truncated/weird results
	// If usage.input exceeds context window, it's likely an overflow
	if (contextWindow && message.stopReason === "stop" && message.usage) {
		const inputTokens =
			(message.usage.input || 0) + (message.usage.cacheRead || 0);
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	return false;
}

/**
 * Extract overflow details from an error message if available.
 * Useful for logging and diagnostics.
 *
 * @param errorMessage - The error message to parse
 * @returns Parsed details or null if not an overflow error
 */
export function parseOverflowDetails(
	errorMessage: string,
): { requestedTokens?: number; maxTokens?: number } | null {
	// Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
	const anthropicMatch = errorMessage.match(
		/(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i,
	);
	if (anthropicMatch) {
		return {
			requestedTokens: Number.parseInt(anthropicMatch[1], 10),
			maxTokens: Number.parseInt(anthropicMatch[2], 10),
		};
	}

	// Google: "input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
	const googleMatch = errorMessage.match(
		/input token count\s*\((\d+)\).*maximum.*\((\d+)\)/i,
	);
	if (googleMatch) {
		return {
			requestedTokens: Number.parseInt(googleMatch[1], 10),
			maxTokens: Number.parseInt(googleMatch[2], 10),
		};
	}

	// xAI: "maximum prompt length is 131072 but the request contains 537812 tokens"
	const xaiMatch = errorMessage.match(
		/maximum prompt length is (\d+).*contains (\d+)/i,
	);
	if (xaiMatch) {
		return {
			maxTokens: Number.parseInt(xaiMatch[1], 10),
			requestedTokens: Number.parseInt(xaiMatch[2], 10),
		};
	}

	// OpenRouter: "maximum context length is X tokens. However, you requested about Y tokens"
	const openrouterMatch = errorMessage.match(
		/maximum context length is (\d+).*requested.*?(\d+)/i,
	);
	if (openrouterMatch) {
		return {
			maxTokens: Number.parseInt(openrouterMatch[1], 10),
			requestedTokens: Number.parseInt(openrouterMatch[2], 10),
		};
	}

	return null;
}

/**
 * Get all overflow detection patterns (for testing).
 * @internal
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}

/**
 * Regex patterns to detect transient/retryable errors from providers.
 * These are temporary failures that should be retried with backoff.
 */
const RETRYABLE_PATTERNS = [
	// Anthropic: "overloaded_error"
	/overloaded/i,

	// Rate limiting (various providers)
	/rate.?limit/i,
	/too many requests/i,
	/429/i,

	// Server errors (5xx)
	/500/i,
	/502/i,
	/503/i,
	/504/i,
	/service.?unavailable/i,
	/server error/i,
	/internal error/i,

	// Temporary failures
	/temporarily/i,
	/try again/i,
	/connection.?error/i,
];

/**
 * Check if an assistant message represents a retryable transient error.
 *
 * Retryable errors include:
 * - Rate limits (429, "too many requests")
 * - Server overload ("overloaded_error")
 * - Server errors (500, 502, 503, 504)
 * - Temporary failures ("service unavailable", "try again later")
 *
 * NOTE: Context overflow errors are NOT retryable - they should be
 * handled by compaction instead.
 *
 * @param message - The assistant message to check
 * @param contextWindow - Context window size for overflow detection
 * @returns true if the error is transient and should be retried
 */
export function isRetryableError(
	message: AssistantMessage,
	contextWindow?: number,
): boolean {
	// Must have an error
	if (message.stopReason !== "error" || !message.errorMessage) {
		return false;
	}

	// Context overflow is NOT retryable (handled by compaction)
	if (isContextOverflow(message, contextWindow)) {
		return false;
	}

	// Check for retryable patterns
	const err = message.errorMessage;
	return RETRYABLE_PATTERNS.some((pattern) => pattern.test(err));
}

/**
 * Get all retryable error patterns (for testing).
 * @internal
 */
export function getRetryablePatterns(): RegExp[] {
	return [...RETRYABLE_PATTERNS];
}
