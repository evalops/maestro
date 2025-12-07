//! Message display widget
//!
//! Renders chat messages with role indicators, tool calls, etc.
//! Inspired by the TypeScript TUI and OpenAI Codex TUI with:
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

use crate::effects::shimmer_spans;
use crate::state::{Message, MessageRole, ToolCallStatus};
use std::collections::HashSet;
use std::time::SystemTime;

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
                format!("  {}", line_text),
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
    format!("{:02}:{:02}", hours, minutes)
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

    // Content lines
    if !message.content.is_empty() {
        let content_lines = message
            .content
            .lines()
            .map(|line| (line.len() / content_width + 1) as u16)
            .sum::<u16>()
            .max(1);
        height += content_lines;
    }

    // Tool calls
    for tc in &message.tool_calls {
        let expanded = expanded_tools.contains(&tc.call_id);
        // header line
        height += 1;
        if expanded {
            // args lines (pretty printed)
            let args_str = serde_json::to_string_pretty(&tc.args).unwrap_or_default();
            let args_lines = args_str
                .lines()
                .map(|l| (l.len() / content_width + 1) as u16)
                .sum::<u16>()
                .max(1);
            height += args_lines;

            // output lines (limit to 10 lines max for display)
            if !tc.output.is_empty() {
                let out_lines = tc
                    .output
                    .lines()
                    .take(10)
                    .map(|l| (l.len() / content_width + 1) as u16)
                    .sum::<u16>()
                    .max(1);
                height += out_lines + 1; // +1 for "Output:" header
            }
        } else {
            // collapsed preview
            height += 1;
        }
    }

    height
}

/// Widget for rendering a single message
pub struct MessageWidget<'a> {
    message: &'a Message,
    expanded_tools: Option<&'a HashSet<String>>,
}

impl<'a> MessageWidget<'a> {
    pub fn new(message: &'a Message) -> Self {
        Self {
            message,
            expanded_tools: None,
        }
    }

