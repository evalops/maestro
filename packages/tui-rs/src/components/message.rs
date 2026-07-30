//! Message display widgets
//!
//! This module implements the chat message display system, including the main scrollable
//! message list (`ChatView`), individual message rendering (`MessageWidget`), and supporting
//! components like the status bar and input box.
//!
//! # Widget Hierarchy
//!
//! ```text
//! ChatView (main container)
//! ├── MessageWidget (per message)
//! │   ├── Role header with timestamp
//! │   ├── Thinking block (collapsible)
//! │   ├── Markdown content
//! │   └── ToolCallWidget (per tool call)
//! ├── ChatInputWidget (bottom input box)
//! └── StatusBarWidget (bottom status line)
//! ```
//!
//! # Rendering Features
//!
//! ## Markdown Parsing
//!
//! The message content supports inline markdown:
//! - **bold**: `**text**`
//! - `code`: backtick-wrapped inline code
//! - Code blocks: triple-backtick fenced blocks with syntax highlighting hints
//! - Links: `[text](url)` rendered with underline styling
//!
//! Markdown parsing is implemented in `parse_markdown_lines()` and `parse_markdown_line()`.
//!
//! ## Scrolling and Viewport Management
//!
//! `ChatView` implements a virtual scrolling system:
//! - Messages are filtered to only renderable ones (via `should_render_message`)
//! - Heights are pre-calculated for all messages (via `calculate_message_height`)
//! - The viewport is anchored from the bottom by `scroll_offset`
//! - Only messages within the viewport are rendered
//! - A scrollbar is drawn when total content height exceeds viewport height
//!
//! ## Tool Call Display
//!
//! Tool calls are rendered as collapsible sections with:
//! - Status pill: `[RUN]`, `[OK]`, `[ERR]`, `[PEND]` with color coding
//! - Tool-specific icons (see `get_tool_icon()`)
//! - Expandable arguments (JSON pretty-printed)
//! - Output display (truncated to first 10 lines when collapsed)
//! - Click indicator: `[+]` collapsed, `[-]` expanded
//!
//! ## Thinking Blocks
//!
//! Assistant messages may include "thinking" content (Claude's internal reasoning):
//! - Rendered in a collapsible section with gutter (│)
//! - Shows character count badge
//! - Collapsed: shows first 2 lines as preview
//! - Expanded: shows full thinking content with italic dim styling
//! - Toggle indicator: `[+]` / `[-]`
//!
//! # Widget Trait Implementation
//!
//! Each widget implements `ratatui::widgets::Widget`:
//!
//! ```rust,ignore
//! impl Widget for MessageWidget<'_> {
//!     fn render(self, area: Rect, buf: &mut Buffer) {
//!         // Write styled text to buffer cells
//!         buf.set_string(x, y, "text", style);
//!         // Or use higher-level Paragraph widget
//!         Paragraph::new(content).render(area, buf);
//!     }
//! }
//! ```
//!
//! ## Stateless Widget Pattern
//!
//! `MessageWidget`, `ToolCallWidget`, `StatusBarWidget` are stateless widgets:
//! - Take references to data (`&'a Message`, `&'a str`)
//! - Consume `self` in `render()` (builder pattern allows chaining)
//! - Do not maintain state across renders
//!
//! ## Stateful Widget Pattern
//!
//! `ChatView` references stateful data (`&'a AppState`) which contains:
//! - Message list
//! - Scroll position
//! - Expanded tool call set
//! - Input state and cursor position
//!
//! # Cursor Positioning
//!
//! `ChatInputWidget` calculates terminal cursor position using:
//! - Unicode width calculation (not byte length)
//! - Text wrapping logic to determine row/column
//! - Clamping to visible area boundaries
//!
//! The cursor position is calculated in `cursor_pos()` and set by the app's render loop.
//!
//! # Keyboard Event Handling
//!
//! This module does NOT handle keyboard events directly. Event handling is performed in
//! the main app loop (src/app.rs), which updates `AppState`. The widgets re-render based
//! on the updated state.
//!
//! # Design Inspiration
//!
//! Visual design inspired by:
//! - TypeScript Maestro TUI
//! - `OpenAI` Codex TUI
//!
//! Features:
//! - Bordered panels and status badges
//! - Tool-specific icons
//! - Shimmer animations for "Working" text
//! - Elapsed time display
//! - Timestamps
//! - Collapsible thinking blocks

use ratatui::{
    buffer::Buffer,
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Widget, Wrap},
};

use crate::components::message_layout::MessageLayoutKey;
use crate::components::textarea::{TextArea, TextAreaWidget};
use crate::effects::shimmer_spans;
use crate::runtime_badges::{build_runtime_badges, RuntimeBadgeParams};
use crate::session::ThinkingLevel;
use crate::state::{
    ApprovalMode, InteractionMode, Message, MessageKind, MessageRole, QueueMode, ToolCallStatus,
};
use crate::tool_output::{clamp_tool_output, format_tool_output_truncation, tool_output_limits};
use crate::tool_summary::summarize_tool_use;
use crate::wrapping::{word_wrap_lines, RtOptions};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::time::SystemTime;
use unicode_width::UnicodeWidthStr;

/// Parse markdown text into styled lines
/// Supports: **bold**, `code`, ```code blocks```, [links](url)
fn parse_markdown_lines(text: &str) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut in_code_block = false;

    for line_text in text.lines() {
        if line_text.starts_with("```") {
            in_code_block = !in_code_block;
            if in_code_block {
                // Code block start with language hint
                let lang = line_text.trim_start_matches("```").trim();
                lines.push(Line::from(vec![
                    Span::styled("```", Style::default().fg(Color::DarkGray)),
                    Span::styled(lang.to_string(), Style::default().fg(Color::Yellow)),
                ]));
            } else {
                lines.push(Line::from(Span::styled(
                    "```",
                    Style::default().fg(Color::DarkGray),
                )));
            }
            continue;
        }

        if in_code_block {
            // Inside code block - render with dim style
            lines.push(Line::from(Span::styled(
                format!("  {line_text}"),
                Style::default()
                    .fg(Color::Green)
                    .add_modifier(Modifier::DIM),
            )));
        } else {
            // Parse inline markdown
            lines.push(parse_markdown_line(line_text));
        }
    }

    lines
}

/// Parse a single line of markdown into styled spans
fn parse_markdown_line(text: &str) -> Line<'static> {
    let mut spans = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        // Check for bold (**text**)
        if i + 1 < chars.len() && chars[i] == '*' && chars[i + 1] == '*' {
            // Flush current
            if !current.is_empty() {
                spans.push(Span::raw(std::mem::take(&mut current)));
            }
            i += 2;
            let start = i;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '*') {
                i += 1;
            }
            let bold_text: String = chars[start..i].iter().collect();
            spans.push(Span::styled(
                bold_text,
                Style::default().add_modifier(Modifier::BOLD),
            ));
            if i + 1 < chars.len() {
                i += 2; // skip closing **
            }
            continue;
        }

        // Check for inline code (`code`)
        if chars[i] == '`' {
            // Flush current
            if !current.is_empty() {
                spans.push(Span::raw(std::mem::take(&mut current)));
            }
            i += 1;
            let start = i;
            while i < chars.len() && chars[i] != '`' {
                i += 1;
            }
            let code_text: String = chars[start..i].iter().collect();
            spans.push(Span::styled(
                code_text,
                Style::default().fg(Color::Cyan).add_modifier(Modifier::DIM),
            ));
            if i < chars.len() {
                i += 1; // skip closing `
            }
            continue;
        }

        // Check for link [text](url)
        if chars[i] == '[' {
            // Flush current
            if !current.is_empty() {
                spans.push(Span::raw(std::mem::take(&mut current)));
            }
            i += 1;
            let text_start = i;
            while i < chars.len() && chars[i] != ']' {
                i += 1;
            }
            let link_text: String = chars[text_start..i].iter().collect();
            i += 1; // skip ]

            if i < chars.len() && chars[i] == '(' {
                i += 1;
                let url_start = i;
                while i < chars.len() && chars[i] != ')' {
                    i += 1;
                }
                let _url: String = chars[url_start..i].iter().collect();
                spans.push(Span::styled(
                    link_text,
                    Style::default()
                        .fg(Color::Blue)
                        .add_modifier(Modifier::UNDERLINED),
                ));
                if i < chars.len() {
                    i += 1; // skip )
                }
            } else {
                // Not a valid link, render as plain text
                current.push('[');
                current.push_str(&link_text);
                current.push(']');
            }
            continue;
        }

        current.push(chars[i]);
        i += 1;
    }

    // Flush remaining
    if !current.is_empty() {
        spans.push(Span::raw(current));
    }

    if spans.is_empty() {
        Line::default()
    } else {
        Line::from(spans)
    }
}

/// Format a timestamp for display (HH:MM)
fn format_timestamp(time: SystemTime) -> String {
    use std::time::UNIX_EPOCH;
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs();
    // Convert to local time (simplified - just use UTC offset approximation)
    // For proper timezone support, would need chrono crate
    let hours = (secs / 3600) % 24;
    let minutes = (secs / 60) % 60;
    format!("{hours:02}:{minutes:02}")
}

/// Get tool-specific icon (matching TypeScript TUI patterns)
fn get_tool_icon(tool: &str) -> &'static str {
    match tool.to_lowercase().as_str() {
        "bash" => "λ",
        "read" => "◇",
        "write" => "◆",
        "edit" => "◈",
        "glob" => "◎",
        "grep" => "⊛",
        "task" => "⊕",
        "todowrite" => "☐",
        "webfetch" => "↯",
        "websearch" => "⌕",
        _ => "●",
    }
}

fn format_tool_status_summary(status: ToolCallStatus, summary: &str) -> String {
    match status {
        ToolCallStatus::Completed => summary.to_string(),
        ToolCallStatus::Running => format!("Running · {summary}"),
        ToolCallStatus::Failed => format!("Failed · {summary}"),
        ToolCallStatus::Pending => format!("Pending · {summary}"),
        ToolCallStatus::Cancelled => format!("Cancelled · {summary}"),
        ToolCallStatus::Blocked => format!("Blocked · {summary}"),
    }
}

