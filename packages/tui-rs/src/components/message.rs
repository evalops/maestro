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
//! - TypeScript Composer TUI
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
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Widget, Wrap},
};

use crate::components::textarea::{TextArea, TextAreaWidget};
use crate::effects::shimmer_spans;
use crate::runtime_badges::{build_runtime_badges, RuntimeBadgeParams};
use crate::session::entries::ThinkingLevel;
use crate::state::{ApprovalMode, Message, MessageRole, ToolCallStatus};
use crate::tool_output::{clamp_tool_output, format_tool_output_truncation, tool_output_limits};
use crate::wrapping::{word_wrap_lines, RtOptions};
use std::collections::HashSet;
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

/// Check if a message should be rendered
/// Skip empty assistant messages (no content AND no tool calls)
pub fn should_render_message(message: &Message) -> bool {
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
        let args_preview =
            get_tool_args_preview(&tc.tool, &tc.args, width.saturating_sub(20) as usize);

        // header line
        height += 1;

        if !args_preview.is_empty() {
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

        // Role header with prefix and timestamp (Codex style)
        if y < max_y {
            let mut header_spans: Vec<Span<'static>> = Vec::new();

            match self.message.role {
                MessageRole::User => {
                    // User messages: "› You" prefix
                    header_spans.push(Span::styled(
                        "› ",
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD | Modifier::DIM),
                    ));
                    header_spans.push(Span::styled(
                        "You",
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ));
                }
                MessageRole::Assistant => {
                    // Assistant messages: "• Composer" prefix
                    header_spans.push(Span::styled(
                        "• ",
                        Style::default()
                            .fg(Color::Magenta)
                            .add_modifier(Modifier::DIM),
                    ));
                    header_spans.push(Span::styled(
                        "Composer",
                        Style::default()
                            .fg(Color::Magenta)
                            .add_modifier(Modifier::BOLD),
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

            // Status bullet and verb (Codex style)
            let (bullet, bullet_style, verb) = match tool_call.status {
                ToolCallStatus::Running => ("●", Style::default().fg(Color::Cyan), "Calling"),
                ToolCallStatus::Completed => ("●", Style::default().fg(Color::Green), "Called"),
                ToolCallStatus::Failed => ("●", Style::default().fg(Color::Red), "Failed"),
                ToolCallStatus::Pending => ("○", Style::default().fg(Color::Yellow), "Pending"),
                ToolCallStatus::Blocked => ("●", Style::default().fg(Color::Magenta), "Blocked"),
            };

            // Get tool args preview for inline display
            let args_preview = get_tool_args_preview(
                &tool_call.tool,
                &tool_call.args,
                area.width.saturating_sub(20) as usize,
            );

            // Get tool-specific icon
            let tool_icon = get_tool_icon(&tool_call.tool);

            // Header line: λ Called bash #12345678  [+]
            let header_line = Line::from(vec![
                Span::styled(bullet, bullet_style.add_modifier(Modifier::BOLD)),
                Span::raw(" "),
                Span::styled(tool_icon, Style::default().fg(Color::Cyan)),
                Span::raw(" "),
                Span::styled(verb, Style::default().add_modifier(Modifier::BOLD)),
                Span::raw(" "),
                Span::styled(
                    tool_call.tool.clone(),
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(" "),
                Span::styled(
                    format!(
                        "#{}",
                        &tool_call.call_id.chars().take(8).collect::<String>()
                    ),
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
            if y < max_y && !args_preview.is_empty() {
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
///     busy,
///     elapsed_secs,
///     thinking_header,
///     queue_summary,
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
    elapsed_secs: u64,
    thinking_header: Option<&'a str>,
    queue_summary: Option<QueueSummary>,
}

#[derive(Debug, Clone, Copy)]
pub struct QueueSummary {
    pub total: usize,
    pub steering: usize,
    pub follow_up: usize,
}

impl QueueSummary {
    pub fn new(total: usize, steering: usize, follow_up: usize) -> Self {
        Self {
            total,
            steering,
            follow_up,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.total == 0
    }
}

impl<'a> ChatInputWidget<'a> {
    pub fn new(
        textarea: &'a TextArea,
        placeholder: &'a str,
        busy: bool,
        elapsed_secs: u64,
        thinking_header: Option<&'a str>,
        queue_summary: Option<QueueSummary>,
    ) -> Self {
        Self {
            textarea,
            placeholder,
            busy,
            elapsed_secs,
            thinking_header,
            queue_summary,
        }
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

        self.textarea.cursor_pos(inner)
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

        // Create title with shimmer effect and elapsed time when busy
        let title: Line = if self.busy {
            let elapsed = fmt_elapsed_compact(self.elapsed_secs);
            let mut spans = vec![Span::raw(" ")];

            // Show thinking header if available, otherwise "Working"
            if let Some(header) = self.thinking_header {
                // Shimmer the thinking header (truncate if too long)
                let max_header_len = 30;
                let display_header = if header.len() > max_header_len {
                    format!("{}...", &header[..max_header_len.saturating_sub(3)])
                } else {
                    header.to_string()
                };
                spans.extend(shimmer_spans(&display_header));
            } else {
                spans.extend(shimmer_spans("Working"));
            }

            let queue_note = if let Some(summary) = self.queue_summary {
                if summary.is_empty() {
                    String::new()
                } else {
                    let mut detail = Vec::new();
                    if summary.steering > 0 {
                        detail.push(format!("{} steer", summary.steering));
                    }
                    if summary.follow_up > 0 {
                        detail.push(format!("{} follow-up", summary.follow_up));
                    }
                    if detail.is_empty() {
                        format!(" | {} queued", summary.total)
                    } else {
                        format!(" | {} queued ({})", summary.total, detail.join(", "))
                    }
                }
            } else {
                String::new()
            };
            spans.push(Span::styled(
                format!(" ({elapsed}{queue_note} | ESC to interrupt) "),
                Style::default().fg(Color::DarkGray),
            ));
            Line::from(spans)
        } else {
            Line::from(" > ")
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(border_style)
            .title(title);

        let inner = block.inner(area);
        block.render(area, buf);

        let text_style = Style::default();
        let placeholder_style = Style::default().fg(Color::DarkGray);

        let textarea_widget = TextAreaWidget::new(self.textarea)
            .style(text_style)
            .placeholder(self.placeholder, placeholder_style);

        textarea_widget.render(inner, buf);
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
    let desired_inner_lines = state.textarea.desired_height(inner_width).max(1);

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
    alert_count: usize,
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
            alert_count: 0,
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
    pub fn with_mcp_status(mut self, connected: usize, tool_count: usize) -> Self {
        self.mcp_connected = connected;
        self.mcp_tool_count = tool_count;
        self
    }

    #[must_use]
    pub fn with_alert_count(mut self, alert_count: usize) -> Self {
        self.alert_count = alert_count;
        self
    }
}

impl Widget for StatusBarWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let mut spans = Vec::new();

        // Model info
        if let Some(model) = self.model {
            spans.push(Span::styled(model, Style::default().fg(Color::Cyan)));
            if let Some(provider) = self.provider {
                spans.push(Span::raw(" via "));
                spans.push(Span::styled(provider, Style::default().fg(Color::DarkGray)));
            }
        }

        // Separator
        if !spans.is_empty() {
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
                alert_count: self.alert_count,
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
/// │  • Composer             │
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
}

impl<'a> ChatView<'a> {
    pub fn new(state: &'a crate::state::AppState) -> Self {
        Self { state }
    }
}

impl Widget for ChatView<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height < 5 || area.width < 10 {
            return;
        }

        let status_height = u16::from(!self.state.zen_mode);
        let input_height = calculate_input_height(self.state, area);
        let chunks = Layout::vertical([
            Constraint::Min(0),                // Messages
            Constraint::Length(input_height),  // Input (auto-grow)
            Constraint::Length(status_height), // Status (hidden in zen mode)
        ])
        .split(area);

        // Render messages
        self.render_messages(chunks[0], buf);

        // Render input
        let input_widget = ChatInputWidget::new(
            &self.state.textarea,
            "Type a message...",
            self.state.busy,
            self.state.elapsed_busy_secs(),
            self.state.thinking_header.as_deref(),
            if self.state.queued_prompt_count > 0 {
                Some(QueueSummary::new(
                    self.state.queued_prompt_count,
                    self.state.queued_steering_count,
                    self.state.queued_follow_up_count,
                ))
            } else {
                None
            },
        );
        input_widget.render(chunks[1], buf);

        // Render status bar (unless zen mode)
        if !self.state.zen_mode {
            // Calculate total usage from all messages
            let usage = self
                .state
                .messages
                .iter()
                .filter_map(|m| m.usage.as_ref())
                .fold(UsageSummary::default(), |mut acc, u| {
                    acc.input_tokens += u.input_tokens;
                    acc.output_tokens += u.output_tokens;
                    acc
                });

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

            let alert_count = usize::from(self.state.error.is_some());

            let status_widget = StatusBarWidget::new(
                self.state.model.as_deref(),
                self.state.provider.as_deref(),
                self.state.cwd.as_deref(),
                self.state.git_branch.as_deref(),
            )
            .with_usage(usage)
            .with_queue_badge(queue_badge.as_deref())
            .with_approval_mode(self.state.approval_mode)
            .with_thinking_level(self.state.thinking_level)
            .with_mcp_status(self.state.mcp_connected, self.state.mcp_tool_count)
            .with_alert_count(alert_count);
            status_widget.render(chunks[2], buf);
        }
    }
}

impl ChatView<'_> {
    fn render_messages(&self, area: Rect, buf: &mut Buffer) {
        // Filter to only renderable messages
        let renderable_messages: Vec<&Message> = self
            .state
            .messages
            .iter()
            .filter(|m| should_render_message(m))
            .collect();

        if area.height == 0 || renderable_messages.is_empty() {
            // Show welcome message
            let welcome = Paragraph::new("Welcome to Composer! Type a message to get started.")
                .style(Style::default().fg(Color::DarkGray))
                .wrap(Wrap { trim: false });
            welcome.render(area, buf);
            return;
        }

        // Calculate heights for all renderable messages
        let msg_heights: Vec<u16> = renderable_messages
            .iter()
            .map(|m| {
                calculate_message_height(
                    m,
                    area.width,
                    &self.state.expanded_tool_calls,
                    self.state.compact_tool_outputs,
                )
            })
            .collect();

        // Calculate total height
        let total_height: u16 = msg_heights.iter().sum();

        // Clamp scroll_offset to available content
        let max_offset = total_height.saturating_sub(area.height);
        let clamped_offset = self.state.scroll_offset.min(max_offset as usize) as u16;

        // Window anchored from bottom by scroll_offset
        let window_bottom = total_height.saturating_sub(clamped_offset);
        let window_top = window_bottom.saturating_sub(area.height);

        // Find the first message whose bottom exceeds window_top
        let mut start_idx = 0;
        let mut accumulated: u16 = 0;
        for (i, h) in msg_heights.iter().enumerate() {
            if accumulated + *h > window_top {
                start_idx = i;
                break;
            }
            accumulated += *h;
        }

        // Render messages from start_idx forward
        let mut y = area.y;
        let max_y = area.y + area.height;

        for (i, message) in renderable_messages.iter().enumerate().skip(start_idx) {
            if y >= max_y {
                break;
            }

            let msg_height = msg_heights[i].min(max_y.saturating_sub(y));

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
        if total_height > area.height {
            let bar_x = area.x + area.width.saturating_sub(1);
            let view_ratio = f32::from(area.height) / f32::from(total_height);
            let thumb_height =
                (f32::from(area.height) * view_ratio).clamp(1.0, f32::from(area.height));
            let scroll_ratio = f32::from(window_top) / f32::from(total_height);
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
                ((f32::from(window_bottom) / f32::from(total_height)) * 100.0).round() as i32
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
