//! Selection List Rendering for Popups and Menus
//!
//! This module provides a generic selection list renderer that handles:
//! - Fuzzy match highlighting with bold characters
//! - Aligned description columns
//! - Selection highlighting
//! - Smart wrapping with proper indentation
//! - Keyboard shortcut display
//!
//! Ported from OpenAI Codex CLI (MIT licensed).

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;
use unicode_width::UnicodeWidthChar;

use crate::key_binding::KeyBinding;
use crate::scroll_state::ScrollState;
use crate::wrapping::{word_wrap_line, RtOptions};

// ─────────────────────────────────────────────────────────────────────────────
// DISPLAY ROW
// ─────────────────────────────────────────────────────────────────────────────

/// A row in a selection list.
///
/// This is a generic representation that can be used for commands, files,
/// skills, or any other selectable item.
#[derive(Debug, Clone, Default)]
pub struct SelectionRow {
    /// The primary display name.
    pub name: String,
    /// Optional keyboard shortcut to display.
    pub shortcut: Option<KeyBinding>,
    /// Character indices to bold for fuzzy match highlighting.
    pub match_indices: Option<Vec<usize>>,
    /// Optional description shown after the name.
    pub description: Option<String>,
    /// Optional custom indent for wrapped lines.
    pub wrap_indent: Option<usize>,
}

impl SelectionRow {
    /// Create a new selection row with just a name.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Default::default()
        }
    }

    /// Add a description.
    pub fn description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    /// Add a keyboard shortcut.
    pub fn shortcut(mut self, shortcut: KeyBinding) -> Self {
        self.shortcut = Some(shortcut);
        self
    }

    /// Add fuzzy match indices for highlighting.
    pub fn match_indices(mut self, indices: Vec<usize>) -> Self {
        self.match_indices = Some(indices);
        self
    }

    /// Set custom wrap indent.
    pub fn wrap_indent(mut self, indent: usize) -> Self {
        self.wrap_indent = Some(indent);
        self
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECTION LIST WIDGET
// ─────────────────────────────────────────────────────────────────────────────

/// Configuration for the selection list.
#[derive(Debug, Clone)]
pub struct SelectionListConfig {
    /// Maximum number of visible results.
    pub max_visible: usize,
    /// Message shown when the list is empty.
    pub empty_message: String,
    /// Style for selected items.
    pub selected_style: Style,
    /// Style for normal items.
    pub normal_style: Style,
    /// Style for descriptions.
    pub description_style: Style,
}

impl Default for SelectionListConfig {
    fn default() -> Self {
        Self {
            max_visible: 10,
            empty_message: "No matches".to_string(),
            selected_style: Style::default().fg(Color::Cyan),
            normal_style: Style::default(),
            description_style: Style::default().fg(Color::DarkGray),
        }
    }
}

/// A selection list widget.
pub struct SelectionList<'a> {
    rows: &'a [SelectionRow],
    state: &'a ScrollState,
    config: SelectionListConfig,
}

impl<'a> SelectionList<'a> {
    /// Create a new selection list.
    pub fn new(rows: &'a [SelectionRow], state: &'a ScrollState) -> Self {
        Self {
            rows,
            state,
            config: SelectionListConfig::default(),
        }
    }

    /// Set the configuration.
    pub fn config(mut self, config: SelectionListConfig) -> Self {
        self.config = config;
        self
    }

    /// Set the maximum number of visible items.
    pub fn max_visible(mut self, max: usize) -> Self {
        self.config.max_visible = max;
        self
    }

    /// Set the empty message.
    pub fn empty_message(mut self, msg: impl Into<String>) -> Self {
        self.config.empty_message = msg.into();
        self
    }

    /// Calculate the height needed to render the list.
    pub fn measure_height(&self, width: u16) -> u16 {
        measure_rows_height(self.rows, self.state, self.config.max_visible, width)
    }
}