fn should_show_tool_args_preview(summary: &str, args_preview: &str) -> bool {
    !args_preview.is_empty() && !summary.contains(args_preview)
}

/// Check if a message should be rendered
/// Skip empty assistant messages (no content AND no tool calls)
pub fn should_render_message(message: &Message) -> bool {
    if message.is_compaction_boundary() {
        return true;
    }

    // User messages always render
    if message.role == MessageRole::User {
        return true;
    }

    // Assistant messages: render if they have content, thinking, tool calls, OR are streaming
    !message.content.is_empty()
        || !message.thinking.is_empty()
        || !message.tool_calls.is_empty()
        || message.streaming
}

/// Calculate the height needed to render a message
pub fn calculate_message_height(
    message: &Message,
    width: u16,
    expanded_tools: &HashSet<String>,
    compact_tool_outputs: bool,
) -> u16 {
    if !should_render_message(message) {
        return 0;
    }

    let mut height: u16 = 0;
    let content_width = width.saturating_sub(4).max(1) as usize;

    // Empty line before message (separator)
    height += 1;

    if message.is_compaction_boundary() {
        height += 1;
        if !message.content.is_empty() {
            let md_lines = parse_markdown_lines(&message.content);
            let wrap_opts = RtOptions::new(content_width)
                .initial_indent(Line::from("  "))
                .subsequent_indent(Line::from("  "));
            let wrapped_lines = word_wrap_lines(&md_lines, wrap_opts);
            height += wrapped_lines.len() as u16;
        }
        return height;
    }

    // Header line with role and timestamp
    height += 1;

    // Thinking content
    if !message.thinking.is_empty() {
        if message.thinking_expanded {
            // Expanded: show full thinking with wrapping
            let thinking_lines = message
                .thinking
                .lines()
                .map(|line| (line.len() / content_width + 1) as u16)
                .sum::<u16>()
                .max(1);
            height += thinking_lines + 1; // +1 for header
        } else {
            // Collapsed: just header + 2 preview lines
            height += 3;
        }
    }

    // Content lines (with word wrapping)
    if !message.content.is_empty() {
        let md_lines = parse_markdown_lines(&message.content);
        let wrap_opts = RtOptions::new(content_width)
            .initial_indent(Line::from("  "))
            .subsequent_indent(Line::from("  "));
        let wrapped_lines = word_wrap_lines(&md_lines, wrap_opts);
        height += wrapped_lines.len() as u16;
    }

    // Tool calls
    for tc in &message.tool_calls {
        let expanded = if compact_tool_outputs {
            expanded_tools.contains(&tc.call_id)
        } else {
            !expanded_tools.contains(&tc.call_id)
        };
        let summary_label = summarize_tool_use(&tc.tool, &tc.args);
        let args_preview =
            get_tool_args_preview(&tc.tool, &tc.args, width.saturating_sub(20) as usize);
        let show_args_preview = should_show_tool_args_preview(&summary_label, &args_preview);

        // header line
        height += 1;

        if show_args_preview {
            height += 1;
        }

        if !tc.output.is_empty() {
            let clamp = clamp_tool_output(&tc.output, tool_output_limits());
            let output_lines: Vec<&str> = clamp.text.lines().collect();
            let max_output_lines = if expanded { 50 } else { 5 };
            let total_lines = output_lines.len();
            let truncated = total_lines > max_output_lines;

            if !output_lines.is_empty() {
                let out_lines = output_lines
                    .iter()
                    .take(max_output_lines)
                    .map(|l| (l.len() / content_width + 1) as u16)
                    .sum::<u16>()
                    .max(1);

                height += out_lines;

                if truncated {
                    height += 1;
                }
                if clamp.truncated {
                    height += 1;
                }
            } else if clamp.truncated {
                height += 1;
            }
        }

        // Spacer after each tool call
        height += 1;
    }

    height
}

/// A stateless widget for rendering a single chat message.
///
/// Renders a complete message including:
/// - Role header with timestamp (User/Assistant)
/// - Optional thinking block (collapsible)
/// - Message content with markdown parsing
/// - Tool calls (collapsible) with status indicators
///
/// # Widget Trait
///
/// Implements `ratatui::widgets::Widget` to render directly to a buffer. The widget
/// consumes itself (builder pattern) to allow method chaining.
///
/// # Usage
///
/// ```rust,ignore
/// let widget = MessageWidget::new(&message)
///     .with_expanded_tools(&expanded_set);
/// frame.render_widget(widget, area);
/// ```
///
/// The widget will skip rendering entirely if `should_render_message()` returns false
/// (e.g., empty assistant messages with no tool calls).
pub struct MessageWidget<'a> {
    message: &'a Message,
    expanded_tools: Option<&'a HashSet<String>>,
    compact_tool_outputs: bool,
}

impl<'a> MessageWidget<'a> {
    #[must_use]
    pub fn new(message: &'a Message) -> Self {
        Self {
            message,
            expanded_tools: None,
            compact_tool_outputs: false,
        }
    }

    #[must_use]
    pub fn with_expanded_tools(mut self, expanded: &'a HashSet<String>) -> Self {
        self.expanded_tools = Some(expanded);
        self
    }

    #[must_use]
    pub fn with_compact_tool_outputs(mut self, compact: bool) -> Self {
        self.compact_tool_outputs = compact;
        self
    }
}

