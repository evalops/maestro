//! `/setup` modal: mandatory EvalOps Identity followed by managed inference or
//! a local provider API key.

use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph, Wrap},
};

use crate::components::dex_companion::{DexCompanion, DexCompanionState, DexPersonality};
use crate::dex_delight::DexLook;
use crate::onboarding_checks::OnboardingReadiness;
use crate::telemetry::{
    OnboardingCollectionStatus, OnboardingProfile, OnboardingRole, OnboardingUseCase,
    OnboardingWorkflow,
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
    Welcome,
    Role,
    UseCase,
    Workflow,
    Verify,
    Checking,
    Results,
    Mode,
    Provider,
    Key,
    WaitingEvalops,
}

/// Frame-local appearance; it never chooses readiness or permissions.
#[derive(Clone, Copy, Debug, Default)]
pub struct SetupPresentation {
    pub animations: bool,
    pub personality: DexPersonality,
    pub look: DexLook,
    pub animation_frame: u64,
}

/// Setup modal state.
pub struct SetupModal {
    visible: bool,
    profile: OnboardingProfile,
    profile_index: usize,
    share_diagnostics: bool,
    connection_available: bool,
    checks: Option<OnboardingReadiness>,
    collection_status: Option<OnboardingCollectionStatus>,
    scroll: u16,
    max_scroll: u16,
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
            profile: OnboardingProfile::default(),
            profile_index: 0,
            share_diagnostics: true,
            connection_available: false,
            checks: None,
            collection_status: None,
            scroll: 0,
            max_scroll: 0,
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
        self.page = SetupPage::Welcome;
        self.profile_index = 0;
        self.scroll = 0;
        self.checks = None;
        self.collection_status = None;
        self.profile = OnboardingProfile::default();
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

