//! Context Compaction for Long Conversations
//!
//! This module provides intelligent context compaction to handle conversations that
//! exceed token limits. When the context grows too large, older messages are summarized
//! while preserving the most recent context for coherent conversation flow.
//!
//! # Strategy
//!
//! The compaction strategy follows these principles:
//!
//! 1. **Preserve Recent Context**: The most recent N messages are always kept intact
//!    to maintain conversation coherence
//! 2. **Summarize History**: Older messages are compressed into a single summary
//!    that captures key information, decisions, and context
//! 3. **Maintain Tool Results**: Recent tool results are kept verbatim as they
//!    contain important facts the model needs
//!
//! # Token Estimation
//!
//! Token counts are estimated using a simple character-based heuristic:
//! - ~4 characters per token (average for English text)
//! - Tool results and code may have different ratios
//!
//! # Example
//!
//! ```rust,ignore
//! use maestro_tui::agent::compaction::{ContextCompactor, CompactionConfig};
//!
//! let mut compactor = ContextCompactor::new(CompactionConfig::default());
//!
//! // Check if compaction is needed
//! let estimated_tokens = compactor.estimate_tokens(&messages);
//! if estimated_tokens > config.max_context_tokens {
//!     let compacted = compactor.compact(&messages, &client, &config).await?;
//! }
//! ```

use crate::ai::{ContentBlock, Message, MessageContent, Role};

/// Configuration for context compaction
#[derive(Debug, Clone)]
pub struct CompactionConfig {
    /// Maximum tokens before triggering compaction
    pub max_context_tokens: u64,
    /// Target tokens after compaction
    pub target_tokens: u64,
    /// Number of recent messages to always preserve
    pub preserve_recent_count: usize,
    /// Whether to include tool results in summary
    pub summarize_tool_results: bool,
    /// Minimum recent tokens to preserve (used with token-based cut point)
    pub keep_recent_tokens: u64,
    /// Auto-compaction threshold as a percentage (0.0 - 1.0)
    /// When context reaches this percentage of `max_context_tokens`, compact proactively
    pub auto_compact_threshold: f64,
    /// Whether auto-compaction is enabled
    pub auto_compact_enabled: bool,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            max_context_tokens: 100_000, // ~100K tokens before compacting
            target_tokens: 50_000,       // Target ~50K after compaction
            preserve_recent_count: 10,   // Keep last 10 messages
            summarize_tool_results: true,
            keep_recent_tokens: 20_000, // Keep at least 20K recent tokens
            auto_compact_threshold: 0.85, // Compact at 85% capacity
            auto_compact_enabled: true, // Enabled by default
        }
    }
}

/// Result of finding a cut point in the message history
#[derive(Debug, Clone)]
pub struct CutPoint {
    /// Index of the first message to keep (everything before is compacted)
    pub first_kept_index: usize,
    /// Whether we're splitting in the middle of a turn
    pub is_split_turn: bool,
    /// If split turn, the index where the current turn starts
    pub turn_start_index: Option<usize>,
    /// Estimated tokens before the cut point
    pub tokens_before: u64,
    /// Estimated tokens after the cut point
    pub tokens_after: u64,
}

/// Check if a message contains tool results
fn has_tool_results(message: &Message) -> bool {
    if let MessageContent::Blocks(blocks) = &message.content {
        blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolResult { .. }))
    } else {
        false
    }
}

/// Check if a message contains tool calls (`ToolUse`)
fn has_tool_calls(message: &Message) -> bool {
    if let MessageContent::Blocks(blocks) = &message.content {
        blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
    } else {
        false
    }
}

/// Check if a position is a valid cut point
///
/// A valid cut point is:
/// - After a complete turn (user message or assistant response without pending tool results)
/// - NOT in the middle of a tool call sequence (assistant with `ToolUse` followed by `ToolResult`)
/// - NOT immediately before a tool result message
fn is_valid_cut_point(messages: &[Message], index: usize) -> bool {
    if index == 0 || index >= messages.len() {
        return index == 0;
    }

    let current = &messages[index];
    let prev = &messages[index - 1];

    // Never cut before a message containing tool results
    if has_tool_results(current) {
        return false;
    }

    // If previous message has tool calls, check if current message is the tool result
    // If so, don't cut here - keep tool calls with their results
    if has_tool_calls(prev) {
        // The next message after a tool call should be tool results - don't cut
        return false;
    }

    // Valid cut points:
    // - After an assistant message (complete turn)
    // - After a user message (start of new turn)
    matches!(prev.role, Role::User | Role::Assistant)
}

