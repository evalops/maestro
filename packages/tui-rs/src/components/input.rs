//! Input and Editor widgets

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};

/// Single-line input widget
pub struct InputWidget {
    value: String,
    cursor: usize,
    placeholder: Option<String>,
    focused: bool,
}

impl InputWidget {
    pub fn new(value: impl Into<String>, cursor: usize, focused: bool) -> Self {
        Self {
            value: value.into(),
            cursor,
            placeholder: None,
            focused,
        }
    }

    pub fn placeholder(mut self, placeholder: impl Into<String>) -> Self {
        self.placeholder = Some(placeholder.into());
        self
    }
}

impl Widget for InputWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let display_text = if self.value.is_empty() {
            self.placeholder.clone().unwrap_or_default()
        } else {
            self.value.clone()
        };

        let style = if self.value.is_empty() && self.placeholder.is_some() {
            Style::default().fg(Color::DarkGray)
        } else {
            Style::default()
        };

        // Simple rendering - just show text
        // In a real implementation, we'd handle scrolling for long inputs
        let paragraph = Paragraph::new(display_text).style(style);
        paragraph.render(area, buf);

        // Cursor position would be reported separately for the parent to handle
    }
}

/// Multi-line editor widget
pub struct EditorWidget {
    lines: Vec<String>,
    cursor: (usize, usize), // (line, column)
    focused: bool,
    scroll_offset: usize,
}

impl EditorWidget {
    pub fn new(lines: Vec<String>, cursor: (usize, usize), focused: bool) -> Self {
        Self {
            lines,
            cursor,
            focused,
            scroll_offset: 0,
        }
    }

    pub fn scroll_offset(mut self, offset: usize) -> Self {
        self.scroll_offset = offset;
        self
    }
}

impl Widget for EditorWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let visible_lines = area.height as usize;
        let start = self.scroll_offset;
        let end = (start + visible_lines).min(self.lines.len());

        let display_lines: Vec<Line> = self.lines[start..end]
            .iter()
            .enumerate()
            .map(|(i, line_text)| {
                let line_num = start + i;
                let is_cursor_line = line_num == self.cursor.0;

                if is_cursor_line && self.focused {
                    // Highlight cursor line
                    Line::from(Span::styled(
                        line_text.clone(),
                        Style::default().add_modifier(Modifier::UNDERLINED),
                    ))
                } else {
                    Line::from(line_text.clone())
                }
            })
            .collect();

        let paragraph = Paragraph::new(display_lines);
        paragraph.render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_input_widget() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 20, 1));
        let widget = InputWidget::new("Hello", 5, true);
        widget.render(buf.area, &mut buf);

        let content: String = (0..5).map(|x| buf.cell((x, 0)).unwrap().symbol()).collect();
        assert_eq!(content, "Hello");
    }

    #[test]
    fn test_editor_widget() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 20, 3));
        let lines = vec![
            "Line 1".to_string(),
            "Line 2".to_string(),
            "Line 3".to_string(),
        ];
        let widget = EditorWidget::new(lines, (1, 0), true);
        widget.render(buf.area, &mut buf);

        let line1: String = (0..6).map(|x| buf.cell((x, 0)).unwrap().symbol()).collect();
        assert_eq!(line1, "Line 1");
    }
}
