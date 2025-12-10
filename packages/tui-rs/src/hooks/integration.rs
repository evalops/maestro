//! Hook integration with the native agent
//!
//! Provides utilities for integrating the hook system with the native Rust agent.
//! This module bridges the hook registry with tool execution.

use super::{
    config::{load_hook_config, HookSource, LoadedHookConfig},
    lua::LuaHookExecutor,
    overflow::{OverflowDetector, OverflowStatus},
    registry::{HookRegistry, SafetyHook},
    types::*,
    wasm::WasmHookExecutor,
};
use std::path::Path;
use std::sync::Arc;

/// Integrated hook system for the native agent
///
/// Combines all hook backends (native, Lua, WASM) into a unified executor.
pub struct IntegratedHookSystem {
    /// Native Rust hooks
    registry: HookRegistry,
    /// Lua script executor
    lua_executor: LuaHookExecutor,
    /// WASM plugin executor
    wasm_executor: WasmHookExecutor,
    /// Overflow detector
    overflow_detector: OverflowDetector,
    /// Current working directory
    cwd: String,
    /// Session ID
    session_id: Option<String>,
    /// Whether hooks are enabled
    enabled: bool,
}

impl IntegratedHookSystem {
    /// Create a new hook system for a given working directory
    pub fn new(cwd: &str) -> Self {
        Self {
            registry: HookRegistry::new(),
            lua_executor: LuaHookExecutor::new(),
            wasm_executor: WasmHookExecutor::new(),
            overflow_detector: OverflowDetector::new(),
            cwd: cwd.to_string(),
            session_id: None,
            enabled: true,
        }
    }

    /// Create and load hooks from configuration files
    pub fn load_from_config(cwd: &str) -> Self {
        let mut system = Self::new(cwd);

        // Load config
        match load_hook_config(Path::new(cwd)) {
            Ok(config) => {
                system.enabled = config.settings.enabled;
                system.load_hooks_from_config(&config);

                if !config.hooks.is_empty() {
                    eprintln!(
                        "[hooks] Loaded {} hooks from {:?}",
                        config.hooks.len(),
                        config.source_paths
                    );
                }
            }
            Err(e) => {
                eprintln!("[hooks] Warning: Failed to load config: {}", e);
            }
        }

        // Register built-in safety hook
        system.registry.register_pre_tool_use(Arc::new(SafetyHook));

        system
    }

    /// Load hooks from parsed configuration
    fn load_hooks_from_config(&mut self, config: &LoadedHookConfig) {
        for hook in &config.hooks {
            match &hook.source {
                HookSource::LuaInline(script) => {
                    if let Err(e) = self.lua_executor.load_script(
                        script,
                        hook.definition.event,
                        hook.definition.tools.clone(),
                    ) {
                        eprintln!("[hooks] Failed to load Lua script: {}", e);
                    }
                }
                HookSource::LuaFile(path) => {
                    if let Err(e) = self.lua_executor.load_file(
                        path,
                        hook.definition.event,
                        hook.definition.tools.clone(),
                    ) {
                        eprintln!("[hooks] Failed to load Lua file {}: {}", path.display(), e);
                    }
                }
                HookSource::Wasm(path) => {
                    if let Err(e) = self.wasm_executor.load_plugin(
                        path,
                        hook.definition.event,
                        hook.definition.tools.clone(),
                    ) {
                        eprintln!("[hooks] Failed to load WASM plugin {}: {}", path.display(), e);
                    }
                }
                HookSource::Command(_cmd) => {
                    // Shell command hooks - would need shell execution
                    // For now, skip these in native mode
                }
                HookSource::TypeScript(_path) => {
                    // TypeScript hooks need IPC bridge
                    // For now, skip these in native mode
                }
            }
        }
    }

    /// Set session ID for hook context
    pub fn set_session_id(&mut self, session_id: Option<String>) {
        self.session_id = session_id;
    }

    /// Set the model for overflow detection
    pub fn set_model(&mut self, model_id: &str) {
        self.overflow_detector = OverflowDetector::for_model(model_id);
    }

