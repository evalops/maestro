//! Generic Scroll/Selection State for List Menus
//!
//! Encapsulates the common behavior of a selectable list that supports:
//! - Optional selection (None when list is empty)
//! - Wrap-around navigation on Up/Down
//! - Maintaining a scroll window so the selected row stays visible
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

/// Generic scroll/selection state for a vertical list menu.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ScrollState {
    /// Currently selected index (None when list is empty).
    pub selected_idx: Option<usize>,
    /// First visible row index.
    pub scroll_top: usize,
}

impl ScrollState {
    /// Create a new scroll state with no selection.
    #[must_use]
    pub fn new() -> Self {
        Self {
            selected_idx: None,
            scroll_top: 0,
        }
    }

    /// Reset selection and scroll to initial state.
    pub fn reset(&mut self) {
        self.selected_idx = None;
        self.scroll_top = 0;
    }

    /// Clamp selection to be within [0, len-1], or None when empty.
    pub fn clamp_selection(&mut self, len: usize) {
        self.selected_idx = match len {
            0 => None,
            _ => Some(self.selected_idx.unwrap_or(0).min(len - 1)),
        };
        if len == 0 {
            self.scroll_top = 0;
        }
    }

    /// Move selection up by one, wrapping to bottom when at top.
    pub fn move_up_wrap(&mut self, len: usize) {
        if len == 0 {
            self.selected_idx = None;
            self.scroll_top = 0;
            return;
        }
        self.selected_idx = Some(match self.selected_idx {
            Some(idx) if idx > 0 => idx - 1,
            Some(_) => len - 1,
            None => 0,
        });
    }

    /// Move selection down by one, wrapping to top when at bottom.
    pub fn move_down_wrap(&mut self, len: usize) {
        if len == 0 {
            self.selected_idx = None;
            self.scroll_top = 0;
            return;
        }
        self.selected_idx = Some(match self.selected_idx {
            Some(idx) if idx + 1 < len => idx + 1,
            _ => 0,
        });
    }

    /// Move selection up by one without wrapping (stops at top).
    pub fn move_up(&mut self, len: usize) {
        if len == 0 {
            self.selected_idx = None;
            return;
        }
        self.selected_idx = Some(match self.selected_idx {
            Some(idx) if idx > 0 => idx - 1,
            Some(idx) => idx,
            None => 0,
        });
    }

    /// Move selection down by one without wrapping (stops at bottom).
    pub fn move_down(&mut self, len: usize) {
        if len == 0 {
            self.selected_idx = None;
            return;
        }
        self.selected_idx = Some(match self.selected_idx {
            Some(idx) if idx + 1 < len => idx + 1,
            Some(idx) => idx,
            None => 0,
        });
    }

    /// Move selection up by a page (`visible_rows` items).
    pub fn page_up(&mut self, len: usize, visible_rows: usize) {
        if len == 0 {
            self.selected_idx = None;
            return;
        }
        let jump = visible_rows.max(1);
        self.selected_idx = Some(match self.selected_idx {
            Some(idx) => idx.saturating_sub(jump),
            None => 0,
        });
    }

    /// Move selection down by a page (`visible_rows` items).
    pub fn page_down(&mut self, len: usize, visible_rows: usize) {
        if len == 0 {
            self.selected_idx = None;
            return;
        }
        let jump = visible_rows.max(1);
        self.selected_idx = Some(match self.selected_idx {
            Some(idx) => (idx + jump).min(len - 1),
            None => jump.min(len - 1),
        });
    }

    /// Jump to the first item.
    pub fn go_to_first(&mut self, len: usize) {
        self.selected_idx = if len > 0 { Some(0) } else { None };
    }

    /// Jump to the last item.
    pub fn go_to_last(&mut self, len: usize) {
        self.selected_idx = if len > 0 { Some(len - 1) } else { None };
    }