impl Widget for SelectionList<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        render_rows(area, buf, self.rows, self.state, &self.config);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDERING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/// Compute the column where descriptions should start.
///
/// This ensures descriptions align across all visible rows.
fn compute_desc_col(
    rows: &[SelectionRow],
    start_idx: usize,
    visible_items: usize,
    content_width: u16,
) -> usize {
    let visible_range = start_idx..(start_idx + visible_items);
    let max_name_width = rows
        .iter()
        .enumerate()
        .filter(|(i, _)| visible_range.contains(i))
        .map(|(_, r)| Line::from(r.name.clone()).width())
        .max()
        .unwrap_or(0);

    let mut desc_col = max_name_width.saturating_add(2);
    if (desc_col as u16) >= content_width {
        desc_col = content_width.saturating_sub(1) as usize;
    }
    desc_col
}

/// Determine the wrap indent for a row.
fn get_wrap_indent(row: &SelectionRow, desc_col: usize, max_width: u16) -> usize {
    let max_indent = max_width.saturating_sub(1) as usize;
    let indent = row.wrap_indent.unwrap_or_else(|| {
        if row.description.is_some() {
            desc_col
        } else {
            0
        }
    });
    indent.min(max_indent)
}

/// Build a display line for a row with fuzzy match highlighting.
fn build_display_line(
    row: &SelectionRow,
    desc_col: usize,
    config: &SelectionListConfig,
) -> Line<'static> {
    // Limit name width when there's a description
    let name_limit = row
        .description
        .as_ref()
        .map(|_| desc_col.saturating_sub(2))
        .unwrap_or(usize::MAX);

    let mut name_spans: Vec<Span> = Vec::with_capacity(row.name.len());
    let mut used_width = 0usize;
    let mut truncated = false;

    // Build name with optional fuzzy match bolding
    if let Some(indices) = row.match_indices.as_ref() {
        let mut idx_iter = indices.iter().peekable();
        for (char_idx, ch) in row.name.chars().enumerate() {
            let ch_w = UnicodeWidthChar::width(ch).unwrap_or(0);
            let next_width = used_width.saturating_add(ch_w);
            if next_width > name_limit {
                truncated = true;
                break;
            }
            used_width = next_width;

            let ch_str = ch.to_string();
            if idx_iter.peek().is_some_and(|next| **next == char_idx) {
                idx_iter.next();
                name_spans.push(Span::styled(
                    ch_str,
                    config
                        .normal_style
                        .patch(Style::default().fg(Color::Yellow)),
                ));
            } else {
                name_spans.push(Span::styled(ch_str, config.normal_style));
            }
        }
    } else {
        for ch in row.name.chars() {
            let ch_w = UnicodeWidthChar::width(ch).unwrap_or(0);
            let next_width = used_width.saturating_add(ch_w);
            if next_width > name_limit {
                truncated = true;
                break;
            }
            used_width = next_width;
            name_spans.push(Span::styled(ch.to_string(), config.normal_style));
        }
    }

    if truncated {
        name_spans.push(Span::raw("..."));
    }

    let name_width = Line::from(name_spans.clone()).width();
    let mut full_spans: Vec<Span> = name_spans;

    // Add shortcut if present
    if let Some(shortcut) = row.shortcut {
        full_spans.push(Span::raw(" ("));
        full_spans.push(Span::from(&shortcut));
        full_spans.push(Span::raw(")"));
    }

    // Add description with padding
    if let Some(desc) = row.description.as_ref() {
        let gap = desc_col.saturating_sub(name_width);
        if gap > 0 {
            full_spans.push(Span::raw(" ".repeat(gap)));
        }
        full_spans.push(Span::styled(desc.clone(), config.description_style));
    }

    Line::from(full_spans)
}