    /// Return the optional setup answers selected in this attempt.
    pub fn profile(&self) -> &OnboardingProfile {
        &self.profile
    }
    /// Whether this attempt may enqueue structured setup information.
    pub fn share_diagnostics(&self) -> bool {
        self.share_diagnostics
    }
    /// Restore the saved information-sharing preference.
    pub fn set_share_diagnostics(&mut self, share: bool) {
        self.share_diagnostics = share;
    }
    /// Toggle information sharing without changing setup progress.
    pub fn toggle_share_diagnostics(&mut self) {
        self.share_diagnostics = !self.share_diagnostics;
    }
    /// Declare whether existing credentials can proceed to explicit verification.
    pub fn set_connection_available(&mut self, available: bool) {
        self.connection_available = available;
    }
    /// Discard old results and offer verification for the saved connection.
    pub fn set_connection_ready(&mut self) {
        self.checks = None;
        self.connection_available = true;
        self.page = SetupPage::Verify;
        self.secret.clear();
        self.status = None;
        self.scroll = 0;
    }
    /// Show an in-progress check and discard previous results.
    pub fn set_checking(&mut self) {
        self.page = SetupPage::Checking;
        self.checks = None;
        self.scroll = 0;
    }
    /// Display observed check results; readiness comes from the checker.
    pub fn set_check_results(&mut self, report: OnboardingReadiness) {
        self.checks = Some(report);
        self.page = SetupPage::Results;
        self.scroll = 0;
    }
    /// Return the latest observed check report, if any.
    pub fn checks(&self) -> Option<&OnboardingReadiness> {
        self.checks.as_ref()
    }
    /// Display the latest local collection outcome.
    pub fn set_collection_status(&mut self, status: OnboardingCollectionStatus) {
        self.collection_status = Some(status);
    }
    /// Scroll result details toward the beginning.
    pub fn scroll_up(&mut self) {
        self.scroll = self.scroll.saturating_sub(1);
    }
    /// Scroll result details toward the end.
    pub fn scroll_down(&mut self) {
        self.scroll = self.scroll.saturating_add(1).min(self.max_scroll);
    }
    /// Derive the companion pose from actual setup progress.
    pub fn dex_state(&self) -> DexCompanionState {
        match self.page {
            SetupPage::Checking => DexCompanionState::Working,
            SetupPage::WaitingEvalops => DexCompanionState::Waiting,
            SetupPage::Results if self.checks.as_ref().is_some_and(|r| r.ready) => {
                DexCompanionState::Finished
            }
            SetupPage::Results => DexCompanionState::Failed,
            _ => DexCompanionState::NeedsInput,
        }
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
            SetupPage::Role | SetupPage::UseCase | SetupPage::Workflow => {
                self.profile_index = self.profile_index.saturating_sub(1);
                self.scroll = 0;
            }
            SetupPage::Results => self.scroll_up(),
            SetupPage::Mode if self.mode_index > 0 => self.mode_index -= 1,
            SetupPage::Provider if self.provider_index > 0 => self.provider_index -= 1,
            _ => {}
        }
    }

    pub fn move_down(&mut self) {
        match self.page {
            SetupPage::Role | SetupPage::UseCase | SetupPage::Workflow => {
                self.profile_index = (self.profile_index + 1).min(self.profile_choices().len() - 1);
                self.scroll = 0;
            }
            SetupPage::Results => self.scroll_down(),
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
        self.scroll = 0;
        match self.page {
            SetupPage::Welcome => {
                self.page = SetupPage::Role;
                self.profile_index = 0;
                None
            }
            SetupPage::Role => {
                self.profile.role = match self.profile_index {
                    1 => Some(OnboardingRole::Developer),
                    2 => Some(OnboardingRole::Platform),
                    3 => Some(OnboardingRole::Product),
                    4 => Some(OnboardingRole::Other),
                    _ => None,
                };
                self.page = SetupPage::UseCase;
                self.profile_index = 0;
                None
            }
            SetupPage::UseCase => {
                self.profile.use_case = match self.profile_index {
                    1 => Some(OnboardingUseCase::Build),
                    2 => Some(OnboardingUseCase::Fix),
                    3 => Some(OnboardingUseCase::Review),
                    4 => Some(OnboardingUseCase::Explore),
                    _ => None,
                };
                self.page = SetupPage::Workflow;
                self.profile_index = 0;
                None
            }
            SetupPage::Workflow => {
                self.profile.workflow = match self.profile_index {
                    1 => Some(OnboardingWorkflow::Interactive),
                    2 => Some(OnboardingWorkflow::Headless),
                    3 => Some(OnboardingWorkflow::Hosted),
                    _ => None,
                };
                self.page = if self.connection_available {
                    SetupPage::Verify
                } else {
                    SetupPage::Mode
                };
                Some(SetupAdvance::ProfileSaved)
            }
            SetupPage::Verify => Some(SetupAdvance::StartChecks),
            SetupPage::Checking => None,
            SetupPage::Results if self.checks.as_ref().is_some_and(|r| r.ready) => {
                Some(SetupAdvance::Finish)
            }
            SetupPage::Results => Some(SetupAdvance::StartChecks),
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
        self.scroll = 0;
        match self.page {
            SetupPage::Welcome | SetupPage::WaitingEvalops | SetupPage::Checking => true,
            SetupPage::Role => {
                self.page = SetupPage::Welcome;
                false
            }
            SetupPage::UseCase => {
                self.page = SetupPage::Role;
                self.profile_index = 0;
                false
            }
            SetupPage::Workflow => {
                self.page = SetupPage::UseCase;
                self.profile_index = 0;
                false
            }
            SetupPage::Mode => {
                self.page = SetupPage::Workflow;
                self.profile_index = 0;
                false
            }
            SetupPage::Verify | SetupPage::Results => {
                self.checks = None;
                self.page = SetupPage::Mode;
                false
            }
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

    pub fn render(&mut self, frame: &mut Frame, area: Rect) {
        self.render_with_theme(frame, area, crate::themes::current_ui_theme());
    }

    fn render_with_theme(&mut self, frame: &mut Frame, area: Rect, theme: maestro_ui::UiTheme) {
        self.render_dex_theme(frame, area, theme, SetupPresentation::default());
    }

    pub fn render_with_dex(
        &mut self,
        frame: &mut Frame,
        area: Rect,
        presentation: SetupPresentation,
    ) {
        self.render_dex_theme(frame, area, crate::themes::current_ui_theme(), presentation);
    }

    fn render_dex_theme(
        &mut self,
        frame: &mut Frame,
        area: Rect,
        theme: maestro_ui::UiTheme,
        presentation: SetupPresentation,
    ) {
        let SetupPresentation {
            animations,
            personality,
            look,
            animation_frame,
        } = presentation;
        if !self.visible {
            return;
        }
        // Setup owns the terminal canvas. Keep the session behind it out of view.
        frame.render_widget(Clear, area);
        frame.render_widget(Block::default().style(theme.text_style()), area);
        let inset = if area.width >= 40 { 2 } else { 0 };
        let inner = Rect::new(
            area.x + inset,
            area.y + u16::from(area.height > 8),
            area.width.saturating_sub(inset * 2),
            area.height
                .saturating_sub(if area.height > 8 { 2 } else { 0 }),
        );
        let footer_rows = crate::wrapping::wrapped_line_count(
            &ratatui::text::Text::from(self.footer()),
            inner.width as usize,
        )
        .min(inner.height.saturating_sub(1) as usize) as u16;
        let scene_height = if personality == DexPersonality::Quiet || inner.height < 22 {
            0
        } else if self.page == SetupPage::Welcome {
            (inner.height / 2).min(17)
        } else {
            5
        };
        let chunks = Layout::vertical([
            Constraint::Length(u16::from(inner.height > 5) * 2),
            Constraint::Length(scene_height),
            Constraint::Min(1),
            Constraint::Length(footer_rows + u16::from(inner.height > 8)),
        ])
        .split(inner);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    if self.page == SetupPage::Welcome {
                        "Welcome to Deixic Code"
                    } else {
                        "Deixic Code"
                    },
                    Style::default()
                        .fg(theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("  /  Guided setup", Style::default().fg(theme.muted)),
            ])),
            chunks[0],
        );
        if scene_height > 0 {
            if self.page == SetupPage::Welcome {
                render_welcome_scene(frame, chunks[1], theme, presentation);
            } else {
                let dex = DexCompanion::new(self.dex_state())
                    .animations(animations)
                    .personality(personality)
                    .look(look)
                    .frame(animation_frame)
                    .theme(Some(theme));
                dex.render_face(
                    Rect::new(chunks[1].x, chunks[1].y, 7.min(chunks[1].width), 2),
                    frame.buffer_mut(),
                );
                frame.render_widget(
                    Paragraph::new(dex.status_line()),
                    Rect::new(chunks[1].x, chunks[1].y + 2, chunks[1].width, 1),
                );
            }
        }
        let body = match self.page {
            SetupPage::Mode => self.mode_lines(theme),
            SetupPage::Provider => self.provider_lines(theme),
            SetupPage::Key => self.key_lines(theme),
            SetupPage::WaitingEvalops => self.waiting_lines(theme),
            _ => self.onboarding_lines(theme),
        };
        let selected_line = match self.page {
            SetupPage::Role | SetupPage::UseCase | SetupPage::Workflow => {
                Some(2 + self.profile_index)
            }
            SetupPage::Provider => Some(2 + self.provider_index),
            SetupPage::Mode => Some(2 + self.mode_index * 3),
            _ => None,
        };
        let selection_scroll = selected_line.map_or(0, |index| {
            let prefix = ratatui::text::Text::from(body[..index.min(body.len())].to_vec());
            crate::wrapping::wrapped_line_count(&prefix, chunks[2].width as usize)
                .saturating_add(1)
                .saturating_sub(chunks[2].height as usize)
                .min(u16::MAX as usize) as u16
        });
        let text = ratatui::text::Text::from(body);
        let max_scroll = crate::wrapping::wrapped_line_count(&text, chunks[2].width as usize)
            .saturating_sub(chunks[2].height as usize)
            .min(u16::MAX as usize) as u16;
        self.max_scroll = max_scroll;
        self.scroll = self.scroll.min(max_scroll);
        frame.render_widget(
            Paragraph::new(text)
                .wrap(Wrap { trim: false })
                .scroll((self.scroll.max(selection_scroll).min(max_scroll), 0)),
            chunks[2],
        );
        frame.render_widget(
            Paragraph::new(self.footer())
                .style(
                    Style::default()
                        .fg(theme.focus)
                        .add_modifier(Modifier::BOLD),
                )
                .wrap(Wrap { trim: false }),
            chunks[3],
        );
    }

    fn profile_choices(&self) -> &'static [&'static str] {
        match self.page {
            SetupPage::Role => &[
                "Skip",
                "Developer",
                "Platform / operations",
                "Product",
                "Other",
            ],
            SetupPage::UseCase => &[
                "Skip",
                "Build something",
                "Fix a problem",
                "Review code",
                "Explore a codebase",
            ],
            _ => &[
                "Skip",
                "Interactive terminal",
                "Headless automation",
                "Hosted runs",
            ],
        }
    }

    fn onboarding_lines(&self, theme: maestro_ui::UiTheme) -> Vec<Line<'static>> {
        let mut lines: Vec<Line<'static>> = match self.page {
            SetupPage::Welcome => vec![
                Line::styled(
                    "Let's get Deixic Code ready for your first run.",
                    Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
                ),
                Line::from(""),
                Line::from("Dex will help you connect and check that your model and tools work."),
                Line::from(""),
                Line::styled(
                    "Make it yours",
                    Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
                ),
                Line::from("Optional answers help our product team understand your needs."),
                Line::from(
                    "Share setup outcomes, timings, and failure categories. No screens, terminal contents, code, or credentials are collected.",
                ),
                Line::from(""),
            ],
            SetupPage::Role | SetupPage::UseCase | SetupPage::Workflow => {
                let prompt = match self.page {
                    SetupPage::Role => "What is your role? (optional)",
                    SetupPage::UseCase => "What do you want to do first? (optional)",
                    _ => "How do you plan to run Deixic Code? (optional)",
                };
                let mut lines = vec![Line::from(prompt), Line::from("")];
                for (i, label) in self.profile_choices().iter().enumerate() {
                    lines.push(Line::from(Span::styled(
                        format!(
                            "{}{}",
                            if i == self.profile_index {
                                "▸ "
                            } else {
                                "  "
                            },
                            label
                        ),
                        if i == self.profile_index {
                            theme.selection_style().fg(theme.focus)
                        } else {
                            theme.text_style()
                        },
                    )));
                }
                lines
            }
            SetupPage::Verify => vec![
                Line::from("Connection saved. Now verify it works."),
                Line::from(
                    "Checks cover configuration, Identity, model access, workspace access, and a bounded model/tool test.",
                ),
                Line::from(
                    "The test sends a small fixed request to your selected model and may incur usage charges. It does not send repository contents.",
                ),
                Line::from(""),
                Line::from("Enter: run readiness checks"),
            ],
            SetupPage::Checking => vec![
                Line::from("Checking your actual configuration and runtime…"),
                Line::from("Dex will report results when the checks finish."),
            ],
            SetupPage::Results => {
                let mut lines = vec![
                    Line::from(if self.checks.as_ref().is_some_and(|r| r.ready) {
                        "Verified: model access and the native read test passed."
                    } else {
                        "Setup needs attention before your first run."
                    }),
                    Line::from(""),
                ];
                if let Some(report) = &self.checks {
                    lines.push(Line::from(format!(
                        "Checks took {:.1}s",
                        report.elapsed_ms as f64 / 1000.0
                    )));
                    for check in &report.checks {
                        let label = match check.status {
                            crate::doctor::CheckStatus::Pass => "PASS",
                            crate::doctor::CheckStatus::Warning => "WARN",
                            crate::doctor::CheckStatus::Fail => "FAIL",
                            crate::doctor::CheckStatus::Skipped => "SKIP",
                        };
                        lines.push(Line::from(format!(
                            "[{label}] {}: {}",
                            check.id.as_str(),
                            check.summary
                        )));
                        if let Some(repair) = &check.repair {
                            lines.push(Line::from(format!("  Next: {repair}")));
                        }
                    }
                }
                lines
            }
            _ => vec![],
        };
        if let Some(status) = &self.status {
            lines.push(Line::from(status.clone()));
        }
        if matches!(self.page, SetupPage::Verify | SetupPage::Results) {
            lines.push(Line::from(""));
            lines.push(Line::from("These checks cover model access and an isolated native read. Session tools, MCP connections, headless automation, and hosted deployment need their own checks."));
        }
        lines.push(Line::from(""));
        lines.push(Line::from(format!(
            "Share setup information: {} (Ctrl+D to change)",
            if self.share_diagnostics { "on" } else { "off" }
        )));
        if let Some(status) = self.collection_status {
            lines.push(Line::from(match status {
                OnboardingCollectionStatus::Queued => {
                    "Setup information queued for the product team."
                }
                OnboardingCollectionStatus::Disabled => "Sharing disabled; setup stays available.",
                OnboardingCollectionStatus::Unavailable => {
                    "Product-team collection unavailable; you can continue setup."
                }
                OnboardingCollectionStatus::Failed => {
                    "Could not send setup information; you can continue setup."
                }
            }));
        }
        lines
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
            SetupPage::Welcome => "Press Enter to continue…   esc skip   PgUp/PgDn scroll",
            SetupPage::Role | SetupPage::UseCase | SetupPage::Workflow => {
                "↑↓ select   enter next   Ctrl+D sharing   esc back"
            }
            SetupPage::Verify => {
                "Enter: run checks   esc reconnect\nCtrl+D sharing   PgUp/PgDn scroll"
            }
            SetupPage::Checking => "PgUp/PgDn scroll   esc close",
            SetupPage::Results if self.checks.as_ref().is_some_and(|r| r.ready) => {
                "enter finish   f feedback   ↑↓ scroll   Ctrl+D sharing"
            }
            SetupPage::Results => "enter retry   f feedback   ↑↓ scroll   esc reconnect",
            SetupPage::Mode => "↑↓ select   enter continue   esc back",
            SetupPage::Provider => "↑↓ select   enter next   esc back",
            SetupPage::Key => "enter save   esc back",
            SetupPage::WaitingEvalops => "esc close",
        }
    }
}

