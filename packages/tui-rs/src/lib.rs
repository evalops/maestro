//! Composer TUI - Native terminal interface
//!
//! This crate provides the primary terminal UI for Composer. The Rust binary
//! is the main entry point that users run directly. It spawns a Node.js
//! subprocess for agent logic and handles all terminal rendering natively.
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────┐
//! │  Rust TUI Binary (ratatui + crossterm)      │
//! │  - Main entry point (users run this)        │
//! │  - Owns terminal completely                 │
//! │  - Native rendering & scrollback            │
//! │  - Chat UI, markdown display                │
//! └──────────────────┬──────────────────────────┘
//!                    │ Simple JSON IPC (prompts, responses)
//!                    ▼
//! ┌─────────────────────────────────────────────┐
//! │  Node.js Agent (--headless mode)            │
//! │  - API calls to Claude                      │
//! │  - Tool execution                           │
//! │  - Context management                       │
//! └─────────────────────────────────────────────┘
//! ```

// Core modules
pub mod agent;
pub mod components;
pub mod effects;
pub mod protocol;
pub mod state;
pub mod terminal;

// New feature modules
pub mod diff;
pub mod key_hints;
pub mod markdown;
pub mod pager;
pub mod palette;
pub mod tooltips;
pub mod wrapping;

mod app;
mod render;

pub use agent::AgentProcess;
pub use app::App;
pub use render::Renderer;
pub use state::AppState;

// Re-export commonly used items
pub use diff::{generate_diff, render_diff, Diff, DiffStats};
pub use key_hints::{KeyBinding, KeyHint};
pub use markdown::render_markdown;
pub use pager::Pager;
pub use palette::{best_color, color_level, has_true_color, theme, ColorLevel};
pub use tooltips::random_tooltip;
pub use wrapping::{truncate, visible_width, wrap_line, wrap_spans};
