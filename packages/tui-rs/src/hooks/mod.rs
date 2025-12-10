//! Hook system for Composer
//!
//! Provides a trait-based hook system that allows intercepting and modifying
//! agent behavior at various points in the execution lifecycle.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────┐     PreToolUse      ┌─────────────┐
//! │   Agent     │ ────────────────────>│   Hooks     │
//! │             │                      │  Registry   │
//! │             │<──────────────────── │             │
//! └─────────────┘   Allow/Block/Modify └─────────────┘
//! ```
//!
//! # Hook Types
//!
//! - **PreToolUse**: Called before a tool executes, can block or modify input
//! - **PostToolUse**: Called after tool execution, can modify output
//! - **SessionStart/End**: Called at session lifecycle boundaries
//! - **Overflow**: Called when context overflow is detected
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::hooks::{HookRegistry, PreToolUseHook, HookResult};
//!
//! struct LoggingHook;
//!
//! impl PreToolUseHook for LoggingHook {
//!     fn on_pre_tool_use(
//!         &self,
//!         tool_name: &str,
//!         tool_input: &serde_json::Value,
//!     ) -> HookResult {
//!         println!("Tool: {} called with {:?}", tool_name, tool_input);
//!         HookResult::Continue
//!     }
//! }
//!
//! let mut registry = HookRegistry::new();
//! registry.register_pre_tool_use(Box::new(LoggingHook));
//! ```

mod types;
mod registry;

pub use types::*;
pub use registry::*;
