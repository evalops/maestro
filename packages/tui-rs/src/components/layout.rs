//! Layout widgets (Column, Row, Box)
//!
//! Note: These are simplified versions. The actual rendering of children
//! is delegated to the Renderer which handles the RenderNode tree directly.

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    widgets::{Block, Borders, Widget},
};

use crate::protocol::{BorderStyle, Padding};

/// Box container with optional border
pub struct BoxWidget {
    border: BorderStyle,
    padding: Padding,
    title: Option<String>,
}

impl BoxWidget {
    pub fn new() -> Self {
        Self {
            border: BorderStyle::None,
            padding: Padding::default(),
            title: None,
        }
    }

    pub fn border(mut self, border: BorderStyle) -> Self {
        self.border = border;
        self
    }

    pub fn padding(mut self, padding: Padding) -> Self {
        self.padding = padding;
        self
    }

    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Get the inner area after applying border and padding
    pub fn inner_area(&self, area: Rect) -> Rect {
        let border_offset = match self.border {
            BorderStyle::None => 0,
            _ => 1,
        };

        Rect::new(
            area.x + border_offset + self.padding.left,
            area.y + border_offset + self.padding.top,
            area.width.saturating_sub(2 * border_offset + self.padding.left + self.padding.right),
            area.height.saturating_sub(2 * border_offset + self.padding.top + self.padding.bottom),
        )
    }
}

impl Default for BoxWidget {
    fn default() -> Self {
        Self::new()
    }
}

impl Widget for BoxWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        match self.border {
            BorderStyle::None => {}
            _ => {
                let borders = Borders::ALL;

                let mut block = Block::default().borders(borders);

                // Set border style
                block = match self.border {
                    BorderStyle::Single => block.border_type(ratatui::widgets::BorderType::Plain),
                    BorderStyle::Double => block.border_type(ratatui::widgets::BorderType::Double),
                    BorderStyle::Rounded => {
                        block.border_type(ratatui::widgets::BorderType::Rounded)
                    }
                    BorderStyle::Heavy => block.border_type(ratatui::widgets::BorderType::Thick),
                    BorderStyle::None => block,
                };

                if let Some(title) = self.title {
                    block = block.title(title);
                }

                block.render(area, buf);
            }
        }
    }
}

/// Calculate child areas for a column layout
pub fn column_layout(area: Rect, child_count: usize, gap: u16) -> Vec<Rect> {
    if child_count == 0 || area.height == 0 {
        return Vec::new();
    }

    let total_gap = gap * (child_count.saturating_sub(1)) as u16;
    let available = area.height.saturating_sub(total_gap);
    let child_height = available / child_count as u16;

    let mut result = Vec::with_capacity(child_count);
    let mut y = area.y;

    for i in 0..child_count {
        if y >= area.bottom() {
            break;
        }
        let height = if i == child_count - 1 {
            // Last child gets remaining space
            area.bottom().saturating_sub(y)
        } else {
            child_height.min(area.bottom() - y)
        };
        result.push(Rect::new(area.x, y, area.width, height));
        y += height + gap;
    }

    result
}

/// Calculate child areas for a row layout
pub fn row_layout(area: Rect, child_count: usize, gap: u16) -> Vec<Rect> {
    if child_count == 0 || area.width == 0 {
        return Vec::new();
    }

    let total_gap = gap * (child_count.saturating_sub(1)) as u16;
    let available = area.width.saturating_sub(total_gap);
    let child_width = available / child_count as u16;

    let mut result = Vec::with_capacity(child_count);
    let mut x = area.x;

    for i in 0..child_count {
        if x >= area.right() {
            break;
        }
        let width = if i == child_count - 1 {
            area.right().saturating_sub(x)
        } else {
            child_width.min(area.right() - x)
        };
        result.push(Rect::new(x, area.y, width, area.height));
        x += width + gap;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_box_inner_area() {
        let widget = BoxWidget::new().border(BorderStyle::Single);
        let outer = Rect::new(0, 0, 10, 5);
        let inner = widget.inner_area(outer);

        assert_eq!(inner.x, 1);
        assert_eq!(inner.y, 1);
        assert_eq!(inner.width, 8);
        assert_eq!(inner.height, 3);
    }

    #[test]
    fn test_column_layout() {
        let area = Rect::new(0, 0, 10, 10);
        let areas = column_layout(area, 2, 0);

        assert_eq!(areas.len(), 2);
        assert_eq!(areas[0].height, 5);
        assert_eq!(areas[1].height, 5);
    }

    #[test]
    fn test_row_layout() {
        let area = Rect::new(0, 0, 10, 10);
        let areas = row_layout(area, 2, 0);

        assert_eq!(areas.len(), 2);
        assert_eq!(areas[0].width, 5);
        assert_eq!(areas[1].width, 5);
    }
}
