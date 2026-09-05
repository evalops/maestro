//! UI-only companion controls. Existing runtime events remain authoritative.
use super::*;
use crate::components::dex_companion::{DexCompanionState, DexPersonality};
use crate::dex_actions::{self, Appearance, Control, LOOKS, Setting};
use crate::dex_delight::DexLook;
use maestro_ui::{ActionPicker, PickerOutcome};

use maestro_interaction::{Action, Attention, Event, Policy, Reaction, Suggestion};

pub(super) struct DexPresentation {
    pub notice: Option<String>,
    pet_notice_index: usize,
    pub suggestion: Suggestion,
    pub picker: ActionPicker<Action<Appearance>>,
    pub attention: Attention<DexCompanionState>,
    reaction: Reaction,
    pub clock: maestro_presentation::clock::ViewClock,
}

impl Default for DexPresentation {
    fn default() -> Self {
        Self {
            notice: None,
            pet_notice_index: 0,
            suggestion: Suggestion::default(),
            picker: ActionPicker::new(LOOKS.to_vec())
                .identified_by(|action| action.id)
                .expect("Dex appearance IDs are unique"),
            attention: Attention::default(),
            reaction: Reaction::default(),
            clock: Default::default(),
        }
    }
}

impl DexPresentation {
    fn now(&self) -> Duration {
        self.clock.now()
    }
    fn pet_frame(&self) -> Option<u64> {
        maestro_presentation::clock::pet_frame(&self.reaction, self.now())
    }
}

pub(super) fn render_appearance(
    frame: &mut ratatui::Frame,
    area: Rect,
    state: &mut ActionPicker<Action<Appearance>>,
    look: DexLook,
) {
    maestro_presentation::components::appearance_picker::render_appearance(
        frame,
        area,
        state,
        look,
        crate::themes::current_ui_theme(),
    );
}

impl App {
    pub(super) fn observed_dex_state(&self) -> DexCompanionState {
        crate::components::activity::dex_state(
            self.state.busy,
            self.approval_controller.is_visible(),
            !self.pending_guardian_reviews.is_empty()
                && !self
                    .state
                    .messages
                    .iter()
                    .flat_map(|message| &message.tool_calls)
                    .any(|call| call.status == crate::state::ToolCallStatus::Running),
            self.state.error.is_some(),
            self.dex_terminal,
        )
    }

    pub(super) fn dex_begin_turn(&mut self) {
        self.dex_delight.notice = None;
        self.dex_delight.suggestion.reset();
        // Two quick turns can complete between frames; each new turn can notify.
        let policy = self.dex_policy();
        let now = self.dex_delight.now();
        self.dex_delight
            .attention
            .update(Event::Started(DexCompanionState::Working), now, policy);
    }

    pub(super) fn dex_look(&self) -> DexLook {
        let mut look = DexLook {
            accessory: self.ui_prefs.dex_accessory,
            accent: self.ui_prefs.dex_accent,
            activity: crate::dex_delight::observed_activity(&self.state),
            pet_frame: if self.dex_pet_active() {
                self.dex_delight.pet_frame()
            } else {
                None
            },
        };
        // A preview is a projection of the saved look plus one highlighted action.
        // Leaving the modal drops it without writing or rolling back preferences.
        if self.active_modal == ActiveModal::DexAppearance {
            if let Some(action) = self.dex_delight.picker.selected() {
                match action.value {
                    Appearance::Accessory(value) => look.accessory = value,
                    Appearance::Accent(value) => look.accent = value,
                }
            }
        }
        look
    }

    /// Cosmetic reactions never compete with a decision or failure.
    pub(super) fn dex_can_delight(&self) -> bool {
        self.active_modal == ActiveModal::None
            && self.ui_prefs.dex_personality() != DexPersonality::Quiet
            && !matches!(
                self.observed_dex_state(),
                DexCompanionState::NeedsInput | DexCompanionState::Failed
            )
    }

    pub(super) fn dex_pet_active(&self) -> bool {
        self.dex_can_delight()
            && self
                .ui_prefs
                .animations
                .unwrap_or(self.configured_animations)
            && self.dex_delight.pet_frame().is_some()
    }