impl Widget for MessageWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        if !should_render_message(self.message) {
            return;
        }

        let mut y = area.y;
        let max_y = area.y + area.height;

        // Blank line separator before message
        if y < max_y {
            y += 1;
        }

        if self.message.is_compaction_boundary() {
            let timestamp = format_timestamp(self.message.timestamp);
            let boundary = Line::from(vec![
                Span::styled(
                    "  ✻ ",
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::DIM),
                ),
                Span::styled(
                    "Conversation compacted",
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::DIM),
                ),
                Span::styled(
                    format!("  {timestamp}"),
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::DIM),
                ),
            ]);
            Paragraph::new(boundary).render(
                Rect {
                    y,
                    height: 1,
                    ..area
                },
                buf,
            );
            y += 1;

            if y < max_y && !self.message.content.is_empty() {
                let md_lines = parse_markdown_lines(&self.message.content);
                let wrap_opts = RtOptions::new(area.width.saturating_sub(4).max(1) as usize)
                    .initial_indent(Line::from("  "))
                    .subsequent_indent(Line::from("  "));
                let wrapped_lines = word_wrap_lines(&md_lines, wrap_opts);
                let available = max_y.saturating_sub(y) as usize;
                Paragraph::new(
                    wrapped_lines
                        .into_iter()
                        .take(available)
                        .collect::<Vec<_>>(),
                )
                .wrap(Wrap { trim: false })
                .render(
                    Rect {
                        x: area.x,
                        y,
                        width: area.width,
                        height: max_y.saturating_sub(y),
                    },
                    buf,
                );
            }
            return;
        }

        // Role header with prefix and timestamp (Codex style)
        if y < max_y {
            let mut header_spans: Vec<Span<'static>> = Vec::new();

            match self.message.role {
                MessageRole::User => {
                    let (label, color) = if self.message.kind == MessageKind::SideQuestion {
                        ("BTW", Color::Blue)
                    } else {
                        ("You", Color::Cyan)
                    };
                    header_spans.push(Span::styled(
                        "› ",
                        Style::default()
                            .fg(color)
                            .add_modifier(Modifier::BOLD | Modifier::DIM),
                    ));
                    header_spans.push(Span::styled(
                        label,
                        Style::default().fg(color).add_modifier(Modifier::BOLD),
                    ));
                }
                MessageRole::Assistant => {
                    let (prefix, label, color) = match self.message.kind {
                        MessageKind::System => ("• ", "System", Color::Yellow),
                        MessageKind::SideAnswer => ("• ", "Maestro (side)", Color::Blue),
                        _ => ("• ", "Maestro", Color::Magenta),
                    };
                    header_spans.push(Span::styled(
                        prefix,
                        Style::default().fg(color).add_modifier(Modifier::DIM),
                    ));
                    header_spans.push(Span::styled(
                        label,
                        Style::default().fg(color).add_modifier(Modifier::BOLD),
                    ));
                }
            }

            // Add timestamp (right-aligned feel)
            let timestamp = format_timestamp(self.message.timestamp);
            header_spans.push(Span::styled(
                format!("  {timestamp}"),
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::DIM),
            ));

            let header = Line::from(header_spans);
            let header_para = Paragraph::new(header);
            header_para.render(
                Rect {
                    y,
                    height: 1,
                    ..area
                },
                buf,
            );
            y += 1;
        }

        // Render thinking content (collapsible)
        if y < max_y && !self.message.thinking.is_empty() {
            let expanded = self.message.thinking_expanded;
            let toggle_hint = if expanded { "[-]" } else { "[+]" };

            // Thinking header with collapse/expand indicator
            let thinking_header = Line::from(vec![
                Span::styled("  │ ", Style::default().fg(Color::DarkGray)),
                Span::styled("◆ ", Style::default().fg(Color::Yellow)),
                Span::styled("Thinking", Style::default().fg(Color::Yellow)),
                Span::styled(
                    format!(" ({} chars) ", self.message.thinking.len()),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(
                    toggle_hint,
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::DIM),
                ),
            ]);
            Paragraph::new(thinking_header).render(
                Rect {
                    x: area.x,
                    y,
                    width: area.width,
                    height: 1,
                },
                buf,
            );
            y += 1;

            if expanded {
                // Show all thinking content with gutter
                for line in self.message.thinking.lines() {
                    if y >= max_y {
                        break;
                    }
                    let max_len = area.width.saturating_sub(6) as usize;
                    let truncated = if line.len() > max_len {
                        format!("{}...", &line[..max_len.saturating_sub(3)])
                    } else {
                        line.to_string()
                    };
                    let content = Line::from(vec![
                        Span::styled("  │ ", Style::default().fg(Color::DarkGray)),
                        Span::styled(
                            truncated,
                            Style::default()
                                .fg(Color::DarkGray)
                                .add_modifier(Modifier::ITALIC),
                        ),
                    ]);
                    Paragraph::new(content).render(
                        Rect {
                            x: area.x,
                            y,
                            width: area.width,
                            height: 1,
                        },
                        buf,
                    );
                    y += 1;
                }
            } else {
                // Show first 2 lines of thinking as preview
                let preview_lines: Vec<&str> = self.message.thinking.lines().take(2).collect();
                for line in preview_lines {
                    if y >= max_y {
                        break;
                    }
                    let max_len = area.width.saturating_sub(6) as usize;
                    let truncated = if line.len() > max_len {
                        format!("{}...", &line[..max_len.saturating_sub(3)])
                    } else {
                        line.to_string()
                    };
                    let preview = Line::from(vec![
                        Span::styled("  │ ", Style::default().fg(Color::DarkGray)),
                        Span::styled(
                            truncated,
                            Style::default()
                                .fg(Color::DarkGray)
                                .add_modifier(Modifier::ITALIC),
                        ),
                    ]);
                    Paragraph::new(preview).render(
                        Rect {
                            x: area.x,
                            y,
                            width: area.width,
                            height: 1,
                        },
                        buf,
                    );
                    y += 1;
                }
            }
        }

        // Render content with markdown styling and proper word wrapping
        if y < max_y && !self.message.content.is_empty() {
            let content_width = area.width.saturating_sub(2) as usize;

            // Parse markdown into styled lines
            let md_lines = parse_markdown_lines(&self.message.content);

            // Word wrap all lines with indent
            let wrap_opts = RtOptions::new(content_width)
                .initial_indent(Line::from("  "))
                .subsequent_indent(Line::from("  "));

            let wrapped_lines = word_wrap_lines(&md_lines, wrap_opts);

            // Render each wrapped line
            for line in wrapped_lines {
                if y >= max_y {
                    break;
                }
                Paragraph::new(line).render(
                    Rect {
                        x: area.x,
                        y,
                        width: area.width,
                        height: 1,
                    },
                    buf,
                );
                y += 1;
            }
        }

        // Render tool calls in Codex style
        for tool_call in &self.message.tool_calls {
            if y >= max_y {
                break;
            }

            let expanded = self
                .expanded_tools
                .is_some_and(|s| s.contains(&tool_call.call_id));
            let expanded = if self.compact_tool_outputs {
                expanded
            } else {
                !expanded
            };

            // Status bullet plus concise summary label.
            let (bullet, bullet_style) = match tool_call.status {
                ToolCallStatus::Running => ("●", Style::default().fg(Color::Cyan)),
                ToolCallStatus::Completed => ("●", Style::default().fg(Color::Green)),
                ToolCallStatus::Failed => ("●", Style::default().fg(Color::Red)),
                ToolCallStatus::Pending => ("○", Style::default().fg(Color::Yellow)),
                ToolCallStatus::Cancelled => ("⊘", Style::default().fg(Color::Yellow)),
                ToolCallStatus::Blocked => ("●", Style::default().fg(Color::Magenta)),
            };
            let summary_label = summarize_tool_use(&tool_call.tool, &tool_call.args);
            let header_label = format_tool_status_summary(tool_call.status, &summary_label);

            // Get tool args preview for inline display
            let args_preview = get_tool_args_preview(
                &tool_call.tool,
                &tool_call.args,
                area.width.saturating_sub(20) as usize,
            );
            let show_args_preview = should_show_tool_args_preview(&summary_label, &args_preview);

            // Get tool-specific icon
            let tool_icon = get_tool_icon(&tool_call.tool);

            // Header line: λ Read package.json · read #12345678  [+]
            let header_line = Line::from(vec![
                Span::styled(bullet, bullet_style.add_modifier(Modifier::BOLD)),
                Span::raw(" "),
                Span::styled(tool_icon, Style::default().fg(Color::Cyan)),
                Span::raw(" "),
                Span::styled(
                    header_label,
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(" "),
                Span::styled(
                    format!("· {}", tool_call.tool),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::raw(" "),
                Span::styled(
                    format!("#{}", tool_call.call_id.chars().take(8).collect::<String>()),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::raw(if expanded { "  [-]" } else { "  [+]" }),
            ]);
            Paragraph::new(header_line).render(
                Rect {
                    x: area.x,
                    y,
                    width: area.width,
                    height: 1,
                },
                buf,
            );
            y += 1;

            // Show args preview inline with tree prefix
            if y < max_y && show_args_preview {
                let preview_line = Line::from(vec![
                    Span::styled("  └ ", Style::default().fg(Color::DarkGray)),
                    Span::styled(args_preview.clone(), Style::default().fg(Color::DarkGray)),
                ]);
                Paragraph::new(preview_line).render(
                    Rect {
                        x: area.x,
                        y,
                        width: area.width,
                        height: 1,
                    },
                    buf,
                );
                y += 1;
            }

            // Output block (truncated to max 5 lines when collapsed)
            if y < max_y && !tool_call.output.is_empty() {
                let clamp = clamp_tool_output(&tool_call.output, tool_output_limits());
                let banner = format_tool_output_truncation(&clamp);
                let output_lines: Vec<&str> = clamp.text.lines().collect();
                let max_output_lines = if expanded { 50 } else { 5 };
                let total_lines = output_lines.len();
                let truncated = total_lines > max_output_lines;

                // Render output lines with tree prefix
                for (i, line) in output_lines.iter().take(max_output_lines).enumerate() {
                    if y >= max_y {
                        break;
                    }
                    let prefix = if i == 0 && args_preview.is_empty() {
                        "  └ "
                    } else {
                        "    "
                    };
                    let output_line = Line::from(vec![
                        Span::styled(prefix, Style::default().fg(Color::DarkGray)),
                        Span::styled(
                            (*line).to_string(),
                            Style::default()
                                .fg(Color::DarkGray)
                                .add_modifier(Modifier::DIM),
                        ),
                    ]);
                    Paragraph::new(output_line).render(
                        Rect {
                            x: area.x,
                            y,
                            width: area.width,
                            height: 1,
                        },
                        buf,
                    );
                    y += 1;
                }

                // Show ellipsis if truncated
                if truncated && y < max_y {
                    let omitted = total_lines - max_output_lines;
                    let ellipsis_line = Line::from(vec![
                        Span::styled("    ", Style::default()),
                        Span::styled(
                            format!("… +{omitted} lines"),
                            Style::default()
                                .fg(Color::DarkGray)
                                .add_modifier(Modifier::DIM),
                        ),
                    ]);
                    Paragraph::new(ellipsis_line).render(
                        Rect {
                            x: area.x,
                            y,
                            width: area.width,
                            height: 1,
                        },
                        buf,
                    );
                    y += 1;
                }

                if let Some(banner) = banner {
                    if y < max_y {
                        let banner_line = Line::from(vec![
                            Span::styled("    ", Style::default()),
                            Span::styled(
                                banner,
                                Style::default()
                                    .fg(Color::DarkGray)
                                    .add_modifier(Modifier::DIM),
                            ),
                        ]);
                        Paragraph::new(banner_line).render(
                            Rect {
                                x: area.x,
                                y,
                                width: area.width,
                                height: 1,
                            },
                            buf,
                        );
                        y += 1;
                    }
                }
            }

            // Spacer
            if y < max_y {
                y += 1;
            }
        }
    }
}

/// Get a preview of tool arguments based on tool type
fn get_tool_args_preview(tool: &str, args: &serde_json::Value, max_len: usize) -> String {
    let preview = match tool.to_lowercase().as_str() {
        "bash" => args
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "read" => args
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "write" => args
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "edit" => args
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "glob" => args
            .get("pattern")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "grep" => args
            .get("pattern")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "task" => args
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "webfetch" | "websearch" => args
            .get("url")
            .or_else(|| args.get("query"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => {
            // Generic: show first string value
            args.as_object()
                .and_then(|obj| {
                    obj.values()
                        .find_map(|v| v.as_str())
                        .map(std::string::ToString::to_string)
                })
                .unwrap_or_default()
        }
    };

    if preview.len() > max_len {
        format!("{}...", &preview[..max_len.saturating_sub(3)])
    } else {
        preview
    }
}

/// A stateless widget for rendering a single tool call.
///
/// Displays tool execution details with status indicator, tool name, and optional
/// output. Supports expand/collapse for detailed view.
///
/// # Status Indicators
///
/// - `?` yellow: Pending
/// - `*` blue: Running
/// - `+` green: Completed
/// - `!` red: Failed
/// - `x` yellow: Cancelled
///
/// # Usage
///
/// ```rust,ignore
/// let widget = ToolCallWidget::new("bash", ToolCallStatus::Completed, output, true);
/// frame.render_widget(widget, area);
/// ```
pub struct ToolCallWidget<'a> {
    tool: &'a str,
    status: ToolCallStatus,
    output: &'a str,
    expanded: bool,
}

impl<'a> ToolCallWidget<'a> {
    #[must_use]
    pub fn new(tool: &'a str, status: ToolCallStatus, output: &'a str, expanded: bool) -> Self {
        Self {
            tool,
            status,
            output,
            expanded,
        }
    }
}

impl Widget for ToolCallWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let (status_icon, status_color) = match self.status {
            ToolCallStatus::Pending => ("?", Color::Yellow),
            ToolCallStatus::Running => ("*", Color::Blue),
            ToolCallStatus::Completed => ("+", Color::Green),
            ToolCallStatus::Failed => ("!", Color::Red),
            ToolCallStatus::Cancelled => ("x", Color::Yellow),
            ToolCallStatus::Blocked => ("X", Color::Magenta),
        };

        let tool_icon = get_tool_icon(self.tool);

        let header = Line::from(vec![
            Span::styled(status_icon, Style::default().fg(status_color)),
            Span::raw(" "),
            Span::styled(tool_icon, Style::default().fg(Color::Cyan)),
            Span::raw(" "),
            Span::styled(self.tool, Style::default().fg(Color::White)),
        ]);

        let header_para = Paragraph::new(header);
        header_para.render(Rect { height: 1, ..area }, buf);

        // Render output if expanded
        if self.expanded && area.height > 1 && !self.output.is_empty() {
            let output_area = Rect {
                y: area.y + 1,
                height: area.height.saturating_sub(1),
                ..area
            };

            let output = Paragraph::new(self.output)
                .wrap(Wrap { trim: false })
                .style(Style::default().fg(Color::DarkGray))
                .block(Block::default().borders(Borders::LEFT));
            output.render(output_area, buf);
        }
    }
}

