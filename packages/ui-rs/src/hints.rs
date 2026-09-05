//! Shared rendering for caller-supplied keyboard bindings.
use crate::UiTheme;
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};

/// One actual keyboard binding and its short action label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyHint<'a> {
    pub key: &'a str,
    pub label: &'a str,
}
impl<'a> KeyHint<'a> {
    pub const fn new(key: &'a str, label: &'a str) -> Self {
        Self { key, label }
    }
}

/// Build a footer borrowing the strings, not the slice of hints.
/// Keys are emphasized; labels and separators use secondary text.
pub fn key_hints<'a>(hints: &[KeyHint<'a>], theme: UiTheme) -> Line<'a> {
    let mut spans = Vec::new();
    for (index, hint) in hints.iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled(" · ", theme.muted_style()));
        }
        spans.push(Span::styled(
            hint.key,
            Style::default()
                .fg(theme.focus)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(" ", theme.muted_style()));
        spans.push(Span::styled(hint.label, theme.muted_style()));
    }
    Line::from(spans).style(theme.muted_style())
}
