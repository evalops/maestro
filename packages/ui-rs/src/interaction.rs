//! Stateless presentation for caller-owned interaction data.
use crate::{SELECTION_MARKER, UiTheme};
use maestro_interaction::Action;
use ratatui::{
    Frame,
    buffer::Buffer,
    layout::Rect,
    style::Style,
    text::Line,
    widgets::{List, ListItem, ListState, Paragraph, Widget},
};

/// A typed action catalog rendered without executing any of its values.
#[must_use]
pub struct ActionList<'a, T> {
    actions: &'a [Action<T>],
    theme: UiTheme,
}

impl<'a, T> ActionList<'a, T> {
    /// The same catalog can drive a command lookup and the host's dispatcher.
    pub fn new(actions: &'a [Action<T>], theme: UiTheme) -> Self {
        Self { actions, theme }
    }

    /// Draw the caller's selected row and retain its scrolling state.
    pub fn render(self, frame: &mut Frame, area: Rect, state: &mut ListState) {
        frame.render_stateful_widget(
            List::new(
                self.actions
                    .iter()
                    .map(|action| ListItem::new(action.label)),
            )
            .style(self.theme.text_style())
            .highlight_symbol(SELECTION_MARKER)
            .highlight_style(self.theme.selection_style()),
            area.intersection(frame.area()),
            state,
        );
    }
}

/// Presentation meaning supplied explicitly by the application.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeTone {
    Neutral,
    Busy,
    Success,
    Attention,
    Error,
}

/// An application-owned notice, hint, or status line within supplied bounds.
///
/// This widget does not create timers, infer success, clear errors, or dispatch
/// actions. Text and placement remain explicit inputs from the application.
#[must_use]
pub struct Notice<'a> {
    pub(crate) text: Line<'a>,
    pub(crate) style: Style,
}

impl<'a> Notice<'a> {
    /// Present text without assigning it any execution meaning.
    pub fn new(text: impl Into<Line<'a>>) -> Self {
        Self {
            text: text.into(),
            style: Style::default(),
        }
    }
    /// Render an explicit state with the caller's semantic palette.
    pub fn themed(text: impl Into<Line<'a>>, tone: NoticeTone, theme: UiTheme) -> Self {
        let color = match tone {
            NoticeTone::Neutral => theme.muted,
            NoticeTone::Busy => theme.focus,
            NoticeTone::Success => theme.success,
            NoticeTone::Attention => theme.attention,
            NoticeTone::Error => theme.error,
        };
        Self::new(text).style(theme.text_style().fg(color))
    }

    /// Apply colors and emphasis supplied by the host.
    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }
}

impl Widget for Notice<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        Paragraph::new(self.text)
            .style(self.style)
            .render(area.intersection(buffer.area), buffer);
    }
}
