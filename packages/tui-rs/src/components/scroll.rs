//! Scroll container utilities
//!
//! Note: The actual scroll container is handled by the Renderer.
//! This module provides the scrollbar rendering utility.

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
};

/// Render a simple scrollbar
pub fn render_scrollbar(
    buf: &mut Buffer,
    area: Rect,
    offset: u16,
    content_height: u16,
    viewport_height: u16,
) {
    if content_height <= viewport_height || area.height == 0 {
        return;
    }

    // Calculate thumb position and size
    let track_height = area.height as f32;
    let thumb_height = (viewport_height as f32 / content_height as f32 * track_height)
        .max(1.0)
        .min(track_height) as u16;

    let max_offset = content_height.saturating_sub(viewport_height);
    let thumb_position = if max_offset > 0 {
        (offset as f32 / max_offset as f32 * (track_height - thumb_height as f32)) as u16
    } else {
        0
    };

    // Draw track
    let track_style = Style::default().fg(Color::DarkGray);
    for y in 0..area.height {
        if let Some(cell) = buf.cell_mut((area.x, area.y + y)) {
            cell.set_symbol("│").set_style(track_style);
        }
    }

    // Draw thumb
    let thumb_style = Style::default().fg(Color::White);
    for y in 0..thumb_height {
        let thumb_y = area.y + thumb_position + y;
        if thumb_y < area.bottom() {
            if let Some(cell) = buf.cell_mut((area.x, thumb_y)) {
                cell.set_symbol("█").set_style(thumb_style);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_scrollbar_no_overflow() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 1, 5));
        let area = buf.area;
        render_scrollbar(&mut buf, area, 0, 3, 5);
        // No scrollbar needed when content fits
    }

    #[test]
    fn test_render_scrollbar_with_overflow() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 1, 5));
        let area = buf.area;
        render_scrollbar(&mut buf, area, 0, 20, 5);
        // Scrollbar should be rendered
        assert!(buf.cell((0, 0)).unwrap().symbol() == "█" || buf.cell((0, 0)).unwrap().symbol() == "│");
    }
}