/// Format elapsed seconds into compact form (like Codex TUI)
fn fmt_elapsed_compact(elapsed_secs: u64) -> String {
    if elapsed_secs < 60 {
        return format!("{elapsed_secs}s");
    }
    if elapsed_secs < 3600 {
        let minutes = elapsed_secs / 60;
        let seconds = elapsed_secs % 60;
        return format!("{minutes}m {seconds:02}s");
    }
    let hours = elapsed_secs / 3600;
    let minutes = (elapsed_secs % 3600) / 60;
    let seconds = elapsed_secs % 60;
    format!("{hours}h {minutes:02}m {seconds:02}s")
}

/// A stateless widget for rendering the chat input box.
///
/// Displays a bordered input area with:
/// - Placeholder text when empty
/// - Text wrapping for multi-line input
/// - Busy indicator with shimmer animation
/// - Elapsed time display during agent processing
/// - Optional thinking header from agent
///
/// # Cursor Position
///
/// The widget provides `cursor_pos()` to calculate where the terminal cursor should
/// be positioned. This accounts for:
/// - Text wrapping within the input area
/// - Unicode display width (not byte length)
/// - Border offset
///
/// # Usage
///
/// ```rust,ignore
/// let widget = ChatInputWidget::new(
///     &state.textarea,
///     "Type a message...",
///     ChatInputWidgetOptions {
///         busy,
///         pending_input_preview,
///     },
/// );
/// frame.render_widget(widget, area);
///
/// if let Some((x, y)) = widget.cursor_pos(area) {
///     frame.set_cursor_position((x, y));
/// }
/// ```
pub struct ChatInputWidget<'a> {
    textarea: &'a TextArea,
    placeholder: &'a str,
    busy: bool,
    pending_input_preview: Option<PendingInputPreview>,
    ghost_text: Option<String>,
    runtime_footer: Option<String>,
}

#[derive(Debug)]
pub struct ChatInputWidgetOptions {
    pub busy: bool,
    pub pending_input_preview: Option<PendingInputPreview>,
    /// Ghost-text suffix shown dimmed after the cursor (slash-command
    /// inline completion). Only pass it when the cursor is at end of input.
    pub ghost_text: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct QueueSummary {
    pub total: usize,
}

impl QueueSummary {
    pub fn new(total: usize) -> Self {
        Self { total }
    }

    pub fn is_empty(&self) -> bool {
        self.total == 0
    }
}

#[derive(Debug, Clone, Default)]
pub struct PendingInputPreview {
    pub steering: Vec<String>,
    pub follow_up: Vec<String>,
    pub steering_mode: QueueMode,
    pub follow_up_mode: QueueMode,
    pub follow_up_edit_binding_label: String,
}

const PREVIEW_LINE_LIMIT: usize = 3;
const INTERRUPT_STEERING_DESCRIPTION: &str = "Ctrl+C interrupt and apply now";
const EDIT_LAST_QUEUED_FOLLOW_UP_DESCRIPTION: &str = "edit queued follow-ups";

impl PendingInputPreview {
    #[must_use]
    pub fn from_state(state: &crate::state::AppState) -> Option<Self> {
        let preview = Self {
            steering: state.queued_steering_preview.clone(),
            follow_up: state.queued_follow_up_preview.clone(),
            steering_mode: state.steering_mode,
            follow_up_mode: state.follow_up_mode,
            follow_up_edit_binding_label: state.queued_follow_up_edit_binding_label.clone(),
        };
        (!preview.is_empty()).then_some(preview)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.steering.is_empty() && self.follow_up.is_empty()
    }

    #[must_use]
    pub fn desired_height(&self, width: u16) -> u16 {
        self.build_lines(width).len() as u16
    }

    fn build_lines(&self, width: u16) -> Vec<Line<'static>> {
        if self.is_empty() || width < 4 {
            return Vec::new();
        }

        let dim_style = Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::DIM);
        let mut lines = Vec::new();

        if !self.steering.is_empty() {
            Self::push_section(
                &mut lines,
                width,
                &Self::section_title(
                    "Queued steering after next tool boundary",
                    self.steering.len(),
                    self.steering_mode,
                ),
                &self.steering,
                false,
            );
            lines.extend(word_wrap_lines(
                &[Line::from(Span::styled(
                    format!("  {INTERRUPT_STEERING_DESCRIPTION}"),
                    dim_style,
                ))],
                RtOptions::new(width as usize)
                    .subsequent_indent(Line::from(Span::styled("    ", dim_style))),
            ));
        }

        if !self.follow_up.is_empty() {
            if !lines.is_empty() {
                lines.push(Line::default());
            }
            Self::push_section(
                &mut lines,
                width,
                &Self::section_title(
                    "Queued follow-ups after turn end",
                    self.follow_up.len(),
                    self.follow_up_mode,
                ),
                &self.follow_up,
                true,
            );
            lines.extend(word_wrap_lines(
                &[Line::from(Span::styled(
                    format!(
                        "  {} {EDIT_LAST_QUEUED_FOLLOW_UP_DESCRIPTION}",
                        self.follow_up_edit_binding_label
                    ),
                    dim_style,
                ))],
                RtOptions::new(width as usize)
                    .subsequent_indent(Line::from(Span::styled("    ", dim_style))),
            ));
        }

        lines
    }

    fn section_title(base: &str, count: usize, mode: QueueMode) -> String {
        if count <= 1 {
            return base.to_string();
        }
        let note = match mode {
            QueueMode::All => format!("next batch: all {count}"),
            QueueMode::One => format!("next batch: 1 of {count}"),
        };
        format!("{base} ({note})")
    }

    fn push_section(
        lines: &mut Vec<Line<'static>>,
        width: u16,
        title: &str,
        entries: &[String],
        italic: bool,
    ) {
        let dim_style = Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::DIM);
        let header = Line::from(vec![
            Span::styled("• ", dim_style),
            Span::styled(title.to_string(), dim_style),
        ]);
        lines.extend(word_wrap_lines(
            &[header],
            RtOptions::new(width as usize)
                .subsequent_indent(Line::from(Span::styled("  ", dim_style))),
        ));

        for entry in entries {
            let entry_style = if italic {
                dim_style.add_modifier(Modifier::ITALIC)
            } else {
                dim_style
            };
            let source_lines: Vec<Line<'static>> = entry
                .lines()
                .map(|line| Line::from(Span::styled(line.to_string(), entry_style)))
                .collect();
            let wrapped = word_wrap_lines(
                &source_lines,
                RtOptions::new(width as usize)
                    .initial_indent(Line::from(Span::styled("  ↳ ", dim_style)))
                    .subsequent_indent(Line::from(Span::styled("    ", dim_style))),
            );
            let wrapped_len = wrapped.len();
            lines.extend(wrapped.into_iter().take(PREVIEW_LINE_LIMIT));
            if wrapped_len > PREVIEW_LINE_LIMIT {
                lines.push(Line::from(Span::styled("    …", entry_style)));
            }
        }
    }

    fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let lines = self.build_lines(area.width);
        if lines.is_empty() {
            return;
        }
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .render(area, buf);
    }
}

impl<'a> ChatInputWidget<'a> {
    pub fn new(
        textarea: &'a TextArea,
        placeholder: &'a str,
        options: ChatInputWidgetOptions,
    ) -> Self {
        Self {
            textarea,
            placeholder,
            busy: options.busy,
            pending_input_preview: options.pending_input_preview,
            ghost_text: options.ghost_text,
            runtime_footer: None,
        }
    }

    /// Attach Grok-style runtime context to the lower-right input border.
    #[must_use]
    pub fn with_runtime_footer(
        mut self,
        model: Option<&str>,
        thinking_level: ThinkingLevel,
        interaction_mode: InteractionMode,
    ) -> Self {
        let mut context = model.unwrap_or("Maestro").to_string();
        if thinking_level != ThinkingLevel::Off {
            context.push_str(&format!(
                " ({})",
                thinking_level.label().to_ascii_lowercase()
            ));
        }
        context.push_str(" · ");
        context.push_str(interaction_mode.label());
        self.runtime_footer = Some(context);
        self
    }

    /// Calculate the on-screen cursor position within the input area.
    ///
    /// Returns `(x, y)` coordinates where the terminal cursor should be placed,
    /// accounting for:
    /// - Border offset (1 cell on each side)
    /// - Text wrapping
    /// - Unicode display width
    ///
    /// Returns `None` if:
    /// - Area is too small to render
    /// - Cursor is outside visible area (scrolled out of view)
    #[must_use]
    pub fn cursor_pos(&self, input_area: Rect) -> Option<(u16, u16)> {
        if input_area.width < 3 || input_area.height < 3 {
            return None;
        }

        let inner = Rect {
            x: input_area.x + 1,
            y: input_area.y + 1,
            width: input_area.width.saturating_sub(2),
            height: input_area.height.saturating_sub(2),
        };
        let preview_height = self
            .pending_input_preview
            .as_ref()
            .map_or(0, |preview| preview.desired_height(inner.width));
        let textarea_area = Rect {
            x: inner.x,
            y: inner.y.saturating_add(preview_height),
            width: inner.width,
            height: inner.height.saturating_sub(preview_height),
        };
        if textarea_area.height == 0 {
            return None;
        }

        self.textarea.cursor_pos(textarea_area)
    }
}

