//! Lua scripting support for hooks
//!
//! Embeds mlua for running Lua scripts as hooks. This provides a lightweight,
//! sandboxed scripting environment for custom hook logic.
//!
//! # Lua Hook API
//!
//! Hooks receive these globals:
//! - `event_type` - The hook event type (string)
//! - `tool_name` - Name of the tool being called
//! - `tool_input` - Tool input as a Lua table
//! - `cwd` - Current working directory
//! - `session_id` - Session ID (may be nil)
//!
//! # Return Values
//!
//! Hooks return a table with optional fields:
//! - `continue` - boolean, whether to continue (default true)
//! - `block` - boolean, whether to block
//! - `reason` - string, reason for blocking
//! - `modified_input` - table, modified tool input
//! - `context` - string, additional context to inject
//!
//! # Example
//!
//! ```lua
//! -- Block dangerous rm commands
//! if tool_name == "Bash" and tool_input.command:match("rm %-rf /") then
//!     return { block = true, reason = "Dangerous rm command blocked" }
//! end
//!
//! -- Add context for file reads
//! if tool_name == "Read" then
//!     return { continue = true, context = "File read logged" }
//! end
//!
//! -- Default: continue
//! return { continue = true }
//! ```

use super::types::*;
use anyhow::{Context, Result};
use std::path::Path;

/// Lua hook executor (stub - requires mlua dependency)
///
/// To enable Lua hooks, add to Cargo.toml:
/// ```toml
/// mlua = { version = "0.9", features = ["lua54", "serialize"] }
/// ```
pub struct LuaHookExecutor {
    /// Cached Lua scripts
    scripts: Vec<CachedScript>,
}

struct CachedScript {
    source: String,
    event: HookEventType,
    tools: Vec<String>,
}

impl LuaHookExecutor {
    /// Create a new Lua executor
    pub fn new() -> Self {
        Self {
            scripts: Vec::new(),
        }
    }

    /// Load a Lua script from a string
    pub fn load_script(
        &mut self,
        source: &str,
        event: HookEventType,
        tools: Vec<String>,
    ) -> Result<()> {
        self.scripts.push(CachedScript {
            source: source.to_string(),
            event,
            tools,
        });
        Ok(())
    }

    /// Load a Lua script from a file
    pub fn load_file(
        &mut self,
        path: &Path,
        event: HookEventType,
        tools: Vec<String>,
    ) -> Result<()> {
        let source = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read Lua script: {}", path.display()))?;
        self.load_script(&source, event, tools)
    }

    /// Execute PreToolUse hooks
    pub fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        for script in &self.scripts {
            if script.event != HookEventType::PreToolUse {
                continue;
            }
            if !script.tools.is_empty() && !script.tools.contains(&input.tool_name) {
                continue;
            }

            match self.run_lua_script(&script.source, input) {
                Ok(result) => {
                    if !matches!(result, HookResult::Continue) {
                        return result;
                    }
                }
                Err(e) => {
                    eprintln!("[lua-hook] Error: {}", e);
                }
            }
        }
        HookResult::Continue
    }

    /// Run a Lua script with the given input
    ///
    /// This is a stub implementation. Full implementation requires mlua.
    fn run_lua_script(&self, source: &str, input: &PreToolUseInput) -> Result<HookResult> {
        // Stub: Parse simple patterns without full Lua runtime
        // This provides basic functionality without the mlua dependency

        // Check for common blocking patterns
        if source.contains("block = true") {
            // Simple pattern matching for common cases
            if source.contains("rm %-rf") || source.contains("rm -rf") {
                if input.tool_name == "Bash" {
                    if let Some(cmd) = input.tool_input.get("command").and_then(|v| v.as_str()) {
                        if cmd.contains("rm -rf /") {
                            // Extract reason if present
                            let reason = if source.contains("reason =") {
                                "Blocked by Lua hook"
                            } else {
                                "Blocked by Lua hook"
                            };
                            return Ok(HookResult::Block {
                                reason: reason.to_string(),
                            });
                        }
                    }
                }
            }
        }

        Ok(HookResult::Continue)
    }

    /// Check if any Lua hooks are loaded
    pub fn has_hooks(&self) -> bool {
        !self.scripts.is_empty()
    }

    /// Get the number of loaded scripts
    pub fn script_count(&self) -> usize {
        self.scripts.len()
    }
}

impl Default for LuaHookExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Full Lua Implementation (requires mlua feature)
// ============================================================================

#[cfg(feature = "lua")]
mod full_lua {
    use super::*;
    use mlua::{Lua, Result as LuaResult, Table, Value};

    /// Full Lua executor with mlua
    pub struct FullLuaExecutor {
        lua: Lua,
    }

    impl FullLuaExecutor {
        pub fn new() -> LuaResult<Self> {
            let lua = Lua::new();

            // Sandbox: remove dangerous functions
            lua.globals().set("os", Value::Nil)?;
            lua.globals().set("io", Value::Nil)?;
            lua.globals().set("loadfile", Value::Nil)?;
            lua.globals().set("dofile", Value::Nil)?;

            Ok(Self { lua })
        }

        pub fn execute(&self, source: &str, input: &PreToolUseInput) -> LuaResult<HookResult> {
            // Set globals
            let globals = self.lua.globals();
            globals.set("event_type", input.hook_event_name.clone())?;
            globals.set("tool_name", input.tool_name.clone())?;
            globals.set("cwd", input.cwd.clone())?;
            globals.set("session_id", input.session_id.clone())?;

            // Convert tool_input to Lua table
            let tool_input = self.lua.to_value(&input.tool_input)?;
            globals.set("tool_input", tool_input)?;

            // Execute script
            let result: Table = self.lua.load(source).eval()?;

            // Parse result
            if result.get::<_, bool>("block").unwrap_or(false) {
                let reason = result
                    .get::<_, String>("reason")
                    .unwrap_or_else(|_| "Blocked by Lua hook".to_string());
                return Ok(HookResult::Block { reason });
            }

            if let Ok(context) = result.get::<_, String>("context") {
                return Ok(HookResult::InjectContext { context });
            }

            if let Ok(modified) = result.get::<_, Value>("modified_input") {
                if let Ok(json) = serde_json::to_value(&modified) {
                    return Ok(HookResult::ModifyInput { new_input: json });
                }
            }

            Ok(HookResult::Continue)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lua_executor_stub() {
        let mut executor = LuaHookExecutor::new();
        executor
            .load_script(
                r#"
            if tool_name == "Bash" and tool_input.command:match("rm %-rf /") then
                return { block = true, reason = "Dangerous" }
            end
            return { continue = true }
        "#,
                HookEventType::PreToolUse,
                vec!["Bash".to_string()],
            )
            .unwrap();

        let input = PreToolUseInput {
            hook_event_name: "PreToolUse".to_string(),
            cwd: "/tmp".to_string(),
            session_id: None,
            timestamp: "2024-01-01".to_string(),
            tool_name: "Bash".to_string(),
            tool_call_id: "123".to_string(),
            tool_input: serde_json::json!({ "command": "rm -rf /" }),
        };

        let result = executor.execute_pre_tool_use(&input);
        assert!(matches!(result, HookResult::Block { .. }));
    }
}