/// A terminal-native landscape: Dex's asymmetric sheet silhouette, a distant
/// crescent, and a few stars. Motion changes the eyes only; layout stays still.
fn render_welcome_scene(
    frame: &mut Frame,
    area: Rect,
    theme: maestro_ui::UiTheme,
    presentation: SetupPresentation,
) {
    if area.width < 32 || area.height < 9 {
        return;
    }
    let mut draw = |x: u16, y: u16, text: &str, color| {
        if x < area.width && y < area.height {
            frame.render_widget(
                Paragraph::new(text.to_owned()).style(Style::default().fg(color)),
                Rect::new(area.x + x, area.y + y, area.width - x, 1),
            );
        }
    };
    draw(0, 0, &"─".repeat(area.width as usize), theme.border);
    draw(
        0,
        area.height - 2,
        &"─".repeat(area.width as usize),
        theme.border,
    );
    for (x, y) in [
        (7, 2),
        (area.width / 2, 3),
        (area.width / 3, area.height - 4),
        (area.width - 5, area.height - 5),
    ] {
        draw(x, y, "✦", theme.muted);
    }
    if area.width >= 64 {
        for (row, line) in [
            "     ░██████░",
            "   ░████░",
            "  ░███░",
            "   ░████░",
            "     ░██████░",
        ]
        .iter()
        .enumerate()
        {
            draw(area.width - 23, 2 + row as u16, line, theme.muted);
        }
        draw(
            area.width / 2,
            area.height - 6,
            "       ░░░░░░",
            theme.border,
        );
        draw(
            area.width / 2,
            area.height - 5,
            "  ░░░░░░░░░░░░░░░░",
            theme.border,
        );
    }
    let blink = presentation.animations && presentation.animation_frame % 64 >= 61;
    let sprite = [
        "      ████████████        ",
        "  ████████████████████    ",
        if blink {
            "████████──████──██████  "
        } else {
            "████████  ████  ██████  "
        },
        "████████████████████████",
        "██████████    ██████████",
        "████████████████████████",
        "  ████  ████  ████  ████",
    ];
    for (row, line) in sprite.iter().enumerate() {
        draw(3, area.height - 8 + row as u16, line, theme.focus);
    }
}

/// Work the TUI must do after the user confirms a page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupAdvance {
    ProfileSaved,
    StartChecks,
    Finish,
    StartEvalops,
    SaveKey {
        provider_id: &'static str,
        secret: String,
    },
}

#[cfg(test)]
#[path = "setup_modal_test.rs"]
mod tests;
