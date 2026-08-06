//! `/context` breakdown: estimate how the current session's context window is
//! spent, split by category (system prompt, tool results, conversation,
//! other/overhead).
//!
//! Token counts use the selected model's bundled tokenizer when available and
//! clearly identify heuristic estimates otherwise. The input is the live
//! TUI transcript (`crate::state::Message`), which mirrors the agent history:
//! regular user/assistant text, thinking blocks, and tool calls with their
//! outputs. UI-only messages (system notices, side questions) never reach the
//! model and are excluded.

use crate::agent::token_counting::{self, CountConfidence};
use crate::agent::token_estimation;
use crate::state::Message;

/// Token breakdown of the current session context, by category.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ContextBreakdown {
    /// Base system prompt sent with every request.
    pub system_prompt: u64,
    /// Tool call inputs and tool result outputs.
    pub tool_results: u64,
    /// User and assistant text, including compaction summaries.
    pub conversation: u64,
    /// Everything else: thinking/reasoning blocks and framing overhead.
    pub other: u64,
}

impl ContextBreakdown {
    /// Estimate the breakdown from the system prompt and the live transcript.
    #[cfg(test)]
    #[must_use]
    pub fn compute(system_prompt: &str, messages: &[Message]) -> Self {
        Self::compute_for_model(system_prompt, messages, None)
    }

    /// Count with the selected model tokenizer when Maestro bundles one.
    #[must_use]
    pub fn compute_for_model(
        system_prompt: &str,
        messages: &[Message],
        model: Option<&str>,
    ) -> Self {
        let count = |text: &str| token_counting::count_tokens(text, model);
        let mut breakdown = Self {
            system_prompt: count(system_prompt),
            ..Self::default()
        };

        for message in messages {
            // Only messages that are part of the model-facing history count:
            // regular turns plus compaction summaries (which are replayed to
            // the model). System notices and side questions are UI-only.
            let in_model_context =
                message.counts_toward_compaction_index() || message.is_compaction_boundary();
            if !in_model_context {
                continue;
            }

            breakdown.conversation += count(&message.content);
            breakdown.other += count(&message.thinking);

            for call in &message.tool_calls {
                // Mirrors the compactor's ToolUse/ToolResult estimation: tool
                // name + serialized input for the call, content for the result.
                let args = serde_json::to_string(&call.args).unwrap_or_default();
                breakdown.tool_results += count(&call.tool) + count(&args) + count(&call.output);
            }
        }

        breakdown
    }

    /// Total estimated tokens across all categories.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.system_prompt + self.tool_results + self.conversation + self.other
    }

    /// Category rows in display order: `(label, tokens, share of total in %)`.
    #[must_use]
    pub fn categories(&self) -> Vec<(&'static str, u64, f64)> {
        let total = self.total();
        [
            ("System prompt", self.system_prompt),
            ("Tool results", self.tool_results),
            ("Conversation", self.conversation),
            ("Other / overhead", self.other),
        ]
        .into_iter()
        .map(|(label, tokens)| (label, tokens, share(tokens, total)))
        .collect()
    }

    /// Render the breakdown as a chat message with counts, percentages, and a
    /// progress bar against the model's context window (when known).
    #[must_use]
    pub fn render(&self, model: Option<&str>, context_window: Option<u64>) -> String {
        let total = self.total();
        let mut lines = vec!["## Context Breakdown".to_string(), String::new()];

        if let Some(model) = model {
            lines.push(format!("**Model:** {model}"));
        }
        let confidence = token_counting::count_tokens_with_metadata("", model).confidence;
        lines.push(format!(
            "**Token count:** {}",
            match confidence {
                CountConfidence::Measured => "measured with the model tokenizer",
                CountConfidence::Estimated => "estimated (model tokenizer unavailable)",
            }
        ));
        lines.push(
            "**Prompt cache:** reuse requires the same model, system prompt, thinking level, and skills; provider caches may expire after long idle periods."
                .to_string(),
        );
        match context_window {
            Some(window) => lines.push(format!("**Context window:** {}", format_tokens(window))),
            None => lines.push("**Context window:** unknown".to_string()),
        }
        lines.push(String::new());

        for (label, tokens, pct) in self.categories() {
            lines.push(format!(
                "- **{label}:** {} ({pct:.1}%)",
                format_tokens(tokens)
            ));
        }
        lines.push(String::new());

        match context_window {
            Some(window) if window > 0 => {
                let used_pct = token_estimation::usage_percentage(total, window);
                lines.push(format!(
                    "**Total:** {} of {} ({used_pct:.1}%)",
                    format_tokens(total),
                    format_tokens(window)
                ));
                lines.push(progress_bar(used_pct / 100.0, 20));
            }
            _ => {
                lines.push(format!("**Total:** {} (estimated)", format_tokens(total)));
            }
        }

        lines.join("\n")
    }
}

/// Share of `part` in `total` as a percentage; `0.0` when `total` is zero.
fn share(part: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    (part as f64 / total as f64) * 100.0
}

/// Simple text progress bar, e.g. `[████████░░░░░░░░░░░░] 40%`.
fn progress_bar(fraction: f64, width: usize) -> String {
    let fraction = fraction.clamp(0.0, 1.0);
    let filled = (fraction * width as f64).round() as usize;
    let empty = width.saturating_sub(filled);
    format!(
        "[{}{}] {:.0}%",
        "█".repeat(filled),
        "░".repeat(empty),
        fraction * 100.0
    )
}

