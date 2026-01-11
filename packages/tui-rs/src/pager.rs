//! Pager overlay for scrollable content
//!
//! Provides a full-screen scrollable view with vim-style navigation.

use crossterm::event::KeyCode;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap};

use crate::key_hints::{self, KeyBinding};

/// Navigation bindings for the pager
pub mod bindings {
    use super::{key_hints, KeyBinding, KeyCode};

    pub const UP: KeyBinding = key_hints::plain(KeyCode::Up);
    pub const DOWN: KeyBinding = key_hints::plain(KeyCode::Down);
    pub const PAGE_UP: KeyBinding = key_hints::plain(KeyCode::PageUp);
    pub const PAGE_DOWN: KeyBinding = key_hints::plain(KeyCode::PageDown);
    pub const HALF_PAGE_UP: KeyBinding = key_hints::ctrl(KeyCode::Char('u'));
    pub const HALF_PAGE_DOWN: KeyBinding = key_hints::ctrl(KeyCode::Char('d'));
    pub const HOME: KeyBinding = key_hints::plain(KeyCode::Home);
    pub const END: KeyBinding = key_hints::plain(KeyCode::End);
    pub const VIM_UP: KeyBinding = key_hints::plain(KeyCode::Char('k'));
    pub const VIM_DOWN: KeyBinding = key_hints::plain(KeyCode::Char('j'));
    pub const VIM_TOP: KeyBinding = key_hints::plain(KeyCode::Char('g'));
    pub const VIM_BOTTOM: KeyBinding = key_hints::shift(KeyCode::Char('G'));
    pub const QUIT: KeyBinding = key_hints::plain(KeyCode::Char('q'));
    pub const ESCAPE: KeyBinding = key_hints::plain(KeyCode::Esc);
    pub const SPACE: KeyBinding = key_hints::plain(KeyCode::Char(' '));
}

/// A scrollable pager overlay
pub struct Pager<'a> {
    /// Content to display
    content: Text<'a>,
    /// Optional title
    title: Option<String>,
    /// Current scroll offset (line number)
    scroll: usize,
    /// Whether the pager is done (user closed it)
    done: bool,
    /// Show line numbers
    show_line_numbers: bool,
    /// Wrap long lines
    wrap: bool,
}

impl<'a> Pager<'a> {
    /// Create a new pager with the given content
    #[must_use]
    pub fn new(content: Text<'a>) -> Self {
        Self {
            content,
            title: None,
            scroll: 0,
            done: false,
            show_line_numbers: false,
            wrap: true,
        }
    }

    /// Create a pager from lines
    #[must_use]
    pub fn from_lines(lines: Vec<Line<'a>>) -> Self {
        Self::new(Text::from(lines))
    }

    /// Create a pager from a string
    pub fn from_string(text: impl Into<String>) -> Self {
        Self::new(Text::raw(text.into()))
    }

    /// Set the title
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Show line numbers
    #[must_use]
    pub fn line_numbers(mut self, show: bool) -> Self {
        self.show_line_numbers = show;
        self
    }

    /// Enable/disable line wrapping
    #[must_use]
    pub fn wrap(mut self, wrap: bool) -> Self {
        self.wrap = wrap;
        self
    }

    /// Check if the pager is done
    #[must_use]
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// Handle a key event
    pub fn handle_key(&mut self, code: KeyCode, viewport_height: usize) {
        let content_height = self.content.lines.len();
        let page_size = viewport_height.saturating_sub(4); // Account for borders and footer

        match code {
            // Scrolling
            KeyCode::Up | KeyCode::Char('k') => {
                self.scroll = self.scroll.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                let max_scroll = content_height.saturating_sub(1).max(0);
                self.scroll = (self.scroll + 1).min(max_scroll);
            }
            KeyCode::PageUp => {
                self.scroll = self.scroll.saturating_sub(page_size);
            }
            KeyCode::PageDown | KeyCode::Char(' ') => {
                self.scroll =
                    (self.scroll + page_size).min(content_height.saturating_sub(page_size));
            }
            KeyCode::Home | KeyCode::Char('g') => {
                self.scroll = 0;
            }
            KeyCode::End | KeyCode::Char('G') => {
                self.scroll = content_height.saturating_sub(page_size);
            }
            // Close
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {
                self.done = true;
            }
            _ => {}
        }
    }

    /// Get the content height
    #[must_use]
    pub fn content_height(&self) -> usize {
        self.content.lines.len()
    }

