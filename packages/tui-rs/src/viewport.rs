//! Viewport Management for Scrollable Content
//!
//! This module provides advanced viewport management with:
//! - Viewport clipping for partially visible content
//! - Scroll offset rendering with negative y positions
//! - Auto-scroll (follow bottom) behavior
//! - Chunk-based visibility ensuring
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

// ─────────────────────────────────────────────────────────────────────────────
// RENDERABLE TRAIT
// ─────────────────────────────────────────────────────────────────────────────

/// A trait for content that can be rendered to a buffer with a calculated height.
///
/// This is more flexible than ratatui's `Widget` because it allows querying
/// the desired height before rendering, enabling viewport calculations.
pub trait Renderable {
    /// Render this content to the given area of the buffer.
    fn render(&self, area: Rect, buf: &mut Buffer);

    /// Calculate the height needed to render this content at the given width.
    fn desired_height(&self, width: u16) -> u16;
}

/// Blanket implementation for references to Renderable.
impl<T: Renderable + ?Sized> Renderable for &T {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        (*self).render(area, buf);
    }

    fn desired_height(&self, width: u16) -> u16 {
        (*self).desired_height(width)
    }
}

/// Blanket implementation for Box<dyn Renderable>.
impl Renderable for Box<dyn Renderable> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        (**self).render(area, buf);
    }

    fn desired_height(&self, width: u16) -> u16 {
        (**self).desired_height(width)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHED RENDERABLE
// ─────────────────────────────────────────────────────────────────────────────

/// A wrapper that caches the desired height calculation.
///
/// This avoids recalculating height on every render when the width hasn't changed.
pub struct CachedRenderable<R: Renderable> {
    inner: R,
    cached_height: std::cell::Cell<Option<u16>>,
    cached_width: std::cell::Cell<Option<u16>>,
}

impl<R: Renderable> CachedRenderable<R> {
    /// Create a new cached renderable wrapper.
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            cached_height: std::cell::Cell::new(None),
            cached_width: std::cell::Cell::new(None),
        }
    }
}

