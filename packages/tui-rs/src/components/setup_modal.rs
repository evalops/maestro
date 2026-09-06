//! `/setup` modal: mandatory EvalOps Identity followed by managed inference or
//! a local provider API key.

use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

/// One local provider offered by the setup modal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SetupProvider {
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
}

/// Visible page inside the setup modal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupPage {
    Mode,
    Provider,
    Key,
    WaitingEvalops,
}

/// Setup modal state.
pub struct SetupModal {
    visible: bool,
    page: SetupPage,
    mode_index: usize,
    provider_index: usize,
    secret: String,
    status: Option<String>,
    continue_to_byok_after_identity: bool,
}

impl Default for SetupModal {
    fn default() -> Self {
        Self::new()
    }
}

impl SetupModal {
    #[must_use]
    pub fn new() -> Self {
        Self {
            visible: false,
            page: SetupPage::Mode,
            mode_index: 0,
            provider_index: 0,
            secret: String::new(),
            status: None,
            continue_to_byok_after_identity: false,
        }
    }

    pub fn show(&mut self) {
        self.visible = true;
        self.page = SetupPage::Mode;
        self.mode_index = 0;
        self.provider_index = 0;
        self.secret.clear();
        self.status = None;
        self.continue_to_byok_after_identity = false;
    }

    pub fn hide(&mut self) {
        self.visible = false;
        self.secret.clear();
        self.status = None;
        self.continue_to_byok_after_identity = false;
    }

    #[must_use]
    pub fn is_visible(&self) -> bool {
        self.visible
    }

    #[must_use]
    pub fn page(&self) -> SetupPage {
        self.page
    }

    #[must_use]
    pub fn mode_index(&self) -> usize {
        self.mode_index
    }

    #[must_use]
    pub fn provider_index(&self) -> usize {
        self.provider_index
    }

