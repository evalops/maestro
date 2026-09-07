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

#[cfg(test)]
mod tests {
    use maestro_ai::{ContentBlock, MessageContent, Role};

    use super::*;

    #[test]
    fn host_resolves_catalog_window_before_core_construction() {
        let catalog_tokens = crate::model_catalog::find_model("gpt-5.5")
            .map(|entry| u64::from(entry.capabilities.context_tokens))
            .expect("gpt-5.5 catalog entry");
        let config = CompactionConfig::for_model("gpt-5.5", None);
        assert_eq!(config.max_context_tokens, catalog_tokens);

        let luna = CompactionConfig::for_model("gpt-5.6-luna", None);
        assert_eq!(luna.max_context_tokens, 1_050_000);
        assert_eq!(luna.target_tokens, 525_000);

        let overridden = CompactionConfig::for_model("gpt-5.5", Some(96_000));
        assert_eq!(overridden.max_context_tokens, 96_000);
    }
    /// Fixture transcript shared by the counter-parity tests below, built twice:
    /// once as the agent history the compactor sees (`crate::ai::Message`) and
    /// once as the TUI transcript `/context` reads (`crate::state::Message`).
    /// The same strings appear in both, so any divergence in the totals is a
    /// divergence between the two token counters and nothing else.
    fn parity_fixture() -> (Vec<Message>, Vec<crate::state::Message>) {
        use crate::state::{
            Message as UiMessage, MessageKind, MessageRole, ToolCallState, ToolCallStatus,
        };
        use std::time::SystemTime;

        // Dense source text: bytes/4 and the o200k tokenizer disagree sharply
        // here, which is what makes the parity assertion meaningful.
        let user_text = "Refactor `fn add(a: usize, b: usize) -> usize { a + b }` \
             into a generic over `core::ops::Add`, and keep the doctest.";
        let assistant_text =
            "Done. `impl<T: Add<Output = T>> Sum<T> for Pair<T>` now covers the generic case.";
        let thinking_text = "The doctest asserts add(2,2)==4; a generic impl must keep that true.";
        let tool_name = "bash";
        let tool_args = serde_json::json!({"command": "cargo test -p maestro-tui add_generic"});
        let tool_output = "running 1 test\ntest add_generic ... ok\n\ntest result: ok. 1 passed";

        let agent = vec![
            Message {
                role: Role::User,
                content: MessageContent::Text(user_text.to_string()),
            },
            Message {
                role: Role::Assistant,
                content: MessageContent::Blocks(vec![
                    ContentBlock::Text {
                        text: assistant_text.to_string(),
                    },
                    ContentBlock::Thinking {
                        thinking: thinking_text.to_string(),
                        signature: None,
                    },
                    ContentBlock::ToolUse {
                        id: "call-1".to_string(),
                        name: tool_name.to_string(),
                        input: tool_args.clone(),
                    },
                ]),
            },
            Message {
                role: Role::User,
                content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_use_id: "call-1".to_string(),
                    content: tool_output.to_string(),
                    is_error: Some(false),
                }]),
            },
        ];

        let ui_message = |role: MessageRole, content: &str| UiMessage {
            id: String::new(),
            role,
            kind: MessageKind::Regular,
            content: content.to_string(),
            thinking: String::new(),
            streaming: false,
            tool_calls: Vec::new(),
            usage: None,
            timestamp: SystemTime::UNIX_EPOCH,
            thinking_expanded: false,
        };
        let mut assistant = ui_message(MessageRole::Assistant, assistant_text);
        assistant.thinking = thinking_text.to_string();
        assistant.tool_calls.push(ToolCallState {
            call_id: "call-1".to_string(),
            tool: tool_name.to_string(),
            args: tool_args,
            status: ToolCallStatus::Completed,
            output: tool_output.to_string(),
        });
        let ui = vec![ui_message(MessageRole::User, user_text), assistant];

        (agent, ui)
    }

    #[test]
    fn auto_compaction_counts_agree_with_context_breakdown() {
        use crate::app::context_breakdown::ContextBreakdown;

        // An OpenAI-clade model, so `token_counting` has a bundled tokenizer
        // and both counts are `CountConfidence::Measured`.
        let model = "gpt-4o";
        let (agent, ui) = parity_fixture();

        let compactor = ContextCompactor::new(CompactionConfig {
            model: Some(model.to_string()),
            ..Default::default()
        });
        let gate_tokens = compactor.estimate_tokens(&agent);
        // The empty system prompt keeps the breakdown to the same content the
        // compactor sees; the compactor never counts the system prompt.
        let breakdown_tokens = ContextBreakdown::compute_for_model("", &ui, Some(model)).total();

        assert!(breakdown_tokens > 0);
        let drift = gate_tokens.abs_diff(breakdown_tokens) as f64 / breakdown_tokens as f64;
        assert!(
            drift <= 0.05,
            "compaction gate counted {gate_tokens} tokens, /context counted \
             {breakdown_tokens}: {:.1}% apart",
            drift * 100.0
        );

        // Prove the gate is no longer reading the bytes/4 heuristic. If it
        // were, this fixture would count materially lower.
        let heuristic_compactor = ContextCompactor::new(CompactionConfig {
            model: None,
            ..Default::default()
        });
        let heuristic = heuristic_compactor.estimate_tokens(&agent);
        assert_ne!(
            gate_tokens, heuristic,
            "gate count matches the bytes/4 heuristic; the tokenizer is not being used"
        );
    }

    #[test]
    fn auto_compact_threshold_uses_the_measured_count() {
        let model = "gpt-4o";
        let (agent, _) = parity_fixture();

        let heuristic_compactor = ContextCompactor::new(CompactionConfig {
            model: None,
            ..Default::default()
        });
        let heuristic = heuristic_compactor.estimate_tokens(&agent);
        let measured_compactor = ContextCompactor::new(CompactionConfig {
            model: Some(model.to_string()),
            ..Default::default()
        });
        let measured = measured_compactor.estimate_tokens(&agent);
        assert!(
            measured > heuristic,
            "fixture must tokenize higher than bytes/4 for this test to bite \
             (measured {measured}, heuristic {heuristic})"
        );

        // Pick a window whose 85% threshold sits between the two counts: the
        // heuristic says "no compaction needed", the tokenizer says "compact".
        let threshold = u64::midpoint(heuristic, measured);
        let max_context_tokens = (threshold as f64 / 0.85).ceil() as u64;

        let measured_compactor = ContextCompactor::new(CompactionConfig {
            model: Some(model.to_string()),
            max_context_tokens,
            ..Default::default()
        });
        let heuristic_compactor = ContextCompactor::new(CompactionConfig {
            model: None,
            max_context_tokens,
            ..Default::default()
        });

        assert!(measured_compactor.should_auto_compact(&agent));
        assert!(!heuristic_compactor.should_auto_compact(&agent));
    }
}
