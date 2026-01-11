//! Markdown rendering for terminal display
//!
//! This module converts markdown text to styled ratatui `Text` using the pulldown-cmark
//! parser. It handles all standard markdown features including headings, code blocks,
//! lists, emphasis, links, and blockquotes, applying appropriate terminal styling.
//!
//! # Rendering Pipeline
//!
//! The rendering process follows these steps:
//!
//! 1. Parse markdown using `pulldown-cmark::Parser` with extended features
//! 2. Process events through `MarkdownRenderer` which maintains style state
//! 3. Syntax highlight code blocks using the `syntax` module
//! 4. Convert to ratatui `Text` with styled `Line` and `Span` elements
//!
//! # Supported Features
//!
//! - **Headings** (H1-H6): Different styles with # prefix preserved
//! - **Code blocks**: Fenced code with language-specific syntax highlighting
//! - **Inline code**: Backtick-delimited code with distinct styling
//! - **Lists**: Both ordered and unordered, with proper indentation
//! - **Emphasis**: Italic (*text*), bold (**text**), strikethrough (~~text~~)
//! - **Links**: Displayed as styled text with URL appended in parentheses
//! - **Blockquotes**: Rendered with vertical bar prefix
//! - **Tables**: Parsed but basic rendering support
//! - **Horizontal rules**: Rendered as separator lines
//!
//! # External Crates
//!
//! - `pulldown-cmark`: CommonMark-compliant markdown parser that provides an
//!   event-based streaming API for efficient parsing
//! - `ratatui`: Terminal UI framework for styled text rendering
//!
//! # Example
//!
//! ```
//! use composer_tui::markdown::render_markdown;
//!
//! let markdown = "# Hello\n\nThis is **bold** and *italic*.";
//! let text = render_markdown(markdown);
//! // `text` is now a ratatui::text::Text ready for rendering
//! ```

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};

use crate::palette::theme;
use crate::syntax;

/// Style configuration for markdown elements.
///
/// This struct defines the visual appearance of different markdown elements when
/// rendered in the terminal. Each field corresponds to a specific markdown construct
/// and contains a ratatui `Style` with foreground/background colors and modifiers.
///
/// The default styles are designed for readability in dark terminal themes.
#[derive(Clone)]
pub struct MarkdownStyles {
    pub h1: Style,
    pub h2: Style,
    pub h3: Style,
    pub h4: Style,
    pub h5: Style,
    pub h6: Style,
    pub code: Style,
    pub code_block: Style,
    pub emphasis: Style,
    pub strong: Style,
    pub strikethrough: Style,
    pub link: Style,
    pub blockquote: Style,
    pub list_marker: Style,
}

impl Default for MarkdownStyles {
    fn default() -> Self {
        Self {
            h1: Style::default().add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
            h2: Style::default().add_modifier(Modifier::BOLD),
            h3: Style::default().add_modifier(Modifier::BOLD | Modifier::ITALIC),
            h4: Style::default().add_modifier(Modifier::ITALIC),
            h5: Style::default().add_modifier(Modifier::ITALIC),
            h6: Style::default().add_modifier(Modifier::ITALIC | Modifier::DIM),
            code: Style::default().fg(Color::Cyan),
            code_block: Style::default().fg(theme::syntax_string()),
            emphasis: Style::default().add_modifier(Modifier::ITALIC),
            strong: Style::default().add_modifier(Modifier::BOLD),
            strikethrough: Style::default().add_modifier(Modifier::CROSSED_OUT),
            link: Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::UNDERLINED),
            blockquote: Style::default().fg(Color::Green),
            list_marker: Style::default().fg(Color::Blue),
        }
    }
}

/// Render markdown text to ratatui Text.
///
/// This is the main entry point for converting markdown strings to styled terminal
/// output. It parses the markdown and returns a `Text` instance ready for rendering
/// with ratatui.
///
/// # Arguments
///
/// - `input`: The markdown source text
///
/// # Returns
///
/// A ratatui `Text<'static>` with styled lines and spans
///
/// # Example
///
/// ```
/// use composer_tui::markdown::render_markdown;
///
/// let text = render_markdown("**Bold** and *italic*");
/// ```
#[must_use]
pub fn render_markdown(input: &str) -> Text<'static> {
    render_markdown_with_width(input, None)
}

/// Render markdown with optional width limit for wrapping.
///
/// This function provides the same functionality as `render_markdown` but with
/// an optional width parameter for future word-wrapping support.
///
/// Note: The width parameter is currently unused but reserved for future implementation
/// of automatic line wrapping at the markdown rendering level.
#[must_use]
pub fn render_markdown_with_width(input: &str, _width: Option<usize>) -> Text<'static> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);

    let parser = Parser::new_ext(input, options);
    let mut renderer = MarkdownRenderer::new();
    renderer.render(parser);
    renderer.into_text()
}

