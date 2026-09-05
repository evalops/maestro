//! Stateless Dex presentation. Callers supply observed activity; visual preferences
//! never select activity, model identity, instructions, or execution behavior.

use ratatui::{prelude::*, widgets::Paragraph};

/// Activity observed by the caller, never inferred from animation or elapsed time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DexCompanionState {
    /// The session can accept a request.
    Ready,
    /// An accepted request is actively running.
    Working,
    /// A user response or approval is required.
    NeedsInput,
    /// Accepted work is waiting on an external prerequisite.
    Waiting,
    /// The current request completed successfully.
    Finished,
    /// The current request failed.
    Failed,
}

impl DexCompanionState {
    /// Plain state text remains visible even without color or animation.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Working => "working",
            Self::NeedsInput => "needs input",
            Self::Waiting => "waiting",
            Self::Finished => "finished",
            Self::Failed => "failed",
        }
    }
}

/// Presentation intensity only; never changes prompts or capabilities.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum DexPersonality {
    /// Text only; always static.
    Quiet,
    /// The selected Dex accent and plain state text.
    #[default]
    Standard,
    /// Add a small state signal beside the same identity and text.
    Expressive,
}

/// A frame-local widget with stable Dex identity across models and activities.
#[derive(Debug, Clone, Copy)]
pub struct DexCompanion {
    state: DexCompanionState,
    personality: DexPersonality,
    animations: bool,
    frame: u64,
    look: crate::dex_delight::DexLook,
}

impl DexCompanion {
    /// Render only the state supplied by the activity owner. Motion defaults off.
    #[must_use]
    pub fn new(state: DexCompanionState) -> Self {
        Self {
            state,
            personality: DexPersonality::Standard,
            animations: false,
            frame: 0,
            look: Default::default(),
        }
    }

    /// Select presentation intensity independently of activity.
    #[must_use]
    pub const fn personality(mut self, personality: DexPersonality) -> Self {
        self.personality = personality;
        self
    }

    /// Disable for reduced motion. Quiet presentation remains static regardless.
    #[must_use]
    pub const fn animations(mut self, enabled: bool) -> Self {
        self.animations = enabled;
        self
    }

    /// Supply the application's animation frame; this widget keeps no clock.
    #[must_use]
    pub const fn frame(mut self, frame: u64) -> Self {
        self.frame = frame;
        self
    }

    /// Apply cosmetics without altering the observed activity.
    pub const fn look(mut self, look: crate::dex_delight::DexLook) -> Self {
        self.look = look;
        self
    }

    /// Six compact expressions; the explicit state label remains the authority.
    #[must_use]
    pub const fn face(&self) -> &'static str {
        match self.state {
            DexCompanionState::Ready => "╰• •╯",
            DexCompanionState::Working => "╰¬ ¬╯",
            DexCompanionState::NeedsInput => "╰• ?╯",
            DexCompanionState::Waiting => "╰− −╯",
            DexCompanionState::Finished => "╰^ ^╯",
            DexCompanionState::Failed => "╰˙ ˎ╯",
        }
    }

    /// A single hop, never a loop. Frames are 100 ms since the observed transition.
    #[must_use]
    pub const fn hopping(&self) -> bool {
        self.animations
            && !matches!(self.personality, DexPersonality::Quiet)
            && matches!(self.state, DexCompanionState::Finished)
            && self.frame >= 2
            && self.frame < 6
    }

    /// Render a tiny portrait in a fixed two-row slot without moving status text.
    pub fn render_face(&self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() || self.personality == DexPersonality::Quiet {
            return;
        }
        let y = area.y + if self.hopping() { 0 } else { area.height - 1 };
        let motion = self.animations && self.personality != DexPersonality::Quiet;
        let face = format!(
            "╰{}╯{}",
            self.look.eyes(self.state, motion),
            self.look.prop()
        );
        let style = Style::default().fg(self.look.accent.color());
        if !self.hopping() && area.height > 1 {
            Paragraph::new(self.look.cap())
                .style(style)
                .render(Rect::new(area.x, area.y, area.width, 1), buf);
        }
        Paragraph::new(face)
            .style(style)
            .render(Rect::new(area.x, y, area.width, 1), buf);
    }

    /// Compact, explicit activity line suitable for existing status surfaces.
    #[must_use]
    pub fn status_line(&self) -> Line<'static> {
        let mut spans = vec![Span::styled(
            "Dex",
            Style::default()
                .fg(self.look.accent.color())
                .add_modifier(Modifier::BOLD),
        )];
        if self.personality == DexPersonality::Expressive {
            let signal = match self.state {
                DexCompanionState::Working if self.animations => {
                    ["·", "•", "●", "•"][(self.frame / 4 % 4) as usize]
                }
                DexCompanionState::Working => "●",
                DexCompanionState::NeedsInput => "?",
                DexCompanionState::Waiting => "…",
                DexCompanionState::Finished => "✓",
                DexCompanionState::Failed => "!",
                DexCompanionState::Ready => "·",
            };
            spans.push(Span::raw(format!(" {signal}")));
        }
        spans.push(Span::raw(format!(" · {}", self.state.label())));
        Line::from(spans)
    }
}

