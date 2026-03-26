//! Visual Effects and Animations
//!
//! This module provides terminal-based visual effects for the TUI, including
//! spinners, shimmer animations, and color utilities. These effects provide
//! visual feedback during loading states and enhance the user experience.
//!
//! # Available Effects
//!
//! ## Spinners
//!
//! Animated loading indicators that cycle through character frames:
//!
//! - **Braille Spinner**: Uses braille characters (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) for a smooth animation
//! - **Dot Spinner**: Classic three-dot animation (`⠏⠛⠹⠼⠶⠧`)
//!
//! Spinners are frame-based - you provide a frame counter and get back the
//! appropriate character to display.
//!
//! ## Shimmer Animation
//!
//! A gradient-like effect that creates a "shine" moving across text. Used
//! for loading states to indicate activity without being distracting.
//!
//! # Usage Examples
//!
//! ## Basic Spinner
//!
//! ```rust,ignore
//! use maestro_tui::effects::{spinner, braille_spinner};
//!
//! // In your render loop, increment frame each iteration
//! let frame = 42;
//! let spinner_char = spinner(frame); // Returns current spinner frame
//!
//! // Or use a specific spinner style
//! let braille = braille_spinner(frame);
//! ```
//!
//! ## Shimmer Effect
//!
//! ```rust,ignore
//! use maestro_tui::effects::shimmer_spans;
//! use ratatui::style::Color;
//!
//! // Create shimmer effect on text
//! let text = "Loading...";
//! let frame = 42;
//! let spans = shimmer_spans(text, frame, Color::Cyan, Color::Blue);
//! ```
//!
//! # Performance Notes
//!
//! - Effects are purely computational - no I/O or allocation per frame
//! - Frame counters should wrap around (use `wrapping_add` or modulo)
//! - Spinner arrays are `const` for zero runtime cost
//!
//! # Rust Concepts
//!
//! - **Const Arrays**: Spinner frames are compile-time constants
//! - **Modular Arithmetic**: Frame wrapping for smooth animation loops
//! - **Zero-Copy**: Returns references to static data where possible

mod shimmer;
mod spinner;

pub use shimmer::shimmer_spans;
pub use spinner::{braille_spinner, dot_spinner, spinner, BRAILLE_FRAMES, DOT_FRAMES};