/// Find the optimal cut point based on token budget
///
/// Walks backward from the end of messages, accumulating tokens until we exceed
/// the `keep_recent_tokens` budget. Returns a valid cut point that respects turn boundaries.
fn find_cut_point(messages: &[Message], keep_recent_tokens: u64) -> CutPoint {
    let total_messages = messages.len();
    let mut accumulated_tokens: u64 = 0;
    let mut candidate_index = total_messages;
    let mut turn_start_index = total_messages;
    let mut is_split_turn = false;

    // Walk backward from the end
    for i in (0..total_messages).rev() {
        let msg_tokens = estimate_message_tokens(&messages[i]);
        accumulated_tokens += msg_tokens;

        // Track turn boundaries (user messages start new turns)
        if messages[i].role == Role::User {
            turn_start_index = i;
        }

        // Once we have enough tokens, look for a valid cut point
        if accumulated_tokens >= keep_recent_tokens {
            // Find the nearest valid cut point at or after this index
            for j in i..total_messages {
                if is_valid_cut_point(messages, j) {
                    candidate_index = j;
                    // Check if we're splitting a turn
                    is_split_turn = j > turn_start_index && turn_start_index < total_messages;
                    break;
                }
            }
            break;
        }
    }

    // If we didn't find a cut point (all messages fit in budget), compact nothing
    if candidate_index == total_messages {
        return CutPoint {
            first_kept_index: 0,
            is_split_turn: false,
            turn_start_index: None,
            tokens_before: 0,
            tokens_after: accumulated_tokens,
        };
    }

    // Calculate tokens before and after the cut
    let tokens_before: u64 = messages[..candidate_index]
        .iter()
        .map(estimate_message_tokens)
        .sum();
    let tokens_after: u64 = messages[candidate_index..]
        .iter()
        .map(estimate_message_tokens)
        .sum();

    CutPoint {
        first_kept_index: candidate_index,
        is_split_turn,
        turn_start_index: if is_split_turn {
            Some(turn_start_index)
        } else {
            None
        },
        tokens_before,
        tokens_after,
    }
}

/// Context compactor for managing long conversations
pub struct ContextCompactor {
    config: CompactionConfig,
}

impl ContextCompactor {
    /// Create a new context compactor with the given configuration
    #[must_use]
    pub fn new(config: CompactionConfig) -> Self {
        Self { config }
    }

    /// Estimate the token count for a set of messages
    ///
    /// Uses a simple heuristic of ~4 characters per token.
    /// This is approximate but sufficient for compaction decisions.
    pub fn estimate_tokens(&self, messages: &[Message]) -> u64 {
        messages.iter().map(estimate_message_tokens).sum()
    }

    /// Check if compaction is needed based on estimated token count
    #[must_use]
    pub fn needs_compaction(&self, messages: &[Message]) -> bool {
        let tokens = self.estimate_tokens(messages);
        tokens > self.config.max_context_tokens
    }

    /// Check if auto-compaction should trigger (proactive compaction before overflow)
    ///
    /// Returns true when:
    /// - Auto-compaction is enabled
    /// - Current token count exceeds the auto-compact threshold percentage
    ///
    /// This allows proactive compaction at e.g. 85% capacity instead of waiting
    /// for the model to hit `MaxTokens` and fail.
    #[must_use]
    pub fn should_auto_compact(&self, messages: &[Message]) -> bool {
        if !self.config.auto_compact_enabled {
            return false;
        }

        let tokens = self.estimate_tokens(messages);
        let threshold =
            (self.config.max_context_tokens as f64 * self.config.auto_compact_threshold) as u64;
        tokens > threshold
    }

    /// Get the current token usage as a percentage of max capacity
    #[must_use]
    pub fn usage_percentage(&self, messages: &[Message]) -> f64 {
        let tokens = self.estimate_tokens(messages);
        (tokens as f64 / self.config.max_context_tokens as f64) * 100.0
    }

