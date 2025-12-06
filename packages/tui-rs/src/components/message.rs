//! Message display widget
//!
//! Renders chat messages with role indicators, tool calls, etc.
//! Inspired by the TypeScript TUI and OpenAI Codex TUI with:
//! - Bordered panels and status badges
//! - Tool-specific icons
//! - Shimmer animations for "Working" text
//! - Elapsed time display

use std::time::Instant;

use ratatui::{
    buffer::Buffer,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Widget, Wrap},
};

use crate::effects::{braille_spinner, shimmer_spans};
use crate::state::{Message, MessageRole, ToolCallStatus};

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
pub fn calculate_message_height(message: &Message, width: u16) -> u16 {
    if !should_render_message(message) {
        return 0;
    }

    let mut height: u16 = 0;
    let content_width = width.saturating_sub(2).max(1) as usize;

    // Header line (only for user messages or assistant messages with content/thinking)
    if message.role == MessageRole::User
        || !message.content.is_empty()
        || !message.thinking.is_empty()
    {
        height += 1;
    }

    // Thinking content (collapsed to 1-3 lines with summary)
    if !message.thinking.is_empty() {
        // Show thinking header + 2 preview lines max
        height += 3;
    }

    // Content lines (rough estimate based on character count)
    if !message.content.is_empty() {
        let content_lines = message
            .content
            .lines()
            .map(|line| (line.len() / content_width + 1) as u16)
            .sum::<u16>()
            .max(1);
        height += content_lines;
    }

    // Tool calls: 2 lines each (header + gutter line)
    height += (message.tool_calls.len() as u16) * 2;

    // Spacing after message
    height += 1;

    height
}

/// Widget for rendering a single message
pub struct MessageWidget<'a> {
    message: &'a Message,
}

