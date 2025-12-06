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

pub mod agent;
pub mod components;
pub mod effects;
pub mod protocol;
pub mod state;
pub mod terminal;

mod app;
mod render;

pub use agent::AgentProcess;
pub use app::App;
pub use render::Renderer;
pub use state::AppState;