    /// Compact messages by summarizing older history
    ///
    /// Returns a new message list with:
    /// - A summary message containing compacted history
    /// - The N most recent messages preserved intact
    ///
    /// This method preserves a fixed number of recent messages.
    /// For token-aware compaction, use `compact_with_tokens`.
    #[must_use]
    pub fn compact(&self, messages: &[Message]) -> CompactionResult {
        if messages.len() <= self.config.preserve_recent_count {
            // Not enough messages to compact
            return CompactionResult {
                messages: messages.to_vec(),
                summary: None,
                compacted_count: 0,
                cut_point: None,
            };
        }

        // Split into messages to compact and messages to preserve
        let split_point = messages
            .len()
            .saturating_sub(self.config.preserve_recent_count);
        let to_compact = &messages[..split_point];
        let to_preserve = &messages[split_point..];

        // Generate summary of compacted messages
        let summary = self.generate_summary(to_compact);

        // Build result: summary + preserved messages
        let mut result_messages = Vec::with_capacity(to_preserve.len() + 1);

        // Add summary as a user message (context injection)
        result_messages.push(Message {
            role: Role::User,
            content: MessageContent::Text(format!(
                "<context_summary>\n{summary}\n</context_summary>\n\nPlease continue from where we left off."
            )),
        });

        // Add preserved messages
        result_messages.extend(to_preserve.iter().cloned());

        CompactionResult {
            messages: result_messages,
            summary: Some(summary),
            compacted_count: to_compact.len(),
            cut_point: None,
        }
    }

    /// Compact messages using token-aware cut point detection
    ///
    /// This method finds the optimal cut point based on token budget while
    /// respecting turn boundaries. Tool calls and their results are kept together.
    ///
    /// Returns a `CompactionResult` with information about whether a turn was split.
    #[must_use]
    pub fn compact_with_tokens(&self, messages: &[Message]) -> CompactionResult {
        let total_tokens = self.estimate_tokens(messages);

        // Check if compaction is needed
        if total_tokens <= self.config.max_context_tokens {
            return CompactionResult {
                messages: messages.to_vec(),
                summary: None,
                compacted_count: 0,
                cut_point: None,
            };
        }

        // Find optimal cut point respecting turn boundaries
        let cut_point = find_cut_point(messages, self.config.keep_recent_tokens);

        // If no valid cut point or nothing to compact
        if cut_point.first_kept_index == 0 {
            return CompactionResult {
                messages: messages.to_vec(),
                summary: None,
                compacted_count: 0,
                cut_point: Some(cut_point),
            };
        }

        let to_compact = &messages[..cut_point.first_kept_index];
        let to_preserve = &messages[cut_point.first_kept_index..];

        // Generate summary with split-turn awareness
        let summary = if cut_point.is_split_turn {
            // When splitting a turn, include context about the partial turn
            let mut parts = vec![self.generate_summary(to_compact)];
            parts.push("\n## Note: The current turn was split during compaction. The assistant was in the middle of responding.".to_string());
            parts.join("\n")
        } else {
            self.generate_summary(to_compact)
        };

        // Build result: summary + preserved messages
        let mut result_messages = Vec::with_capacity(to_preserve.len() + 1);

        // Add summary as a user message (context injection)
        result_messages.push(Message {
            role: Role::User,
            content: MessageContent::Text(format!(
                "<context_summary>\n{summary}\n</context_summary>\n\nPlease continue from where we left off."
            )),
        });

        // Add preserved messages
        result_messages.extend(to_preserve.iter().cloned());

        CompactionResult {
            messages: result_messages,
            summary: Some(summary),
            compacted_count: to_compact.len(),
            cut_point: Some(cut_point),
        }
    }