    /// Update token count for overflow detection
    pub fn update_tokens(&mut self, input: u64, output: u64, cache: u64) {
        self.overflow_detector.update_tokens(input, output, cache);
    }

    /// Check overflow status
    pub fn check_overflow(&self) -> OverflowStatus {
        self.overflow_detector.check_status()
    }

    /// Execute PreToolUse hooks
    ///
    /// Returns the hook result which may block, modify, or continue execution.
    pub fn execute_pre_tool_use(
        &self,
        tool_name: &str,
        tool_call_id: &str,
        tool_input: &serde_json::Value,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let input = PreToolUseInput {
            hook_event_name: "PreToolUse".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            tool_name: tool_name.to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_input: tool_input.clone(),
        };

        // Execute native hooks first
        let native_result = self.registry.execute_pre_tool_use(&input);
        if !matches!(native_result, HookResult::Continue) {
            return native_result;
        }

        // Execute Lua hooks
        let lua_result = self.lua_executor.execute_pre_tool_use(&input);
        if !matches!(lua_result, HookResult::Continue) {
            return lua_result;
        }

        // Execute WASM hooks
        let wasm_result = self.wasm_executor.execute_pre_tool_use(&input);
        if !matches!(wasm_result, HookResult::Continue) {
            return wasm_result;
        }

        HookResult::Continue
    }

    /// Execute PostToolUse hooks
    pub fn execute_post_tool_use(
        &self,
        tool_name: &str,
        tool_call_id: &str,
        tool_input: &serde_json::Value,
        tool_output: &str,
        is_error: bool,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let input = PostToolUseInput {
            hook_event_name: "PostToolUse".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            tool_name: tool_name.to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_input: tool_input.clone(),
            tool_output: tool_output.to_string(),
            is_error,
        };

        self.registry.execute_post_tool_use(&input)
    }

    /// Check if a stop reason indicates overflow
    pub fn is_overflow_stop(&self, stop_reason: &str) -> bool {
        self.overflow_detector.check_stop_reason(stop_reason)
    }

    /// Handle overflow - returns true if auto-compaction should proceed
    pub fn handle_overflow(&self) -> bool {
        let result = self.overflow_detector.handle_overflow(
            &self.cwd,
            self.session_id.as_deref(),
        );

        matches!(result, HookResult::Continue)
    }

    /// Get hook statistics
    pub fn stats(&self) -> HookStats {
        HookStats {
            native_hooks: self.registry.has_hooks(HookEventType::PreToolUse) as usize,
            lua_scripts: self.lua_executor.script_count(),
            wasm_plugins: self.wasm_executor.plugin_count(),
            enabled: self.enabled,
        }
    }
}

/// Statistics about loaded hooks
#[derive(Debug, Clone)]
pub struct HookStats {
    pub native_hooks: usize,
    pub lua_scripts: usize,
    pub wasm_plugins: usize,
    pub enabled: bool,
}

impl HookStats {
    /// Total number of hooks
    pub fn total(&self) -> usize {
        self.native_hooks + self.lua_scripts + self.wasm_plugins
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_integrated_system() {
        let system = IntegratedHookSystem::new("/tmp");
        assert!(system.enabled);

        let stats = system.stats();
        assert_eq!(stats.native_hooks, 0);
    }

    #[test]
    fn test_pre_tool_use_hook() {
        let mut system = IntegratedHookSystem::new("/tmp");
        system.registry.register_pre_tool_use(Arc::new(SafetyHook));

        // Safe command
        let result = system.execute_pre_tool_use(
            "Bash",
            "123",
            &serde_json::json!({ "command": "ls -la" }),
        );
        assert!(matches!(result, HookResult::Continue));

        // Dangerous command
        let result = system.execute_pre_tool_use(
            "Bash",
            "456",
            &serde_json::json!({ "command": "rm -rf /" }),
        );
        assert!(matches!(result, HookResult::Block { .. }));
    }
}