impl<R: Renderable> Renderable for CachedRenderable<R> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        self.inner.render(area, buf);
    }

    fn desired_height(&self, width: u16) -> u16 {
        if self.cached_width.get() != Some(width) {
            let height = self.inner.desired_height(width);
            self.cached_height.set(Some(height));
            self.cached_width.set(Some(width));
        }
        self.cached_height.get().unwrap_or(0)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// VIEWPORT VIEW
// ─────────────────────────────────────────────────────────────────────────────

/// A scrollable view of renderable content.
///
/// This implements the core viewport logic from Codex CLI:
/// - Negative y offset for partially visible content at top
/// - Scroll clamping to valid range
/// - Auto-follow bottom behavior detection
/// - Chunk visibility ensuring
pub struct ViewportView {
    /// Current scroll offset in content rows.
    scroll_offset: usize,
    /// Last rendered content height (for auto-scroll detection).
    last_content_height: Option<usize>,
    /// Last viewport height used.
    last_viewport_height: Option<usize>,
    /// Pending request to scroll a chunk into view.
    pending_scroll_chunk: Option<usize>,
}

impl Default for ViewportView {
    fn default() -> Self {
        Self::new()
    }
}

impl ViewportView {
    /// Create a new viewport view starting at the top.
    pub fn new() -> Self {
        Self {
            scroll_offset: 0,
            last_content_height: None,
            last_viewport_height: None,
            pending_scroll_chunk: None,
        }
    }

    /// Create a new viewport view scrolled to the bottom.
    pub fn at_bottom() -> Self {
        Self {
            scroll_offset: usize::MAX,
            last_content_height: None,
            last_viewport_height: None,
            pending_scroll_chunk: None,
        }
    }

    /// Get the current scroll offset.
    pub fn scroll_offset(&self) -> usize {
        self.scroll_offset
    }

    /// Set the scroll offset directly.
    pub fn set_scroll_offset(&mut self, offset: usize) {
        self.scroll_offset = offset;
    }

    /// Scroll up by one line.
    pub fn scroll_up(&mut self) {
        self.scroll_offset = self.scroll_offset.saturating_sub(1);
    }

    /// Scroll down by one line.
    pub fn scroll_down(&mut self) {
        self.scroll_offset = self.scroll_offset.saturating_add(1);
    }

    /// Scroll up by a page.
    pub fn page_up(&mut self, viewport_height: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(viewport_height);
    }

    /// Scroll down by a page.
    pub fn page_down(&mut self, viewport_height: usize) {
        self.scroll_offset = self.scroll_offset.saturating_add(viewport_height);
    }

    /// Scroll up by half a page.
    pub fn half_page_up(&mut self, viewport_height: usize) {
        let half = viewport_height.saturating_add(1) / 2;
        self.scroll_offset = self.scroll_offset.saturating_sub(half);
    }

    /// Scroll down by half a page.
    pub fn half_page_down(&mut self, viewport_height: usize) {
        let half = viewport_height.saturating_add(1) / 2;
        self.scroll_offset = self.scroll_offset.saturating_add(half);
    }

    /// Jump to the top.
    pub fn go_to_top(&mut self) {
        self.scroll_offset = 0;
    }

    /// Jump to the bottom.
    pub fn go_to_bottom(&mut self) {
        self.scroll_offset = usize::MAX;
    }

    /// Check if the view is scrolled to the bottom.
    ///
    /// Used to determine if we should auto-follow new content.
    pub fn is_scrolled_to_bottom(&self) -> bool {
        if self.scroll_offset == usize::MAX {
            return true;
        }
        let Some(content_height) = self.last_content_height else {
            return false;
        };
        let Some(viewport_height) = self.last_viewport_height else {
            return false;
        };
        if content_height <= viewport_height {
            return true;
        }
        let max_scroll = content_height.saturating_sub(viewport_height);
        self.scroll_offset >= max_scroll
    }

    /// Request that a specific chunk index be scrolled into view on next render.
    pub fn scroll_chunk_into_view(&mut self, chunk_index: usize) {
        self.pending_scroll_chunk = Some(chunk_index);
    }

    /// Render content with viewport clipping.
    ///
    /// This is the core rendering function that handles:
    /// - Negative y offsets for partially visible content
    /// - Scroll clamping
    /// - End-of-content markers
    ///
    /// Returns the number of content rows actually rendered.
    pub fn render<R: Renderable>(
        &mut self,
        area: Rect,
        buf: &mut Buffer,
        renderables: &[R],
    ) -> usize {
        if area.height == 0 || area.width == 0 {
            return 0;
        }

        // Calculate total content height
        let content_height: usize = renderables
            .iter()
            .map(|r| r.desired_height(area.width) as usize)
            .sum();

        self.last_content_height = Some(content_height);
        self.last_viewport_height = Some(area.height as usize);

        // Handle pending scroll-into-view request
        if let Some(idx) = self.pending_scroll_chunk.take() {
            self.ensure_chunk_visible(idx, area, renderables);
        }

        // Clamp scroll offset to valid range
        self.scroll_offset = self
            .scroll_offset
            .min(content_height.saturating_sub(area.height as usize));

        // Render with viewport clipping
        let mut y = -(self.scroll_offset as isize);
        let mut drawn_bottom = area.y;

        for renderable in renderables {
            let top = y;
            let height = renderable.desired_height(area.width) as isize;
            y += height;
            let bottom = y;

            // Skip if completely above viewport
            if bottom <= 0 {
                continue;
            }

            // Stop if completely below viewport
            if top >= area.height as isize {
                break;
            }

            if top < 0 {
                // Partially visible at top - render with offset
                let offset = (-top) as u16;
                let drawn = render_with_offset(area, buf, renderable, offset);
                drawn_bottom = drawn_bottom.max(area.y + drawn);
            } else {
                // Fully visible (or partially at bottom)
                let draw_height = (height as u16).min(area.height.saturating_sub(top as u16));
                let draw_area = Rect::new(area.x, area.y + top as u16, area.width, draw_height);
                renderable.render(draw_area, buf);
                drawn_bottom = drawn_bottom.max(draw_area.y.saturating_add(draw_area.height));
            }
        }

        // Fill remaining viewport with end-of-content markers
        for row in drawn_bottom..area.bottom() {
            if area.width > 0 {
                if let Some(cell) = buf.cell_mut((area.x, row)) {
                    cell.set_symbol("~");
                }
                for x in area.x + 1..area.right() {
                    if let Some(cell) = buf.cell_mut((x, row)) {
                        cell.set_symbol(" ");
                    }
                }
            }
        }

        content_height
    }

    /// Ensure a specific chunk is visible in the viewport.
    fn ensure_chunk_visible<R: Renderable>(&mut self, idx: usize, area: Rect, renderables: &[R]) {
        if area.height == 0 || idx >= renderables.len() {
            return;
        }

        // Calculate the y position of the target chunk
        let chunk_top: usize = renderables
            .iter()
            .take(idx)
            .map(|r| r.desired_height(area.width) as usize)
            .sum();

        let chunk_height = renderables[idx].desired_height(area.width) as usize;
        let chunk_bottom = chunk_top + chunk_height;

        let viewport_height = area.height as usize;
        let current_top = self.scroll_offset;
        let current_bottom = current_top.saturating_add(viewport_height.saturating_sub(1));

        // Adjust scroll to bring chunk into view
        if chunk_top < current_top {
            self.scroll_offset = chunk_top;
        } else if chunk_bottom > current_bottom {
            self.scroll_offset = chunk_bottom.saturating_sub(viewport_height.saturating_sub(1));
        }
    }

    /// Calculate scroll percentage (0-100).
    pub fn scroll_percentage(&self, content_height: usize, viewport_height: usize) -> u8 {
        if content_height <= viewport_height {
            return 100;
        }
        let max_scroll = content_height.saturating_sub(viewport_height);
        if max_scroll == 0 {
            return 100;
        }
        let clamped_offset = self.scroll_offset.min(max_scroll);
        ((clamped_offset as f32 / max_scroll as f32) * 100.0).round() as u8
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// OFFSET RENDERING
// ─────────────────────────────────────────────────────────────────────────────

/// Render content that's partially visible at the top of the viewport.
///
/// This works by:
/// 1. Creating a temporary buffer tall enough for the content
/// 2. Rendering to that buffer
/// 3. Copying only the visible portion to the target buffer
///
/// Returns the number of rows copied.
fn render_with_offset<R: Renderable>(
    area: Rect,
    buf: &mut Buffer,
    renderable: &R,
    scroll_offset: u16,
) -> u16 {
    let height = renderable.desired_height(area.width);
    let temp_height = height.min(area.height + scroll_offset);

    // Create temporary buffer for full content
    let mut temp_buf = Buffer::empty(Rect::new(0, 0, area.width, temp_height));
    renderable.render(*temp_buf.area(), &mut temp_buf);

    // Copy visible portion to target buffer
    let copy_height = area.height.min(temp_buf.area().height.saturating_sub(scroll_offset));
    for y in 0..copy_height {
        let src_y = y + scroll_offset;
        for x in 0..area.width {
            if let (Some(src), Some(dst)) =
                (temp_buf.cell((x, src_y)), buf.cell_mut((area.x + x, area.y + y)))
            {
                *dst = src.clone();
            }
        }
    }

    copy_height
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMPLE RENDERABLES
// ─────────────────────────────────────────────────────────────────────────────

use ratatui::text::Text;
use ratatui::widgets::{Paragraph, Widget, Wrap};

/// A simple text renderable that wraps content.
pub struct TextRenderable {
    text: Text<'static>,
}

impl TextRenderable {
    /// Create a new text renderable.
    pub fn new(text: Text<'static>) -> Self {
        Self { text }
    }

    /// Create from lines.
    pub fn from_lines(lines: Vec<ratatui::text::Line<'static>>) -> Self {
        Self::new(Text::from(lines))
    }
}

impl Renderable for TextRenderable {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        Paragraph::new(self.text.clone())
            .wrap(Wrap { trim: false })
            .render(area, buf);
    }

    fn desired_height(&self, width: u16) -> u16 {
        if width == 0 {
            return 0;
        }
        crate::wrapping::wrapped_line_count(&self.text, width as usize) as u16
    }
}

/// A renderable with insets (padding/margin).
pub struct InsetRenderable<R: Renderable> {
    inner: R,
    top: u16,
    right: u16,
    bottom: u16,
    left: u16,
}

impl<R: Renderable> InsetRenderable<R> {
    /// Create with uniform insets.
    pub fn uniform(inner: R, inset: u16) -> Self {
        Self {
            inner,
            top: inset,
            right: inset,
            bottom: inset,
            left: inset,
        }
    }

    /// Create with specific insets (top, right, bottom, left).
    pub fn new(inner: R, top: u16, right: u16, bottom: u16, left: u16) -> Self {
        Self {
            inner,
            top,
            right,
            bottom,
            left,
        }
    }

    /// Create with only top inset (commonly used for spacing between items).
    pub fn top(inner: R, top: u16) -> Self {
        Self {
            inner,
            top,
            right: 0,
            bottom: 0,
            left: 0,
        }
    }
}

impl<R: Renderable> Renderable for InsetRenderable<R> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        let inner_area = Rect {
            x: area.x.saturating_add(self.left),
            y: area.y.saturating_add(self.top),
            width: area
                .width
                .saturating_sub(self.left)
                .saturating_sub(self.right),
            height: area
                .height
                .saturating_sub(self.top)
                .saturating_sub(self.bottom),
        };
        self.inner.render(inner_area, buf);
    }

    fn desired_height(&self, width: u16) -> u16 {
        let inner_width = width.saturating_sub(self.left).saturating_sub(self.right);
        self.inner
            .desired_height(inner_width)
            .saturating_add(self.top)
            .saturating_add(self.bottom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::text::Line;

    struct FixedHeightRenderable(u16);

    impl Renderable for FixedHeightRenderable {
        fn render(&self, area: Rect, buf: &mut Buffer) {
            for y in 0..self.0.min(area.height) {
                if let Some(cell) = buf.cell_mut((area.x, area.y + y)) {
                    cell.set_symbol("X");
                }
            }
        }

        fn desired_height(&self, _width: u16) -> u16 {
            self.0
        }
    }

    #[test]
    fn viewport_scrolls_up_down() {
        let mut view = ViewportView::new();
        assert_eq!(view.scroll_offset(), 0);

        view.scroll_down();
        assert_eq!(view.scroll_offset(), 1);

        view.scroll_up();
        assert_eq!(view.scroll_offset(), 0);

        view.scroll_up();
        assert_eq!(view.scroll_offset(), 0); // Clamped at 0
    }

    #[test]
    fn viewport_page_navigation() {
        let mut view = ViewportView::new();
        view.set_scroll_offset(50);

        view.page_up(10);
        assert_eq!(view.scroll_offset(), 40);

        view.page_down(10);
        assert_eq!(view.scroll_offset(), 50);
    }

    #[test]
    fn viewport_at_bottom_detection() {
        let mut view = ViewportView::at_bottom();
        assert!(view.is_scrolled_to_bottom());

        view.set_scroll_offset(0);
        // Without render, we don't have cached heights
        assert!(!view.is_scrolled_to_bottom());
    }

    #[test]
    fn viewport_clamps_scroll() {
        let mut view = ViewportView::new();
        view.set_scroll_offset(1000);

        let renderables = vec![FixedHeightRenderable(5)];
        let area = Rect::new(0, 0, 10, 10);
        let mut buf = Buffer::empty(area);

        view.render(area, &mut buf, &renderables);

        // With 5 lines of content and 10 lines viewport, max scroll is 0
        assert_eq!(view.scroll_offset(), 0);
    }

    #[test]
    fn viewport_renders_partial_top() {
        let mut view = ViewportView::new();
        view.set_scroll_offset(2);

        let renderables = vec![FixedHeightRenderable(5)];
        let area = Rect::new(0, 0, 10, 3);
        let mut buf = Buffer::empty(area);

        view.render(area, &mut buf, &renderables);

        // Should render lines 2,3,4 of the content (0-indexed)
        // First cell should have content
        assert_eq!(buf.cell((0, 0)).unwrap().symbol(), "X");
    }

    #[test]
    fn scroll_percentage_calculates_correctly() {
        let mut view = ViewportView::new();
        view.set_scroll_offset(50);

        assert_eq!(view.scroll_percentage(200, 100), 50);
        assert_eq!(view.scroll_percentage(100, 100), 100); // No scrolling needed
    }

    #[test]
    fn inset_renderable_adds_padding() {
        let inner = FixedHeightRenderable(5);
        let inset = InsetRenderable::top(inner, 2);

        assert_eq!(inset.desired_height(10), 7); // 5 + 2 top
    }

    #[test]
    fn text_renderable_wraps() {
        let text = Text::from(vec![
            Line::from("Short"),
            Line::from("Another line"),
        ]);
        let renderable = TextRenderable::new(text);

        // At width 10, should be 2 lines
        let height = renderable.desired_height(10);
        assert!(height >= 2);
    }

    #[test]
    fn cached_renderable_caches_height() {
        let inner = FixedHeightRenderable(5);
        let cached = CachedRenderable::new(inner);

        // First call calculates
        assert_eq!(cached.desired_height(10), 5);

        // Second call uses cache (same width)
        assert_eq!(cached.desired_height(10), 5);

        // Different width recalculates
        assert_eq!(cached.desired_height(20), 5);
    }
}
