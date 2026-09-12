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

use crate::token_estimation;

/// BPE encoding families we can count accurately.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenEncoding {
    O200k,
    Cl100k,
}

/// Provenance attached to a token count shown to users or used for budgeting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CountConfidence {
    /// Counted by a tokenizer bundled for the selected model family.
    Measured,
    /// Estimated with the shared bytes-per-token heuristic.
    Estimated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenCount {
    pub tokens: u64,
    pub confidence: CountConfidence,
}

/// Inputs whose stability determines whether a provider prompt cache can be reused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheIdentity<'a> {
    pub model: &'a str,
    pub system_prompt_sha256: &'a str,
    pub thinking: &'a str,
    pub skills_sha256: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheReuse {
    Reusable,
    ModelChanged,
    SystemPromptChanged,
    ThinkingChanged,
    SkillsChanged,
    ToolsChanged,
    LikelyExpired,
}

impl CacheReuse {
    pub fn explanation(self) -> &'static str {
        match self {
            Self::Reusable => {
                "Model, system prompt, thinking, and tools match; cache reuse is not confirmed."
            }
            Self::ModelChanged => "Model changed.",
            Self::SystemPromptChanged => "System prompt or instructions changed.",
            Self::ThinkingChanged => "Thinking settings changed.",
            Self::SkillsChanged => "Skills changed.",
            Self::ToolsChanged => "Tool schemas changed.",
            Self::LikelyExpired => {
                "At least five minutes since the previous request; cache may have expired."
            }
        }
    }
}

/// Diagnostic request identity, persisted by the existing session owner.
/// This predicts reuse; it never substitutes for provider-reported cache usage.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RequestCacheSnapshot {
    pub model: String,
    pub system_sha256: String,
    pub thinking_sha256: String,
    pub tools_sha256: String,
    pub prepared_at_seconds: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_topology: Option<maestro_ai::cache_topology::CacheTopology>,
}

impl RequestCacheSnapshot {
    pub fn from_request(config: &maestro_ai::RequestConfig, prepared_at_seconds: u64) -> Self {
        use sha2::{Digest, Sha256};
        let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
        Self {
            model: config.model.clone(),
            system_sha256: hash(config.system.as_deref().unwrap_or_default().as_bytes()),
            thinking_sha256: hash(
                serde_json::to_string(&config.thinking)
                    .expect("thinking settings serialize")
                    .as_bytes(),
            ),
            tools_sha256: hash(
                serde_json::to_string(config.tools.as_ref())
                    .expect("tool schemas serialize")
                    .as_bytes(),
            ),
            prepared_at_seconds,
            cache_topology: config
                .cache_topology
                .as_ref()
                .map(|prepared| prepared.topology().clone()),
        }
    }

    pub fn compare(&self, previous: &Self) -> CacheReuse {
        fn identity(value: &RequestCacheSnapshot) -> CacheIdentity<'_> {
            CacheIdentity {
                model: &value.model,
                system_prompt_sha256: &value.system_sha256,
                thinking: &value.thinking_sha256,
                skills_sha256: "", // Effective skill text is part of the request prompt.
            }
        }
        let reason = cache_reuse(
            &identity(previous),
            &identity(self),
            self.prepared_at_seconds
                .saturating_sub(previous.prepared_at_seconds),
            300,
        );
        if matches!(reason, CacheReuse::Reusable | CacheReuse::LikelyExpired)
            && self.tools_sha256 != previous.tools_sha256
        {
            CacheReuse::ToolsChanged
        } else {
            reason
        }
    }
}

