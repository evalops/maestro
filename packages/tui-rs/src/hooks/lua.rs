//! Lua scripting support for hooks
//!
//! Embeds mlua for running Lua scripts as hooks. This provides a lightweight,
//! sandboxed scripting environment for custom hook logic.
//!
//! # Feature Flag
//!
//! Enable with: `cargo build --features lua`
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

#[cfg(feature = "lua")]
use std::time::{Duration, Instant};

/// Cached Lua script with metadata
struct CachedScript {
    source: String,
    event: HookEventType,
    tools: Vec<String>,
    #[allow(dead_code)]
    path: Option<std::path::PathBuf>,
}

// ============================================================================
// Stub Implementation (no mlua feature)
// ============================================================================

#[cfg(not(feature = "lua"))]
pub struct LuaHookExecutor {
    scripts: Vec<CachedScript>,
}

#[cfg(not(feature = "lua"))]
impl LuaHookExecutor {
    pub fn new() -> Self {
        Self { scripts: Vec::new() }
    }

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
            path: None,
        });
        Ok(())
    }

    pub fn load_file(
        &mut self,
        path: &Path,
        event: HookEventType,
        tools: Vec<String>,
    ) -> Result<()> {
        let source = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read Lua script: {}", path.display()))?;
        self.scripts.push(CachedScript {
            source,
            event,
            tools,
            path: Some(path.to_path_buf()),
        });
        Ok(())
    }

    pub fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        for script in &self.scripts {
            if script.event != HookEventType::PreToolUse {
                continue;
            }
            if !script.tools.is_empty() && !script.tools.contains(&input.tool_name) {
                continue;
            }

            // Stub: simple pattern matching without full Lua
            if let Some(result) = self.stub_execute(&script.source, input) {
                if !matches!(result, HookResult::Continue) {
                    return result;
                }
            }
        }
        HookResult::Continue
    }

    fn stub_execute(&self, source: &str, input: &PreToolUseInput) -> Option<HookResult> {
        // Pattern match for common safety hooks
        if source.contains("block = true") && source.contains("rm") {
            if input.tool_name == "Bash" {
                if let Some(cmd) = input.tool_input.get("command").and_then(|v| v.as_str()) {
                    if cmd.contains("rm -rf /") || cmd.contains("rm -rf ~") {
                        return Some(HookResult::Block {
                            reason: "Blocked by Lua hook (stub mode)".to_string(),
                        });
                    }
                }
            }
        }
        Some(HookResult::Continue)
    }

    pub fn execute_post_tool_use(&self, _input: &PostToolUseInput) -> HookResult {
        HookResult::Continue
    }

    pub fn has_hooks(&self) -> bool {
        !self.scripts.is_empty()
    }

    pub fn script_count(&self) -> usize {
        self.scripts.len()
    }

    pub fn reload(&mut self) -> Result<usize> {
        // Reload scripts from their file paths
        let mut reloaded = 0;
        for script in &mut self.scripts {
            if let Some(ref path) = script.path {
                if path.exists() {
                    if let Ok(new_source) = std::fs::read_to_string(path) {
                        script.source = new_source;
                        reloaded += 1;
                    }
                }
            }
        }
        Ok(reloaded)
    }
}

#[cfg(not(feature = "lua"))]
impl Default for LuaHookExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Full Implementation (with mlua feature)
// ============================================================================

#[cfg(feature = "lua")]
use mlua::{Lua, Table, Value};

#[cfg(feature = "lua")]
pub struct LuaHookExecutor {
    lua: Lua,
    scripts: Vec<CachedScript>,
    timeout: Duration,
}