    pub(super) fn pet_dex(&mut self) {
        // Reactions never cover an approval or change an observed failure state.
        if !self.dex_can_delight() {
            return;
        }
        let now = self.dex_delight.now();
        self.dex_delight.reaction.start(now);
        if self.ui_prefs.dex_personality() != DexPersonality::Quiet && !self.state.busy {
            const REACTIONS: [&str; 3] = [
                "Dex appreciates the boop.",
                "A tiny bow from Dex.",
                "Dex is all ears.",
            ];
            self.dex_delight.notice =
                Some(REACTIONS[self.dex_delight.pet_notice_index].to_string());
            self.dex_delight.pet_notice_index =
                (self.dex_delight.pet_notice_index + 1) % REACTIONS.len();
        }
    }

    pub(super) fn dex_hit(&self, x: u16, y: u16) -> bool {
        if self.ui_prefs.dex_personality() == DexPersonality::Quiet {
            return false;
        }
        let Some((width, height)) = self.terminal_size else {
            return false;
        };
        let area = Rect::new(0, 0, width, height);
        let input = calculate_input_height(&self.state, area);
        let footer = u16::from(!self.state.zen_mode);
        let mark = if !self
            .state
            .messages
            .iter()
            .any(crate::components::should_render_message)
        {
            crate::dex_delight::welcome_portrait_area(Rect::new(
                0,
                0,
                width,
                height.saturating_sub(input + footer),
            ))
        } else if width >= 48 && height >= 16 {
            Some(Rect::new(
                0,
                height.saturating_sub(input + footer + 2),
                6,
                2,
            ))
        } else {
            None
        };
        mark.is_some_and(|r| r.contains((x, y).into()))
    }