impl Widget for ChatInputWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        // Border style based on busy state
        let border_style = if self.busy {
            Style::default().fg(Color::DarkGray)
        } else {
            Style::default().fg(Color::Cyan)
        };

        let mut block = Block::default()
            .borders(Borders::ALL)
            .border_style(border_style)
            .title(Line::from(" > "));
        if let Some(runtime_footer) = self.runtime_footer {
            block = block.title_bottom(
                Line::from(format!(" {runtime_footer} "))
                    .style(Style::default().fg(Color::DarkGray))
                    .alignment(Alignment::Right),
            );
        }

        let inner = block.inner(area);
        block.render(area, buf);

        let preview_height = self
            .pending_input_preview
            .as_ref()
            .map_or(0, |preview| preview.desired_height(inner.width));
        if let Some(preview) = &self.pending_input_preview {
            let preview_area = Rect {
                x: inner.x,
                y: inner.y,
                width: inner.width,
                height: preview_height.min(inner.height),
            };
            preview.render(preview_area, buf);
        }

        let textarea_area = Rect {
            x: inner.x,
            y: inner.y.saturating_add(preview_height),
            width: inner.width,
            height: inner.height.saturating_sub(preview_height),
        };
        if textarea_area.height == 0 {
            return;
        }

        let text_style = Style::default();
        let placeholder_style = Style::default().fg(Color::DarkGray);

        let textarea_widget = TextAreaWidget::new(self.textarea)
            .style(text_style)
            .placeholder(self.placeholder, placeholder_style);

        textarea_widget.render(textarea_area, buf);

        // Render ghost-text completion dimmed right after the cursor.
        // The caller only passes `ghost_text` when the cursor is at end of
        // input, so the cursor position is exactly where the suffix belongs.
        if let Some(ghost) = &self.ghost_text {
            if let Some((cursor_x, cursor_y)) = self.textarea.cursor_pos(textarea_area) {
                let remaining = usize::from(textarea_area.right().saturating_sub(cursor_x));
                if remaining > 0 {
                    let ghost_style = Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::DIM);
                    buf.set_stringn(cursor_x, cursor_y, ghost, remaining, ghost_style);
                }
            }
        }
    }
}

const MIN_TOTAL_INPUT_HEIGHT: u16 = 3;
const MAX_VISIBLE_INPUT_LINES: u16 = 6;
const MIN_MESSAGES_HEIGHT: u16 = 3;

/// Calculate dynamic chat input height based on wrapped lines.
///
/// The height includes borders. It grows with content up to a cap, and
/// always leaves at least a small message viewport.
pub(crate) fn calculate_input_height(state: &crate::state::AppState, area: Rect) -> u16 {
    let status_height = u16::from(!state.zen_mode);

    // If space is tight, fall back to minimum.
    let available_after_status = area.height.saturating_sub(status_height);
    if available_after_status <= MIN_TOTAL_INPUT_HEIGHT {
        return available_after_status.max(1);
    }

    let inner_width = area.width.saturating_sub(2).max(1);
    let preview_height = PendingInputPreview::from_state(state)
        .map_or(0, |preview| preview.desired_height(inner_width));
    let desired_inner_lines = state
        .textarea
        .desired_height(inner_width)
        .max(1)
        .saturating_add(preview_height);

    let max_total_for_input = available_after_status
        .saturating_sub(MIN_MESSAGES_HEIGHT)
        .max(MIN_TOTAL_INPUT_HEIGHT);
    let max_inner_for_input = max_total_for_input.saturating_sub(2).max(1);

    let visible_inner = desired_inner_lines
        .min(MAX_VISIBLE_INPUT_LINES)
        .min(max_inner_for_input)
        .max(1);

    visible_inner
        .saturating_add(2)
        .max(MIN_TOTAL_INPUT_HEIGHT)
        .min(available_after_status)
}

/// Token usage summary for display
#[derive(Default, Clone, Copy)]
pub struct UsageSummary {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl UsageSummary {
    /// Format tokens for display (e.g., "1.2k" for 1200)
    fn format_tokens(count: u64) -> String {
        if count >= 1000 {
            format!("{:.1}k", count as f64 / 1000.0)
        } else {
            count.to_string()
        }
    }
}

/// Grok-inspired one-line status for the active turn.
///
/// Keeps transient execution state out of the composer border so activity,
/// elapsed time, queue pressure, token usage, and controls scan as one row.
pub struct TurnStatusWidget<'a> {
    activity: Option<&'a str>,
    elapsed_secs: u64,
    queue: QueueSummary,
    tokens: Option<u64>,
    can_queue_follow_up: bool,
}

impl<'a> TurnStatusWidget<'a> {
    #[must_use]
    pub fn new(
        activity: Option<&'a str>,
        elapsed_secs: u64,
        queue: QueueSummary,
        tokens: Option<u64>,
        can_queue_follow_up: bool,
    ) -> Self {
        Self {
            activity,
            elapsed_secs,
            queue,
            tokens,
            can_queue_follow_up,
        }
    }
}

impl Widget for TurnStatusWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }

        let activity = self.activity.unwrap_or("Working");
        let activity = if activity.chars().count() > 30 {
            format!("{}…", activity.chars().take(29).collect::<String>())
        } else {
            activity.to_owned()
        };
        let dim = Style::default().fg(Color::DarkGray);
        let mut spans = vec![Span::styled("◐ ", Style::default().fg(Color::Cyan))];
        spans.extend(shimmer_spans(&activity));
        spans.push(Span::styled(
            format!("  ·  {}", fmt_elapsed_compact(self.elapsed_secs)),
            dim,
        ));

        if area.width >= 48 && !self.queue.is_empty() {
            spans.push(Span::styled(
                format!("  ·  {} queued", self.queue.total),
                Style::default().fg(Color::Yellow),
            ));
        }
        if area.width >= 64 {
            if let Some(tokens) = self.tokens.filter(|tokens| *tokens > 0) {
                spans.push(Span::styled(
                    format!("  ·  {} tok", UsageSummary::format_tokens(tokens)),
                    dim,
                ));
            }
        }
        if area.width >= 84 && self.can_queue_follow_up {
            spans.push(Span::styled("  ·  Tab queue", dim));
        }
        spans.push(Span::styled("  ·  Esc interrupt", dim));

        Paragraph::new(Line::from(spans)).render(area, buf);
    }
}

/// Grok-inspired one-line session header.
///
/// Keeps location on the left and context pressure on the right so the
/// conversation itself can remain visually quiet.
pub struct SessionHeaderWidget<'a> {
    cwd: Option<&'a str>,
    git_branch: Option<&'a str>,
    context_used: Option<u64>,
    context_window: Option<u64>,
}

impl<'a> SessionHeaderWidget<'a> {
    #[must_use]
    pub fn new(cwd: Option<&'a str>, git_branch: Option<&'a str>) -> Self {
        Self {
            cwd,
            git_branch,
            context_used: None,
            context_window: None,
        }
    }

    #[must_use]
    pub fn with_context(mut self, used: Option<u64>, window: Option<u64>) -> Self {
        self.context_used = used;
        self.context_window = window.filter(|value| *value > 0);
        self
    }
}

impl Widget for SessionHeaderWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        buf.set_style(area, Style::default().bg(Color::Black));
        let location = format_session_location(self.cwd, self.git_branch);
        let context = format_context_usage(self.context_used, self.context_window);
        let context_width = context.as_ref().map_or(0, |text| text.width() as u16);
        let location_width = area
            .width
            .saturating_sub(context_width)
            .saturating_sub(u16::from(context_width > 0));
        let location = truncate_location(&location, location_width as usize);
        if !location.is_empty() {
            buf.set_string(
                area.x,
                area.y,
                location,
                Style::default().fg(Color::DarkGray).bg(Color::Black),
            );
        }

        if let Some(context) = context {
            let color = match (self.context_used, self.context_window) {
                (Some(used), Some(window))
                    if used.saturating_mul(100) >= window.saturating_mul(90) =>
                {
                    Color::Red
                }
                (Some(used), Some(window))
                    if used.saturating_mul(100) >= window.saturating_mul(75) =>
                {
                    Color::Yellow
                }
                _ => Color::Gray,
            };
            let x = area.right().saturating_sub(context_width);
            buf.set_string(
                x,
                area.y,
                context,
                Style::default().fg(color).bg(Color::Black),
            );
        }
    }
}

fn format_session_location(cwd: Option<&str>, git_branch: Option<&str>) -> String {
    let Some(cwd) = cwd else {
        return String::new();
    };
    let path = std::path::Path::new(cwd);
    let compact = dirs::home_dir()
        .and_then(|home| path.strip_prefix(home).ok())
        .map_or_else(
            || cwd.to_string(),
            |relative| {
                if relative.as_os_str().is_empty() {
                    "~".to_string()
                } else {
                    format!("~/{}", relative.display())
                }
            },
        );
    match git_branch {
        Some(branch) if !branch.is_empty() => format!("{compact}  ·  {branch}"),
        _ => compact,
    }
}

fn format_context_usage(used: Option<u64>, window: Option<u64>) -> Option<String> {
    match (used, window) {
        (Some(used), Some(window)) => Some(format!(
            "{} / {}",
            format_context_tokens(used),
            format_context_tokens(window)
        )),
        (Some(used), None) if used > 0 => Some(format!("{} context", format_context_tokens(used))),
        _ => None,
    }
}

fn format_context_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        let value = tokens as f64 / 1_000_000.0;
        if value < 10.0 {
            format!("{value:.1}M")
        } else {
            format!("{}M", tokens / 1_000_000)
        }
    } else if tokens >= 10_000 {
        format!("{}K", tokens / 1_000)
    } else if tokens >= 1_000 {
        format!("{:.1}K", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}

fn truncate_location(value: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    if value.width() <= max_width {
        return value.to_string();
    }
    if max_width == 1 {
        return "…".to_string();
    }
    let tail: String = value.chars().rev().take(max_width - 1).collect();
    format!("…{}", tail.chars().rev().collect::<String>())
}

/// A stateless widget for rendering the bottom status bar.
///
/// Displays:
/// - Left side: Model name, provider, working directory, git branch
/// - Right side: Token usage (input/output), terminal size
///
/// Hidden in zen mode.
///
/// # Usage
///
/// ```rust,ignore
/// let widget = StatusBarWidget::new(
///     Some("claude-opus-4"),
///     Some("anthropic"),
///     Some("/path/to/project"),
///     Some("main"),
/// ).with_usage(usage_summary);
/// frame.render_widget(widget, area);
/// ```
pub struct StatusBarWidget<'a> {
    model: Option<&'a str>,
    provider: Option<&'a str>,
    cwd: Option<&'a str>,
    git_branch: Option<&'a str>,
    usage: UsageSummary,
    /// Number of active hooks (None = hooks disabled)
    hook_count: Option<usize>,
    queue_badge: Option<&'a str>,
    approval_mode: Option<ApprovalMode>,
    thinking_level: Option<ThinkingLevel>,
    mcp_connected: usize,
    mcp_tool_count: usize,
    mcp_failed: usize,
    alert_count: usize,
    sandbox_policy: Option<&'a str>,
    workspace_trusted: bool,
    pending_approvals: usize,
    shortcut_hints: bool,
    paste_note: Option<&'a str>,
}