    /// Get current scroll position
    #[must_use]
    pub fn scroll_position(&self) -> usize {
        self.scroll
    }
}

impl Widget for Pager<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Clear the area first
        Clear.render(area, buf);

        // Create the block with title
        let mut block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray));

        if let Some(title) = &self.title {
            block = block.title(format!(" {title} "));
        }

        // Inner area for content
        let inner = block.inner(area);

        // Render the block
        block.render(area, buf);

        // Calculate footer height
        let footer_height = 1;
        let content_height = inner.height.saturating_sub(footer_height);

        // Content area
        let content_area = Rect {
            x: inner.x,
            y: inner.y,
            width: inner.width,
            height: content_height,
        };

        // Footer area
        let footer_area = Rect {
            x: inner.x,
            y: inner.y + content_height,
            width: inner.width,
            height: footer_height,
        };

        // Render content with scroll (clamp to u16::MAX to avoid truncation)
        let scroll_row = self.scroll.min(u16::MAX as usize) as u16;
        let mut paragraph = Paragraph::new(self.content.clone()).scroll((scroll_row, 0));

        if self.wrap {
            paragraph = paragraph.wrap(Wrap { trim: false });
        }

        paragraph.render(content_area, buf);

        // Render footer with hints
        let footer = create_footer(
            self.scroll,
            self.content.lines.len(),
            content_height as usize,
        );
        footer.render(footer_area, buf);
    }
}

/// Create the footer line with navigation hints
fn create_footer(scroll: usize, total_lines: usize, visible_lines: usize) -> Line<'static> {
    let mut spans = Vec::new();

    // Position indicator
    let position = if total_lines <= visible_lines {
        "All".to_string()
    } else if scroll == 0 {
        "Top".to_string()
    } else if scroll + visible_lines >= total_lines {
        "End".to_string()
    } else {
        let percent = (scroll * 100) / total_lines.max(1);
        format!("{percent}%")
    };

    spans.push(Span::styled(
        format!(" {position} "),
        Style::default().fg(Color::Black).bg(Color::DarkGray),
    ));

    spans.push(Span::raw(" "));

    // Navigation hints
    let hints = [
        ("↑↓", "scroll"),
        ("PgUp/Dn", "page"),
        ("g/G", "top/end"),
        ("q", "close"),
    ];

    for (i, (key, desc)) in hints.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(" │ ", Style::default().fg(Color::DarkGray)));
        }
        spans.push(Span::styled(
            (*key).to_string(),
            Style::default().add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::raw(" "));
        spans.push(Span::styled(
            (*desc).to_string(),
            Style::default().fg(Color::DarkGray),
        ));
    }

    Line::from(spans)
}

/// A modal pager that can be shown over other content
pub struct PagerModal<'a> {
    pager: Pager<'a>,
}

impl<'a> PagerModal<'a> {
    #[must_use]
    pub fn new(content: Text<'a>) -> Self {
        Self {
            pager: Pager::new(content),
        }
    }

    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.pager = self.pager.title(title);
        self
    }

    #[must_use]
    pub fn is_done(&self) -> bool {
        self.pager.is_done()
    }

    pub fn handle_key(&mut self, code: KeyCode, viewport_height: usize) {
        self.pager.handle_key(code, viewport_height);
    }
}

impl Widget for PagerModal<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Add some margin around the pager
        let margin = 2u16;
        let pager_area = Rect {
            x: area.x + margin,
            y: area.y + margin,
            width: area.width.saturating_sub(margin * 2),
            height: area.height.saturating_sub(margin * 2),
        };

        self.pager.render(pager_area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pager_scrolls() {
        let content = Text::from(vec![
            Line::from("Line 1"),
            Line::from("Line 2"),
            Line::from("Line 3"),
        ]);
        let mut pager = Pager::new(content);

        assert_eq!(pager.scroll_position(), 0);

        pager.handle_key(KeyCode::Down, 10);
        assert_eq!(pager.scroll_position(), 1);

        pager.handle_key(KeyCode::Up, 10);
        assert_eq!(pager.scroll_position(), 0);
    }

    #[test]
    fn pager_closes_on_q() {
        let mut pager = Pager::from_string("test");
        assert!(!pager.is_done());

        pager.handle_key(KeyCode::Char('q'), 10);
        assert!(pager.is_done());
    }

    #[test]
    fn pager_closes_on_esc() {
        let mut pager = Pager::from_string("test");
        pager.handle_key(KeyCode::Esc, 10);
        assert!(pager.is_done());
    }
}