    pub(super) fn dex_next_prompt(&self) -> Option<&'static str> {
        if self.ui_prefs.dex_suggestions_disabled
            || !self.state.input().is_empty()
            || self.active_modal != ActiveModal::None
        {
            return None;
        }
        self.dex_delight
            .suggestion
            .visible(crate::dex_delight::next_prompt(
                &self.state,
                self.dex_terminal,
            ))
    }

    fn dex_policy(&self) -> Policy {
        Policy {
            notifications: self.ui_prefs.dex_notifications
                && self.terminal_notifier.should_send_desktop_notification(),
            recaps: !self.ui_prefs.dex_recap_disabled,
            ..Policy::default()
        }
    }

    pub(super) fn dex_focus_lost(&mut self) {
        let policy = self.dex_policy();
        let now = self.dex_delight.now();
        self.dex_delight
            .attention
            .update(Event::FocusLost, now, policy);
    }

    pub(super) fn dex_focus_returned(&mut self) {
        let state = self.observed_dex_state();
        let policy = self.dex_policy();
        let now = self.dex_delight.now();
        let effect = self.dex_delight.attention.update(
            Event::FocusGained {
                state,
                attention: needs_attention(state),
            },
            now,
            policy,
        );
        if let Some(state) = effect.recap {
            self.dex_delight.notice = Some(format!(
                "Welcome back. {}",
                crate::dex_delight::recap(&self.state, Some(state))
            ));
        }
    }

    pub(super) fn dex_observe_attention(
        &mut self,
        state: DexCompanionState,
    ) -> Option<crate::notifications::DexAttention> {
        let policy = self.dex_policy();
        let now = self.dex_delight.now();
        let effects = self.dex_delight.attention.update(
            Event::Observed {
                state,
                attention: needs_attention(state),
            },
            now,
            policy,
        );
        effects.notification.and_then(|state| match state {
            DexCompanionState::Finished => Some(crate::notifications::DexAttention::Finished),
            DexCompanionState::Failed => Some(crate::notifications::DexAttention::Failed),
            DexCompanionState::NeedsInput => Some(crate::notifications::DexAttention::NeedsInput),
            _ => None,
        })
    }

    pub(super) fn sync_dex_attention(&mut self) {
        if let Some(effect) = self.dex_observe_attention(self.observed_dex_state()) {
            crate::notifications::notify_dex_attention(effect);
        }
    }

    pub(super) fn handle_dex_command(&mut self, setting: &str) {
        match dex_actions::controls()
            .find(setting)
            .map(|action| action.value)
        {
            Some(Control::Pet) => {
                self.pet_dex();
                return;
            }
            Some(Control::Appearance) => {
                self.dex_delight.picker.open();
                if let Some(action) = LOOKS.iter().find(|action| {
                    matches!(action.value, Appearance::Accessory(value) if value == self.ui_prefs.dex_accessory)
                }) {
                    self.dex_delight.picker.select_id(action.id);
                }
                self.active_modal = ActiveModal::DexAppearance;
                return;
            }
            Some(Control::Recap) => {
                self.dex_delight.notice = Some(crate::dex_delight::recap(
                    &self.state,
                    self.dex_delight
                        .attention
                        .last_observed()
                        .or(self.dex_terminal),
                ));
                return;
            }
            Some(Control::Next) => {
                if let Some(prompt) =
                    crate::dex_delight::next_prompt(&self.state, self.dex_terminal)
                {
                    if self.state.input().is_empty() {
                        self.state.set_input(prompt);
                        self.update_slash_state();
                        self.dex_delight.suggestion.dismiss();
                    }
                } else {
                    self.dex_delight.notice = Some("No next step to suggest yet.".to_string());
                }
                return;
            }
            Some(Control::Help) => {
                self.dex_delight.notice = Some(
                    "/dex appearance · pet · recap · next · notifications-on · tips-off"
                        .to_string(),
                );
                return;
            }
            _ => {}
        }
        if let Some(action) = dex_actions::looks().find(setting) {
            self.apply_dex_appearance(*action);
            return;
        }
        let Some(action) = dex_actions::settings().find(setting) else {
            return;
        };
        let mut prefs = crate::ui_prefs::UiPrefs::load_default();
        match action.value {
            Setting::Personality(value) => prefs.dex_personality = Some(value.to_owned()),
            Setting::Motion(value) => prefs.animations = Some(value),
            Setting::Tips(value) => prefs.dex_tips_dismissed = !value,
            Setting::Notifications(value) => prefs.dex_notifications = value,
            Setting::Suggestions(value) => prefs.dex_suggestions_disabled = !value,
            Setting::Recap(value) => prefs.dex_recap_disabled = !value,
        }
        self.save_dex_prefs(prefs, action.label);
    }

    fn apply_dex_appearance(&mut self, action: Action<Appearance>) {
        let mut prefs = crate::ui_prefs::UiPrefs::load_default();
        match action.value {
            Appearance::Accessory(value) => prefs.dex_accessory = value,
            Appearance::Accent(value) => prefs.dex_accent = value,
        }
        prefs.dex_tips_dismissed = true;
        self.save_dex_prefs(prefs, action.label);
    }

    fn save_dex_prefs(&mut self, prefs: crate::ui_prefs::UiPrefs, description: &str) {
        match prefs.save_default() {
            Ok(()) => {
                self.ui_prefs = prefs;
                self.dex_delight.notice = Some(format!("Dex: {description} (saved)"));
            }
            Err(error) => {
                self.state.error = Some(format!("Could not save Dex preferences: {error}"));
            }
        }
    }

    pub(super) fn handle_dex_appearance_key(&mut self, code: KeyCode) -> Result<()> {
        match self.dex_delight.picker.handle_key(code, false) {
            PickerOutcome::Selected(action) => {
                self.apply_dex_appearance(action);
                self.active_modal = ActiveModal::None;
            }
            PickerOutcome::Cancelled => self.active_modal = ActiveModal::None,
            PickerOutcome::Pending | PickerOutcome::Changed(_) => {}
        }
        Ok(())
    }
}

fn needs_attention(state: DexCompanionState) -> bool {
    matches!(
        state,
        DexCompanionState::Finished | DexCompanionState::Failed | DexCompanionState::NeedsInput
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_appearance_picker_keeps_last_option_and_position_visible() {
        let backend = ratatui::backend::TestBackend::new(60, 20);
        let mut terminal = ratatui::Terminal::new(backend).expect("test terminal");
        let mut state = ActionPicker::new(LOOKS.to_vec());
        state.open();
        for _ in 1..LOOKS.len() {
            state.handle_key(KeyCode::Down, false);
        }
        terminal
            .draw(|frame| render_appearance(frame, frame.area(), &mut state, DexLook::default()))
            .expect("render appearance picker");
        let buffer = terminal.backend().buffer();
        let text = (0..20)
            .map(|y| (0..60).map(|x| buffer[(x, y)].symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("› Accent: rose"));
        assert!(text.contains("12/12"));
        assert!(text.contains("Esc cancel"));
        assert_eq!(
            state.selected().map(|action| action.label),
            Some("Accent: rose")
        );
    }
}