impl<'a> MessageWidget<'a> {
    pub fn new(message: &'a Message) -> Self {
        Self { message }
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

        // Role header - only render for user messages or assistant messages with content/thinking
        let should_show_header = self.message.role == MessageRole::User
            || !self.message.content.is_empty()
            || !self.message.thinking.is_empty();

        if should_show_header && y < max_y {
            let mut header_spans: Vec<Span<'static>> = Vec::new();

            match self.message.role {
                MessageRole::User => {
                    header_spans.push(Span::styled(
                        "You",
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ));
                }
                MessageRole::Assistant => {
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

        // Render thinking content (collapsed with preview)
        if y < max_y && !self.message.thinking.is_empty() {
            // Thinking header - use glyph instead of emoji
            let thinking_header = Line::from(vec![
                Span::styled("│ ", Style::default().fg(Color::DarkGray)),
                Span::styled("~ ", Style::default().fg(Color::Yellow)),
                Span::styled("Thinking", Style::default().fg(Color::Yellow)),
                Span::styled(
                    format!(" ({} chars)", self.message.thinking.len()),
                    Style::default().fg(Color::DarkGray),
                ),
            ]);
            let header_para = Paragraph::new(thinking_header);
            header_para.render(
                Rect {
                    x: area.x,
                    y,
                    width: area.width,
                    height: 1,
                },
                buf,
            );
            y += 1;

            // Show first 2 lines of thinking as preview
            if y < max_y {
                let preview_lines: Vec<&str> = self.message.thinking.lines().take(2).collect();
                for line in preview_lines {
                    if y >= max_y {
                        break;
                    }
                    let max_len = area.width.saturating_sub(4) as usize;
                    let truncated = if line.len() > max_len {
                        format!("{}...", &line[..max_len.saturating_sub(3)])
                    } else {
                        line.to_string()
                    };
                    let preview = Line::from(vec![
                        Span::styled("│ ", Style::default().fg(Color::DarkGray)),
                        Span::styled(
                            truncated,
                            Style::default()
                                .fg(Color::DarkGray)
                                .add_modifier(Modifier::ITALIC),
                        ),
                    ]);
                    let preview_para = Paragraph::new(preview);
                    preview_para.render(
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

        // Render content (if any)
        if y < max_y && !self.message.content.is_empty() {
            let content_height = {
                let content_width = area.width.saturating_sub(2).max(1) as usize;
                self.message
                    .content
                    .lines()
                    .map(|line| (line.len() / content_width + 1) as u16)
                    .sum::<u16>()
                    .max(1)
            };

            let available_height = max_y.saturating_sub(y);
            let render_height = content_height.min(available_height);

            let content_area = Rect {
                x: area.x + 2, // Indent content
                y,
                width: area.width.saturating_sub(2),
                height: render_height,
            };

            let content = Paragraph::new(self.message.content.as_str())
                .wrap(Wrap { trim: false })
                .style(Style::default().fg(Color::White));
            content.render(content_area, buf);
            y += render_height;
        }

        // Render tool calls with beautiful bordered panels
        for tool_call in &self.message.tool_calls {
            if y >= max_y {
                break;
            }

            let icon = get_tool_icon(&tool_call.tool);

            // Gutter style based on status
            let gutter_style = match tool_call.status {
                ToolCallStatus::Running => Style::default().fg(Color::Blue),
                ToolCallStatus::Completed => Style::default().fg(Color::DarkGray),
                ToolCallStatus::Failed => Style::default().fg(Color::Red),
                ToolCallStatus::Pending => Style::default().fg(Color::Yellow),
            };

            // Build tool line with spinner for running, bullet for others
            let mut tool_spans: Vec<Span<'static>> = Vec::new();

            // Bullet/spinner
            match tool_call.status {
                ToolCallStatus::Running => {
                    tool_spans.push(braille_spinner(Some(Instant::now())));
                }
                ToolCallStatus::Completed => {
                    tool_spans.push(Span::styled(
                        "*",
                        Style::default()
                            .fg(Color::Green)
                            .add_modifier(Modifier::BOLD),
                    ));
                }
                ToolCallStatus::Failed => {
                    tool_spans.push(Span::styled(
                        "*",
                        Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                    ));
                }
                ToolCallStatus::Pending => {
                    tool_spans.push(Span::styled("*", Style::default().fg(Color::Yellow)));
                }
            }

            tool_spans.push(Span::raw(" "));

            // Verb: "Running" or "Ran"
            let verb = match tool_call.status {
                ToolCallStatus::Running => "Running",
                ToolCallStatus::Completed | ToolCallStatus::Failed => "Ran",
                ToolCallStatus::Pending => "Pending",
            };
            tool_spans.push(Span::styled(
                verb,
                Style::default().add_modifier(Modifier::BOLD),
            ));
            tool_spans.push(Span::raw(" "));

            // Icon and tool name
            tool_spans.push(Span::styled(icon, Style::default().fg(Color::Cyan)));
            tool_spans.push(Span::raw(" "));
            tool_spans.push(Span::styled(
                tool_call.tool.clone(),
                Style::default().fg(Color::White),
            ));

            let tool_line = Line::from(tool_spans);
            let tool_para = Paragraph::new(tool_line);
            tool_para.render(
                Rect {
                    x: area.x,
                    y,
                    width: area.width,
                    height: 1,
                },
                buf,
            );
            y += 1;

            // Second line: show args preview or output preview with gutter
            if y < max_y {
                let preview = if !tool_call.output.is_empty() {
                    // Show first line of output
                    let first_line = tool_call.output.lines().next().unwrap_or("");
                    let max_len = area.width.saturating_sub(6) as usize;
                    if first_line.len() > max_len {
                        format!("{}...", &first_line[..max_len.saturating_sub(3)])
                    } else {
                        first_line.to_string()
                    }
                } else {
                    // Show args preview
                    get_tool_args_preview(
                        &tool_call.tool,
                        &tool_call.args,
                        area.width.saturating_sub(6) as usize,
                    )
                };

                // Use corner gutter for last line of tool call
                let preview_line = Line::from(vec![
                    Span::styled("  └ ", gutter_style),
                    Span::styled(preview, Style::default().fg(Color::DarkGray)),
                ]);

                let preview_para = Paragraph::new(preview_line);
                preview_para.render(
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
}

impl<'a> ChatInputWidget<'a> {
    pub fn new(
        input: &'a str,
        cursor: usize,
        placeholder: &'a str,
        busy: bool,
        elapsed_secs: u64,
    ) -> Self {
        Self {
            input,
            cursor,
            placeholder,
            busy,
            elapsed_secs,
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
            spans.extend(shimmer_spans("Working"));
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

/// Status bar widget
pub struct StatusBarWidget<'a> {
    model: Option<&'a str>,
    provider: Option<&'a str>,
    cwd: Option<&'a str>,
    git_branch: Option<&'a str>,
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
        }
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

        // Terminal size on the right side
        let size_str = if let Ok((cols, rows)) = crate::terminal::size() {
            format!(" {}x{}", cols, rows)
        } else {
            String::new()
        };

        let line = Line::from(spans);
        let para = Paragraph::new(line).style(Style::default().fg(Color::DarkGray));
        para.render(area, buf);

        // Render size on the right
        if !size_str.is_empty() {
            let size_x = area.right().saturating_sub(size_str.len() as u16);
            let size_span = Span::styled(&size_str, Style::default().fg(Color::DarkGray));
            buf.set_span(size_x, area.y, &size_span, size_str.len() as u16);
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
        );
        input_widget.render(chunks[1], buf);

        // Render status bar
        let status_widget = StatusBarWidget::new(
            self.state.model.as_deref(),
            self.state.provider.as_deref(),
            self.state.cwd.as_deref(),
            self.state.git_branch.as_deref(),
        );
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
            .map(|m| calculate_message_height(m, area.width))
            .collect();

        // Calculate total height
        let total_height: u16 = msg_heights.iter().sum();

        // Find first message that fits (auto-scroll to bottom)
        let start_idx = if total_height <= area.height {
            0
        } else {
            // Find first message that fits from the end
            let mut height_sum: u16 = 0;
            let mut idx = renderable_messages.len();
            for (i, h) in msg_heights.iter().enumerate().rev() {
                if height_sum + h > area.height {
                    break;
                }
                height_sum += h;
                idx = i;
            }
            idx
        };

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

            let widget = MessageWidget::new(message);
            widget.render(msg_area, buf);

            y += msg_height;
        }
    }
}