impl<'a> StatusBarWidget<'a> {
    #[must_use]
    pub fn new(
        model: Option<&'a str>,
        provider: Option<&'a str>,
        cwd: Option<&'a str>,
        git_branch: Option<&'a str>,
    ) -> Self {
        Self {
            model,
            provider,
            cwd,
            git_branch,
            usage: UsageSummary::default(),
            hook_count: None,
            queue_badge: None,
            approval_mode: None,
            thinking_level: None,
            mcp_connected: 0,
            mcp_tool_count: 0,
            mcp_failed: 0,
            alert_count: 0,
            sandbox_policy: None,
            workspace_trusted: false,
            pending_approvals: 0,
            shortcut_hints: false,
            paste_note: None,
        }
    }

    #[must_use]
    pub fn with_usage(mut self, usage: UsageSummary) -> Self {
        self.usage = usage;
        self
    }

    /// Set hook count (None = hooks disabled, Some(0) = enabled but none loaded)
    #[must_use]
    pub fn with_hooks(mut self, count: Option<usize>) -> Self {
        self.hook_count = count;
        self
    }

    #[must_use]
    pub fn with_queue_badge(mut self, badge: Option<&'a str>) -> Self {
        self.queue_badge = badge;
        self
    }

    #[must_use]
    pub fn with_approval_mode(mut self, approval_mode: ApprovalMode) -> Self {
        self.approval_mode = Some(approval_mode);
        self
    }

    #[must_use]
    pub fn with_thinking_level(mut self, thinking_level: ThinkingLevel) -> Self {
        self.thinking_level = Some(thinking_level);
        self
    }

    #[must_use]
    pub fn with_mcp_status(mut self, connected: usize, tool_count: usize, failed: usize) -> Self {
        self.mcp_connected = connected;
        self.mcp_tool_count = tool_count;
        self.mcp_failed = failed;
        self
    }

    #[must_use]
    pub fn with_alert_count(mut self, alert_count: usize) -> Self {
        self.alert_count = alert_count;
        self
    }

    #[must_use]
    pub fn with_sandbox_policy(mut self, sandbox_policy: Option<&'a str>) -> Self {
        self.sandbox_policy = sandbox_policy;
        self
    }

    #[must_use]
    pub fn with_workspace_trusted(mut self, workspace_trusted: bool) -> Self {
        self.workspace_trusted = workspace_trusted;
        self
    }

    #[must_use]
    pub fn with_pending_approvals(mut self, pending_approvals: usize) -> Self {
        self.pending_approvals = pending_approvals;
        self
    }

    #[must_use]
    pub fn with_shortcut_hints(mut self) -> Self {
        self.shortcut_hints = true;
        self
    }

    /// Note about folded pasted content, e.g. "pasted 42 lines (folded)".
    #[must_use]
    pub fn with_paste_note(mut self, note: Option<&'a str>) -> Self {
        self.paste_note = note;
        self
    }
}

impl Widget for StatusBarWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let mut spans = Vec::new();

        if self.shortcut_hints {
            let hints = if area.width >= 72 {
                "Shift+Tab:mode  │  Ctrl+C:cancel  │  F1:shortcuts"
            } else {
                "Shift+Tab:mode  │  F1:help"
            };
            spans.push(Span::styled(hints, Style::default().fg(Color::DarkGray)));
        }

        // Model info
        if let Some(model) = self.model {
            if !spans.is_empty() {
                spans.push(Span::raw(" | "));
            }
            spans.push(Span::styled(model, Style::default().fg(Color::Cyan)));
            if let Some(provider) = self.provider {
                spans.push(Span::raw(" via "));
                spans.push(Span::styled(provider, Style::default().fg(Color::DarkGray)));
            }
        }

        // Separator
        if !spans.is_empty() && self.cwd.is_some() {
            spans.push(Span::raw(" | "));
        }

        // Working directory
        if let Some(cwd) = self.cwd {
            // Show just the last component
            let short_cwd = cwd.rsplit('/').next().unwrap_or(cwd);
            spans.push(Span::styled(short_cwd, Style::default().fg(Color::Blue)));

            // Git branch
            if let Some(branch) = self.git_branch {
                spans.push(Span::raw(" ("));
                spans.push(Span::styled(branch, Style::default().fg(Color::Green)));
                spans.push(Span::raw(")"));
            }
        }

        // Hook status
        if let Some(count) = self.hook_count {
            if !spans.is_empty() {
                spans.push(Span::raw(" | "));
            }
            if count > 0 {
                spans.push(Span::styled(
                    format!("hooks:{count}"),
                    Style::default().fg(Color::Magenta),
                ));
            } else {
                spans.push(Span::styled(
                    "hooks:0",
                    Style::default().fg(Color::DarkGray),
                ));
            }
        }

        // Folded-paste note
        if let Some(note) = self.paste_note {
            if !spans.is_empty() {
                spans.push(Span::raw(" | "));
            }
            spans.push(Span::styled(
                note.to_string(),
                Style::default().fg(Color::DarkGray),
            ));
        }

        let line = Line::from(spans);
        let left_width = line.width() as u16;
        let para = Paragraph::new(line).style(Style::default().fg(Color::DarkGray));
        para.render(area, buf);

        // Build right-side info (usage + terminal size)
        let mut usage_text: Option<String> = None;

        // Token usage
        let total_tokens = self.usage.input_tokens + self.usage.output_tokens;
        if total_tokens > 0 {
            usage_text = Some(format!(
                "↑{} ↓{}",
                UsageSummary::format_tokens(self.usage.input_tokens),
                UsageSummary::format_tokens(self.usage.output_tokens)
            ));
        }

        let badges = self.approval_mode.map(|mode| {
            build_runtime_badges(RuntimeBadgeParams {
                approval_mode: mode,
                thinking_level: self.thinking_level.unwrap_or(ThinkingLevel::Off),
                mcp_connected: self.mcp_connected,
                mcp_tool_count: self.mcp_tool_count,
                mcp_failed: self.mcp_failed,
                alert_count: self.alert_count,
                sandbox_policy: self.sandbox_policy.map(str::to_owned),
                workspace_trusted: self.workspace_trusted,
                pending_approvals: self.pending_approvals,
            })
        });
        let core_badges = badges
            .as_ref()
            .and_then(|b| (!b.core.is_empty()).then(|| b.core.join(" ")));
        let env_badges = badges
            .as_ref()
            .and_then(|b| (!b.env.is_empty()).then(|| b.env.join(" ")));

        let queue_text = self.queue_badge.map(|badge| badge.to_string());

        let term_text = crate::terminal::size()
            .ok()
            .map(|(cols, rows)| format!("{cols}x{rows}"));

        let available_width = area.width.saturating_sub(left_width + 1);

        let mut include_core = core_badges.is_some();
        let mut include_env = env_badges.is_some();

        let mut right_text = build_right_text(
            usage_text.as_deref(),
            core_badges.as_deref(),
            env_badges.as_deref(),
            queue_text.as_deref(),
            term_text.as_deref(),
            include_core,
            include_env,
        );

        if !right_text.is_empty()
            && UnicodeWidthStr::width(right_text.as_str()) > available_width as usize
        {
            include_env = false;
            right_text = build_right_text(
                usage_text.as_deref(),
                core_badges.as_deref(),
                env_badges.as_deref(),
                queue_text.as_deref(),
                term_text.as_deref(),
                include_core,
                include_env,
            );
        }

        if !right_text.is_empty()
            && UnicodeWidthStr::width(right_text.as_str()) > available_width as usize
        {
            include_core = false;
            right_text = build_right_text(
                usage_text.as_deref(),
                core_badges.as_deref(),
                env_badges.as_deref(),
                queue_text.as_deref(),
                term_text.as_deref(),
                include_core,
                include_env,
            );
        }

        // Render right-side info
        if !right_text.is_empty() {
            let right_line = Line::from(Span::styled(
                right_text,
                Style::default().fg(Color::DarkGray),
            ));
            let right_width = right_line.width() as u16;
            let right_x = area.right().saturating_sub(right_width);
            buf.set_line(right_x, area.y, &right_line, right_width);
        }
    }
}

fn build_right_text(
    usage_text: Option<&str>,
    core_badges: Option<&str>,
    env_badges: Option<&str>,
    queue_text: Option<&str>,
    term_text: Option<&str>,
    include_core: bool,
    include_env: bool,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(usage) = usage_text {
        parts.push(usage.to_string());
    }
    if include_core {
        if let Some(core) = core_badges {
            if !core.is_empty() {
                parts.push(core.to_string());
            }
        }
    }
    if include_env {
        if let Some(env) = env_badges {
            if !env.is_empty() {
                parts.push(env.to_string());
            }
        }
    }
    if let Some(queue) = queue_text {
        parts.push(queue.to_string());
    }
    if let Some(term) = term_text {
        parts.push(term.to_string());
    }

    parts.join(" ")
}

/// The main chat view widget containing messages, input, and status bar.
///
/// This is the top-level widget for the chat interface. It implements a virtual
/// scrolling system to efficiently render large message histories.
///
/// # Layout
///
/// ```text
/// ┌─────────────────────────┐
/// │  Messages (scrollable)  │
/// │                         │
/// │  • Maestro              │
/// │  I can help with that   │
/// │                         │
/// │  › You                  │
/// │  Please do              │
/// │                         │
/// ├─────────────────────────┤
/// │ > Type message_         │ <- Input box (auto-growing)
/// ├─────────────────────────┤
/// │ opus-4 | project (main) │ <- Status bar (1 row, hidden in zen mode)
/// └─────────────────────────┘
/// ```
///
/// # Virtual Scrolling
///
/// The message list uses virtual scrolling:
/// 1. Pre-calculate heights for all messages
/// 2. Determine which messages are visible based on scroll offset
/// 3. Render only visible messages
/// 4. Draw scrollbar if content exceeds viewport
///
/// This allows smooth scrolling through thousands of messages.
///
/// # Usage
///
/// ```rust,ignore
/// let view = ChatView::new(&app_state);
/// frame.render_widget(view, frame.area());
/// ```
pub struct ChatView<'a> {
    state: &'a crate::state::AppState,
    sandbox_policy: Option<&'a str>,
    workspace_trusted: bool,
    pending_approvals: usize,
}

