//! Render tree to widgets converter

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};

use crate::components::{BoxWidget, EditorWidget, InputWidget, TextWidget, column_layout, row_layout, render_scrollbar};
use crate::protocol::{RenderNode, StyledSpan};

/// Renderer that converts RenderNode tree to ratatui widgets
pub struct Renderer;

impl Renderer {
    pub fn new() -> Self {
        Self
    }

    /// Render a node tree to the buffer
    pub fn render(&self, node: &RenderNode, area: Rect, buf: &mut Buffer) {
        match node {
            RenderNode::Text { content, style } => {
                let widget = TextWidget::new(content.clone(), style.clone());
                widget.render(area, buf);
            }

            RenderNode::StyledText { spans } => {
                let widget = crate::components::StyledTextWidget::new(spans.clone());
                widget.render(area, buf);
            }

            RenderNode::Column { children, gap } => {
                let child_areas = column_layout(area, children.len(), *gap);
                for (child, child_area) in children.iter().zip(child_areas.iter()) {
                    self.render(child, *child_area, buf);
                }
            }

            RenderNode::Row { children, gap } => {
                let child_areas = row_layout(area, children.len(), *gap);
                for (child, child_area) in children.iter().zip(child_areas.iter()) {
                    self.render(child, *child_area, buf);
                }
            }

            RenderNode::Box { child, border, padding, title } => {
                let mut widget = BoxWidget::new()
                    .border(border.clone())
                    .padding(padding.clone());

                if let Some(t) = title {
                    widget = widget.title(t.clone());
                }

                // Get inner area for child
                let inner_area = widget.inner_area(area);

                // Render the box border
                widget.render(area, buf);

                // Render child in inner area
                if let Some(c) = child {
                    self.render(c, inner_area, buf);
                }
            }

            RenderNode::Scroll { child, offset, content_height, show_scrollbar } => {
                // Calculate content area (leave room for scrollbar if shown)
                let (content_area, scrollbar_area) = if *show_scrollbar && *content_height > area.height {
                    let content_width = area.width.saturating_sub(1);
                    (
                        Rect::new(area.x, area.y, content_width, area.height),
                        Some(Rect::new(area.right() - 1, area.y, 1, area.height)),
                    )
                } else {
                    (area, None)
                };

                // Render child content
                self.render(child, content_area, buf);

                // Render scrollbar
                if let Some(sb_area) = scrollbar_area {
                    render_scrollbar(buf, sb_area, *offset, *content_height, area.height);
                }
            }

            RenderNode::Input { value, cursor, placeholder, focused } => {
                let mut widget = InputWidget::new(value.clone(), *cursor, *focused);
                if let Some(p) = placeholder {
                    widget = widget.placeholder(p.clone());
                }
                widget.render(area, buf);
            }

            RenderNode::Editor { lines, cursor, focused, scroll_offset } => {
                let widget = EditorWidget::new(lines.clone(), *cursor, *focused)
                    .scroll_offset(*scroll_offset);
                widget.render(area, buf);
            }

            RenderNode::Markdown { lines } => {
                self.render_markdown(lines, area, buf);
            }

            RenderNode::SelectList { items, selected, scroll_offset } => {
                self.render_select_list(items, *selected, *scroll_offset, area, buf);
            }

            RenderNode::StatusBar { left, center: _, right } => {
                self.render_status_bar(left, right, area, buf);
            }

            RenderNode::Spacer { size: _ } => {
                // Spacer doesn't render anything visible
            }

            RenderNode::Empty => {
                // Nothing to render
            }
        }
    }

    fn render_markdown(&self, lines: &[Vec<StyledSpan>], area: Rect, buf: &mut Buffer) {
        let display_lines: Vec<Line> = lines
            .iter()
            .map(|spans| {
                let ratatui_spans: Vec<Span> = spans
                    .iter()
                    .map(|s| Span::styled(s.text.clone(), Style::from(s.style.clone())))
                    .collect();
                Line::from(ratatui_spans)
            })
            .collect();

        let paragraph = Paragraph::new(display_lines);
        paragraph.render(area, buf);
    }

    fn render_select_list(
        &self,
        items: &[crate::protocol::SelectItem],
        selected: usize,
        scroll_offset: usize,
        area: Rect,
        buf: &mut Buffer,
    ) {
        let visible_count = area.height as usize;
        let start = scroll_offset;
        let end = (start + visible_count).min(items.len());

        let lines: Vec<Line> = items[start..end]
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let index = start + i;
                let is_selected = index == selected;
                let prefix = if is_selected { "> " } else { "  " };

                let style = if is_selected {
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else if item.disabled {
                    Style::default().fg(Color::DarkGray)
                } else {
                    Style::default()
                };

                Line::from(Span::styled(format!("{}{}", prefix, item.label), style))
            })
            .collect();

        let paragraph = Paragraph::new(lines);
        paragraph.render(area, buf);
    }

    fn render_status_bar(
        &self,
        left: &[crate::protocol::StatusItem],
        right: &[crate::protocol::StatusItem],
        area: Rect,
        buf: &mut Buffer,
    ) {
        // Render left items
        if !left.is_empty() {
            let spans: Vec<Span> = left
                .iter()
                .map(|item| Span::styled(item.content.clone(), Style::from(item.style.clone())))
                .collect();
            let para = Paragraph::new(Line::from(spans));
            para.render(area, buf);
        }

        // Render right items (right-aligned)
        if !right.is_empty() {
            let text: String = right.iter().map(|i| i.content.as_str()).collect();
            let right_width = text.len() as u16;
            let right_area = Rect::new(
                area.right().saturating_sub(right_width),
                area.y,
                right_width,
                area.height,
            );
            let spans: Vec<Span> = right
                .iter()
                .map(|item| Span::styled(item.content.clone(), Style::from(item.style.clone())))
                .collect();
            let para = Paragraph::new(Line::from(spans));
            para.render(right_area, buf);
        }
    }
}

impl Default for Renderer {
    fn default() -> Self {
        Self::new()
    }
}