impl Widget for DexCompanion {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let mut lines = if self.personality == DexPersonality::Quiet {
            Vec::new()
        } else {
            let eyes = match self.state {
                DexCompanionState::Ready => "•   •",
                DexCompanionState::Working => "¬   ¬",
                DexCompanionState::NeedsInput => "•   ?",
                DexCompanionState::Waiting => "−   −",
                DexCompanionState::Finished => "^   ^",
                DexCompanionState::Failed => "˙   ˎ",
            };
            super::deixic_logo::static_logo_lines(area.height.saturating_sub(1))
                .into_iter()
                .map(|line| {
                    Line::styled(
                        line.to_string()
                            .replace("•   •", eyes)
                            .replace("• •", &eyes.replace("   ", " ")),
                        Style::default().fg(self.look.accent.color()),
                    )
                })
                .collect()
        };
        // Preserve the state row even if the shared mark gains a taller tier.
        lines.truncate(usize::from(area.height.saturating_sub(1)));
        lines.push(self.status_line());
        Paragraph::new(lines)
            .alignment(Alignment::Center)
            .render(area, buf);
    }
}

/// Apply the production startup portrait to the shared compact welcome mark.
pub fn render_welcome_portrait(
    area: Rect,
    buf: &mut Buffer,
    look: crate::dex_delight::DexLook,
    state: DexCompanionState,
    animations: bool,
) {
    if let Some(mark) = crate::dex_delight::welcome_portrait_area(area) {
        let eyes = look.eyes(state, animations);
        let face = format!("  ╭─╯ {:5}  ╰╮ ", eyes.replace(' ', "   "));
        Paragraph::new(face)
            .style(Style::default().fg(look.accent.color()))
            .render(Rect::new(mark.x, mark.y + 1, mark.width, 1), buf);
        for y in mark.y..mark.bottom() {
            for x in mark.x..mark.right() {
                buf[(x, y)].set_fg(look.accent.color());
            }
        }
        if look.accessory != crate::dex_delight::DexAccessory::None {
            Paragraph::new(look.cap())
                .style(Style::default().fg(look.accent.color()))
                .render(Rect::new(mark.x + 4, mark.y.saturating_sub(1), 5, 1), buf);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_portrait_share_the_selected_accent() {
        use crate::dex_delight::{DexAccent, DexLook};
        for accent in [
            DexAccent::Violet,
            DexAccent::Mint,
            DexAccent::Amber,
            DexAccent::Rose,
        ] {
            let companion = DexCompanion::new(DexCompanionState::Ready).look(DexLook {
                accent,
                ..DexLook::default()
            });
            assert_eq!(
                companion.status_line().spans[0].style.fg,
                Some(accent.color())
            );
            let area = Rect::new(0, 0, 30, 8);
            let mut buf = Buffer::empty(area);
            companion.render(area, &mut buf);
            assert!(
                (0..area.width).any(|x| {
                    let cell = &buf[(x, 0)];
                    cell.fg == accent.color() && cell.symbol() != " "
                }),
                "the first portrait row must use the selected accent"
            );
        }
    }

    #[test]
    fn poses_are_distinct_and_hop_is_bounded_and_optional() {
        let states = [
            DexCompanionState::Ready,
            DexCompanionState::Working,
            DexCompanionState::NeedsInput,
            DexCompanionState::Waiting,
            DexCompanionState::Finished,
            DexCompanionState::Failed,
        ];
        let faces: std::collections::HashSet<_> = states
            .into_iter()
            .map(|state| DexCompanion::new(state).face())
            .collect();
        assert_eq!(faces.len(), 6);
        for personality in [
            DexPersonality::Quiet,
            DexPersonality::Standard,
            DexPersonality::Expressive,
        ] {
            for state in states {
                for motion in [false, true] {
                    for frame in [0, 2, 5, 6, 10_000] {
                        let dex = DexCompanion::new(state)
                            .personality(personality)
                            .animations(motion)
                            .frame(frame);
                        assert_eq!(
                            dex.hopping(),
                            motion
                                && personality != DexPersonality::Quiet
                                && state == DexCompanionState::Finished
                                && (2..6).contains(&frame)
                        );
                        let area = Rect::new(0, 0, 5, 2);
                        let mut buf = Buffer::empty(area);
                        dex.render_face(area, &mut buf);
                        if personality != DexPersonality::Quiet {
                            let row = u16::from(!dex.hopping());
                            let text: String = (0..5).map(|x| buf[(x, row)].symbol()).collect();
                            assert_eq!(text, dex.face());
                        } else {
                            assert!(buf.content.iter().all(|cell| cell.symbol() == " "));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn all_states_remain_explicit_across_personality_and_motion() {
        for state in [
            DexCompanionState::Ready,
            DexCompanionState::Working,
            DexCompanionState::NeedsInput,
            DexCompanionState::Waiting,
            DexCompanionState::Finished,
            DexCompanionState::Failed,
        ] {
            for personality in [
                DexPersonality::Quiet,
                DexPersonality::Standard,
                DexPersonality::Expressive,
            ] {
                for animate in [false, true] {
                    let text = DexCompanion::new(state)
                        .personality(personality)
                        .animations(animate)
                        .frame(8)
                        .status_line()
                        .to_string();
                    assert!(text.starts_with("Dex"));
                    assert!(text.ends_with(state.label()));
                }
            }
        }
    }

    #[test]
    fn reduced_motion_and_quiet_are_frame_independent() {
        let expressive =
            DexCompanion::new(DexCompanionState::Working).personality(DexPersonality::Expressive);
        assert_eq!(
            expressive.frame(0).status_line(),
            expressive.frame(8).status_line()
        );
        let quiet = expressive
            .personality(DexPersonality::Quiet)
            .animations(true);
        assert_eq!(quiet.frame(0).status_line(), quiet.frame(8).status_line());
        let animated = expressive.animations(true);
        assert_ne!(
            animated.frame(0).status_line(),
            animated.frame(8).status_line()
        );
        let ready = DexCompanion::new(DexCompanionState::Ready)
            .personality(DexPersonality::Expressive)
            .animations(true);
        assert_eq!(ready.frame(0).status_line(), ready.frame(8).status_line());
    }

    #[test]
    fn widget_keeps_state_readable_in_a_single_row() {
        let area = Rect::new(0, 0, 32, 1);
        let mut buf = Buffer::empty(area);
        DexCompanion::new(DexCompanionState::NeedsInput).render(area, &mut buf);
        let text: String = (0..area.width).map(|x| buf[(x, 0)].symbol()).collect();
        assert!(text.contains("Dex · needs input"));
    }

    #[test]
    fn short_companion_preserves_state_at_every_logo_tier() {
        for height in 1..=14 {
            let area = Rect::new(0, 0, 32, height);
            let mut buf = Buffer::empty(area);
            DexCompanion::new(DexCompanionState::NeedsInput).render(area, &mut buf);
            let text: String = buf.content.iter().map(|cell| cell.symbol()).collect();
            assert!(
                text.contains("Dex · needs input"),
                "height {height}: {text}"
            );
        }
    }

    #[test]
    fn widget_uses_existing_mark_and_state_without_model_identity() {
        let area = Rect::new(0, 0, 40, 14);
        let mut buf = Buffer::empty(area);
        DexCompanion::new(DexCompanionState::Failed).render(area, &mut buf);
        let text: String = buf.content.iter().map(|cell| cell.symbol()).collect();
        let mark = super::super::deixic_logo::static_logo_lines(area.height.saturating_sub(1));
        assert!(!mark.is_empty());
        assert!(text.contains("˙   ˎ"));
        assert!(text.contains("Dex · failed"));
    }
}

#[cfg(test)]
mod delight_render_tests {
    use super::*;
    use crate::dex_delight::{DexAccent, DexAccessory, DexActivity, DexLook};

    #[test]
    fn cosmetics_and_reactions_keep_fixed_bounds_and_quiet_is_empty() {
        let area = Rect::new(0, 0, 6, 2);
        let look = DexLook {
            accessory: DexAccessory::Beanie,
            accent: DexAccent::Mint,
            activity: DexActivity::Running,
            pet_frame: Some(4),
        };
        let mut buffer = Buffer::empty(area);
        DexCompanion::new(DexCompanionState::Working)
            .look(look)
            .animations(true)
            .render_face(area, &mut buffer);
        let text: String = buffer.content.iter().map(|c| c.symbol()).collect();
        assert!(text.contains("╭─●─╮"));
        assert!(text.contains("− −"));
        assert!(text.contains('▤'));
        assert_eq!(buffer[(0, 1)].fg, DexAccent::Mint.color());
        let mut quiet = Buffer::empty(area);
        DexCompanion::new(DexCompanionState::Working)
            .look(look)
            .personality(DexPersonality::Quiet)
            .render_face(area, &mut quiet);
        assert!(quiet.content.iter().all(|c| c.symbol() == " "));
    }
}
