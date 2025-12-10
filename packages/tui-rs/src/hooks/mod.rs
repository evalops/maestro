//! Hook system for Composer
//!
//! Provides a comprehensive hook system for intercepting and modifying agent
//! behavior. Supports multiple execution backends:
//!
//! - **Native Rust hooks** - Trait-based, zero overhead
//! - **Lua scripts** - Lightweight scripting for custom logic
//! - **WASM plugins** - Sandboxed, polyglot plugins
//! - **TypeScript hooks** - IPC bridge to Node.js hooks
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────┐     PreToolUse      ┌─────────────────────────────┐
//! │   Agent     │ ────────────────────>│       Hook System           │
//! │             │                      │                             │
//! │             │<──────────────────── │  ┌─────────┐ ┌─────────┐   │
//! └─────────────┘   Allow/Block/Modify │  │  Rust   │ │   Lua   │   │
//!                                      │  │ Traits  │ │ Scripts │   │
//!                                      │  └─────────┘ └─────────┘   │
//!                                      │  ┌─────────┐ ┌─────────┐   │
//!                                      │  │  WASM   │ │ Node.js │   │
//!                                      │  │ Plugins │ │  Bridge │   │
//!                                      │  └─────────┘ └─────────┘   │
//!                                      └─────────────────────────────┘
//! ```
//!
//! # Hook Types
//!
//! - **PreToolUse**: Called before a tool executes, can block or modify input
//! - **PostToolUse**: Called after tool execution, can modify output
//! - **SessionStart/End**: Called at session lifecycle boundaries
//! - **Overflow**: Called when context overflow is detected
//!
//! # Configuration
//!
//! Hooks can be configured via TOML files:
//! - `~/.composer/hooks.toml` - Global hooks
//! - `.composer/hooks.toml` - Project-local hooks
//!
//! ```toml
//! [settings]
//! enabled = true
//! timeout_ms = 30000
//!
//! [[hooks]]
//! event = "PreToolUse"
//! tools = ["Bash"]
//! lua = """
//! if tool_input.command:match("rm %-rf") then
//!     return { block = true, reason = "Dangerous command" }
//! end
//! """
//! ```
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::hooks::{HookRegistry, PreToolUseHook, HookResult};
//!
//! struct LoggingHook;
//!
//! impl PreToolUseHook for LoggingHook {
//!     fn on_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
//!         println!("Tool: {} called", input.tool_name);
//!         HookResult::Continue
//!     }
//! }
//!
//! let mut registry = HookRegistry::new();
//! registry.register_pre_tool_use(Arc::new(LoggingHook));
//! ```

mod types;
mod registry;
mod config;
mod lua;
mod wasm;
mod bridge;
mod overflow;

pub use types::*;
pub use registry::*;
pub use config::*;
pub use lua::*;
pub use wasm::*;
pub use bridge::*;
pub use overflow::*;
