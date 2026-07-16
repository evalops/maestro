//! Accurate token counter (OpenAI clade) with bytes/4 fallback.
//!
//! Mirrors `src/agent/token-counter.ts`. The native TUI keeps the fast,
//! offline-capable `token_estimation::estimate_tokens` (bytes/4) as its default
//! and exposes [`count_tokens`] for callers that know the model and need
//! real accuracy (e.g. compaction thresholds, context-overflow preflight).
//!
//! The BPE instances are constructed lazily and cached for the process
//! lifetime. If a tokenizer cannot be loaded (e.g. missing data file), the
//! call falls back to the bytes/4 heuristic rather than panicking.

use std::sync::OnceLock;

use tiktoken_rs::CoreBPE;

use crate::agent::token_estimation;

/// BPE encoding families we can count accurately.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenEncoding {
    O200k,
    Cl100k,
}

fn o200k() -> Option<&'static CoreBPE> {
    static BPE: OnceLock<Option<CoreBPE>> = OnceLock::new();
    BPE.get_or_init(|| tiktoken_rs::o200k_base().ok()).as_ref()
}

fn cl100k() -> Option<&'static CoreBPE> {
    static BPE: OnceLock<Option<CoreBPE>> = OnceLock::new();
    BPE.get_or_init(|| tiktoken_rs::cl100k_base().ok()).as_ref()
}

/// Resolve the tokenizer encoding for a model id, or `None` when no accurate
/// tokenizer is bundled (Anthropic, Google, unknown).
#[must_use]
pub fn encoding_for_model(model: &str) -> Option<TokenEncoding> {
    let m = model.to_lowercase();
    // GPT-4o family and o-series / GPT-5 use o200k_base.
    if m.contains("gpt-4o")
        || m.contains("gpt-5")
        || m.contains("o1")
        || m.contains("o3")
        || m.contains("o4")
    {
        return Some(TokenEncoding::O200k);
    }
    // GPT-4 / GPT-3.5 / embeddings use cl100k_base.
    if m.contains("gpt-4") || m.contains("gpt-3.5") || m.contains("text-embedding") {
        return Some(TokenEncoding::Cl100k);
    }
    None
}

/// Count tokens accurately for OpenAI-clade models; fall back to the shared
/// bytes/4 heuristic otherwise (or when `model` is `None`/unknown, or when the
/// BPE data could not be loaded).
#[must_use]
pub fn count_tokens(text: &str, model: Option<&str>) -> u64 {
    let Some(encoding) = model.and_then(encoding_for_model) else {
        return token_estimation::estimate_tokens(text);
    };
    let bpe = match encoding {
        TokenEncoding::O200k => o200k(),
        TokenEncoding::Cl100k => cl100k(),
    };
    match bpe {
        Some(bpe) => bpe.encode_ordinary(text).len() as u64,
        None => token_estimation::estimate_tokens(text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn o200k_counts_known_values() {
        assert_eq!(count_tokens("Hello, world!", Some("gpt-4o")), 4);
        // bytes/4 would say ceil(35/4)=9; the real o200k count is 13.
        assert_eq!(
            count_tokens("function add(a, b) { return a + b; }", Some("gpt-4o")),
            13
        );
    }

    #[test]
    fn cl100k_counts_known_values() {
        assert_eq!(count_tokens("Hello, world!", Some("gpt-4")), 4);
    }

    #[test]
    fn encoding_for_model_maps_clades() {
        assert_eq!(encoding_for_model("gpt-4o"), Some(TokenEncoding::O200k));
        assert_eq!(encoding_for_model("o3-mini"), Some(TokenEncoding::O200k));
        assert_eq!(
            encoding_for_model("gpt-4-turbo"),
            Some(TokenEncoding::Cl100k)
        );
        assert_eq!(encoding_for_model("claude-sonnet-4-5"), None);
        assert_eq!(encoding_for_model("gemini-2.5-pro"), None);
    }

    #[test]
    fn falls_back_to_heuristic_for_non_openai() {
        let text = "Hello, world!";
        assert_eq!(
            count_tokens(text, Some("claude-sonnet-4-5")),
            token_estimation::estimate_tokens(text)
        );
        assert_eq!(
            count_tokens(text, None),
            token_estimation::estimate_tokens(text)
        );
    }
}
