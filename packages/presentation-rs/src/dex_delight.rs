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
            return "˙ ˎ";
        }
        if state == DexCompanionState::NeedsInput {
            return "• ?";
        }
        if motion && self.pet_frame.is_some_and(|f| f < 8) {
            return if self.pet_frame.is_some_and(|f| f < 3) {
                "o o"
            } else if self.pet_frame.is_some_and(|f| f < 6) {
                "− −"
            } else {
                "^ −"
            };
        }
        if self.accessory == DexAccessory::Glasses
            || (state == DexCompanionState::Working && self.activity == DexActivity::Reading)
        {
            return "o-o";
        }
        match state {
            DexCompanionState::Ready => "• •",
            DexCompanionState::Working if self.activity == DexActivity::Searching => "• O",
            DexCompanionState::Working => "¬ ¬",
            DexCompanionState::NeedsInput => "• ?",
            DexCompanionState::Waiting => "− −",
            DexCompanionState::Finished => "^ ^",
            DexCompanionState::Failed => "˙ ˎ",
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

/// Exact startup hit area, matching the compact welcome mark.
pub fn welcome_portrait_area(area: Rect) -> Option<Rect> {
    (area.width >= 44 && area.height >= 5).then(|| Rect::new(area.x + 1, area.y + 1, 16, 3))
}
