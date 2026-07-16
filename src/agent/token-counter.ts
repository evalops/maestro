/**
 * @fileoverview Accurate token counter (OpenAI clade) with bytes/4 fallback.
 *
 * The shared heuristic in `@evalops/contracts` (`estimateTokens`, ~bytes/4) is
 * fast, dependency-free, and correct enough for display. It under-counts code
 * by ~25-35% versus a real BPE, which matters at budget-critical decision
 * points (prompt-cache eligibility, context-overflow preflight, compaction
 * thresholds).
 *
 * This module provides accurate counts for the OpenAI clade (o200k_base for
 * GPT-4o/o-series, cl100k_base for GPT-4/GPT-3.5) and falls back to
 * `estimateTokens` for providers without a bundled tokenizer (Anthropic,
 * Google, etc.). Only the two needed encodings are imported to keep the
 * bundle lean.
 *
 * Mirrored by `packages/tui-rs/src/agent/token_counting.rs` (tiktoken-rs) so
 * native and TS counts agree for the same encoding.
 *
 * @example
 * ```typescript
 * import { countTokens } from "./token-counter.js";
 *
 * const n = countTokens(code, "gpt-4o");      // accurate (o200k_base)
 * const m = countTokens(code, "claude-...");   // bytes/4 fallback
 * ```
 */

import { estimateTokens } from "@evalops/contracts";
import { countTokens as countCl100k } from "gpt-tokenizer/encoding/cl100k_base";
// Lean per-encoding imports — only the two OpenAI clade encodings ship.
import { countTokens as countO200k } from "gpt-tokenizer/encoding/o200k_base";

/** BPE encoding families we can count accurately. */
export type TokenEncoding = "o200k_base" | "cl100k_base";

/**
 * Resolve the tokenizer encoding for a model id, or `null` when no accurate
 * tokenizer is bundled (Anthropic, Google, unknown) — callers fall back to
 * the bytes/4 heuristic.
 */
export function encodingForModel(model: string): TokenEncoding | null {
	const m = model.toLowerCase();
	// GPT-4o family and o-series / GPT-5 use o200k_base.
	if (
		m.includes("gpt-4o") ||
		m.includes("gpt-5") ||
		/^o[134]\b/.test(m) ||
		m.includes("o1") ||
		m.includes("o3") ||
		m.includes("o4")
	) {
		return "o200k_base";
	}
	// GPT-4 / GPT-3.5 / embeddings use cl100k_base.
	if (
		m.includes("gpt-4") ||
		m.includes("gpt-3.5") ||
		m.includes("text-embedding")
	) {
		return "cl100k_base";
	}
	return null;
}

/**
 * Count tokens accurately for OpenAI-clade models; fall back to the shared
 * bytes/4 heuristic otherwise (or when `model` is unknown/omitted).
 */
export function countTokens(text: string, model?: string): number {
	if (!model) {
		return estimateTokens(text);
	}
	const encoding = encodingForModel(model);
	if (!encoding) {
		return estimateTokens(text);
	}
	try {
		return encoding === "o200k_base" ? countO200k(text) : countCl100k(text);
	} catch {
		return estimateTokens(text);
	}
}
