//! Text widget

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::{Paragraph, Widget, Wrap},
};

use crate::protocol::TextStyle;

/// A simple text widget
pub struct TextWidget {
    content: String,
    style: Style,
}

impl TextWidget {
    pub fn new(content: impl Into<String>, style: TextStyle) -> Self {
        Self {
            content: content.into(),
            style: style.into(),
        }
    }

    pub fn plain(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            style: Style::default(),
        }
    }
}

impl Widget for TextWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let paragraph = Paragraph::new(self.content)
            .style(self.style)
            .wrap(Wrap { trim: false });
        paragraph.render(area, buf);
    }
}

/// A styled text widget with multiple spans
pub struct StyledTextWidget {
    spans: Vec<crate::protocol::StyledSpan>,
}

impl StyledTextWidget {
    pub fn new(spans: Vec<crate::protocol::StyledSpan>) -> Self {
        Self { spans }
    }
}

impl Widget for StyledTextWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let spans: Vec<Span> = self
            .spans
            .into_iter()
            .map(|s| Span::styled(s.text, Style::from(s.style)))
            .collect();
        let line = Line::from(spans);
        let paragraph = Paragraph::new(line).wrap(Wrap { trim: false });
        paragraph.render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_widget_render() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 1));
        let widget = TextWidget::plain("Hello");
        widget.render(buf.area, &mut buf);

        // Check that "Hello" was rendered
        let content: String = (0..5).map(|x| buf.cell((x, 0)).unwrap().symbol()).collect();
        assert_eq!(content, "Hello");
    }
}
