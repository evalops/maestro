//! Visual effects for the TUI
//!
//! Includes shimmer animations, spinners, and color utilities.

mod shimmer;
mod spinner;

pub use shimmer::shimmer_spans;
pub use spinner::{braille_spinner, dot_spinner, spinner, BRAILLE_FRAMES, DOT_FRAMES};
