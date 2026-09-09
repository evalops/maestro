//! Frame-local product appearance values; the runtime supplies observed activity.
use crate::components::dex_companion::DexCompanionState;
use ratatui::{layout::Rect, style::Color};
use serde::{Deserialize, Serialize};

/// Cosmetic accessory, independent of the selected model or capabilities.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DexAccessory {
    #[default]
    None,
    Glasses,
    Beanie,
    Antenna,
    Sprout,
    CatEars,
    Crown,
    Bow,
}

/// Small, deliberately readable accent palette.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DexAccent {
    #[default]
    Violet,
    Mint,
    Amber,
    Rose,
}

impl DexAccent {
    pub fn color(self) -> Color {
        match self {
            Self::Violet => {
                let (r, g, b) = crate::shimmer::DEIXIC_ACCENT;
                Color::Rgb(r, g, b)
            }
            Self::Mint => Color::Rgb(147, 190, 166),
            Self::Amber => Color::Rgb(210, 183, 128),
            Self::Rose => Color::Rgb(207, 158, 178),
        }
    }
}

/// Presentation of a known running tool. Unknown tools keep the neutral face.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum DexActivity {
    #[default]
    Thinking,
    Reading,
    Searching,
    Editing,
    Running,
}

impl DexActivity {
    pub fn from_tool(tool: &str) -> Self {
        match tool {
            "read" | "read_file" => Self::Reading,
            "grep" | "glob" | "search" | "web_search" => Self::Searching,
            "edit" | "write" | "apply_patch" => Self::Editing,
            "bash" | "shell" | "execute" => Self::Running,
            _ => Self::Thinking,
        }
    }

    pub const fn phrase(self) -> &'static str {
        match self {
            Self::Thinking => "Mulling it over…",
            Self::Reading => "Taking a closer look…",
            Self::Searching => "Following the clues…",
            Self::Editing => "Making a few adjustments…",
            Self::Running => "Keeping an eye on it…",
        }
    }
}

/// A frame-local description shared by startup, the activity line, and previews.
#[derive(Debug, Clone, Copy, Default)]
pub struct DexLook {
    pub accessory: DexAccessory,
    pub accent: DexAccent,
    pub activity: DexActivity,
    /// Some only during an explicit pet reaction; never selects runtime state.
    pub pet_frame: Option<u64>,
}

impl DexLook {
    pub fn eyes(self, state: DexCompanionState, motion: bool) -> &'static str {
        // Attention expressions always take precedence over cosmetic reactions.
        if state == DexCompanionState::Failed {
            return "⠂ ⠕";
        }
        if state == DexCompanionState::NeedsInput {
            return "• ?";
        }
        // One brief blink, then a smile. No idle loop or change to activity.
        if let Some(frame) = self.pet_frame.filter(|_| motion) {
            match frame {
                0..=1 => return "− −",
                2..=5 => return "^ ^",
                _ => {}
            }
        }
        if self.accessory == DexAccessory::Glasses
            || (state == DexCompanionState::Working && self.activity == DexActivity::Reading)
        {
            return "o-o";
        }
        match state {
            DexCompanionState::Ready => "• •",
            DexCompanionState::Working if self.activity == DexActivity::Searching => "• O",
            DexCompanionState::Working if self.activity == DexActivity::Running => "⠶ ⠶",
            DexCompanionState::Working => "¬ ¬",
            DexCompanionState::NeedsInput => "• ?",
            DexCompanionState::Waiting => "− −",
            DexCompanionState::Finished => "^ ^",
            DexCompanionState::Failed => "⠂ ⠕",
        }
    }

    pub const fn cap(self) -> &'static str {
        match self.accessory {
            DexAccessory::Beanie => "╭─●─╮",
            DexAccessory::Antenna => "  °  ",
            DexAccessory::Sprout => " \\|/ ",
            DexAccessory::CatEars => "/\\ /\\",
            DexAccessory::Crown => " \\W/ ",
            DexAccessory::Bow => " >o< ",
            _ => "     ",
        }
    }

    pub const fn prop(self) -> &'static str {
        match self.activity {
            DexActivity::Editing => "/",
            DexActivity::Running => "▤",
            _ => " ",
        }
    }
}

/// Exact startup hit area, matching the selected welcome mark.
pub fn welcome_portrait_area(area: Rect) -> Option<Rect> {
    (area.width >= 44 && area.height >= 5).then(|| {
        let height = crate::components::deixic_logo::welcome_logo_height(area.height);
        Rect::new(
            area.x + 1,
            area.y + 1,
            crate::components::deixic_logo::logo_visual_width(height),
            crate::components::deixic_logo::logo_line_count(height),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_and_failure_have_static_distinct_eyes() {
        let running = DexLook {
            activity: DexActivity::Running,
            ..Default::default()
        };
        assert_eq!(running.eyes(DexCompanionState::Working, false), "⠶ ⠶");
        assert_ne!(
            running.eyes(DexCompanionState::Working, false),
            DexLook::default().eyes(DexCompanionState::Working, false)
        );
        assert_eq!(running.eyes(DexCompanionState::Failed, false), "⠂ ⠕");
    }

    #[test]
    fn pet_blinks_then_smiles_and_returns_to_observed_state() {
        for (frame, expected) in [
            (0, "− −"),
            (1, "− −"),
            (2, "^ ^"),
            (5, "^ ^"),
            (6, "• •"),
            (1000, "• •"),
        ] {
            let look = DexLook {
                pet_frame: Some(frame),
                ..Default::default()
            };
            assert_eq!(look.eyes(DexCompanionState::Ready, true), expected);
            assert_eq!(look.eyes(DexCompanionState::Ready, false), "• •");
            assert_eq!(look.eyes(DexCompanionState::Failed, true), "⠂ ⠕");
            assert_eq!(look.eyes(DexCompanionState::NeedsInput, true), "• ?");
        }
        let look = DexLook {
            pet_frame: Some(6),
            accessory: DexAccessory::Glasses,
            ..Default::default()
        };
        assert_eq!(look.eyes(DexCompanionState::Ready, true), "o-o");
    }
}
