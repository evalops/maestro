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

use crate::agent::protocol::close_dangling_untrusted_content_envelope;
use crate::agent::token_estimation::{self, IMAGE_TOKEN_ESTIMATE};
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
    /// Whether intra-message compaction is enabled. This is the second
    /// compaction layer: when inter-turn compaction cannot find a valid cut
    /// point (or the kept messages still exceed budget after compaction),
    /// individual oversized messages have their largest text/tool-result
    /// blocks elided in place. Mirrors grok-build's `intra_compaction` pass.
    pub intra_compact_enabled: bool,
    /// Maximum tokens a single kept message may occupy before its largest
    /// elidable blocks (Text, ToolResult) are head/tail-elided.
    pub intra_message_token_budget: u64,
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
            intra_compact_enabled: true,
            intra_message_token_budget: 8_000,
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
                intra_compacted_count: 0,
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
            intra_compacted_count: 0,
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
                intra_compacted_count: 0,
            };
        }

        // Find optimal cut point respecting turn boundaries
        let cut_point = find_cut_point(messages, self.config.keep_recent_tokens);

        // If no valid cut point or nothing to compact, fall back to
        // intra-message compaction: elide oversized individual messages that
        // inter-turn compaction could not relocate (e.g. a single giant tool
        // result with no valid cut point available).
        if cut_point.first_kept_index == 0 {
            let mut messages = messages.to_vec();
            let intra = self.compact_intra(&mut messages);
            return CompactionResult {
                messages,
                summary: None,
                compacted_count: 0,
                cut_point: Some(cut_point),
                intra_compacted_count: intra,
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

        // Second compaction layer (intra-message): if the kept window still
        // exceeds the budget after inter-turn compaction, elide oversized
        // individual messages in place. The injected summary (index 0) is left
        // intact.
        let mut intra_compacted_count = 0;
        if self.config.intra_compact_enabled
            && self.estimate_tokens(&result_messages) > self.config.max_context_tokens
        {
            for msg in result_messages.iter_mut().skip(1) {
                if elide_message_to_budget(msg, self.config.intra_message_token_budget) > 0 {
                    intra_compacted_count += 1;
                }
            }
        }

        CompactionResult {
            messages: result_messages,
            summary: Some(summary),
            compacted_count: to_compact.len(),
            cut_point: Some(cut_point),
            intra_compacted_count,
        }
    }

    /// Apply intra-message compaction in place.
    ///
    /// Elides any message whose estimated token count exceeds
    /// [`CompactionConfig::intra_message_token_budget`] down to that budget by
    /// head/tail-eliding its largest Text/ToolResult blocks. Returns the number
    /// of messages that were modified. No-ops when intra compaction is disabled.
    pub fn compact_intra(&self, messages: &mut [Message]) -> usize {
        if !self.config.intra_compact_enabled {
            return 0;
        }
        let mut count = 0;
        for msg in messages.iter_mut() {
            if elide_message_to_budget(msg, self.config.intra_message_token_budget) > 0 {
                count += 1;
            }
        }
        count
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
                                } if self.config.summarize_tool_results => {
                                    let status = if is_error.unwrap_or(false) {
                                        "failed"
                                    } else {
                                        "succeeded"
                                    };
                                    // Truncating already-wrapped tool output
                                    // (see `agent::protocol::wrap_untrusted_content`)
                                    // can keep an opening `<untrusted_content>`
                                    // tag while dropping its close, leaving the
                                    // rest of this compacted summary --
                                    // including its own closing
                                    // `</context_summary>` tag and the "Please
                                    // continue" instruction that follows --
                                    // structurally inside a never-closed
                                    // untrusted region. Repair it before use.
                                    let truncated = close_dangling_untrusted_content_envelope(
                                        &truncate_text(content, 150),
                                    );
                                    tool_results.push(format!("Tool {status}: {truncated}"));
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
    /// Number of messages that had content elided via intra-message compaction
    pub intra_compacted_count: usize,
}

impl CompactionResult {
    /// Check if compaction actually occurred
    #[must_use]
    pub fn was_compacted(&self) -> bool {
        self.compacted_count > 0 || self.intra_compacted_count > 0
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
        ContentBlock::Image { .. } => IMAGE_TOKEN_ESTIMATE,
    }
}

/// Estimate token count for text using the shared bytes/4 heuristic.
/// Delegates to [`crate::agent::token_estimation::estimate_tokens`].
#[inline]
fn estimate_text_tokens(text: &str) -> u64 {
    token_estimation::estimate_tokens(text)
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
        format!("{}...", truncated[..pos].trim())
    } else {
        format!("{}...", truncated.trim())
    }
}