/// Internal renderer state for processing markdown events.
///
/// This struct maintains rendering state as it processes the stream of events from
/// pulldown-cmark. It uses a stack-based approach for nested styles and list tracking
/// to properly handle nested markdown constructs.
///
/// # Style Stack
///
/// Styles are composed using a stack, where each nested construct (emphasis, strong,
/// link) pushes a new combined style onto the stack. This allows proper handling of
/// nested emphasis like ***bold italic***.
///
/// # List State
///
/// Lists are tracked with a stack of `Option<u64>` where:
/// - `None` indicates an unordered list (bullet points)
/// - `Some(n)` indicates an ordered list starting at number `n`
///
/// This allows proper rendering of nested lists with correct indentation and markers.
struct MarkdownRenderer {
    styles: MarkdownStyles,
    lines: Vec<Line<'static>>,
    current_spans: Vec<Span<'static>>,
    style_stack: Vec<Style>,
    list_stack: Vec<Option<u64>>, // None = unordered, Some(n) = ordered starting at n
    in_code_block: bool,
    code_block_content: String,
    code_block_lang: Option<String>,
    blockquote_depth: usize,
    /// Current link URL (for appending after link text)
    current_link_url: Option<String>,
}

impl MarkdownRenderer {
    fn new() -> Self {
        Self {
            styles: MarkdownStyles::default(),
            lines: Vec::new(),
            current_spans: Vec::new(),
            style_stack: vec![Style::default()],
            list_stack: Vec::new(),
            in_code_block: false,
            code_block_content: String::new(),
            code_block_lang: None,
            blockquote_depth: 0,
            current_link_url: None,
        }
    }

    fn current_style(&self) -> Style {
        self.style_stack.last().copied().unwrap_or_default()
    }

    fn push_style(&mut self, style: Style) {
        let combined = self.current_style().patch(style);
        self.style_stack.push(combined);
    }

    fn pop_style(&mut self) {
        if self.style_stack.len() > 1 {
            self.style_stack.pop();
        }
    }

    fn flush_line(&mut self) {
        if !self.current_spans.is_empty() {
            let mut spans = Vec::new();

            // Add blockquote prefix if needed
            for _ in 0..self.blockquote_depth {
                spans.push(Span::styled("│ ", self.styles.blockquote));
            }

            // Add list prefix if needed
            if !self.list_stack.is_empty() {
                let indent = "  ".repeat(self.list_stack.len() - 1);
                spans.push(Span::raw(indent));
            }

            spans.append(&mut self.current_spans);
            self.lines.push(Line::from(spans));
        }
        self.current_spans = Vec::new();
    }

    fn add_text(&mut self, text: &str) {
        if self.in_code_block {
            self.code_block_content.push_str(text);
        } else {
            let style = self.current_style();
            self.current_spans
                .push(Span::styled(text.to_string(), style));
        }
    }

    fn render(&mut self, parser: Parser<'_>) {
        for event in parser {
            match event {
                Event::Start(tag) => self.start_tag(tag),
                Event::End(tag) => self.end_tag(tag),
                Event::Text(text) => self.add_text(&text),
                Event::Code(code) => {
                    self.current_spans
                        .push(Span::styled(format!("`{code}`"), self.styles.code));
                }
                Event::SoftBreak => {
                    self.current_spans.push(Span::raw(" "));
                }
                Event::HardBreak => {
                    self.flush_line();
                }
                Event::Rule => {
                    self.flush_line();
                    self.lines.push(Line::from(Span::styled(
                        "─".repeat(40),
                        Style::default().fg(Color::DarkGray),
                    )));
                }
                _ => {}
            }
        }
        self.flush_line();
    }

    fn start_tag(&mut self, tag: Tag) {
        match tag {
            Tag::Heading { level, .. } => {
                self.flush_line();
                let style = match level {
                    HeadingLevel::H1 => self.styles.h1,
                    HeadingLevel::H2 => self.styles.h2,
                    HeadingLevel::H3 => self.styles.h3,
                    HeadingLevel::H4 => self.styles.h4,
                    HeadingLevel::H5 => self.styles.h5,
                    HeadingLevel::H6 => self.styles.h6,
                };
                self.push_style(style);

                // Add heading prefix
                let prefix = match level {
                    HeadingLevel::H1 => "# ",
                    HeadingLevel::H2 => "## ",
                    HeadingLevel::H3 => "### ",
                    HeadingLevel::H4 => "#### ",
                    HeadingLevel::H5 => "##### ",
                    HeadingLevel::H6 => "###### ",
                };
                self.current_spans
                    .push(Span::styled(prefix.to_string(), style));
            }
            Tag::Paragraph => {
                self.flush_line();
            }
            Tag::BlockQuote(_) => {
                self.flush_line();
                self.blockquote_depth += 1;
            }
            Tag::CodeBlock(kind) => {
                self.flush_line();
                self.in_code_block = true;
                self.code_block_content.clear();
                self.code_block_lang = match kind {
                    CodeBlockKind::Fenced(lang) if !lang.is_empty() => Some(lang.to_string()),
                    _ => None,
                };
            }
            Tag::List(start) => {
                self.flush_line();
                self.list_stack.push(start);
            }
            Tag::Item => {
                self.flush_line();
                // Add list marker
                let marker = if let Some(Some(n)) = self.list_stack.last_mut() {
                    let marker = format!("{n}. ");
                    *n += 1;
                    marker
                } else {
                    "* ".to_string()
                };
                let indent = "  ".repeat(self.list_stack.len().saturating_sub(1));
                self.current_spans.push(Span::styled(
                    format!("{indent}{marker}"),
                    self.styles.list_marker,
                ));
            }
            Tag::Emphasis => {
                self.push_style(self.styles.emphasis);
            }
            Tag::Strong => {
                self.push_style(self.styles.strong);
            }
            Tag::Strikethrough => {
                self.push_style(self.styles.strikethrough);
            }
            Tag::Link { dest_url, .. } => {
                self.push_style(self.styles.link);
                // Store URL for displaying after link text
                self.current_link_url = Some(dest_url.to_string());
            }
            _ => {}
        }
    }

