/**
 * Unified Cache Retention Abstraction
 *
 * Issue #852: Unified cache retention abstraction across providers
 *
 * This module provides a unified abstraction for prompt caching across
 * different LLM providers. Instead of consumers needing to know provider-specific
 * caching mechanisms (Anthropic's cache_control, OpenAI's automatic caching),
 * they can use a single CacheRetention enum.
 *
 * ## Design Principles
 *
 * 1. **Simple API**: Single enum works across all providers
 * 2. **Cost savings**: Anthropic cache reads are ~90% cheaper
 * 3. **Consistent behavior**: Caching works the same way regardless of provider
 * 4. **Sensible defaults**: "short" for interactive, "none" for one-shot
 *
 * ## Caching Strategy by Provider
 *
 * | Provider | `"none"` | `"short"` | `"long"` |
 * |----------|----------|-----------|----------|
 * | **Anthropic** | No cache_control | cache_control on system + last message | Same (+ ttl if supported) |
 * | **OpenAI** | No explicit control | Automatic (no flag needed) | prompt_cache_retention: "24h" |
 * | **Others** | No-op | No-op | No-op |
 *
 * ## Usage
 *
 * ```typescript
 * import { shouldEnableAnthropicCaching } from './cache-retention-mapper';
 *
 * const enabled = shouldEnableAnthropicCaching('short');
 * // enabled = true
 * ```
 *
 * ## Cost Impact (Anthropic Example)
 *
 * With prompt caching enabled:
 * - Regular input tokens: $3.00 / million tokens
 * - Cache write: $3.75 / million tokens (25% premium)
 * - Cache read: $0.30 / million tokens (**90% discount!**)
 *
 * For a 100K token system prompt used 10 times:
 * - Without caching: 1M tokens × $3.00 = $3.00
 * - With caching: 100K write ($0.375) + 900K reads ($0.27) = **$0.645** (78% savings)
 *
 * @module agent/cache-retention-mapper
 */

/**
 * Cache retention level for prompt caching.
 *
 * - `"none"` - No caching (one-shot requests, evals)
 * - `"short"` - Short-term caching (interactive sessions, default)
 * - `"long"` - Long-term caching (24h retention, extended sessions)
 */
export type CacheRetention = "none" | "short" | "long";

/**
 * Determines whether to enable Anthropic's cache_control.
 *
 * Anthropic uses explicit `cache_control: { type: "ephemeral" }` annotations
 * on content blocks to enable prompt caching. We apply these to:
 * - System prompt
 * - Last user message in the conversation
 *
 * This provides significant cost savings (~90% discount on cache reads).
 *
 * @param retention - The cache retention level
 * @returns True if cache_control should be added to requests
 *
 * @example
 * ```typescript
 * const enabled = shouldEnableAnthropicCaching('short');
 * if (enabled) {
 *   systemPrompt.cache_control = { type: "ephemeral" };
 * }
 * ```
 */
export function shouldEnableAnthropicCaching(
	retention: CacheRetention | undefined,
): boolean {
	if (!retention || retention === "none") {
		return false;
	}

	// Enable for both "short" and "long"
	// Anthropic benefits from explicit caching even for short durations
	return retention === "short" || retention === "long";
}

/**
 * Determines whether to enable OpenAI's explicit cache retention.
 *
 * OpenAI has automatic prompt caching that works transparently.
 * For "short" retention, we rely on this automatic caching.
 * For "long" retention, we can request explicit 24h retention via
 * the `prompt_cache_retention` parameter (if supported by the API).
 *
 * Note: As of the Responses API, explicit cache control is limited.
 * This function returns true only for "long" retention to indicate
 * when we should attempt to use explicit retention parameters.
 *
 * @param retention - The cache retention level
 * @returns True if explicit cache parameters should be set
 *
 * @example
 * ```typescript
 * const enabled = shouldEnableOpenAICaching('long');
 * if (enabled) {
 *   requestBody.prompt_cache_retention = "24h";
 * }
 * ```
 */
export function shouldEnableOpenAICaching(
	retention: CacheRetention | undefined,
): boolean {
	if (!retention || retention === "none") {
		return false;
	}

	// OpenAI has automatic caching for "short"
	// Only enable explicit control for "long" retention
	return retention === "long";
}