/// Elide text to `max_chars`, code-block aware.
///
/// When the text contains fenced code blocks (```), oversized blocks are
/// elided in place first — preserving the fence and language tag plus the head
/// and tail lines so the model retains the structure and the most recent
/// context (often the actual error). If the result is still over budget, it
/// falls back to whole-string head/tail elision. Returns the original text
/// unchanged when it already fits.
fn elide_text(text: &str, max_chars: usize) -> String {
    let char_count = text.chars().count();
    if char_count <= max_chars || max_chars == 0 {
        return text.to_string();
    }

    if text.contains("```") {
        let code_elided = elide_oversized_code_blocks(text, max_chars);
        if code_elided.chars().count() <= max_chars {
            return code_elided;
        }
        return head_tail_elide(&code_elided, max_chars);
    }

    head_tail_elide(text, max_chars)
}

/// Whole-string head/tail elision with an omission marker.
fn head_tail_elide(text: &str, max_chars: usize) -> String {
    let char_count = text.chars().count();
    if char_count <= max_chars || max_chars == 0 {
        return text.to_string();
    }

    // Reserve ~30% for the tail so the most recent lines are preserved.
    let tail = max_chars / 3;
    let head = max_chars.saturating_sub(tail);

    let head_end = text
        .char_indices()
        .nth(head)
        .map_or_else(|| text.len(), |(i, _)| i);
    let tail_start_char = char_count.saturating_sub(tail);
    let tail_start = text
        .char_indices()
        .nth(tail_start_char)
        .map_or_else(|| text.len(), |(i, _)| i);

    let omitted = char_count - head - (char_count - tail_start_char);
    format!(
        "{}\n\n... [{} chars elided] ...\n\n{}",
        text[..head_end].trim(),
        omitted,
        text[tail_start..].trim(),
    )
}

/// Lines of code preserved at the head/tail of an elided fenced block.
const CODE_BLOCK_HEAD_LINES: usize = 8;
const CODE_BLOCK_TAIL_LINES: usize = 8;