impl<'a> ChatView<'a> {
    pub fn new(state: &'a crate::state::AppState) -> Self {
        Self {
            state,
            sandbox_policy: None,
            workspace_trusted: false,
            pending_approvals: 0,
        }
    }

    #[must_use]
    pub fn with_runtime_status(
        mut self,
        sandbox_policy: Option<&'a str>,
        workspace_trusted: bool,
        pending_approvals: usize,
    ) -> Self {
        self.sandbox_policy = sandbox_policy;
        self.workspace_trusted = workspace_trusted;
        self.pending_approvals = pending_approvals;
        self
    }
}

impl Widget for ChatView<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height < 5 || area.width < 10 {
            return;
        }

        let status_height = u16::from(!self.state.zen_mode);
        let header_height = u16::from(!self.state.zen_mode);
        let turn_status_height = u16::from(self.state.busy);
        let input_height = calculate_input_height(self.state, area);
        let chunks = Layout::vertical([
            Constraint::Length(header_height), // Session location + context
            Constraint::Min(0),                // Messages
            Constraint::Length(turn_status_height), // Active turn status
            Constraint::Length(input_height),  // Input (auto-grow)
            Constraint::Length(status_height), // Status (hidden in zen mode)
        ])
        .split(area);

        let context_used = self
            .state
            .messages
            .iter()
            .rev()
            .find_map(|message| message.usage.as_ref())
            .map(|usage| {
                usage
                    .input_tokens
                    .saturating_add(usage.output_tokens)
                    .saturating_add(usage.cache_read_tokens)
            });

        if !self.state.zen_mode {
            SessionHeaderWidget::new(self.state.cwd.as_deref(), self.state.git_branch.as_deref())
                .with_context(context_used, self.state.context_window)
                .render(chunks[0], buf);
        }

        // Render messages
        self.render_messages(chunks[1], buf);

        if self.state.busy {
            TurnStatusWidget::new(
                self.state.thinking_header.as_deref(),
                self.state.elapsed_busy_secs(),
                QueueSummary::new(self.state.queued_prompt_count),
                context_used,
                self.state.can_queue_follow_up_shortcut(),
            )
            .render(chunks[2], buf);
        }

        // Render input
        let input_widget = ChatInputWidget::new(
            &self.state.textarea,
            "Type a message...",
            ChatInputWidgetOptions {
                busy: self.state.busy,
                pending_input_preview: PendingInputPreview::from_state(self.state),
                ghost_text: if self.state.cursor() == self.state.input().len() {
                    self.state.ghost_completion.clone()
                } else {
                    None
                },
            },
        )
        .with_runtime_footer(
            self.state.model.as_deref(),
            self.state.thinking_level,
            self.state.interaction_mode,
        );
        input_widget.render(chunks[3], buf);

        // Render status bar (unless zen mode)
        if !self.state.zen_mode {
            let queue_badge = {
                let label = format!(
                    "queue:f={} s={}",
                    self.state.follow_up_mode.short_label(),
                    self.state.steering_mode.short_label()
                );
                if self.state.queued_prompt_count > 0 {
                    Some(format!("{label}({})", self.state.queued_prompt_count))
                } else {
                    Some(label)
                }
            };

            let alert_count = self.state.unseen_alerts;

            let paste_note = self
                .state
                .textarea
                .folded_paste_lines()
                .map(|lines| format!("pasted {lines} lines (folded)"));

            let status_widget = StatusBarWidget::new(None, None, None, None)
                .with_queue_badge(queue_badge.as_deref())
                .with_approval_mode(self.state.approval_mode)
                .with_thinking_level(self.state.thinking_level)
                .with_mcp_status(
                    self.state.mcp_connected,
                    self.state.mcp_tool_count,
                    self.state.mcp_failed,
                )
                .with_alert_count(alert_count)
                .with_sandbox_policy(self.sandbox_policy)
                .with_workspace_trusted(self.workspace_trusted)
                .with_pending_approvals(self.pending_approvals)
                .with_paste_note(paste_note.as_deref())
                .with_shortcut_hints();
            status_widget.render(chunks[4], buf);
        }
    }
}