    pub fn with_expanded_tools(mut self, expanded: &'a HashSet<String>) -> Self {
        self.expanded_tools = Some(expanded);
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

                    // Show shimmer "Working" indicator when streaming
                    if self.message.streaming
                        && self.message.content.is_empty()
                        && self.message.thinking.is_empty()
                        && self.message.tool_calls.is_empty()
                    {
                        header_spans.push(Span::raw(" "));
                        header_spans.extend(shimmer_spans("Working"));
                    }
                }
            };

            // Add timestamp (right-aligned feel)
            let timestamp = format_timestamp(self.message.timestamp);
            header_spans.push(Span::styled(
                format!("  {}", timestamp),
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

        // Render content with markdown styling
        if y < max_y && !self.message.content.is_empty() {
            // Parse markdown and render styled lines
            let md_lines = parse_markdown_lines(&self.message.content);

            for line in md_lines {
                if y >= max_y {
                    break;
                }
                // Render with indent
                let mut prefixed_spans = vec![Span::raw("  ")];
                prefixed_spans.extend(line.spans);
                let prefixed_line = Line::from(prefixed_spans);
                Paragraph::new(prefixed_line).render(
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

        // Render tool calls with bordered panels and expand/collapse
        for tool_call in &self.message.tool_calls {
            if y >= max_y {
                break;
            }

            let icon = get_tool_icon(&tool_call.tool);
            let expanded = self
                .expanded_tools
                .map(|s| s.contains(&tool_call.call_id))
                .unwrap_or(false);

            // Status pill color
            let (pill_text, pill_style) = match tool_call.status {
                ToolCallStatus::Running => ("RUN", Style::default().fg(Color::Blue)),
                ToolCallStatus::Completed => ("OK", Style::default().fg(Color::Green)),
                ToolCallStatus::Failed => ("ERR", Style::default().fg(Color::Red)),
                ToolCallStatus::Pending => ("PEND", Style::default().fg(Color::Yellow)),
            };

            // Header line
            let header_line = Line::from(vec![
                Span::styled(
                    format!("[{}]", pill_text),
                    pill_style.add_modifier(Modifier::BOLD),
                ),
                Span::raw(" "),
                Span::styled(icon, Style::default().fg(Color::Cyan)),
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
                        &tool_call.call_id.chars().take(6).collect::<String>()
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

            if expanded && y < max_y {
                // Args block
                let args_str = serde_json::to_string_pretty(&tool_call.args).unwrap_or_default();
                let args_para = Paragraph::new(args_str)
                    .wrap(Wrap { trim: false })
                    .style(Style::default().fg(Color::DarkGray));
                let args_height =
                    (tool_call.args.to_string().len().max(1) as u16).min(max_y.saturating_sub(y));
                args_para.render(
                    Rect {
                        x: area.x + 2,
                        y,
                        width: area.width.saturating_sub(2),
                        height: args_height,
                    },
                    buf,
                );
                y += args_height;

                // Output block
                if y < max_y && !tool_call.output.is_empty() {
                    let out_para = Paragraph::new(tool_call.output.as_str())
                        .wrap(Wrap { trim: false })
                        .style(Style::default().fg(Color::White));
                    let out_height = (tool_call.output.lines().count().max(1) as u16)
                        .min(max_y.saturating_sub(y));
                    out_para.render(
                        Rect {
                            x: area.x + 2,
                            y,
                            width: area.width.saturating_sub(2),
                            height: out_height,
                        },
                        buf,
                    );
                    y += out_height;
                }
            } else if y < max_y {
                // Collapsed preview (args or first output line)
                let preview = if !tool_call.output.is_empty() {
                    tool_call.output.lines().next().unwrap_or("").to_string()
                } else {
                    get_tool_args_preview(
                        &tool_call.tool,
                        &tool_call.args,
                        area.width.saturating_sub(6) as usize,
                    )
                };
                let preview_line = Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(preview, Style::default().fg(Color::DarkGray)),
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
                .and_then(|obj| obj.values().find_map(|v| v.as_str()).map(|s| s.to_string()))
                .unwrap_or_default()
        }
    };

    if preview.len() > max_len {
        format!("{}...", &preview[..max_len.saturating_sub(3)])
    } else {
        preview
    }
}

/// Widget for rendering a tool call
pub struct ToolCallWidget<'a> {
    tool: &'a str,
    status: ToolCallStatus,
    output: &'a str,
    expanded: bool,
}

impl<'a> ToolCallWidget<'a> {
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
        };

        let header = Line::from(vec![
            Span::styled(status_icon, Style::default().fg(status_color)),
            Span::raw(" "),
            Span::styled(self.tool, Style::default().fg(Color::Cyan)),
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
        return format!("{}s", elapsed_secs);
    }
    if elapsed_secs < 3600 {
        let minutes = elapsed_secs / 60;
        let seconds = elapsed_secs % 60;
        return format!("{}m {:02}s", minutes, seconds);
    }
    let hours = elapsed_secs / 3600;
    let minutes = (elapsed_secs % 3600) / 60;
    let seconds = elapsed_secs % 60;
    format!("{}h {:02}m {:02}s", hours, minutes, seconds)
}

/// Widget for the chat input area
pub struct ChatInputWidget<'a> {
    input: &'a str,
    cursor: usize,
    placeholder: &'a str,
    busy: bool,
    elapsed_secs: u64,
    thinking_header: Option<&'a str>,
}

impl<'a> ChatInputWidget<'a> {
    pub fn new(
        input: &'a str,
        cursor: usize,
        placeholder: &'a str,
        busy: bool,
        elapsed_secs: u64,
        thinking_header: Option<&'a str>,
    ) -> Self {
        Self {
            input,
            cursor,
            placeholder,
            busy,
            elapsed_secs,
            thinking_header,
        }
    }

    /// Calculate cursor position relative to the input area
    /// Returns (x, y) position where the terminal cursor should be placed
    pub fn cursor_pos(&self, input_area: Rect) -> Option<(u16, u16)> {
        if self.busy || input_area.width < 3 || input_area.height < 3 {
            return None;
        }

        // Inner area after borders
        let inner_x = input_area.x + 1;
        let inner_y = input_area.y + 1;
        let inner_width = input_area.width.saturating_sub(2);

        if inner_width == 0 {
            return None;
        }

        // Calculate cursor column using unicode display width
        use unicode_width::UnicodeWidthStr;
        let text_before_cursor = if self.cursor <= self.input.len() {
            &self.input[..self.cursor]
        } else {
            self.input
        };
        let col = text_before_cursor.width() as u16;

        // Handle wrapping - for now just clamp to first line
        // TODO: proper multi-line cursor positioning with wrap calculation
        let clamped_col = col.min(inner_width.saturating_sub(1));

        Some((inner_x + clamped_col, inner_y))
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

            spans.push(Span::styled(
                format!(" ({} | ESC to interrupt) ", elapsed),
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

        // Content
        let display = if self.input.is_empty() {
            self.placeholder
        } else {
            self.input
        };

        let style = if self.input.is_empty() {
            Style::default().fg(Color::DarkGray)
        } else {
            Style::default()
        };

        let para = Paragraph::new(display)
            .style(style)
            .wrap(Wrap { trim: false });
        para.render(inner, buf);
    }
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

/// Status bar widget
pub struct StatusBarWidget<'a> {
    model: Option<&'a str>,
    provider: Option<&'a str>,
    cwd: Option<&'a str>,
    git_branch: Option<&'a str>,
    usage: UsageSummary,
}

impl<'a> StatusBarWidget<'a> {
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
        }
    }

    pub fn with_usage(mut self, usage: UsageSummary) -> Self {
        self.usage = usage;
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

        let line = Line::from(spans);
        let para = Paragraph::new(line).style(Style::default().fg(Color::DarkGray));
        para.render(area, buf);

        // Build right-side info (usage + terminal size)
        let mut right_spans = Vec::new();

        // Token usage
        let total_tokens = self.usage.input_tokens + self.usage.output_tokens;
        if total_tokens > 0 {
            right_spans.push(Span::styled(
                format!(
                    "↑{} ↓{} ",
                    UsageSummary::format_tokens(self.usage.input_tokens),
                    UsageSummary::format_tokens(self.usage.output_tokens)
                ),
                Style::default().fg(Color::DarkGray),
            ));
        }

        // Terminal size
        if let Ok((cols, rows)) = crate::terminal::size() {
            right_spans.push(Span::styled(
                format!("{}x{}", cols, rows),
                Style::default().fg(Color::DarkGray),
            ));
        }

        // Render right-side info
        if !right_spans.is_empty() {
            let right_line = Line::from(right_spans);
            let right_width = right_line.width() as u16;
            let right_x = area.right().saturating_sub(right_width);
            buf.set_line(right_x, area.y, &right_line, right_width);
        }
    }
}

/// The main chat view widget
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

        // Layout: messages area, input (3 lines), status bar (1 line)
        let chunks = Layout::vertical([
            Constraint::Min(0),    // Messages
            Constraint::Length(3), // Input
            Constraint::Length(1), // Status
        ])
        .split(area);

        // Render messages
        self.render_messages(chunks[0], buf);

        // Render input
        let input_widget = ChatInputWidget::new(
            &self.state.input,
            self.state.cursor,
            "Type a message...",
            self.state.busy,
            self.state.elapsed_busy_secs(),
            self.state.thinking_header.as_deref(),
        );
        input_widget.render(chunks[1], buf);

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

        // Render status bar
        let status_widget = StatusBarWidget::new(
            self.state.model.as_deref(),
            self.state.provider.as_deref(),
            self.state.cwd.as_deref(),
            self.state.git_branch.as_deref(),
        )
        .with_usage(usage);
        status_widget.render(chunks[2], buf);
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
            .map(|m| calculate_message_height(m, area.width, &self.state.expanded_tool_calls))
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

            let widget =
                MessageWidget::new(message).with_expanded_tools(&self.state.expanded_tool_calls);
            widget.render(msg_area, buf);

            y += msg_height;
        }

        // Draw a simple scrollbar on the right
        if total_height > area.height {
            let bar_x = area.x + area.width.saturating_sub(1);
            let view_ratio = area.height as f32 / total_height as f32;
            let thumb_height = ((area.height as f32) * view_ratio).clamp(1.0, area.height as f32);
            let scroll_ratio = window_top as f32 / total_height as f32;
            let thumb_start = (scroll_ratio * (area.height as f32 - thumb_height)).round() as u16;
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