/// Human-readable token count, matching the usage tracker's K/M style.
fn format_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}K", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::token_estimation::estimate_tokens;
    use crate::state::{MessageKind, MessageRole, ToolCallState, ToolCallStatus};
    use std::time::SystemTime;

    fn message(role: MessageRole, kind: MessageKind, content: &str) -> Message {
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            role,
            kind,
            content: content.to_string(),
            thinking: String::new(),
            streaming: false,
            tool_calls: Vec::new(),
            usage: None,
            timestamp: SystemTime::now(),
            thinking_expanded: false,
        }
    }

    fn tool_call(tool: &str, args: serde_json::Value, output: &str) -> ToolCallState {
        ToolCallState {
            call_id: "call-1".to_string(),
            tool: tool.to_string(),
            args,
            status: ToolCallStatus::Completed,
            output: output.to_string(),
        }
    }

    #[test]
    fn empty_session_counts_only_system_prompt() {
        let breakdown = ContextBreakdown::compute("You are a helpful assistant.", &[]);

        assert_eq!(
            breakdown.system_prompt,
            estimate_tokens("You are a helpful assistant.")
        );
        assert_eq!(breakdown.tool_results, 0);
        assert_eq!(breakdown.conversation, 0);
        assert_eq!(breakdown.other, 0);
        assert_eq!(breakdown.total(), breakdown.system_prompt);
    }

    #[test]
    fn fully_empty_session_is_zero() {
        let breakdown = ContextBreakdown::compute("", &[]);
        assert_eq!(breakdown.total(), 0);
        // Percentages must not divide by zero.
        for (_, _, pct) in breakdown.categories() {
            assert!(pct.abs() < f64::EPSILON);
        }
    }

    #[test]
    fn fixture_history_splits_into_categories() {
        let mut assistant = message(MessageRole::Assistant, MessageKind::Regular, "Sure thing");
        assistant.thinking = "Let me think about this".to_string();
        assistant.tool_calls.push(tool_call(
            "read",
            serde_json::json!({"path": "/tmp/a"}),
            "file contents here",
        ));
        let messages = vec![
            message(
                MessageRole::User,
                MessageKind::Regular,
                "Please read a file",
            ),
            assistant,
            // UI-only kinds must be excluded.
            message(MessageRole::Assistant, MessageKind::System, "local notice"),
            message(
                MessageRole::User,
                MessageKind::SideQuestion,
                "side question",
            ),
        ];

        let breakdown = ContextBreakdown::compute("sys", &messages);

        assert_eq!(breakdown.system_prompt, estimate_tokens("sys"));
        assert_eq!(
            breakdown.conversation,
            estimate_tokens("Please read a file") + estimate_tokens("Sure thing")
        );
        assert_eq!(breakdown.other, estimate_tokens("Let me think about this"));
        let args = serde_json::to_string(&serde_json::json!({"path": "/tmp/a"})).unwrap();
        assert_eq!(
            breakdown.tool_results,
            estimate_tokens("read")
                + estimate_tokens(&args)
                + estimate_tokens("file contents here")
        );
        assert_eq!(
            breakdown.total(),
            breakdown.system_prompt
                + breakdown.tool_results
                + breakdown.conversation
                + breakdown.other
        );
    }

    #[test]
    fn compaction_summary_counts_as_conversation() {
        let messages = vec![message(
            MessageRole::Assistant,
            MessageKind::CompactionBoundary,
            "## Conversation Summary\n\nStuff happened.",
        )];
        let breakdown = ContextBreakdown::compute("", &messages);
        assert_eq!(
            breakdown.conversation,
            estimate_tokens("## Conversation Summary\n\nStuff happened.")
        );
    }

    #[test]
    fn percentages_sum_to_hundred() {
        let mut assistant = message(MessageRole::Assistant, MessageKind::Regular, "answer");
        assistant.thinking = "thinking".to_string();
        assistant.tool_calls.push(tool_call(
            "bash",
            serde_json::json!({"command": "ls"}),
            "out",
        ));
        let messages = vec![
            message(MessageRole::User, MessageKind::Regular, "question"),
            assistant,
        ];

        let breakdown = ContextBreakdown::compute("system prompt", &messages);
        let sum: f64 = breakdown.categories().iter().map(|(_, _, pct)| pct).sum();
        assert!(
            (sum - 100.0).abs() < 0.001,
            "category percentages should sum to 100, got {sum}"
        );
    }

    #[test]
    fn render_includes_bar_against_window() {
        let messages = vec![message(
            MessageRole::User,
            MessageKind::Regular,
            &"x".repeat(400),
        )];
        let breakdown = ContextBreakdown::compute("sys", &messages);
        let rendered = breakdown.render(Some("claude-sonnet-4-5-20250514"), Some(200_000));

        assert!(rendered.contains("## Context Breakdown"));
        assert!(rendered.contains("**Model:** claude-sonnet-4-5-20250514"));
        assert!(rendered.contains("**Context window:** 200.0K"));
        assert!(rendered.contains("System prompt"));
        assert!(rendered.contains("Tool results"));
        assert!(rendered.contains("Conversation"));
        assert!(rendered.contains("Other / overhead"));
        assert!(rendered.contains('█') || rendered.contains('░'));
        assert!(rendered.contains("% used") || rendered.contains('%'));
    }

    #[test]
    fn render_without_window_omits_bar() {
        let breakdown = ContextBreakdown::compute("sys", &[]);
        let rendered = breakdown.render(None, None);
        assert!(rendered.contains("**Context window:** unknown"));
        assert!(rendered.contains("**Total:**"));
        assert!(!rendered.contains('['));
    }

    #[test]
    fn progress_bar_edges() {
        assert_eq!(progress_bar(0.0, 10), "[░░░░░░░░░░] 0%");
        assert_eq!(progress_bar(1.0, 10), "[██████████] 100%");
        // Over-100% usage clamps instead of overflowing the bar.
        assert_eq!(progress_bar(1.5, 10), "[██████████] 100%");
    }
}
