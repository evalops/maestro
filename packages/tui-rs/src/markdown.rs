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
//! use maestro_tui::markdown::render_markdown;
//!
//! let markdown = "# Hello\n\nThis is **bold** and *italic*.";
//! let text = render_markdown(markdown);
//! // `text` is now a ratatui::text::Text ready for rendering
//! ```

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};

use crate::hyperlink;
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
/// use maestro_tui::markdown::render_markdown;
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
struct LinkState {
    url: String,
    label: String,
    spans: Vec<Span<'static>>,
    has_rendered_segment: bool,
}

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
    /// Current link target and visible label while parsing `[label](url)`.
    current_link: Option<LinkState>,
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
            current_link: None,
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
        let style = self.current_style();
        if self.in_code_block {
            self.code_block_content.push_str(text);
        } else if let Some(link) = self.current_link.as_mut() {
            link.label.push_str(text);
            link.spans.push(Span::styled(text.to_string(), style));
        } else {
            self.current_spans
                .push(Span::styled(text.to_string(), style));
        }
    }

    fn add_inline_code(&mut self, code: &str) {
        if let Some(link) = self.current_link.as_mut() {
            let code_label = format!("`{code}`");
            link.label.push_str(&code_label);
            link.spans.push(Span::styled(code_label, self.styles.code));
            return;
        }
        self.current_spans
            .push(Span::styled(format!("`{code}`"), self.styles.code));
    }

    fn add_soft_break(&mut self) {
        let style = self.current_style();
        if let Some(link) = self.current_link.as_mut() {
            link.label.push(' ');
            link.spans.push(Span::styled(" ", style));
            return;
        }
        self.current_spans.push(Span::raw(" "));
    }

    fn append_link_spans(&mut self, url: &str, label: &str, spans: Vec<Span<'static>>) {
        if url.starts_with("file://") {
            if spans.is_empty() {
                self.current_spans
                    .push(hyperlink::link_span(url, label, self.styles.link));
            } else {
                for span in spans {
                    self.current_spans.push(Span::styled(
                        hyperlink::wrap_in_link(url, span.content.as_ref()),
                        span.style,
                    ));
                }
            }
            return;
        }
        if spans.is_empty() {
            self.current_spans
                .push(Span::styled(label.to_string(), self.styles.link));
        } else {
            self.current_spans.extend(spans);
        }
    }

    fn add_hard_break(&mut self) {
        let pending_link_segment = if let Some(link) = self.current_link.as_mut() {
            if link.label.is_empty() && link.spans.is_empty() {
                None
            } else {
                let segment_spans = std::mem::take(&mut link.spans);
                let segment_label = std::mem::take(&mut link.label);
                let url = link.url.clone();
                Some((url, segment_label, segment_spans))
            }
        } else {
            None
        };
        if let Some((url, label, spans)) = pending_link_segment {
            self.append_link_spans(&url, &label, spans);
            if let Some(link) = self.current_link.as_mut() {
                link.has_rendered_segment = true;
            }
        }
        self.flush_line();
    }

    fn render(&mut self, parser: Parser<'_>) {
        for event in parser {
            match event {
                Event::Start(tag) => self.start_tag(tag),
                Event::End(tag) => self.end_tag(tag),
                Event::Text(text) => self.add_text(&text),
                Event::Code(code) => self.add_inline_code(&code),
                Event::SoftBreak => self.add_soft_break(),
                Event::HardBreak => self.add_hard_break(),
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
                self.current_link = Some(LinkState {
                    url: dest_url.to_string(),
                    label: String::new(),
                    spans: Vec::new(),
                    has_rendered_segment: false,
                });
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
                if let Some(link) = self.current_link.take() {
                    if link.label.is_empty() && link.spans.is_empty() && link.has_rendered_segment {
                        if !link.url.starts_with("file://") {
                            self.current_spans.push(Span::styled(
                                format!(" ({})", link.url),
                                Style::default().fg(Color::DarkGray),
                            ));
                        }
                        return;
                    }
                    let label = if link.label.is_empty() {
                        link.url.as_str()
                    } else {
                        link.label.as_str()
                    };
                    self.append_link_spans(&link.url, label, link.spans);
                    if !link.url.starts_with("file://") {
                        self.current_spans.push(Span::styled(
                            format!(" ({})", link.url),
                            Style::default().fg(Color::DarkGray),
                        ));
                    }
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

    #[test]
    fn renders_file_uri_links_as_terminal_hyperlinks() {
        let text =
            render_markdown("See [src/main.ts](file:///Users/alice/work/maestro/src/main.ts#L42).");
        let rendered: String = text
            .lines
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.as_ref()))
            .collect();

        assert!(crate::hyperlink::contains_hyperlink(&rendered));
        assert_eq!(
            crate::hyperlink::extract_urls(&rendered),
            vec!["file:///Users/alice/work/maestro/src/main.ts#L42"]
        );
        assert_eq!(
            crate::hyperlink::strip_hyperlinks(&rendered),
            "See src/main.ts."
        );
    }

    #[test]
    fn keeps_soft_breaks_inside_file_uri_link_labels() {
        let text =
            render_markdown("See [src\nmain.ts](file:///Users/alice/work/maestro/src/main.ts).");
        let rendered: String = text
            .lines
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.as_ref()))
            .collect();

        assert!(crate::hyperlink::contains_hyperlink(&rendered));
        assert_eq!(
            crate::hyperlink::strip_hyperlinks(&rendered),
            "See src main.ts."
        );
    }

    #[test]
    fn preserves_hard_breaks_inside_file_uri_link_labels() {
        let text =
            render_markdown("See [src  \nmain.ts](file:///Users/alice/work/maestro/src/main.ts).");
        let rendered_lines: Vec<String> = text
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        let rendered = rendered_lines.join("\n");

        assert!(crate::hyperlink::contains_hyperlink(&rendered));
        assert_eq!(
            rendered_lines
                .iter()
                .map(|line| crate::hyperlink::strip_hyperlinks(line))
                .collect::<Vec<_>>(),
            vec!["See src".to_string(), "main.ts.".to_string()]
        );
    }

    #[test]
    fn skips_empty_hard_break_file_uri_link_segments() {
        let text =
            render_markdown("See [\\\nmain.ts](file:///Users/alice/work/maestro/src/main.ts).");
        let rendered_lines: Vec<String> = text
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        let visible_lines: Vec<String> = rendered_lines
            .iter()
            .map(|line| crate::hyperlink::strip_hyperlinks(line))
            .collect();

        assert!(crate::hyperlink::contains_hyperlink(
            &rendered_lines.join("\n")
        ));
        assert!(visible_lines
            .iter()
            .all(|line| !line.contains("file:///Users/alice/work/maestro/src/main.ts")));
        assert_eq!(
            visible_lines,
            vec!["See ".to_string(), "main.ts.".to_string()]
        );
    }

    #[test]
    fn skips_consecutive_empty_hard_break_file_uri_link_segments() {
        let text = render_markdown(
            "See [src\\\n\\\nmain.ts](file:///Users/alice/work/maestro/src/main.ts).",
        );
        let rendered_lines: Vec<String> = text
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        let visible_lines: Vec<String> = rendered_lines
            .iter()
            .map(|line| crate::hyperlink::strip_hyperlinks(line))
            .collect();

        assert!(crate::hyperlink::contains_hyperlink(
            &rendered_lines.join("\n")
        ));
        assert!(!visible_lines
            .iter()
            .any(|line| line.contains("file:///Users/alice/work/maestro/src/main.ts")));
        assert_eq!(
            visible_lines,
            vec!["See src".to_string(), "main.ts.".to_string()]
        );
    }

    #[test]
    fn skips_empty_link_end_after_hard_break_file_uri_segment() {
        let text = render_markdown("See [src\\\n](file:///Users/alice/work/maestro/src/main.ts)");
        let rendered_lines: Vec<String> = text
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        let visible_lines: Vec<String> = rendered_lines
            .iter()
            .map(|line| crate::hyperlink::strip_hyperlinks(line))
            .collect();

        assert!(crate::hyperlink::contains_hyperlink(
            &rendered_lines.join("\n")
        ));
        assert!(visible_lines
            .iter()
            .all(|line| !line.contains("file:///Users/alice/work/maestro/src/main.ts")));
        assert_eq!(visible_lines, vec!["See src".to_string()]);
    }

    #[test]
    fn keeps_non_file_url_fallback_after_empty_hard_break_link_end() {
        let text = render_markdown("See [the docs\\\n](https://example.com/docs)");
        let rendered_lines: Vec<String> = text
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();

        assert_eq!(
            rendered_lines,
            vec![
                "See the docs".to_string(),
                " (https://example.com/docs)".to_string()
            ]
        );
    }

    #[test]
    fn keeps_non_file_links_visible_for_terminal_fallback() {
        let text = render_markdown("Read [the docs](https://example.com/docs).");
        let rendered: String = text
            .lines
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.as_ref()))
            .collect();

        assert!(!crate::hyperlink::contains_hyperlink(&rendered));
        assert_eq!(rendered, "Read the docs (https://example.com/docs).");
    }

    #[test]
    fn preserves_nested_styles_in_non_file_links() {
        let text = render_markdown("Read [the **bold** docs](https://example.com/docs).");
        let rendered: String = text
            .lines
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.as_ref()))
            .collect();
        let bold_span = text
            .lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .find(|span| span.content.as_ref() == "bold")
            .expect("bold link label span should be preserved");

        assert_eq!(rendered, "Read the bold docs (https://example.com/docs).");
        assert!(bold_span.style.add_modifier.contains(Modifier::BOLD));
        assert!(bold_span.style.add_modifier.contains(Modifier::UNDERLINED));
    }
}
