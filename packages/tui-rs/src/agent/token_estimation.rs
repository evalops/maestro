//! Token estimation — single source of truth (Rust).
//!
//! Every native surface that reasons about context-window usage (compaction
//! gates, preflight overflow checks, prompt-cache accounting, renderers) MUST
//! import from here instead of re-implementing the bytes/4 heuristic.
//!
//! ## Cross-language parity
//!
//! Constants and formulas mirror the TypeScript implementation in
//! `packages/contracts/src/token-estimation.ts` so token budgets computed on
//! the native side and the TS side agree. Follows the single-source-of-truth
//! discipline of xai-org/grok-build's `xai-token-estimation` crate.
//!
//! Note: Rust measures `str::len()` (UTF-8 bytes) while TS measures
//! `string.length` (UTF-16 units). For ASCII-dominated source these agree;
//! both divide by [`BYTES_PER_TOKEN`].

/// Bytes per token under the rough character-based heuristic.
pub const BYTES_PER_TOKEN: usize = 4;

/// Per-image approximate token cost when summing low-resolution image patches.
pub const IMAGE_TOKEN_ESTIMATE: u64 = 765;

/// Estimate the token count of a string using the shared bytes/4 heuristic.
///
/// Empty input is `0`; any non-empty input is at least `1` token.
#[inline]
pub fn estimate_tokens(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    text.len().div_ceil(BYTES_PER_TOKEN).max(1) as u64
}

/// Estimate the token count of a value by serializing it to JSON first.
#[inline]
pub fn estimate_tokens_from_json(value: &impl serde::Serialize) -> u64 {
    match serde_json::to_string(value) {
        Ok(s) => estimate_tokens(&s),
        Err(_) => 0,
    }
}

/// Inverse of [`estimate_tokens`]: convert a token budget into a byte/char budget.
#[inline]
pub fn estimate_chars(tokens: u64) -> u64 {
    tokens.saturating_mul(BYTES_PER_TOKEN as u64)
}

/// Token estimate for `image_count` images at [`IMAGE_TOKEN_ESTIMATE`] each.
#[inline]
pub fn estimate_image_tokens(image_count: u64) -> u64 {
    image_count.saturating_mul(IMAGE_TOKEN_ESTIMATE)
}

/// Usage percentage of a context window, clamped to `[0.0, 100.0]`.
/// Returns `0.0` when capacity is zero.
#[inline]
pub fn usage_percentage(used: u64, capacity: u64) -> f64 {
    if capacity == 0 {
        return 0.0;
    }
    let pct = (used as f64 / capacity as f64) * 100.0;
    pct.clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_is_zero() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn non_empty_at_least_one() {
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("ab"), 1);
        assert_eq!(estimate_tokens("abc"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    #[test]
    fn parity_samples() {
        assert_eq!(estimate_tokens("Hello"), 2);
        assert_eq!(estimate_tokens("Hello, world!"), 4);
    }

    #[test]
    fn inverse_and_images() {
        assert_eq!(estimate_chars(estimate_tokens("Hello, world!")), 16);
        assert_eq!(estimate_image_tokens(3), 3 * IMAGE_TOKEN_ESTIMATE);
        assert_eq!(usage_percentage(50, 100), 50.0);
        assert_eq!(usage_percentage(0, 0), 0.0);
        assert_eq!(usage_percentage(300, 100), 100.0);
    }
}