/// Render selection rows to a buffer.
fn render_rows(
    area: Rect,
    buf: &mut Buffer,
    rows: &[SelectionRow],
    state: &ScrollState,
    config: &SelectionListConfig,
) {
    if rows.is_empty() {
        if area.height > 0 {
            let msg = Line::from(Span::styled(
                config.empty_message.clone(),
                Style::default().fg(Color::DarkGray),
            ));
            msg.render(area, buf);
        }
        return;
    }

    // Determine visible window
    let visible_items = config
        .max_visible
        .min(rows.len())
        .min(area.height.max(1) as usize);

    let mut start_idx = state.scroll_top.min(rows.len().saturating_sub(1));
    if let Some(sel) = state.selected_idx {
        if sel < start_idx {
            start_idx = sel;
        } else if visible_items > 0 {
            let bottom = start_idx + visible_items - 1;
            if sel > bottom {
                start_idx = sel + 1 - visible_items;
            }
        }
    }

    let desc_col = compute_desc_col(rows, start_idx, visible_items, area.width);

    // Render rows with wrapping
    let mut cur_y = area.y;
    for (i, row) in rows.iter().enumerate().skip(start_idx).take(visible_items) {
        if cur_y >= area.y + area.height {
            break;
        }

        let is_selected = Some(i) == state.selected_idx;
        let row_config = if is_selected {
            SelectionListConfig {
                normal_style: config.selected_style,
                description_style: config.selected_style,
                ..config.clone()
            }
        } else {
            config.clone()
        };

        let mut line = build_display_line(row, desc_col, &row_config);

        // Apply selection styling to all spans
        if is_selected {
            for span in &mut line.spans {
                span.style = config.selected_style;
            }
        }

        // Wrap with proper indentation
        let continuation_indent = get_wrap_indent(row, desc_col, area.width);
        let options = RtOptions::new(area.width as usize)
            .initial_indent(Line::from(""))
            .subsequent_indent(Line::from(" ".repeat(continuation_indent)));
        let wrapped = word_wrap_line(&line, options);

        // Render wrapped lines
        for wrapped_line in wrapped {
            if cur_y >= area.y + area.height {
                break;
            }
            wrapped_line.render(
                Rect {
                    x: area.x,
                    y: cur_y,
                    width: area.width,
                    height: 1,
                },
                buf,
            );
            cur_y = cur_y.saturating_add(1);
        }
    }
}

/// Measure the height needed to render the selection list.
fn measure_rows_height(
    rows: &[SelectionRow],
    state: &ScrollState,
    max_visible: usize,
    width: u16,
) -> u16 {
    if rows.is_empty() {
        return 1; // Placeholder "no matches" line
    }

    let content_width = width.saturating_sub(1).max(1);
    let visible_items = max_visible.min(rows.len());

    let mut start_idx = state.scroll_top.min(rows.len().saturating_sub(1));
    if let Some(sel) = state.selected_idx {
        if sel < start_idx {
            start_idx = sel;
        } else if visible_items > 0 {
            let bottom = start_idx + visible_items - 1;
            if sel > bottom {
                start_idx = sel + 1 - visible_items;
            }
        }
    }

    let desc_col = compute_desc_col(rows, start_idx, visible_items, content_width);
    let config = SelectionListConfig::default();

    let mut total: u16 = 0;
    for row in rows.iter().skip(start_idx).take(visible_items) {
        let line = build_display_line(row, desc_col, &config);
        let continuation_indent = get_wrap_indent(row, desc_col, content_width);
        let opts = RtOptions::new(content_width as usize)
            .initial_indent(Line::from(""))
            .subsequent_indent(Line::from(" ".repeat(continuation_indent)));
        total = total.saturating_add(word_wrap_line(&line, opts).len() as u16);
    }
    total.max(1)
}

// ─────────────────────────────────────────────────────────────────────────────
// FUZZY MATCHING
// ─────────────────────────────────────────────────────────────────────────────

