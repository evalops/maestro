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
//! use composer_tui::agent::compaction::{ContextCompactor, CompactionConfig};
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
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            max_context_tokens: 100_000, // ~100K tokens before compacting
            target_tokens: 50_000,       // Target ~50K after compaction
            preserve_recent_count: 10,   // Keep last 10 messages
            summarize_tool_results: true,
        }
    }
}

/// Context compactor for managing long conversations
pub struct ContextCompactor {
    config: CompactionConfig,
}

impl ContextCompactor {
    /// Create a new context compactor with the given configuration
    pub fn new(config: CompactionConfig) -> Self {
        Self { config }
    }

    /// Estimate the token count for a set of messages
    ///
    /// Uses a simple heuristic of ~4 characters per token.
    /// This is approximate but sufficient for compaction decisions.
    pub fn estimate_tokens(&self, messages: &[Message]) -> u64 {
        messages.iter().map(|m| estimate_message_tokens(m)).sum()
    }

    /// Check if compaction is needed based on estimated token count
    pub fn needs_compaction(&self, messages: &[Message]) -> bool {
        let tokens = self.estimate_tokens(messages);
        tokens > self.config.max_context_tokens
    }

    /// Compact messages by summarizing older history
    ///
    /// Returns a new message list with:
    /// - A summary message containing compacted history
    /// - The N most recent messages preserved intact
    pub fn compact(&self, messages: &[Message]) -> CompactionResult {
        if messages.len() <= self.config.preserve_recent_count {
            // Not enough messages to compact
            return CompactionResult {
                messages: messages.to_vec(),
                summary: None,
                compacted_count: 0,
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
                "<context_summary>\n{}\n</context_summary>\n\nPlease continue from where we left off.",
                summary
            )),
        });

        // Add preserved messages
        result_messages.extend(to_preserve.iter().cloned());

        CompactionResult {
            messages: result_messages,
            summary: Some(summary),
            compacted_count: to_compact.len(),
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
                                    assistant_actions.push(format!("Used tool: {}", name));
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
                                        tool_results
                                            .push(format!("Tool {}: {}", status, truncated));
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
                    .map(|r| format!("- {}", r))
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
                    .map(|a| format!("- {}", a))
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
                    .map(|r| format!("- {}", r))
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
}

impl CompactionResult {
    /// Check if compaction actually occurred
    pub fn was_compacted(&self) -> bool {
        self.compacted_count > 0
    }
}

/// Estimate token count for a single message
fn estimate_message_tokens(message: &Message) -> u64 {
    match &message.content {
        MessageContent::Text(text) => estimate_text_tokens(text),
        MessageContent::Blocks(blocks) => blocks.iter().map(|b| estimate_block_tokens(b)).sum(),
    }
}

/// Estimate token count for a content block
fn estimate_block_tokens(block: &ContentBlock) -> u64 {
    match block {
        ContentBlock::Text { text } => estimate_text_tokens(text),
        ContentBlock::Thinking { thinking } => estimate_text_tokens(thinking),
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
    if text.len() <= max_chars {
        return text.to_string();
    }

    // Find a good break point (space or newline)
    let truncated = &text[..max_chars];
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
        };
        assert!(result.was_compacted());

        let result_no_compact = CompactionResult {
            messages: vec![],
            summary: None,
            compacted_count: 0,
        };
        assert!(!result_no_compact.was_compacted());
    }
}