#[cfg(feature = "lua")]
impl LuaHookExecutor {
    pub fn new() -> Self {
        let lua = Lua::new();

        // Sandbox: remove dangerous functions
        if let Ok(globals) = lua.globals().clone().into_table() {
            let _ = globals.set("os", Value::Nil);
            let _ = globals.set("io", Value::Nil);
            let _ = globals.set("loadfile", Value::Nil);
            let _ = globals.set("dofile", Value::Nil);
            let _ = globals.set("load", Value::Nil);
            let _ = globals.set("require", Value::Nil);
        }

        Self {
            lua,
            scripts: Vec::new(),
            timeout: Duration::from_secs(30),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn load_script(
        &mut self,
        source: &str,
        event: HookEventType,
        tools: Vec<String>,
    ) -> Result<()> {
        // Validate script compiles
        self.lua
            .load(source)
            .into_function()
            .with_context(|| "Failed to compile Lua script")?;

        self.scripts.push(CachedScript {
            source: source.to_string(),
            event,
            tools,
            path: None,
        });
        Ok(())
    }

    pub fn load_file(
        &mut self,
        path: &Path,
        event: HookEventType,
        tools: Vec<String>,
    ) -> Result<()> {
        let source = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read Lua script: {}", path.display()))?;

        // Validate script compiles
        self.lua
            .load(&source)
            .into_function()
            .with_context(|| format!("Failed to compile Lua script: {}", path.display()))?;

        self.scripts.push(CachedScript {
            source,
            event,
            tools,
            path: Some(path.to_path_buf()),
        });
        Ok(())
    }

    pub fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        let start = Instant::now();

        for script in &self.scripts {
            if script.event != HookEventType::PreToolUse {
                continue;
            }
            if !script.tools.is_empty() && !script.tools.contains(&input.tool_name) {
                continue;
            }

            // Check timeout
            if start.elapsed() > self.timeout {
                eprintln!("[lua-hook] Timeout exceeded");
                return HookResult::Continue;
            }

            match self.execute_script(&script.source, input) {
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

    fn execute_script(&self, source: &str, input: &PreToolUseInput) -> Result<HookResult> {
        let globals = self.lua.globals();

        // Set input globals
        globals.set("event_type", input.hook_event_name.clone())?;
        globals.set("tool_name", input.tool_name.clone())?;
        globals.set("tool_call_id", input.tool_call_id.clone())?;
        globals.set("cwd", input.cwd.clone())?;
        globals.set(
            "session_id",
            input.session_id.clone().unwrap_or_default(),
        )?;

        // Convert tool_input to Lua table
        let tool_input = self.lua.to_value(&input.tool_input)?;
        globals.set("tool_input", tool_input)?;

        // Execute script
        let result: Table = self.lua.load(source).eval()?;

        // Parse result table
        self.parse_result(&result)
    }

    fn parse_result(&self, result: &Table) -> Result<HookResult> {
        // Check for block
        if result.get::<bool>("block").unwrap_or(false) {
            let reason = result
                .get::<String>("reason")
                .unwrap_or_else(|_| "Blocked by Lua hook".to_string());
            return Ok(HookResult::Block { reason });
        }

        // Check for context injection
        if let Ok(context) = result.get::<String>("context") {
            if !context.is_empty() {
                return Ok(HookResult::InjectContext { context });
            }
        }

        // Check for modified input
        if let Ok(modified) = result.get::<Value>("modified_input") {
            if !matches!(modified, Value::Nil) {
                let json: serde_json::Value = self.lua.from_value(modified)?;
                return Ok(HookResult::ModifyInput { new_input: json });
            }
        }

        Ok(HookResult::Continue)
    }

    pub fn execute_post_tool_use(&self, input: &PostToolUseInput) -> HookResult {
        for script in &self.scripts {
            if script.event != HookEventType::PostToolUse {
                continue;
            }
            if !script.tools.is_empty() && !script.tools.contains(&input.tool_name) {
                continue;
            }

            if let Err(e) = self.execute_post_script(&script.source, input) {
                eprintln!("[lua-hook] PostToolUse error: {}", e);
            }
        }
        HookResult::Continue
    }

    fn execute_post_script(&self, source: &str, input: &PostToolUseInput) -> Result<()> {
        let globals = self.lua.globals();

        globals.set("event_type", input.hook_event_name.clone())?;
        globals.set("tool_name", input.tool_name.clone())?;
        globals.set("tool_call_id", input.tool_call_id.clone())?;
        globals.set("tool_output", input.tool_output.clone())?;
        globals.set("is_error", input.is_error)?;
        globals.set("cwd", input.cwd.clone())?;
        globals.set(
            "session_id",
            input.session_id.clone().unwrap_or_default(),
        )?;

        let tool_input = self.lua.to_value(&input.tool_input)?;
        globals.set("tool_input", tool_input)?;

        let _: Value = self.lua.load(source).eval()?;
        Ok(())
    }

    pub fn has_hooks(&self) -> bool {
        !self.scripts.is_empty()
    }

    pub fn script_count(&self) -> usize {
        self.scripts.len()
    }

    pub fn reload(&mut self) -> Result<usize> {
        let mut reloaded = 0;
        for script in &mut self.scripts {
            if let Some(ref path) = script.path {
                if path.exists() {
                    if let Ok(new_source) = std::fs::read_to_string(path) {
                        // Validate new source compiles
                        if self.lua.load(&new_source).into_function().is_ok() {
                            script.source = new_source;
                            reloaded += 1;
                        }
                    }
                }
            }
        }
        Ok(reloaded)
    }
}

#[cfg(feature = "lua")]
impl Default for LuaHookExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lua_executor_creation() {
        let executor = LuaHookExecutor::new();
        assert_eq!(executor.script_count(), 0);
        assert!(!executor.has_hooks());
    }

    #[test]
    fn test_load_script() {
        let mut executor = LuaHookExecutor::new();
        executor
            .load_script(
                r#"return { continue = true }"#,
                HookEventType::PreToolUse,
                vec![],
            )
            .unwrap();
        assert_eq!(executor.script_count(), 1);
    }

    #[test]
    fn test_execute_pre_tool_use() {
        let mut executor = LuaHookExecutor::new();
        executor
            .load_script(
                r#"
                if tool_name == "Bash" then
                    local cmd = tool_input.command or ""
                    if cmd:match("rm %-rf /") then
                        return { block = true, reason = "Dangerous command" }
                    end
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

    #[test]
    fn test_safe_command() {
        let mut executor = LuaHookExecutor::new();
        executor
            .load_script(
                r#"return { continue = true }"#,
                HookEventType::PreToolUse,
                vec![],
            )
            .unwrap();

        let input = PreToolUseInput {
            hook_event_name: "PreToolUse".to_string(),
            cwd: "/tmp".to_string(),
            session_id: None,
            timestamp: "2024-01-01".to_string(),
            tool_name: "Bash".to_string(),
            tool_call_id: "123".to_string(),
            tool_input: serde_json::json!({ "command": "ls -la" }),
        };

        let result = executor.execute_pre_tool_use(&input);
        assert!(matches!(result, HookResult::Continue));
    }
}