/// Perform fuzzy matching and return match indices.
///
/// Returns None if the pattern doesn't match the text.
pub fn fuzzy_match(text: &str, pattern: &str) -> Option<Vec<usize>> {
    if pattern.is_empty() {
        return Some(vec![]);
    }

    let text_lower = text.to_lowercase();
    let pattern_lower = pattern.to_lowercase();
    let mut indices = Vec::new();
    let mut pattern_chars = pattern_lower.chars().peekable();

    for (i, ch) in text_lower.chars().enumerate() {
        if let Some(&pattern_ch) = pattern_chars.peek() {
            if ch == pattern_ch {
                indices.push(i);
                pattern_chars.next();
            }
        }
    }

    if pattern_chars.peek().is_none() {
        Some(indices)
    } else {
        None
    }
}

/// Score a fuzzy match (higher is better).
///
/// Considers:
/// - Consecutive matches (bonus)
/// - Match at start (bonus)
/// - Total gaps between matches (penalty)
pub fn fuzzy_score(indices: &[usize]) -> usize {
    if indices.is_empty() {
        return 0;
    }

    let mut score: usize = 0;

    // Bonus for starting at the beginning
    if indices[0] == 0 {
        score += 100;
    }

    // Penalty for gaps, bonus for consecutive
    let mut consecutive: usize = 0;
    for window in indices.windows(2) {
        let gap = window[1] - window[0];
        if gap == 1 {
            consecutive += 1;
        } else {
            score = score.saturating_sub(gap * 10);
        }
    }

    score += consecutive * 20;
    score
}

/// Filter and sort items by fuzzy match.
pub fn fuzzy_filter<T, F>(items: &[T], pattern: &str, get_text: F) -> Vec<(usize, Vec<usize>)>
where
    F: Fn(&T) -> &str,
{
    let mut matches: Vec<(usize, Vec<usize>, usize)> = items
        .iter()
        .enumerate()
        .filter_map(|(i, item)| {
            fuzzy_match(get_text(item), pattern).map(|indices| {
                let score = fuzzy_score(&indices);
                (i, indices, score)
            })
        })
        .collect();

    // Sort by score (descending) then by original index
    matches.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));

    matches
        .into_iter()
        .map(|(i, indices, _)| (i, indices))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_match_basic() {
        let indices = fuzzy_match("hello world", "hw").unwrap();
        assert_eq!(indices, vec![0, 6]);
    }

    #[test]
    fn fuzzy_match_case_insensitive() {
        let indices = fuzzy_match("HelloWorld", "hw").unwrap();
        assert_eq!(indices, vec![0, 5]);
    }

    #[test]
    fn fuzzy_match_no_match() {
        assert!(fuzzy_match("hello", "xyz").is_none());
    }

    #[test]
    fn fuzzy_match_empty_pattern() {
        let indices = fuzzy_match("hello", "").unwrap();
        assert!(indices.is_empty());
    }

    #[test]
    fn fuzzy_score_consecutive_bonus() {
        let indices1 = vec![0, 1, 2]; // Consecutive
        let indices2 = vec![0, 2, 4]; // Gaps
        assert!(fuzzy_score(&indices1) > fuzzy_score(&indices2));
    }

    #[test]
    fn fuzzy_filter_sorts_by_score() {
        let items = vec!["hello world", "hw", "somewhere else"];
        let results = fuzzy_filter(&items, "hw", |s| s);
        assert_eq!(results[0].0, 1); // "hw" should be first (exact match)
    }

    #[test]
    fn selection_row_builder() {
        let row = SelectionRow::new("test")
            .description("A test item")
            .match_indices(vec![0, 2]);

        assert_eq!(row.name, "test");
        assert_eq!(row.description, Some("A test item".to_string()));
        assert_eq!(row.match_indices, Some(vec![0, 2]));
    }

    #[test]
    fn measure_height_empty() {
        let state = ScrollState::new();
        let height = measure_rows_height(&[], &state, 10, 80);
        assert_eq!(height, 1); // Empty message
    }

    #[test]
    fn measure_height_single_row() {
        let rows = vec![SelectionRow::new("test")];
        let state = ScrollState::new();
        let height = measure_rows_height(&rows, &state, 10, 80);
        assert_eq!(height, 1);
    }
}
