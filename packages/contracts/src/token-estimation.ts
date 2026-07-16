/**
 * @fileoverview Token estimation — single source of truth (TypeScript).
 *
 * Every TS surface that reasons about context-window usage (compaction gates,
 * preflight overflow checks, context optimizers, repo maps, prompt-cache
 * accounting, and every client renderer) MUST import from here instead of
 * re-implementing the bytes/4 heuristic.
 *
 * ## Cross-language parity
 *
 * The constants and formulas mirror the Rust implementation in
 * `packages/tui-rs/src/agent/token_estimation.rs` so that token budgets
 * computed on the native side and the TS side agree. The design follows the
 * same single-source-of-truth discipline as xai-org/grok-build's
 * `xai-token-estimation` crate.
 *
 * @example
 * ```typescript
 * import { estimateTokens, usagePercentage } from "@evalops/contracts";
 *
 * const used = estimateTokens(prompt);
 * const pct = usagePercentage(used, 200_000);
 * ```
 */

/** Bytes per token under the rough character-based heuristic. */
export const BYTES_PER_TOKEN = 4;

/**
 * Per-image approximate token cost when summing low-resolution image patches.
 * Matches the Rust constant and the grok-build default.
 */
export const IMAGE_TOKEN_ESTIMATE = 765;

/**
 * Estimate the token count of a string using the shared bytes/4 heuristic.
 *
 * Empty input is `0`; any non-empty input is at least `1` token.
 */
export function estimateTokens(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return Math.max(1, Math.ceil(text.length / BYTES_PER_TOKEN));
}

/**
 * Estimate the token count of a value by serializing it to JSON first.
 * Returns `0` if the value cannot be serialized.
 */
export function estimateTokensFromJson(value: unknown): number {
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		return 0;
	}
	return estimateTokens(json);
}

/**
 * Inverse of {@link estimateTokens}: convert a token budget into a character
 * budget. Used by callers that size text passages against a model's context
 * window.
 */
export function estimateChars(tokens: number): number {
	return Math.max(0, tokens * BYTES_PER_TOKEN);
}

/** Token estimate for `imageCount` images at {@link IMAGE_TOKEN_ESTIMATE} each. */
export function estimateImageTokens(imageCount: number): number {
	return Math.max(0, imageCount) * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Usage percentage of a context window, clamped to `[0, 100]`.
 * Returns `0` when capacity is non-positive.
 */
export function usagePercentage(used: number, capacity: number): number {
	if (capacity <= 0) {
		return 0;
	}
	const pct = (used / capacity) * 100;
	if (pct < 0) {
		return 0;
	}
	if (pct > 100) {
		return 100;
	}
	return pct;
}
