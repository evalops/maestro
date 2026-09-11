//! Compatibility facade for the context compaction core.
//!
//! Compaction algorithms, continuation records, summary framing, token
//! accounting, and envelope repair live in `maestro-context`. This module
//! keeps the historical `maestro_tui::agent::compaction` paths and resolves
//! the provider model catalog at the TUI boundary before constructing the
//! TUI-free core configuration.

use maestro_ai::Message;

pub use maestro_context::TokenCounter;
pub use maestro_context::close_dangling_untrusted_content_envelope;
pub use maestro_context::token_estimation::{self, IMAGE_TOKEN_ESTIMATE};
pub use maestro_context::{
    ContinuationCommand, ContinuationRecord, CutPoint, allocate_summary_chars,
    build_continuation_record, extract_context_summary, render_context_summary,
};

/// Configuration kept source-compatible with the historical TUI module.
///
/// The fields remain public for callers that build a custom compaction policy.
/// Conversion to the algorithmic configuration happens at the TUI/core seam.
#[derive(Debug, Clone)]
pub struct CompactionConfig {
    pub max_context_tokens: u64,
    pub target_tokens: u64,
    pub preserve_recent_count: usize,
    pub summarize_tool_results: bool,
    pub keep_recent_tokens: u64,
    pub auto_compact_threshold: f64,
    pub auto_compact_enabled: bool,
    pub intra_compact_enabled: bool,
    pub intra_message_token_budget: u64,
    pub model: Option<String>,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        maestro_context::CompactionConfig::default().into()
    }
}

impl CompactionConfig {
    /// Resolve a model's context limit in the host, then pass only the scalar
    /// window into the TUI-free core. Explicit overrides take precedence.
    #[must_use]
    pub fn for_model(model: &str, configured_context_window: Option<u64>) -> Self {
        let resolved_context_window = configured_context_window.or_else(|| {
            crate::model_catalog::find_model(model)
                .map(|entry| u64::from(entry.capabilities.context_tokens))
        });
        maestro_context::CompactionConfig::for_model(model, resolved_context_window).into()
    }

    #[must_use]
    pub fn summary_char_budget(&self) -> usize {
        self.clone().into_core().summary_char_budget()
    }

    fn into_core(self) -> maestro_context::CompactionConfig {
        self.into()
    }
}

impl From<maestro_context::CompactionConfig> for CompactionConfig {
    fn from(value: maestro_context::CompactionConfig) -> Self {
        Self {
            max_context_tokens: value.max_context_tokens,
            target_tokens: value.target_tokens,
            preserve_recent_count: value.preserve_recent_count,
            summarize_tool_results: value.summarize_tool_results,
            keep_recent_tokens: value.keep_recent_tokens,
            auto_compact_threshold: value.auto_compact_threshold,
            auto_compact_enabled: value.auto_compact_enabled,
            intra_compact_enabled: value.intra_compact_enabled,
            intra_message_token_budget: value.intra_message_token_budget,
            model: value.model,
        }
    }
}

impl From<CompactionConfig> for maestro_context::CompactionConfig {
    fn from(value: CompactionConfig) -> Self {
        Self {
            max_context_tokens: value.max_context_tokens,
            target_tokens: value.target_tokens,
            preserve_recent_count: value.preserve_recent_count,
            summarize_tool_results: value.summarize_tool_results,
            keep_recent_tokens: value.keep_recent_tokens,
            auto_compact_threshold: value.auto_compact_threshold,
            auto_compact_enabled: value.auto_compact_enabled,
            intra_compact_enabled: value.intra_compact_enabled,
            intra_message_token_budget: value.intra_message_token_budget,
            model: value.model,
        }
    }
}

pub use maestro_context::CompactionResult;

/// TUI compatibility wrapper around the TUI-free context compactor.
pub struct ContextCompactor {
    inner: maestro_context::ContextCompactor,
}

impl ContextCompactor {
    #[must_use]
    pub fn new(config: CompactionConfig) -> Self {
        Self {
            inner: maestro_context::ContextCompactor::new(config.into_core()),
        }
    }

    #[must_use]
    pub fn counter(&self) -> &TokenCounter {
        self.inner.counter()
    }

    pub fn estimate_tokens(&self, messages: &[Message]) -> u64 {
        self.inner.estimate_tokens(messages)
    }

    #[must_use]
    pub fn needs_compaction(&self, messages: &[Message]) -> bool {
        self.inner.needs_compaction(messages)
    }

    #[must_use]
    pub fn should_auto_compact(&self, messages: &[Message]) -> bool {
        self.inner.should_auto_compact(messages)
    }

    #[must_use]
    pub fn usage_percentage(&self, messages: &[Message]) -> f64 {
        self.inner.usage_percentage(messages)
    }

    #[must_use]
    pub fn compact(&self, messages: &[Message]) -> CompactionResult {
        self.inner.compact(messages)
    }

    #[must_use]
    pub fn compact_with_tokens(&self, messages: &[Message]) -> CompactionResult {
        self.inner.compact_with_tokens(messages)
    }

    pub fn compact_intra(&self, messages: &mut [Message]) -> usize {
        self.inner.compact_intra(messages)
    }
}