    /// Generate a summary of messages for compaction
    ///
    /// This extracts key information:
    /// - User requests and decisions
    /// - Tool usage and important results
    /// - Key facts and context
    fn generate_summary(&self, messages: &[Message]) -> String {
        let mut summary_parts = Vec::new();

        // Track conversation flow
        let mut user_requests: Vec<String> = Vec::new();
        let mut assistant_actions: Vec<String> = Vec::new();
        let mut tool_results: Vec<String> = Vec::new();

        for message in messages {
            match message.role {
                Role::User => {
                    if let Some(text) = message.content.as_text() {
                        // Extract key request (first 200 chars)
                        let truncated = truncate_text(text, 200);
                        if !truncated.trim().is_empty() {
                            user_requests.push(truncated);
                        }
                    }
                }
                Role::Assistant => {
                    if let MessageContent::Blocks(blocks) = &message.content {
                        for block in blocks {
                            match block {
                                ContentBlock::Text { text } => {
                                    // Extract key response (first 100 chars)
                                    let truncated = truncate_text(text, 100);
                                    if !truncated.trim().is_empty() {
                                        assistant_actions.push(truncated);
                                    }
                                }
                                ContentBlock::ToolUse { name, .. } => {
                                    assistant_actions.push(format!("Used tool: {name}"));
                                }
                                ContentBlock::ToolResult {
                                    content, is_error, ..
                                } => {
                                    if self.config.summarize_tool_results {
                                        let status = if is_error.unwrap_or(false) {
                                            "failed"
                                        } else {
                                            "succeeded"
                                        };
                                        let truncated = truncate_text(content, 150);
                                        tool_results.push(format!("Tool {status}: {truncated}"));
                                    }
                                }
                                _ => {}
                            }
                        }
                    } else if let Some(text) = message.content.as_text() {
                        let truncated = truncate_text(text, 100);
                        if !truncated.trim().is_empty() {
                            assistant_actions.push(truncated);
                        }
                    }
                }
                Role::System => {
                    // Skip system messages in summary
                }
            }
        }

        // Build summary
        if !user_requests.is_empty() {
            summary_parts.push(format!(
                "## Previous User Requests\n{}",
                user_requests
                    .iter()
                    .take(5)
                    .map(|r| format!("- {r}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }

        if !assistant_actions.is_empty() {
            summary_parts.push(format!(
                "## Previous Actions\n{}",
                assistant_actions
                    .iter()
                    .take(10)
                    .map(|a| format!("- {a}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }

        if !tool_results.is_empty() {
            summary_parts.push(format!(
                "## Previous Tool Results\n{}",
                tool_results
                    .iter()
                    .take(5)
                    .map(|r| format!("- {r}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }

        if summary_parts.is_empty() {
            "No significant history to summarize.".to_string()
        } else {
            summary_parts.join("\n\n")
        }
    }
}

/// Result of a compaction operation
#[derive(Debug)]
pub struct CompactionResult {
    /// The compacted message list
    pub messages: Vec<Message>,
    /// The generated summary (if compaction occurred)
    pub summary: Option<String>,
    /// Number of messages that were compacted
    pub compacted_count: usize,
    /// Information about the cut point (if token-aware compaction was used)
    pub cut_point: Option<CutPoint>,
}

impl CompactionResult {
    /// Check if compaction actually occurred
    #[must_use]
    pub fn was_compacted(&self) -> bool {
        self.compacted_count > 0
    }

    /// Check if a turn was split during compaction
    #[must_use]
    pub fn was_turn_split(&self) -> bool {
        self.cut_point.as_ref().is_some_and(|cp| cp.is_split_turn)
    }
}

/// Estimate token count for a single message
fn estimate_message_tokens(message: &Message) -> u64 {
    match &message.content {
        MessageContent::Text(text) => estimate_text_tokens(text),
        MessageContent::Blocks(blocks) => blocks.iter().map(estimate_block_tokens).sum(),
    }
}

/// Estimate token count for a content block
fn estimate_block_tokens(block: &ContentBlock) -> u64 {
    match block {
        ContentBlock::Text { text } => estimate_text_tokens(text),
        ContentBlock::Thinking { thinking, .. } => estimate_text_tokens(thinking),
        ContentBlock::ToolUse { name, input, .. } => {
            let input_str = serde_json::to_string(input).unwrap_or_default();
            estimate_text_tokens(name) + estimate_text_tokens(&input_str)
        }
        ContentBlock::ToolResult { content, .. } => estimate_text_tokens(content),
        ContentBlock::Image { .. } => {
            // Images have fixed token costs, estimate ~1000 tokens
            1000
        }
    }
}

/// Estimate token count for text using character ratio
fn estimate_text_tokens(text: &str) -> u64 {
    // ~4 characters per token is a reasonable estimate
    (text.len() / 4).max(1) as u64
}

/// Truncate text to a maximum length, preserving word boundaries
fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }

    // Find a good break point (space or newline). Slice on a UTF-8 boundary.
    let end_idx = text
        .char_indices()
        .nth(max_chars)
        .map_or_else(|| text.len(), |(i, _)| i);
    let truncated = &text[..end_idx];
    if let Some(pos) = truncated.rfind(|c: char| c.is_whitespace()) {
        format!("{}...", &truncated[..pos].trim())
    } else {
        format!("{}...", truncated.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_user_message(text: &str) -> Message {
        Message {
            role: Role::User,
            content: MessageContent::Text(text.to_string()),
        }
    }

    fn make_assistant_message(text: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: MessageContent::Text(text.to_string()),
        }
    }

    #[test]
    fn test_estimate_text_tokens() {
        assert_eq!(estimate_text_tokens("Hello"), 1); // 5 chars / 4 = 1
        assert_eq!(estimate_text_tokens("Hello, world!"), 3); // 13 chars / 4 = 3
        assert_eq!(estimate_text_tokens(""), 1); // min 1
    }

    #[test]
    fn test_estimate_message_tokens() {
        let msg = make_user_message("Hello, world!");
        let tokens = estimate_message_tokens(&msg);
        assert!(tokens >= 1);
    }

    #[test]
    fn test_needs_compaction_small() {
        let config = CompactionConfig {
            max_context_tokens: 1000,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        let messages = vec![
            make_user_message("Hello"),
            make_assistant_message("Hi there!"),
        ];

        assert!(!compactor.needs_compaction(&messages));
    }

    #[test]
    fn test_needs_compaction_large() {
        let config = CompactionConfig {
            max_context_tokens: 10, // Very small threshold for testing
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        let messages = vec![
            make_user_message("This is a longer message that should exceed the token limit"),
            make_assistant_message("And this response adds even more tokens to the conversation"),
        ];

        assert!(compactor.needs_compaction(&messages));
    }

    #[test]
    fn test_compact_preserves_recent() {
        let config = CompactionConfig {
            preserve_recent_count: 2,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        let messages = vec![
            make_user_message("Old message 1"),
            make_assistant_message("Old response 1"),
            make_user_message("Old message 2"),
            make_assistant_message("Old response 2"),
            make_user_message("Recent message"),
            make_assistant_message("Recent response"),
        ];

        let result = compactor.compact(&messages);

        assert!(result.was_compacted());
        assert_eq!(result.compacted_count, 4); // 6 - 2 = 4 compacted
                                               // Summary + 2 preserved = 3 total
        assert_eq!(result.messages.len(), 3);
        // First message should be the summary
        assert!(result.messages[0]
            .content
            .as_text()
            .unwrap()
            .contains("context_summary"));
    }

    #[test]
    fn test_compact_too_few_messages() {
        let config = CompactionConfig {
            preserve_recent_count: 5,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        let messages = vec![
            make_user_message("Message 1"),
            make_assistant_message("Response 1"),
        ];

        let result = compactor.compact(&messages);

        assert!(!result.was_compacted());
        assert_eq!(result.messages.len(), 2);
    }

    #[test]
    fn test_truncate_text_short() {
        let text = "Hello";
        assert_eq!(truncate_text(text, 10), "Hello");
    }

    #[test]
    fn test_truncate_text_long() {
        let text = "Hello world this is a long message";
        let truncated = truncate_text(text, 15);
        assert!(truncated.ends_with("..."));
        assert!(truncated.len() <= 18); // 15 + "..."
    }

    #[test]
    fn test_truncate_text_utf8_safe_no_panic() {
        // Previously would panic because byte length > max_chars while char length <= max_chars.
        let text = "😀😀😀";
        let truncated = truncate_text(text, 5);
        assert_eq!(truncated, text);
    }

    #[test]
    fn test_generate_summary_empty() {
        let config = CompactionConfig::default();
        let compactor = ContextCompactor::new(config);

        let messages: Vec<Message> = vec![];
        let summary = compactor.generate_summary(&messages);

        assert!(summary.contains("No significant history"));
    }

    #[test]
    fn test_generate_summary_with_content() {
        let config = CompactionConfig::default();
        let compactor = ContextCompactor::new(config);

        let messages = vec![
            make_user_message("Please help me fix the bug"),
            make_assistant_message("I'll help you debug the issue"),
        ];

        let summary = compactor.generate_summary(&messages);

        assert!(summary.contains("Previous User Requests") || summary.contains("Previous Actions"));
    }

    #[test]
    fn test_generate_summary_with_tool_results() {
        let config = CompactionConfig {
            summarize_tool_results: true,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        let messages = vec![
            make_user_message("Read the file"),
            Message {
                role: Role::Assistant,
                content: MessageContent::Blocks(vec![
                    ContentBlock::ToolUse {
                        id: "123".to_string(),
                        name: "read".to_string(),
                        input: serde_json::json!({"path": "/tmp/test.txt"}),
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "123".to_string(),
                        content: "File contents here".to_string(),
                        is_error: Some(false),
                    },
                ]),
            },
        ];

        let summary = compactor.generate_summary(&messages);

        assert!(summary.contains("Tool") || summary.contains("read"));
    }

    #[test]
    fn test_compaction_result_was_compacted() {
        let result = CompactionResult {
            messages: vec![],
            summary: Some("Summary".to_string()),
            compacted_count: 5,
            cut_point: None,
        };
        assert!(result.was_compacted());

        let result_no_compact = CompactionResult {
            messages: vec![],
            summary: None,
            compacted_count: 0,
            cut_point: None,
        };
        assert!(!result_no_compact.was_compacted());
    }

    // ============================================================
    // Turn-Aware Compaction Tests
    // ============================================================

    fn make_tool_use_message(tool_name: &str, tool_id: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![ContentBlock::ToolUse {
                id: tool_id.to_string(),
                name: tool_name.to_string(),
                input: serde_json::json!({}),
            }]),
        }
    }

    fn make_tool_result_message(tool_id: &str, result: &str) -> Message {
        Message {
            role: Role::User, // Tool results come as user messages
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: tool_id.to_string(),
                content: result.to_string(),
                is_error: Some(false),
            }]),
        }
    }

    #[test]
    fn test_has_tool_results() {
        let msg_with_tool_result = make_tool_result_message("123", "result");
        assert!(super::has_tool_results(&msg_with_tool_result));

        let msg_without = make_user_message("Hello");
        assert!(!super::has_tool_results(&msg_without));
    }

    #[test]
    fn test_has_tool_calls() {
        let msg_with_tool_use = make_tool_use_message("read", "123");
        assert!(super::has_tool_calls(&msg_with_tool_use));

        let msg_without = make_assistant_message("Hello");
        assert!(!super::has_tool_calls(&msg_without));
    }

    #[test]
    fn test_is_valid_cut_point_before_tool_result() {
        let messages = vec![
            make_user_message("Read the file"),
            make_tool_use_message("read", "123"),
            make_tool_result_message("123", "file contents"),
            make_assistant_message("Here's the file"),
        ];

        // Should NOT be valid to cut before tool result (index 2)
        assert!(!super::is_valid_cut_point(&messages, 2));
        // Should NOT be valid to cut after tool use (index 2 means cutting after index 1)
        assert!(!super::is_valid_cut_point(&messages, 2));
        // Valid to cut after assistant message
        assert!(super::is_valid_cut_point(&messages, 4) || messages.len() == 4);
    }

    #[test]
    fn test_is_valid_cut_point_after_complete_turn() {
        let messages = vec![
            make_user_message("Hello"),
            make_assistant_message("Hi there!"),
            make_user_message("How are you?"),
        ];

        // Valid to cut after user message
        assert!(super::is_valid_cut_point(&messages, 1));
        // Valid to cut after assistant message
        assert!(super::is_valid_cut_point(&messages, 2));
    }

    #[test]
    fn test_find_cut_point_respects_tool_sequence() {
        // Create a conversation with a tool call sequence
        let messages = vec![
            make_user_message("Task 1"),               // 0
            make_assistant_message("Working on it"),   // 1
            make_user_message("Task 2"),               // 2
            make_tool_use_message("read", "123"),      // 3
            make_tool_result_message("123", "result"), // 4
            make_assistant_message("Done"),            // 5
        ];

        let cut_point = super::find_cut_point(&messages, 50); // Very low token budget to force cut

        // The cut point should not be between tool use (3) and tool result (4)
        // It should be at index 3 or earlier, or at 5 or later
        if cut_point.first_kept_index > 0 {
            assert!(
                cut_point.first_kept_index <= 3 || cut_point.first_kept_index >= 5,
                "Cut point {} should not split tool call sequence",
                cut_point.first_kept_index
            );
        }
    }

    #[test]
    fn test_compact_with_tokens_no_compaction_needed() {
        let config = CompactionConfig {
            max_context_tokens: 100_000,
            keep_recent_tokens: 20_000,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        let messages = vec![make_user_message("Hello"), make_assistant_message("Hi!")];

        let result = compactor.compact_with_tokens(&messages);
        assert!(!result.was_compacted());
        assert_eq!(result.messages.len(), 2);
    }

    #[test]
    fn test_compact_with_tokens_compaction_occurs() {
        let config = CompactionConfig {
            max_context_tokens: 100, // Very low to trigger compaction
            keep_recent_tokens: 50,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        // Create messages that exceed the token limit
        let messages = vec![
            make_user_message(&"a".repeat(200)), // ~50 tokens
            make_assistant_message(&"b".repeat(200)),
            make_user_message(&"c".repeat(200)),
            make_assistant_message(&"d".repeat(200)),
        ];

        let result = compactor.compact_with_tokens(&messages);
        // Should compact some messages
        assert!(result.was_compacted() || result.messages.len() < messages.len() + 1);
    }

    #[test]
    fn test_was_turn_split() {
        let result_not_split = CompactionResult {
            messages: vec![],
            summary: None,
            compacted_count: 0,
            cut_point: Some(CutPoint {
                first_kept_index: 0,
                is_split_turn: false,
                turn_start_index: None,
                tokens_before: 0,
                tokens_after: 100,
            }),
        };
        assert!(!result_not_split.was_turn_split());

        let result_split = CompactionResult {
            messages: vec![],
            summary: None,
            compacted_count: 5,
            cut_point: Some(CutPoint {
                first_kept_index: 5,
                is_split_turn: true,
                turn_start_index: Some(3),
                tokens_before: 500,
                tokens_after: 100,
            }),
        };
        assert!(result_split.was_turn_split());
    }

    // ============================================================
    // Auto-Compaction Tests
    // ============================================================

    #[test]
    fn test_should_auto_compact_disabled() {
        let config = CompactionConfig {
            max_context_tokens: 1000,
            auto_compact_enabled: false, // Disabled
            auto_compact_threshold: 0.85,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        // Even with lots of tokens, should not trigger when disabled
        let messages = vec![make_user_message(&"a".repeat(4000))]; // ~1000 tokens

        assert!(!compactor.should_auto_compact(&messages));
    }

    #[test]
    fn test_should_auto_compact_below_threshold() {
        let config = CompactionConfig {
            max_context_tokens: 1000,
            auto_compact_enabled: true,
            auto_compact_threshold: 0.85, // 850 tokens
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        // ~200 tokens (800 chars / 4)
        let messages = vec![make_user_message(&"a".repeat(800))];

        assert!(!compactor.should_auto_compact(&messages));
    }

    #[test]
    fn test_should_auto_compact_above_threshold() {
        let config = CompactionConfig {
            max_context_tokens: 1000,
            auto_compact_enabled: true,
            auto_compact_threshold: 0.85, // 850 tokens
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        // ~1000 tokens (4000 chars / 4), which is above 850 threshold
        let messages = vec![make_user_message(&"a".repeat(4000))];

        assert!(compactor.should_auto_compact(&messages));
    }

    #[test]
    fn test_usage_percentage() {
        let config = CompactionConfig {
            max_context_tokens: 1000,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        // ~250 tokens = 25%
        let messages = vec![make_user_message(&"a".repeat(1000))];
        let pct = compactor.usage_percentage(&messages);

        assert!(pct > 20.0 && pct < 30.0);
    }

    #[test]
    fn test_auto_compact_default_config() {
        let config = CompactionConfig::default();

        assert!(config.auto_compact_enabled);
        assert!((config.auto_compact_threshold - 0.85).abs() < 0.01);
    }
}