    /// Adjust `scroll_top` so the current `selected_idx` is visible.
    pub fn ensure_visible(&mut self, len: usize, visible_rows: usize) {
        if len == 0 || visible_rows == 0 {
            self.scroll_top = 0;
            return;
        }
        if let Some(sel) = self.selected_idx {
            // Scroll up if selection is above visible area
            if sel < self.scroll_top {
                self.scroll_top = sel;
            } else {
                // Scroll down if selection is below visible area
                let bottom = self.scroll_top + visible_rows - 1;
                if sel > bottom {
                    self.scroll_top = sel + 1 - visible_rows;
                }
            }
        } else {
            self.scroll_top = 0;
        }
    }

    /// Get the range of visible indices given the total length and visible rows.
    #[must_use]
    pub fn visible_range(&self, len: usize, visible_rows: usize) -> std::ops::Range<usize> {
        let start = self.scroll_top;
        let end = (start + visible_rows).min(len);
        start..end
    }

    /// Check if there are items above the visible area.
    #[must_use]
    pub fn has_items_above(&self) -> bool {
        self.scroll_top > 0
    }

    /// Check if there are items below the visible area.
    #[must_use]
    pub fn has_items_below(&self, len: usize, visible_rows: usize) -> bool {
        self.scroll_top + visible_rows < len
    }

    /// Set selection to a specific index (clamped to valid range).
    pub fn select(&mut self, idx: usize, len: usize) {
        if len == 0 {
            self.selected_idx = None;
        } else {
            self.selected_idx = Some(idx.min(len - 1));
        }
    }

    /// Clear the selection.
    pub fn clear_selection(&mut self) {
        self.selected_idx = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_state() {
        let s = ScrollState::new();
        assert_eq!(s.selected_idx, None);
        assert_eq!(s.scroll_top, 0);
    }

    #[test]
    fn test_clamp_selection() {
        let mut s = ScrollState::new();
        s.selected_idx = Some(5);
        s.clamp_selection(3);
        assert_eq!(s.selected_idx, Some(2));

        s.clamp_selection(0);
        assert_eq!(s.selected_idx, None);
    }

    #[test]
    fn test_wrap_navigation() {
        let mut s = ScrollState::new();
        let len = 5;

        s.clamp_selection(len);
        assert_eq!(s.selected_idx, Some(0));

        // Wrap up from 0 -> last
        s.move_up_wrap(len);
        assert_eq!(s.selected_idx, Some(4));

        // Wrap down from last -> 0
        s.move_down_wrap(len);
        assert_eq!(s.selected_idx, Some(0));
    }

    #[test]
    fn test_no_wrap_navigation() {
        let mut s = ScrollState::new();
        let len = 5;

        s.select(0, len);

        // Should stay at 0
        s.move_up(len);
        assert_eq!(s.selected_idx, Some(0));

        s.select(4, len);

        // Should stay at 4
        s.move_down(len);
        assert_eq!(s.selected_idx, Some(4));
    }

    #[test]
    fn test_ensure_visible() {
        let mut s = ScrollState::new();
        let len = 10;
        let vis = 3;

        s.select(5, len);
        s.ensure_visible(len, vis);
        assert!(s.scroll_top <= 5 && s.scroll_top + vis > 5);

        s.select(0, len);
        s.ensure_visible(len, vis);
        assert_eq!(s.scroll_top, 0);
    }

    #[test]
    fn test_page_navigation() {
        let mut s = ScrollState::new();
        let len = 20;
        let vis = 5;

        s.select(0, len);

        s.page_down(len, vis);
        assert_eq!(s.selected_idx, Some(5));

        s.page_up(len, vis);
        assert_eq!(s.selected_idx, Some(0));
    }

    #[test]
    fn test_visible_range() {
        let mut s = ScrollState::new();
        s.scroll_top = 5;
        let range = s.visible_range(20, 5);
        assert_eq!(range, 5..10);
    }

    #[test]
    fn test_has_items_above_below() {
        let mut s = ScrollState::new();
        s.scroll_top = 5;
        assert!(s.has_items_above());
        assert!(s.has_items_below(20, 5));

        s.scroll_top = 0;
        assert!(!s.has_items_above());

        s.scroll_top = 15;
        assert!(!s.has_items_below(20, 5));
    }
}
