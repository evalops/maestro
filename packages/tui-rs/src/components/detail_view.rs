//! Full-output detail view overlay.
//!
//! Opened with Ctrl+E (from the transcript or the approval modal), the detail
//! view shows the complete, untruncated content of an expandable item: a tool
//! call's full output, a full error body, or full message text. The inline
//! transcript clamps tool output (5 lines collapsed, 50 expanded, plus a
//! char/line clamp) and the error surface clamps to 8 wrapped lines; this
//! overlay imposes no limit.
//!
//! Rendering follows the overlay convention: the covered cells are blanked
//! with `Clear` before the bordered panel is drawn, so no stale frame content
//! shows through.

use crossterm::event::KeyCode;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap};

/// A scrollable overlay showing full, untruncated content.
///
/// State lives in the struct (title, content, scroll offset); rendering goes
/// through `impl Widget for &DetailView` so the app can keep the instance
/// across frames without cloning the content.
pub struct DetailView {
    /// Panel title (e.g. "Tool: bash").
    title: String,
    /// Full untruncated content.
    content: String,
    /// Current scroll offset (line number).
    scroll: usize,
}

impl DetailView {
    /// Create a detail view for the given title and content.
    pub fn new(title: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            content: content.into(),
            scroll: 0,
        }
    }

    /// The panel title.
    #[must_use]
    pub fn title(&self) -> &str {
        &self.title
    }

    /// The full untruncated content.
    #[must_use]
    pub fn content(&self) -> &str {
        &self.content
    }

    /// Current scroll offset in lines.
    #[must_use]
    pub fn scroll_position(&self) -> usize {
        self.scroll
    }

    /// Number of content lines.
    #[must_use]
    pub fn content_height(&self) -> usize {
        self.content.lines().count()
    }

    /// Handle a key event. Returns `true` when the view asked to close.
    ///
    /// Scrolling: Up/Down (and j/k), PageUp/PageDown, Home/End (and g/G).
    /// Close: Esc, q, or Enter.
    pub fn handle_key(&mut self, code: KeyCode, viewport_height: usize) -> bool {
        let content_height = self.content_height();
        let page_size = viewport_height.saturating_sub(6).max(1);

        match code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.scroll = self.scroll.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.scroll = (self.scroll + 1).min(content_height.saturating_sub(1));
            }
            KeyCode::PageUp => {
                self.scroll = self.scroll.saturating_sub(page_size);
            }
            KeyCode::PageDown => {
                self.scroll =
                    (self.scroll + page_size).min(content_height.saturating_sub(page_size));
            }
            KeyCode::Home | KeyCode::Char('g') => {
                self.scroll = 0;
            }
            KeyCode::End | KeyCode::Char('G') => {
                self.scroll = content_height.saturating_sub(page_size);
            }
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {
                return true;
            }
            _ => {}
        }
        false
    }
}

impl Widget for &DetailView {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Centered panel with a small margin, like the other overlays.
        let margin = 2u16;
        let panel = Rect {
            x: area.x + margin,
            y: area.y + margin,
            width: area.width.saturating_sub(margin * 2),
            height: area.height.saturating_sub(margin * 2),
        };
        if panel.width == 0 || panel.height == 0 {
            return;
        }

        // Overlay convention: blank the covered cells first so no stale
        // frame content mixes with the panel.
        Clear.render(panel, buf);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(format!(" {} ", self.title));
        let inner = block.inner(panel);
        block.render(panel, buf);

        let footer_height = 1u16;
        let content_height = inner.height.saturating_sub(footer_height);
        let content_area = Rect {
            x: inner.x,
            y: inner.y,
            width: inner.width,
            height: content_height,
        };
        let footer_area = Rect {
            x: inner.x,
            y: inner.y + content_height,
            width: inner.width,
            height: footer_height,
        };

        let scroll_row = self.scroll.min(u16::MAX as usize) as u16;
        Paragraph::new(self.content.as_str())
            .wrap(Wrap { trim: false })
            .scroll((scroll_row, 0))
            .render(content_area, buf);

        footer_line(
            self.scroll,
            self.content_height(),
            content_area.height as usize,
        )
        .render(footer_area, buf);
    }
}

/// Footer with a position indicator and key hints.
fn footer_line(scroll: usize, total_lines: usize, visible_lines: usize) -> Line<'static> {
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

    let mut spans = vec![
        Span::styled(
            format!(" {position} "),
            Style::default().fg(Color::Black).bg(Color::DarkGray),
        ),
        Span::raw(" "),
    ];
    for (i, (key, desc)) in [("↑↓", "scroll"), ("PgUp/Dn", "page"), ("Esc", "close")]
        .iter()
        .enumerate()
    {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrolls_with_arrows_and_pages() {
        let content = (1..=100)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut view = DetailView::new("Tool: bash", content);

        assert_eq!(view.scroll_position(), 0);
        assert!(!view.handle_key(KeyCode::Down, 24));
        assert_eq!(view.scroll_position(), 1);
        assert!(!view.handle_key(KeyCode::PageDown, 24));
        assert_eq!(view.scroll_position(), 19);
        assert!(!view.handle_key(KeyCode::End, 24));
        assert_eq!(view.scroll_position(), 82);
        assert!(!view.handle_key(KeyCode::Home, 24));
        assert_eq!(view.scroll_position(), 0);
        assert!(!view.handle_key(KeyCode::Up, 24));
        assert_eq!(view.scroll_position(), 0);
    }

    #[test]
    fn closes_on_esc_q_and_enter() {
        for code in [KeyCode::Esc, KeyCode::Char('q'), KeyCode::Enter] {
            let mut view = DetailView::new("t", "content");
            assert!(view.handle_key(code, 24));
        }
    }

    #[test]
    fn keeps_full_untruncated_content() {
        let long = "x".repeat(10_000);
        let view = DetailView::new("Tool: read", long.clone());
        assert_eq!(view.content(), long);
        assert_eq!(view.title(), "Tool: read");
    }

    #[test]
    fn render_blanks_cells_covered_by_overlay() {
        use ratatui::Terminal;
        use ratatui::backend::TestBackend;

        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).expect("test terminal");

        let view = DetailView::new("Tool: bash", "full output here");

        terminal
            .draw(|frame| {
                // Poison every cell with stale frame content; the overlay must
                // blank (Clear) the cells it covers before drawing.
                let area = frame.area();
                for y in area.top()..area.bottom() {
                    for x in area.left()..area.right() {
                        frame.buffer_mut()[(x, y)].set_symbol("X");
                    }
                }
                frame.render_widget(&view, area);
            })
            .expect("draw detail view");

        let buffer = terminal.backend().buffer();
        // Inside the panel (margin of 2 on each side) no poisoned cell may
        // survive; every covered cell is blank or panel content.
        for y in 2..22 {
            for x in 2..78 {
                let symbol = buffer[(x, y)].symbol();
                assert_ne!(symbol, "X", "cell ({x}, {y}) was not cleared");
            }
        }
        // Corners outside the panel keep the poisoned content, proving the
        // overlay only clears its own footprint.
        assert_eq!(buffer[(0, 0)].symbol(), "X");
    }
}