    #[must_use]
    pub fn providers() -> &'static [SetupProvider] {
        &[
            SetupProvider {
                id: "openrouter",
                label: "OpenRouter",
                hint: "One key, many models",
            },
            SetupProvider {
                id: "anthropic",
                label: "Anthropic",
                hint: "Claude",
            },
            SetupProvider {
                id: "openai",
                label: "OpenAI",
                hint: "API key, not ChatGPT login",
            },
            SetupProvider {
                id: "google",
                label: "Google",
                hint: "Gemini",
            },
            SetupProvider {
                id: "xai",
                label: "xAI",
                hint: "Grok",
            },
        ]
    }

    #[must_use]
    pub fn selected_provider(&self) -> SetupProvider {
        Self::providers()[self.provider_index]
    }

    #[must_use]
    pub fn secret(&self) -> &str {
        &self.secret
    }

    pub fn set_waiting_evalops(&mut self) {
        self.page = SetupPage::WaitingEvalops;
        self.status = Some("Waiting for the browser callback…".to_owned());
    }

    /// Continue a BYOK setup only after the required Identity login succeeds.
    pub fn continue_to_byok_after_identity(&mut self) -> bool {
        if !self.continue_to_byok_after_identity {
            return false;
        }
        self.continue_to_byok_after_identity = false;
        self.page = SetupPage::Provider;
        self.status = Some("EvalOps Identity verified. Choose a provider.".to_owned());
        true
    }

    pub fn set_status(&mut self, status: impl Into<String>) {
        self.status = Some(status.into());
    }

    pub fn move_up(&mut self) {
        match self.page {
            SetupPage::Mode if self.mode_index > 0 => self.mode_index -= 1,
            SetupPage::Provider if self.provider_index > 0 => self.provider_index -= 1,
            _ => {}
        }
    }

    pub fn move_down(&mut self) {
        match self.page {
            SetupPage::Mode if self.mode_index < 1 => self.mode_index += 1,
            SetupPage::Provider if self.provider_index + 1 < Self::providers().len() => {
                self.provider_index += 1;
            }
            _ => {}
        }
    }

    pub fn insert_char(&mut self, c: char) {
        if self.page == SetupPage::Key && !c.is_control() {
            self.secret.push(c);
        }
    }

    pub fn insert_str(&mut self, s: &str) {
        if self.page != SetupPage::Key {
            return;
        }
        for c in s.chars() {
            if !c.is_control() && c != ' ' {
                self.secret.push(c);
            }
        }
    }

    pub fn backspace(&mut self) {
        if self.page == SetupPage::Key {
            self.secret.pop();
        }
    }

    /// Advance one page. Returns `Some(SetupAdvance)` when the caller must act.
    pub fn confirm(&mut self) -> Option<SetupAdvance> {
        match self.page {
            SetupPage::Mode if self.mode_index == 0 => {
                self.continue_to_byok_after_identity = false;
                Some(SetupAdvance::StartEvalops)
            }
            SetupPage::Mode => {
                self.continue_to_byok_after_identity = true;
                Some(SetupAdvance::StartEvalops)
            }
            SetupPage::Provider => {
                self.page = SetupPage::Key;
                self.secret.clear();
                None
            }
            SetupPage::Key if self.secret.trim().is_empty() => {
                self.status = Some("Paste or type an API key.".to_owned());
                None
            }
            SetupPage::Key => Some(SetupAdvance::SaveKey {
                provider_id: self.selected_provider().id,
                secret: self.secret.trim().to_owned(),
            }),
            SetupPage::WaitingEvalops => None,
        }
    }

    /// Go back one page. Returns true when the modal should close.
    pub fn back(&mut self) -> bool {
        match self.page {
            SetupPage::Mode | SetupPage::WaitingEvalops => true,
            SetupPage::Provider => {
                self.page = SetupPage::Mode;
                false
            }
            SetupPage::Key => {
                self.page = SetupPage::Provider;
                self.secret.clear();
                self.status = None;
                false
            }
        }
    }

    pub fn render(&self, frame: &mut Frame, area: Rect) {
        self.render_with_theme(frame, area, crate::themes::current_ui_theme());
    }

    fn render_with_theme(&self, frame: &mut Frame, area: Rect, theme: maestro_ui::UiTheme) {
        if !self.visible {
            return;
        }
        let modal_width = 58.min(area.width.saturating_sub(4));
        let modal_height = 16.min(area.height.saturating_sub(2));
        let modal_area = Rect {
            x: area.x + (area.width.saturating_sub(modal_width)) / 2,
            y: area.y + (area.height.saturating_sub(modal_height)) / 3,
            width: modal_width,
            height: modal_height,
        };
        frame.render_widget(Clear, modal_area);
        let title = match self.page {
            SetupPage::Mode => " Setup ",
            SetupPage::Provider => " Setup · your key ",
            SetupPage::Key => " Setup · API key ",
            SetupPage::WaitingEvalops => " Setup · EvalOps ",
        };
        let block = Block::default()
            .title(title)
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.border))
            .title_style(
                Style::default()
                    .fg(theme.focus)
                    .add_modifier(Modifier::BOLD),
            )
            .style(theme.text_style());
        let inner = block.inner(modal_area);
        frame.render_widget(block, modal_area);

        let chunks = Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).split(inner);
        let body = match self.page {
            SetupPage::Mode => self.mode_lines(theme),
            SetupPage::Provider => self.provider_lines(theme),
            SetupPage::Key => self.key_lines(theme),
            SetupPage::WaitingEvalops => self.waiting_lines(theme),
        };
        frame.render_widget(Paragraph::new(body).wrap(Wrap { trim: false }), chunks[0]);
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                self.footer(),
                Style::default().fg(theme.muted),
            ))),
            chunks[1],
        );
    }

    fn mode_lines(&self, theme: maestro_ui::UiTheme) -> Vec<Line<'static>> {
        let mut lines = vec![
            Line::from(Span::raw(
                "EvalOps Identity is required to use Deixic Code.",
            )),
            Line::from(""),
        ];
        lines.extend(self.choice(
            0,
            self.mode_index,
            "Managed inference",
            "Sign in with EvalOps Identity and use the managed gateway.",
            theme,
        ));
        lines.push(Line::from(""));
        lines.extend(self.choice(
            1,
            self.mode_index,
            "Use your own key",
            "Sign in with Identity first, then add OpenRouter, Anthropic, OpenAI, or another key.",
            theme,
        ));
        lines
    }

    fn provider_lines(&self, theme: maestro_ui::UiTheme) -> Vec<Line<'static>> {
        let mut lines = vec![Line::from(Span::raw("Choose a provider.")), Line::from("")];
        for (index, provider) in Self::providers().iter().enumerate() {
            let selected = index == self.provider_index;
            let marker = if selected { "▸ " } else { "  " };
            let style = if selected {
                theme
                    .selection_style()
                    .fg(theme.focus)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme.text)
            };
            lines.push(Line::from(vec![
                Span::styled(marker.to_owned(), style),
                Span::styled(provider.label.to_owned(), style),
                Span::styled(
                    format!("  {}", provider.hint),
                    Style::default().fg(theme.muted),
                ),
            ]));
        }
        lines
    }

    fn key_lines(&self, theme: maestro_ui::UiTheme) -> Vec<Line<'static>> {
        let provider = self.selected_provider();
        let masked = if self.secret.is_empty() {
            String::new()
        } else {
            "•".repeat(self.secret.chars().count().min(48))
        };
        let mut lines = vec![
            Line::from(Span::raw(format!("Paste your {} API key.", provider.label))),
            Line::from(Span::styled(
                "Stored in the OS credential store, not in config.toml.",
                Style::default().fg(theme.muted),
            )),
            Line::from(""),
            Line::from(vec![
                Span::styled("Key  ", Style::default().fg(theme.muted)),
                Span::styled(
                    if masked.is_empty() {
                        " ".to_owned()
                    } else {
                        masked
                    },
                    Style::default().fg(theme.text),
                ),
            ]),
        ];
        if let Some(status) = &self.status {
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                status.clone(),
                Style::default().fg(theme.attention),
            )));
        }
        lines
    }

    fn waiting_lines(&self, theme: maestro_ui::UiTheme) -> Vec<Line<'static>> {
        vec![
            Line::from(Span::raw(
                "A browser window opens for the required EvalOps Identity login.",
            )),
            Line::from(Span::styled(
                "This session stays here until the callback finishes.",
                Style::default().fg(theme.muted),
            )),
            Line::from(""),
            Line::from(Span::styled(
                self.status
                    .clone()
                    .unwrap_or_else(|| "Waiting for the browser callback…".to_owned()),
                Style::default().fg(theme.attention),
            )),
        ]
    }

    fn choice(
        &self,
        index: usize,
        selected: usize,
        title: &str,
        detail: &str,
        theme: maestro_ui::UiTheme,
    ) -> Vec<Line<'static>> {
        let is_selected = index == selected;
        let marker = if is_selected { "▸ " } else { "  " };
        let title_style = if is_selected {
            theme
                .selection_style()
                .fg(theme.focus)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme.text)
        };
        vec![
            Line::from(vec![
                Span::styled(marker.to_owned(), title_style),
                Span::styled(title.to_owned(), title_style),
            ]),
            Line::from(vec![
                Span::raw("    "),
                Span::styled(detail.to_owned(), Style::default().fg(theme.muted)),
            ]),
        ]
    }

    fn footer(&self) -> &'static str {
        match self.page {
            SetupPage::Mode => "↑↓ select   enter continue   esc close",
            SetupPage::Provider => "↑↓ select   enter next   esc back",
            SetupPage::Key => "enter save   esc back",
            SetupPage::WaitingEvalops => "esc close",
        }
    }
}