/// Explain cache reuse before resuming a session. Content is compared only by
/// caller-provided hashes, so prompts and skill text never enter telemetry.
#[must_use]
pub fn cache_reuse(
    previous: &CacheIdentity<'_>,
    current: &CacheIdentity<'_>,
    idle_seconds: u64,
    expiry_hint_seconds: u64,
) -> CacheReuse {
    if previous.model != current.model {
        CacheReuse::ModelChanged
    } else if previous.system_prompt_sha256 != current.system_prompt_sha256 {
        CacheReuse::SystemPromptChanged
    } else if previous.thinking != current.thinking {
        CacheReuse::ThinkingChanged
    } else if previous.skills_sha256 != current.skills_sha256 {
        CacheReuse::SkillsChanged
    } else if idle_seconds >= expiry_hint_seconds {
        CacheReuse::LikelyExpired
    } else {
        CacheReuse::Reusable
    }
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
    count_tokens_with_metadata(text, model).tokens
}

/// Count tokens and retain whether the value was measured or estimated.
#[must_use]
pub fn count_tokens_with_metadata(text: &str, model: Option<&str>) -> TokenCount {
    let Some(encoding) = model.and_then(encoding_for_model) else {
        return TokenCount {
            tokens: token_estimation::estimate_tokens(text),
            confidence: CountConfidence::Estimated,
        };
    };
    let bpe = match encoding {
        TokenEncoding::O200k => o200k(),
        TokenEncoding::Cl100k => cl100k(),
    };
    match bpe {
        Some(bpe) => TokenCount {
            tokens: bpe.encode_ordinary(text).len() as u64,
            confidence: CountConfidence::Measured,
        },
        None => TokenCount {
            tokens: token_estimation::estimate_tokens(text),
            confidence: CountConfidence::Estimated,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_cache_snapshot_roundtrip_explains_real_request_changes() {
        let mut config = maestro_ai::RequestConfig::default();
        let initial = RequestCacheSnapshot::from_request(&config, 10);
        let restored: RequestCacheSnapshot =
            serde_json::from_str(&serde_json::to_string(&initial).unwrap()).unwrap();
        assert_eq!(
            RequestCacheSnapshot::from_request(&config, 11).compare(&restored),
            CacheReuse::Reusable
        );
        assert_eq!(
            RequestCacheSnapshot::from_request(&config, 311).compare(&restored),
            CacheReuse::LikelyExpired
        );
        config.thinking = Some(maestro_ai::ThinkingConfig::enabled(2048));
        assert_eq!(
            RequestCacheSnapshot::from_request(&config, 11).compare(&restored),
            CacheReuse::ThinkingChanged
        );
        config.thinking = None;
        config.tools = std::sync::Arc::new(vec![maestro_ai::Tool::new("read", "Read a file")]);
        assert_eq!(
            RequestCacheSnapshot::from_request(&config, 11).compare(&restored),
            CacheReuse::ToolsChanged
        );
        config.system = Some("new instruction".into());
        assert_eq!(
            RequestCacheSnapshot::from_request(&config, 11).compare(&restored),
            CacheReuse::SystemPromptChanged
        );
        config.model = "changed-model".into();
        assert_eq!(
            RequestCacheSnapshot::from_request(&config, 11).compare(&restored),
            CacheReuse::ModelChanged
        );
        assert!(
            !serde_json::to_string(&RequestCacheSnapshot::from_request(&config, 11))
                .unwrap()
                .contains("new instruction")
        );
    }

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

    #[test]
    fn count_reports_measurement_provenance() {
        assert_eq!(
            count_tokens_with_metadata("hello", Some("gpt-5")).confidence,
            CountConfidence::Measured
        );
        assert_eq!(
            count_tokens_with_metadata("hello", Some("claude-sonnet-4-5")).confidence,
            CountConfidence::Estimated
        );
    }

    #[test]
    fn cache_reuse_explains_invalidation_and_expiry() {
        let original = CacheIdentity {
            model: "gpt-5",
            system_prompt_sha256: "prompt-a",
            thinking: "medium",
            skills_sha256: "skills-a",
        };
        let changed_model = CacheIdentity {
            model: "gpt-5.1",
            ..original.clone()
        };
        assert_eq!(
            cache_reuse(&original, &changed_model, 1, 300),
            CacheReuse::ModelChanged
        );
        assert_eq!(
            cache_reuse(&original, &original, 301, 300),
            CacheReuse::LikelyExpired
        );
    }
}