    fn end_tag(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Heading(_) => {
                self.pop_style();
                self.flush_line();
                self.lines.push(Line::from("")); // blank line after heading
            }
            TagEnd::Paragraph => {
                self.flush_line();
                self.lines.push(Line::from("")); // blank line after paragraph
            }
            TagEnd::BlockQuote(_) => {
                self.blockquote_depth = self.blockquote_depth.saturating_sub(1);
                self.flush_line();
            }
            TagEnd::CodeBlock => {
                self.in_code_block = false;
                // Render code block with border and syntax highlighting
                let lang = self.code_block_lang.as_deref();
                let lang_label = lang.unwrap_or("code");

                // Header
                self.lines.push(Line::from(vec![
                    Span::styled("┌─ ", Style::default().fg(Color::DarkGray)),
                    Span::styled(lang_label.to_string(), Style::default().fg(Color::DarkGray)),
                    Span::styled(" ─", Style::default().fg(Color::DarkGray)),
                ]));

                // Syntax-highlighted content
                let highlighted_lines = syntax::highlight_code(&self.code_block_content, lang);
                for mut line in highlighted_lines {
                    // Prepend the border
                    let mut spans = vec![Span::styled("│ ", Style::default().fg(Color::DarkGray))];
                    spans.append(&mut line.spans);
                    self.lines.push(Line::from(spans));
                }

                // Footer
                self.lines.push(Line::from(Span::styled(
                    "└──────",
                    Style::default().fg(Color::DarkGray),
                )));
                self.lines.push(Line::from("")); // blank line after code block

                self.code_block_content.clear();
                self.code_block_lang = None;
            }
            TagEnd::List(_) => {
                self.list_stack.pop();
                if self.list_stack.is_empty() {
                    self.flush_line();
                    self.lines.push(Line::from("")); // blank line after list
                }
            }
            TagEnd::Item => {
                self.flush_line();
            }
            TagEnd::Emphasis => {
                self.pop_style();
            }
            TagEnd::Strong => {
                self.pop_style();
            }
            TagEnd::Strikethrough => {
                self.pop_style();
            }
            TagEnd::Link => {
                self.pop_style();
                // Append the URL after the link text
                if let Some(url) = self.current_link_url.take() {
                    self.current_spans.push(Span::styled(
                        format!(" ({url})"),
                        Style::default().fg(Color::DarkGray),
                    ));
                }
            }
            _ => {}
        }
    }

    fn into_text(mut self) -> Text<'static> {
        // Remove trailing empty lines
        while self.lines.last().is_some_and(|l| l.spans.is_empty()) {
            self.lines.pop();
        }
        Text::from(self.lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_plain_text() {
        let text = render_markdown("Hello, world!");
        assert!(!text.lines.is_empty());
    }

    #[test]
    fn renders_heading() {
        let text = render_markdown("# Heading 1");
        assert!(text
            .lines
            .iter()
            .any(|l| { l.spans.iter().any(|s| s.content.contains("Heading")) }));
    }

    #[test]
    fn renders_code_block() {
        let text = render_markdown("```rust\nfn main() {}\n```");
        // With syntax highlighting, tokens may be split across spans
        // Check that the code content is present by concatenating all spans
        let all_content: String = text
            .lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.as_ref()))
            .collect();
        assert!(all_content.contains("fn") && all_content.contains("main"));
    }

    #[test]
    fn renders_list() {
        let text = render_markdown("* Item 1\n* Item 2");
        assert!(text.lines.len() >= 2);
    }

    #[test]
    fn renders_emphasis() {
        let text = render_markdown("This is *italic* text");
        assert!(!text.lines.is_empty());
    }
}