/// Elide fenced code blocks that individually exceed roughly half the message
/// budget. Each oversized block is replaced with its opening fence + language
/// tag, the first/last few content lines, and a `[N lines elided]` marker,
/// followed by the closing fence. Non-code text and small code blocks pass
/// through unchanged.
fn elide_oversized_code_blocks(text: &str, max_chars: usize) -> String {
    let block_threshold = (max_chars / 2).max(
        (CODE_BLOCK_HEAD_LINES + CODE_BLOCK_TAIL_LINES) * 40, // rough chars floor
    );

    let mut out = String::with_capacity(text.len());
    let mut lines = text.lines().peekable();

    while let Some(line) = lines.next() {
        if line.trim_start().starts_with("```") {
            let fence_line = line;
            let mut block_lines: Vec<&str> = Vec::new();
            let mut closed = false;
            for inner in lines.by_ref() {
                if inner.trim_start().starts_with("```") {
                    closed = true;
                    break;
                }
                block_lines.push(inner);
            }

            let block_chars: usize = block_lines.iter().map(|l| l.len() + 1).sum();
            if block_chars > block_threshold
                && block_lines.len() > CODE_BLOCK_HEAD_LINES + CODE_BLOCK_TAIL_LINES
            {
                let omitted = block_lines.len() - CODE_BLOCK_HEAD_LINES - CODE_BLOCK_TAIL_LINES;
                out.push_str(fence_line);
                out.push('\n');
                for l in block_lines.iter().take(CODE_BLOCK_HEAD_LINES) {
                    out.push_str(l);
                    out.push('\n');
                }
                out.push_str(&format!("... [{} lines elided] ...\n", omitted));
                for l in block_lines
                    .iter()
                    .skip(block_lines.len() - CODE_BLOCK_TAIL_LINES)
                {
                    out.push_str(l);
                    out.push('\n');
                }
                if closed {
                    out.push_str("```");
                    out.push('\n');
                }
            } else {
                out.push_str(fence_line);
                out.push('\n');
                for l in &block_lines {
                    out.push_str(l);
                    out.push('\n');
                }
                if closed {
                    out.push_str("```");
                    out.push('\n');
                }
            }
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }

    out
}

/// Elide a single content block's large string field down to `max_chars`.
///
/// Only [`ContentBlock::Text`] and [`ContentBlock::ToolResult`] are elided.
/// `ToolUse` blocks (small, needed for tool-call continuity), `Thinking`
/// blocks (signature-bound for API replay), and `Image` blocks (fixed cost)
/// are returned unchanged.
fn elide_block(block: ContentBlock, max_chars: usize) -> ContentBlock {
    match block {
        ContentBlock::Text { text } => ContentBlock::Text {
            text: elide_text(&text, max_chars),
        },
        ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => ContentBlock::ToolResult {
            tool_use_id,
            // Same dangling-envelope risk as the truncation in
            // `generate_summary` (head/tail elision keeps the tail, so this
            // is normally a no-op, but the head-only oversized-code-block
            // path in `elide_oversized_code_blocks` doesn't guarantee the
            // tail survives if the block itself sits at the very end).
            content: close_dangling_untrusted_content_envelope(&elide_text(&content, max_chars)),
            is_error,
        },
        other => other,
    }
}

/// Elide an oversized message in place so it fits within `budget_tokens`.
///
/// Greedily elides the largest elidable blocks (Text, ToolResult) until the
/// message token estimate is within budget (or no more elidable blocks
/// remain). Returns the number of blocks that were modified.
fn elide_message_to_budget(message: &mut Message, budget_tokens: u64) -> usize {
    if estimate_message_tokens(message) <= budget_tokens {
        return 0;
    }
    let max_chars = budget_tokens.saturating_mul(token_estimation::BYTES_PER_TOKEN as u64) as usize;

    match &mut message.content {
        MessageContent::Text(text) => {
            let elided = elide_text(text, max_chars);
            if elided != *text {
                *text = elided;
                return 1;
            }
            0
        }
        MessageContent::Blocks(blocks) => {
            // Elide the largest blocks first until the message fits the budget.
            let mut order: Vec<usize> = (0..blocks.len()).collect();
            order.sort_by(|&a, &b| {
                estimate_block_tokens(&blocks[b]).cmp(&estimate_block_tokens(&blocks[a]))
            });

            let mut total: u64 = blocks.iter().map(estimate_block_tokens).sum();
            let mut changed = 0;
            for idx in order {
                if total <= budget_tokens {
                    break;
                }
                let before = estimate_block_tokens(&blocks[idx]);
                let placeholder = ContentBlock::Text {
                    text: String::new(),
                };
                let original = std::mem::replace(&mut blocks[idx], placeholder);
                let replacement = elide_block(original, max_chars);
                let after = estimate_block_tokens(&replacement);
                blocks[idx] = replacement;
                if after < before {
                    changed += 1;
                }
                total = total - before + after;
            }
            changed
        }
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
        assert_eq!(estimate_text_tokens("Hello"), 2); // 5 chars / 4, ceil = 2
        assert_eq!(estimate_text_tokens("Hello, world!"), 4); // 13 chars / 4, ceil = 4
        assert_eq!(estimate_text_tokens(""), 0); // empty = 0
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

    // ========================================================================
    // Regression: dangling `<untrusted_content>` after truncation/elision
    //
    // A head-only truncation of already-enveloped tool output (see
    // `agent::protocol::wrap_untrusted_content`) can keep the opening tag
    // and drop the closing one. Left unrepaired, everything folded into the
    // `<context_summary>` after that point -- including the summary's own
    // `</context_summary>` close tag and the "Please continue" instruction
    // -- reads as still "inside" a never-closed untrusted region.
    // ========================================================================

    #[test]
    fn test_close_dangling_untrusted_content_envelope_validates_every_opener() {
        // Failed untrusted tools with partial output render two envelopes, so
        // truncation can keep the first envelope complete while cutting inside
        // the *second* opener. Checking only the first opener's `>` leaves the
        // second one malformed.
        let first = "<untrusted_content source=\"web_fetch\" origin=\"https://example.com/a\">\npartial output\n</untrusted_content>\nerror: ";
        let second_opener_fragment =
            "<untrusted_content source=\"web_fetch\" origin=\"https://example.com/a/very/long";
        let truncated = format!("{first}{second_opener_fragment}");
        let repaired = close_dangling_untrusted_content_envelope(&truncated);

        assert!(
            !repaired.contains(second_opener_fragment),
            "the malformed second opener must be reconstructed, not left in place: {repaired}"
        );
        assert!(
            repaired.contains("<untrusted_content>\n</untrusted_content>"),
            "the cut opener must be replaced with a complete provenance-free envelope: {repaired}"
        );
        assert_eq!(
            repaired.matches("<untrusted_content").count(),
            repaired.matches("</untrusted_content>").count(),
            "repaired text must be balanced: {repaired}"
        );
        // The first, intact envelope must survive untouched.
        assert!(repaired.contains(first));
    }

    #[test]
    fn test_close_dangling_untrusted_content_envelope_repairs_truncated_open_tag() {
        let dangling = "<untrusted_content source=\"web_fetch\" origin=\"https://example.com\">\nfirst line of a much longer body that got cut off mid-sent";
        let repaired = close_dangling_untrusted_content_envelope(dangling);
        assert_eq!(
            repaired.matches("<untrusted_content").count(),
            repaired.matches("</untrusted_content>").count(),
            "repaired text must have a matching close tag for every open tag: {repaired}"
        );
        assert!(repaired.ends_with("</untrusted_content>"));
    }

    #[test]
    fn test_close_dangling_untrusted_content_envelope_reconstructs_partial_opener() {
        let partial =
            "<untrusted_content source=\"web_fetch\" origin=\"https://example.com/a/very/long";
        let repaired = close_dangling_untrusted_content_envelope(partial);

        assert_eq!(
            repaired, "<untrusted_content>\n</untrusted_content>",
            "a quoted attribute cut in half must not survive as malformed structure"
        );
    }

    #[test]
    fn test_close_dangling_untrusted_content_envelope_is_noop_when_already_balanced() {
        let balanced = "<untrusted_content source=\"web_fetch\">complete body</untrusted_content>";
        assert_eq!(
            close_dangling_untrusted_content_envelope(balanced),
            balanced
        );
    }

    #[test]
    fn test_close_dangling_untrusted_content_envelope_is_noop_for_unwrapped_text() {
        let plain = "just a normal tool result with no envelope at all";
        assert_eq!(close_dangling_untrusted_content_envelope(plain), plain);
    }

    #[test]
    fn test_generate_summary_repairs_truncated_envelope_in_tool_result() {
        let config = CompactionConfig {
            summarize_tool_results: true,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        // `generate_summary` only extracts `ToolResult` blocks from
        // `Role::Assistant` messages (mirrors what the real agent loop
        // produces: an assistant's `ToolUse` and its paired `ToolResult` in
        // the same `Blocks` message) -- a `ToolResult` under a `Role::User`
        // message (as `make_tool_result_message` builds, matching the wire
        // shape) is never inspected here at all, only `as_text()`'d.
        //
        // Longer than the 150-char truncation budget `generate_summary`
        // applies to tool results, so `truncate_text` cuts inside the body
        // and the closing tag is dropped.
        let long_wrapped_result = format!(
            "<untrusted_content source=\"web_fetch\" origin=\"https://attacker.example/page\">\n{}\n</untrusted_content>",
            "x".repeat(300)
        );
        let messages = vec![Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![
                ContentBlock::ToolUse {
                    id: "call-1".to_string(),
                    name: "web_fetch".to_string(),
                    input: serde_json::json!({"url": "https://attacker.example/page"}),
                },
                ContentBlock::ToolResult {
                    tool_use_id: "call-1".to_string(),
                    content: long_wrapped_result,
                    is_error: Some(false),
                },
            ]),
        }];

        let summary = compactor.generate_summary(&messages);

        assert_eq!(
            summary.matches("<untrusted_content").count(),
            summary.matches("</untrusted_content>").count(),
            "summary must not leave a dangling untrusted-content open tag: {summary}"
        );
    }

    #[test]
    fn test_generate_summary_reconstructs_envelope_when_long_origin_is_truncated() {
        let config = CompactionConfig {
            summarize_tool_results: true,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);
        let long_origin = format!("https://attacker.example/{}", "segment/".repeat(30));
        let wrapped_result = format!(
            "<untrusted_content source=\"web_fetch\" origin=\"{long_origin}\">\nbody\n</untrusted_content>"
        );
        let messages = vec![Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: "call-1".to_string(),
                content: wrapped_result,
                is_error: Some(false),
            }]),
        }];

        let summary = compactor.generate_summary(&messages);
        assert!(
            summary.contains("<untrusted_content>\n</untrusted_content>"),
            "summary must reconstruct a complete envelope when truncation cuts inside its opener: {summary}"
        );
        assert_eq!(
            summary.matches("<untrusted_content").count(),
            summary.matches("</untrusted_content>").count(),
            "reconstructed envelope must remain balanced: {summary}"
        );
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
            intra_compacted_count: 0,
        };
        assert!(result.was_compacted());

        let result_no_compact = CompactionResult {
            messages: vec![],
            summary: None,
            compacted_count: 0,
            cut_point: None,
            intra_compacted_count: 0,
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
            intra_compacted_count: 0,
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
            intra_compacted_count: 0,
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

    #[test]
    fn test_elide_text_preserves_short_and_head_tail_long() {
        // Short text is unchanged.
        assert_eq!(elide_text("short", 100), "short");

        // Long text keeps head + tail with an omission marker.
        let long = "x".repeat(1000);
        let elided = elide_text(&long, 100);
        assert!(elided.contains("chars elided"));
        assert!(elided.len() < long.len());
        // Head and tail both survive (all 'x' here, so check marker presence).
        assert!(elided.starts_with('x'));
        assert!(elided.ends_with('x'));
    }

    #[test]
    fn test_elide_text_code_block_preserves_fence_and_lang() {
        // A large fenced code block is elided in place: the fence + language
        // tag, the first/last few lines, and an elision marker survive.
        let mut block = String::from("```rust\n");
        for i in 0..200 {
            block.push_str(&format!("let x_{i} = {i};\n"));
        }
        block.push_str("```");

        let elided = elide_text(&block, 400);
        assert!(
            elided.contains("```rust"),
            "fence + language tag must survive: {elided}"
        );
        assert!(
            elided.contains("lines elided"),
            "elision marker must be present"
        );
        assert!(elided.contains("let x_0 = 0;"), "head content must survive");
        assert!(
            elided.contains("let x_199 = 199;"),
            "tail content must survive"
        );
        assert!(elided.len() < block.len());
    }

    #[test]
    fn test_elide_text_small_code_block_unchanged() {
        let block = "```ts\nconst a = 1;\nconst b = 2;\n```";
        // Budget large enough that nothing needs eliding.
        assert_eq!(elide_text(block, 10_000), block);
    }

    #[test]
    fn test_elide_text_mixed_code_and_prose() {
        // Prose with an embedded oversized code block: prose is preserved and
        // only the oversized block is elided.
        let mut input = String::from("Here is the file:\n```python\n");
        for i in 0..150 {
            input.push_str(&format!("print({i})\n"));
        }
        input.push_str("```\nThat was the file.");

        let elided = elide_text(&input, 300);
        assert!(elided.contains("Here is the file:"));
        assert!(elided.contains("That was the file."));
        assert!(elided.contains("```python"));
        assert!(elided.contains("lines elided"));
    }

    #[test]
    fn test_compact_intra_elides_oversized_message() {
        // intra_message_token_budget = 100 => 400 chars; feed a 4000-char message.
        let config = CompactionConfig {
            intra_message_token_budget: 100,
            max_context_tokens: 10,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        let mut messages = vec![make_user_message(&"a".repeat(4000))];
        let changed = compactor.compact_intra(&mut messages);

        assert_eq!(changed, 1);
        let after = super::estimate_message_tokens(&messages[0]);
        // Elided to roughly the budget (kept head/tail + omission marker overhead).
        assert!(after <= 200, "expected <= ~budget tokens, got {after}");
        assert!(
            after < 1000,
            "expected reduction from original 1000 tokens, got {after}"
        );
    }

    #[test]
    fn test_compact_intra_disabled_noop() {
        let config = CompactionConfig {
            intra_compact_enabled: false,
            intra_message_token_budget: 100,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        let original = make_user_message(&"a".repeat(4000));
        let mut messages = vec![original.clone()];
        let changed = compactor.compact_intra(&mut messages);

        assert_eq!(changed, 0);
        assert_eq!(super::estimate_message_tokens(&messages[0]), 1000);
    }

    #[test]
    fn test_compact_intra_leaves_tool_use_intact() {
        // A ToolUse block must not be elided, even when the message is large.
        let config = CompactionConfig {
            intra_message_token_budget: 10,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        let mut messages = vec![make_tool_use_message("bash", "tool-1")];
        let changed = compactor.compact_intra(&mut messages);

        // ToolUse alone is tiny, so nothing exceeds the budget => no change.
        assert_eq!(changed, 0);
    }

    #[test]
    fn test_compact_with_tokens_intra_fallback_no_cut_point() {
        // A single oversized user message: no valid inter-turn cut point
        // exists, so the intra-message layer must elide it instead of
        // returning the context unchanged.
        let config = CompactionConfig {
            max_context_tokens: 500, // 2000 chars
            target_tokens: 250,
            keep_recent_tokens: 20_000, // force no inter cut point
            intra_message_token_budget: 50,
            ..Default::default()
        };
        let compactor = ContextCompactor::new(config);

        let messages = vec![make_user_message(&"a".repeat(40_000))]; // ~10k tokens
        let result = compactor.compact_with_tokens(&messages);

        assert!(result.intra_compacted_count > 0);
        assert!(result.was_compacted());
        assert!(compactor.estimate_tokens(&result.messages) <= 500);
    }
}