impl ChatView<'_> {
    fn message_layout_key(message: &Message) -> MessageLayoutKey {
        let mut hasher = DefaultHasher::new();
        message.id.hash(&mut hasher);
        std::mem::discriminant(&message.role).hash(&mut hasher);
        std::mem::discriminant(&message.kind).hash(&mut hasher);
        message.content.len().hash(&mut hasher);
        message.thinking.len().hash(&mut hasher);
        message.streaming.hash(&mut hasher);
        message.thinking_expanded.hash(&mut hasher);
        message.tool_calls.len().hash(&mut hasher);
        for tool_call in &message.tool_calls {
            tool_call.call_id.hash(&mut hasher);
            tool_call.tool.hash(&mut hasher);
            tool_call.output.len().hash(&mut hasher);
        }
        MessageLayoutKey::new(hasher.finish())
    }

    fn message_layout_settings_key(&self) -> u64 {
        let mut key = u64::from(self.state.compact_tool_outputs);
        for call_id in &self.state.expanded_tool_calls {
            let mut hasher = DefaultHasher::new();
            call_id.hash(&mut hasher);
            key ^= hasher.finish().rotate_left(1);
        }
        key ^ (self.state.expanded_tool_calls.len() as u64).rotate_left(32)
    }

    fn render_messages(&self, area: Rect, buf: &mut Buffer) {
        // Filter to only renderable messages
        let renderable_messages: Vec<&Message> = self
            .state
            .messages
            .iter()
            .filter(|m| should_render_message(m))
            .collect();

        if area.height == 0 || renderable_messages.is_empty() {
            let welcome = Paragraph::new("Maestro\nType a message or /help.")
                .style(Style::default().fg(Color::DarkGray))
                .wrap(Wrap { trim: false });
            welcome.render(area, buf);
            return;
        }

        let layout_keys = renderable_messages
            .iter()
            .map(|message| Self::message_layout_key(message))
            .collect::<Vec<_>>();
        let layout = self.state.prepare_message_layout(
            area.width,
            self.message_layout_settings_key(),
            &layout_keys,
            |index| {
                usize::from(calculate_message_height(
                    renderable_messages[index],
                    area.width,
                    &self.state.expanded_tool_calls,
                    self.state.compact_tool_outputs,
                ))
            },
        );
        let total_height = layout.total_height();

        // Clamp scroll_offset to available content
        let max_offset = total_height.saturating_sub(usize::from(area.height));
        let clamped_offset = self.state.scroll_offset.min(max_offset);

        // Window anchored from bottom by scroll_offset
        let window_bottom = total_height.saturating_sub(clamped_offset);
        let window_top = window_bottom.saturating_sub(usize::from(area.height));

        // Find the first message whose bottom exceeds window_top
        let start_idx = layout.first_visible(window_top);

        // Render messages from start_idx forward
        let mut y = area.y;
        let max_y = area.y + area.height;

        for (i, message) in renderable_messages.iter().enumerate().skip(start_idx) {
            if y >= max_y {
                break;
            }

            let msg_height = layout.heights()[i].min(usize::from(max_y.saturating_sub(y))) as u16;

            let msg_area = Rect {
                x: area.x,
                y,
                width: area.width,
                height: msg_height,
            };

            let widget = MessageWidget::new(message)
                .with_expanded_tools(&self.state.expanded_tool_calls)
                .with_compact_tool_outputs(self.state.compact_tool_outputs);
            widget.render(msg_area, buf);

            y += msg_height;
        }

        // Draw a simple scrollbar on the right
        if total_height > usize::from(area.height) {
            let bar_x = area.x + area.width.saturating_sub(1);
            let view_ratio = f32::from(area.height) / total_height as f32;
            let thumb_height =
                (f32::from(area.height) * view_ratio).clamp(1.0, f32::from(area.height));
            let scroll_ratio = window_top as f32 / total_height as f32;
            let thumb_start =
                (scroll_ratio * (f32::from(area.height) - thumb_height)).round() as u16;
            for i in 0..area.height {
                let ch = if i >= thumb_start && i < thumb_start + thumb_height as u16 {
                    '█'
                } else {
                    '░'
                };
                if let Some(cell) = buf.cell_mut((bar_x, area.y + i)) {
                    cell.set_symbol(ch.to_string().as_str());
                    cell.set_style(Style::default().fg(Color::DarkGray));
                }
            }

            // Scroll percentage indicator
            let percent = if total_height == 0 {
                0
            } else {
                ((window_bottom as f32 / total_height as f32) * 100.0).round() as i32
            };
            let pct_str = format!("{:>3}%", percent.clamp(0, 100));
            let pct_x = bar_x.saturating_sub(pct_str.len() as u16);
            if pct_x >= area.x {
                buf.set_string(pct_x, area.y, pct_str, Style::default().fg(Color::DarkGray));
            }
        }

        // Jump-to-latest indicator
        if self.state.scroll_offset > 0 {
            let hint = "Jump to latest (G)";
            let hx = area
                .x
                .saturating_add(area.width.saturating_sub(hint.len() as u16 + 2));
            buf.set_string(
                hx,
                area.y,
                hint,
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::ITALIC),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buffer_lines(buf: &Buffer, width: u16, height: u16) -> Vec<String> {
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buf.cell((x, y)).unwrap().symbol())
                    .collect::<String>()
            })
            .collect()
    }

    #[test]
    fn pending_input_preview_is_empty_without_items() {
        let preview = PendingInputPreview::default();
        assert_eq!(preview.desired_height(48), 0);
    }

    #[test]
    fn pending_input_preview_renders_sections() {
        let preview = PendingInputPreview {
            steering: vec!["steer first".to_string()],
            follow_up: vec!["follow later".to_string()],
            steering_mode: QueueMode::All,
            follow_up_mode: QueueMode::All,
            follow_up_edit_binding_label: "Shift+Left".to_string(),
        };
        let width = 96;
        let height = preview.desired_height(width);
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));

        preview.render(Rect::new(0, 0, width, height), &mut buf);

        let rendered = buffer_lines(&buf, width, height).join("\n");
        assert!(rendered.contains("Queued steering after next"));
        assert!(rendered.contains("Queued follow-ups after turn end"));
        assert!(rendered.contains("steer first"));
        assert!(rendered.contains("Ctrl+C interrupt and apply now"));
        assert!(rendered.contains("follow later"));
        assert!(rendered.contains("Shift+Left edit queued follow-ups"));
    }

    #[test]
    fn pending_input_preview_describes_next_batch_for_multiple_items() {
        let preview = PendingInputPreview {
            steering: vec!["steer first".to_string(), "steer second".to_string()],
            follow_up: vec![
                "follow first".to_string(),
                "follow second".to_string(),
                "follow third".to_string(),
            ],
            steering_mode: QueueMode::One,
            follow_up_mode: QueueMode::All,
            follow_up_edit_binding_label: "Alt+Up".to_string(),
        };
        let width = 128;
        let height = preview.desired_height(width);
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));

        preview.render(Rect::new(0, 0, width, height), &mut buf);

        let rendered = buffer_lines(&buf, width, height).join("\n");
        assert!(rendered.contains("Queued steering after next tool boundary (next batch: 1 of 2)"));
        assert!(rendered.contains("Queued follow-ups after turn end (next batch: all 3)"));
    }

    #[test]
    fn turn_status_shows_active_turn_details_at_wide_widths() {
        let widget = TurnStatusWidget::new(
            Some("Indexing workspace"),
            12,
            QueueSummary::new(2),
            Some(1_200),
            true,
        );
        let width = 120;
        let mut buf = Buffer::empty(Rect::new(0, 0, width, 1));

        widget.render(Rect::new(0, 0, width, 1), &mut buf);

        let rendered = buffer_lines(&buf, width, 1).join("\n");
        assert!(rendered.contains("Indexing workspace"));
        assert!(rendered.contains("12s"));
        assert!(rendered.contains("2 queued"));
        assert!(rendered.contains("1.2k tok"));
        assert!(rendered.contains("Tab queue"));
        assert!(rendered.contains("Esc interrupt"));
    }

    #[test]
    fn turn_status_keeps_essential_state_at_narrow_widths() {
        let widget =
            TurnStatusWidget::new(Some("Working"), 12, QueueSummary::new(2), Some(1_200), true);
        let width = 46;
        let mut buf = Buffer::empty(Rect::new(0, 0, width, 1));

        widget.render(Rect::new(0, 0, width, 1), &mut buf);

        let rendered = buffer_lines(&buf, width, 1).join("\n");
        assert!(rendered.contains("Working"));
        assert!(rendered.contains("12s"));
        assert!(rendered.contains("Esc interrupt"));
        assert!(!rendered.contains("queued"));
        assert!(!rendered.contains("tok"));
        assert!(!rendered.contains("Tab queue"));
    }

    #[test]
    fn input_footer_keeps_model_effort_and_mode_next_to_the_composer() {
        let textarea = TextArea::new();
        let widget = ChatInputWidget::new(
            &textarea,
            "",
            ChatInputWidgetOptions {
                busy: false,
                pending_input_preview: None,
                ghost_text: None,
            },
        )
        .with_runtime_footer(
            Some("gpt-5.4"),
            ThinkingLevel::High,
            InteractionMode::AlwaysApprove,
        );
        let width = 96;
        let height = 4;
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));

        widget.render(Rect::new(0, 0, width, height), &mut buf);

        let rendered = buffer_lines(&buf, width, height).join("\n");
        assert!(rendered.contains("gpt-5.4 (high) · always-approve"));
    }

    #[test]
    fn input_renders_ghost_text_completion_after_cursor() {
        let mut textarea = TextArea::new();
        textarea.set_text("/qui");
        textarea.set_cursor(4);
        let widget = ChatInputWidget::new(
            &textarea,
            "",
            ChatInputWidgetOptions {
                busy: false,
                pending_input_preview: None,
                ghost_text: Some("t".to_string()),
            },
        );
        let width = 40;
        let height = 3;
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));

        widget.render(Rect::new(0, 0, width, height), &mut buf);

        let rendered = buffer_lines(&buf, width, height).join("\n");
        assert!(rendered.contains("/quit"));
    }

    #[test]
    fn input_without_ghost_text_leaves_trailing_cells_blank() {
        let mut textarea = TextArea::new();
        textarea.set_text("/qui");
        textarea.set_cursor(4);
        let widget = ChatInputWidget::new(
            &textarea,
            "",
            ChatInputWidgetOptions {
                busy: false,
                pending_input_preview: None,
                ghost_text: None,
            },
        );
        let width = 40;
        let height = 3;
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));

        widget.render(Rect::new(0, 0, width, height), &mut buf);

        let rendered = buffer_lines(&buf, width, height).join("\n");
        assert!(!rendered.contains("/quit"));
    }

    #[test]
    fn session_header_pairs_location_with_context_pressure() {
        let width = 80;
        let mut buf = Buffer::empty(Rect::new(0, 0, width, 1));

        SessionHeaderWidget::new(Some("/workspace/maestro"), Some("main"))
            .with_context(Some(9_500), Some(500_000))
            .render(Rect::new(0, 0, width, 1), &mut buf);

        let rendered = buffer_lines(&buf, width, 1).join("\n");
        assert!(rendered.contains("/workspace/maestro  ·  main"));
        assert!(rendered.contains("9.5K / 500K"));
    }

    #[test]
    fn session_header_degrades_without_a_known_context_limit() {
        assert_eq!(
            format_context_usage(Some(12_000), None).as_deref(),
            Some("12K context")
        );
        assert_eq!(format_context_usage(None, Some(500_000)), None);
    }

    #[test]
    fn tool_calls_render_concise_summary_labels() {
        let message = Message {
            id: "msg-1".to_string(),
            role: MessageRole::Assistant,
            kind: MessageKind::Regular,
            content: String::new(),
            thinking: String::new(),
            streaming: false,
            tool_calls: vec![crate::state::ToolCallState {
                call_id: "call-12345678".to_string(),
                tool: "read".to_string(),
                args: serde_json::json!({
                    "file_path": "/Users/jonathanhaas/Documents/Projects/maestro/package.json"
                }),
                status: ToolCallStatus::Completed,
                output: String::new(),
            }],
            usage: None,
            timestamp: SystemTime::UNIX_EPOCH,
            thinking_expanded: false,
        };

        let width = 100;
        let height = calculate_message_height(&message, width, &HashSet::new(), true);
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));

        MessageWidget::new(&message)
            .with_expanded_tools(&HashSet::new())
            .render(Rect::new(0, 0, width, height), &mut buf);

        let rendered = buffer_lines(&buf, width, height).join("\n");
        assert!(rendered.contains("Read package.json"));
        assert!(rendered.contains("· read"));
        assert!(rendered.contains("/Users/jonathanhaas/Documents/Projects/maestro/package.json"));
    }

    #[test]
    fn assistant_messages_render_maestro_header() {
        let message = Message {
            id: "msg-2".to_string(),
            role: MessageRole::Assistant,
            kind: MessageKind::Regular,
            content: "Hello".to_string(),
            thinking: String::new(),
            streaming: false,
            tool_calls: vec![],
            usage: None,
            timestamp: SystemTime::UNIX_EPOCH,
            thinking_expanded: false,
        };

        let width = 80;
        let height = calculate_message_height(&message, width, &HashSet::new(), true);
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));

        MessageWidget::new(&message).render(Rect::new(0, 0, width, height), &mut buf);

        let rendered = buffer_lines(&buf, width, height).join("\n");
        assert!(rendered.contains("• Maestro"));
        assert!(!rendered.contains("• Composer"));
    }

    #[test]
    fn empty_chat_view_uses_plain_maestro_welcome_copy() {
        let state = crate::state::AppState::default();
        let width = 100;
        let height = 20;
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));

        ChatView::new(&state).render(Rect::new(0, 0, width, height), &mut buf);

        let rendered = buffer_lines(&buf, width, height).join("\n");
        assert!(rendered.contains("Maestro"));
        assert!(rendered.contains("Type a message or /help."));
        assert!(!rendered.contains("Welcome to Maestro!"));
        assert!(!rendered.contains("Welcome to Composer! Type a message to get started."));
    }

    fn transcript_layout_message(id: &str, content: &str) -> Message {
        Message {
            id: id.to_string(),
            role: MessageRole::Assistant,
            kind: MessageKind::Regular,
            content: content.to_string(),
            thinking: String::new(),
            streaming: false,
            tool_calls: vec![],
            usage: None,
            timestamp: SystemTime::UNIX_EPOCH,
            thinking_expanded: false,
        }
    }

    #[test]
    fn transcript_layout_reuses_stable_heights_and_remeasures_streaming_tail() {
        let mut state = crate::state::AppState::default();
        state.messages = vec![
            transcript_layout_message("one", "# First\n\nA stable message."),
            transcript_layout_message("two", "# Second\n\nA streaming message."),
        ];
        let area = Rect::new(0, 0, 80, 24);

        ChatView::new(&state).render(area, &mut Buffer::empty(area));
        let cold_measurements = state.transcript_layout_measurements();
        assert_eq!(cold_measurements, 2);

        ChatView::new(&state).render(area, &mut Buffer::empty(area));
        assert_eq!(state.transcript_layout_measurements(), cold_measurements);

        state.messages[1].content.push_str(" More streamed text.");
        ChatView::new(&state).render(area, &mut Buffer::empty(area));
        assert_eq!(
            state.transcript_layout_measurements(),
            cold_measurements + 1
        );
    }

    #[test]
    fn transcript_layout_width_change_remeasures_every_message() {
        let mut state = crate::state::AppState::default();
        state.messages = vec![
            transcript_layout_message("one", "A stable message."),
            transcript_layout_message("two", "Another stable message."),
        ];

        let wide = Rect::new(0, 0, 80, 24);
        ChatView::new(&state).render(wide, &mut Buffer::empty(wide));
        let cold_measurements = state.transcript_layout_measurements();

        let narrow = Rect::new(0, 0, 60, 24);
        ChatView::new(&state).render(narrow, &mut Buffer::empty(narrow));
        assert_eq!(
            state.transcript_layout_measurements(),
            cold_measurements + 2
        );
    }
}