/// Work the TUI must do after the user confirms a page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupAdvance {
    StartEvalops,
    SaveKey {
        provider_id: &'static str,
        secret: String,
    },
}

#[cfg(test)]
mod tests {
    #[test]
    fn all_setup_pages_use_shared_theme() {
        for theme in crate::components::theme_test::palettes() {
            let mut modal = SetupModal::new();
            modal.show();
            for page in [
                SetupPage::Mode,
                SetupPage::Provider,
                SetupPage::Key,
                SetupPage::WaitingEvalops,
            ] {
                modal.page = page;
                let mut terminal =
                    ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 40)).unwrap();
                terminal
                    .draw(|frame| modal.render_with_theme(frame, frame.area(), theme))
                    .unwrap();
                crate::components::theme_test::assert_palette(terminal.backend().buffer(), theme);
            }
        }
    }

    use super::*;

    #[test]
    fn setup_modal_starts_hidden_on_mode() {
        let modal = SetupModal::new();
        assert!(!modal.is_visible());
        assert_eq!(modal.page(), SetupPage::Mode);
    }

    #[test]
    fn setup_modal_byok_starts_evalops_identity_before_provider_setup() {
        let mut modal = SetupModal::new();
        modal.show();
        modal.move_down();
        assert_eq!(modal.confirm(), Some(SetupAdvance::StartEvalops));
        assert!(modal.continue_to_byok_after_identity());
        assert_eq!(modal.page(), SetupPage::Provider);
        assert_eq!(modal.selected_provider().id, "openrouter");
        assert_eq!(modal.confirm(), None);
        assert_eq!(modal.page(), SetupPage::Key);
        modal.insert_str("sk-or-test");
        match modal.confirm() {
            Some(SetupAdvance::SaveKey {
                provider_id,
                secret,
            }) => {
                assert_eq!(provider_id, "openrouter");
                assert_eq!(secret, "sk-or-test");
            }
            other => panic!("expected save key, got {other:?}"),
        }
    }

    #[test]
    fn setup_modal_evalops_starts_login() {
        let mut modal = SetupModal::new();
        modal.show();
        assert_eq!(modal.confirm(), Some(SetupAdvance::StartEvalops));
    }

    #[test]
    fn setup_modal_back_from_mode_closes() {
        let mut modal = SetupModal::new();
        modal.show();
        assert!(modal.back());
    }

    #[test]
    fn setup_modal_masks_and_strips_secret_paste() {
        let mut modal = SetupModal::new();
        modal.show();
        modal.move_down();
        assert_eq!(modal.confirm(), Some(SetupAdvance::StartEvalops));
        assert!(modal.continue_to_byok_after_identity());
        assert_eq!(modal.confirm(), None);
        modal.insert_str(" sk-or-one\nsk-or-two ");
        assert_eq!(modal.secret(), "sk-or-onesk-or-two");
        modal.backspace();
        assert!(modal.secret().ends_with('w'));
    }
}
