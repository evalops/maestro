//! Hook integration with the native agent
//!
//! Provides utilities for integrating the hook system with the native Rust agent.
//! This module bridges the hook registry with tool execution.

use super::{
    bridge::NodeHookBridge,
    config::{load_hook_config, HookSource, LoadedHookConfig},
    lua::LuaHookExecutor,
    overflow::{OverflowDetector, OverflowStatus},
    registry::{HookRegistry, SafetyHook},
    types::*,
    wasm::WasmHookExecutor,
};
use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Integrated hook system for the native agent
///
/// Combines all hook backends (native, Lua, WASM, IPC) into a unified executor.
pub struct IntegratedHookSystem {
    /// Native Rust hooks
    registry: HookRegistry,
    /// Lua script executor
    lua_executor: LuaHookExecutor,
    /// WASM plugin executor
    wasm_executor: WasmHookExecutor,
    /// IPC bridge to Node.js for TypeScript hooks
    node_bridge: Option<Arc<Mutex<NodeHookBridge>>>,
    /// TypeScript hook paths (queued for IPC execution)
    typescript_hooks: Vec<TypeScriptHookConfig>,
    /// Overflow detector
    overflow_detector: OverflowDetector,
    /// Current working directory
    cwd: String,
    /// Session ID
    session_id: Option<String>,
    /// Whether hooks are enabled
    enabled: bool,
    /// Session start time
    session_start: Option<Instant>,
    /// Turn count for session
    turn_count: u32,
    /// Execution metrics
    metrics: HookMetrics,
    /// Hook timeout
    timeout: Duration,
    /// Log file path
    log_file: Option<String>,
}

/// TypeScript hook configuration
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct TypeScriptHookConfig {
    path: PathBuf,
    event: HookEventType,
    tools: Vec<String>,
}

impl IntegratedHookSystem {
    /// Create a new hook system for a given working directory
    pub fn new(cwd: &str) -> Self {
        Self {
            registry: HookRegistry::new(),
            lua_executor: LuaHookExecutor::new(),
            wasm_executor: WasmHookExecutor::new(),
            node_bridge: None,
            typescript_hooks: Vec::new(),
            overflow_detector: OverflowDetector::new(),
            cwd: cwd.to_string(),
            session_id: None,
            enabled: true,
            session_start: None,
            turn_count: 0,
            metrics: HookMetrics::default(),
            timeout: Duration::from_secs(30),
            log_file: None,
        }
    }

    /// Create and load hooks from configuration files
    pub fn load_from_config(cwd: &str) -> Self {
        let mut system = Self::new(cwd);

        // Load config
        match load_hook_config(Path::new(cwd)) {
            Ok(config) => {
                system.enabled = config.settings.enabled;
                system.timeout = Duration::from_millis(config.settings.timeout_ms);
                system.log_file = config.settings.log_file.clone();
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
                        eprintln!(
                            "[hooks] Failed to load WASM plugin {}: {}",
                            path.display(),
                            e
                        );
                    }
                }
                HookSource::Command(_cmd) => {
                    // Shell command hooks - would need shell execution
                    // For now, skip these in native mode
                }
                HookSource::TypeScript(path) => {
                    // Queue TypeScript hooks for IPC execution
                    self.typescript_hooks.push(TypeScriptHookConfig {
                        path: path.clone(),
                        event: hook.definition.event,
                        tools: hook.definition.tools.clone(),
                    });
                }
            }
        }

        // Initialize IPC bridge if we have TypeScript hooks
        if !self.typescript_hooks.is_empty() {
            self.node_bridge = Some(Arc::new(Mutex::new(NodeHookBridge::bundled())));
        }
    }

    /// Start the IPC bridge (must be called in async context)
    pub async fn start_bridge(&mut self) -> Result<()> {
        if let Some(ref bridge) = self.node_bridge {
            let mut bridge = bridge.lock().await;
            bridge.start().await?;
            eprintln!(
                "[hooks] Started IPC bridge for {} TypeScript hooks",
                self.typescript_hooks.len()
            );
        }
        Ok(())
    }

    /// Stop the IPC bridge
    pub async fn stop_bridge(&mut self) -> Result<()> {
        if let Some(ref bridge) = self.node_bridge {
            let mut bridge = bridge.lock().await;
            bridge.stop().await?;
        }
        Ok(())
    }

    /// Reload all hooks from config files
    pub fn reload(&mut self) -> Result<ReloadResult> {
        let lua_reloaded = self.lua_executor.reload()?;
        let wasm_reloaded = self.wasm_executor.reload()?;

        // Reload config
        if let Ok(config) = load_hook_config(Path::new(&self.cwd)) {
            self.enabled = config.settings.enabled;
            self.timeout = Duration::from_millis(config.settings.timeout_ms);
            self.log_file = config.settings.log_file.clone();
        }

        Ok(ReloadResult {
            lua_scripts: lua_reloaded,
            wasm_plugins: wasm_reloaded,
        })
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

    /// Signal session start
    pub fn on_session_start(&mut self, source: &str) -> HookResult {
        self.session_start = Some(Instant::now());
        self.turn_count = 0;

        if !self.enabled {
            return HookResult::Continue;
        }

        let input = SessionStartInput {
            hook_event_name: "SessionStart".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            source: source.to_string(),
        };

        self.log_event(
            "SessionStart",
            &serde_json::to_string(&input).unwrap_or_default(),
        );
        self.registry.execute_session_start(&input)
    }

    /// Signal session end
    pub fn on_session_end(&mut self, reason: &str) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let duration_ms = self
            .session_start
            .map(|s| s.elapsed().as_millis() as u64)
            .unwrap_or(0);

        let input = SessionEndInput {
            hook_event_name: "SessionEnd".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            reason: reason.to_string(),
            duration_ms,
            turn_count: self.turn_count,
        };

        self.log_event(
            "SessionEnd",
            &serde_json::to_string(&input).unwrap_or_default(),
        );
        self.registry.execute_session_end(&input)
    }

    /// Increment turn count
    pub fn increment_turn(&mut self) {
        self.turn_count += 1;
    }

    /// Execute PreToolUse hooks (sync version - no IPC)
    ///
    /// Returns the hook result which may block, modify, or continue execution.
    /// Note: This sync version does not execute TypeScript hooks via IPC.
    /// Use execute_pre_tool_use_async for full hook support.
    pub fn execute_pre_tool_use(
        &mut self,
        tool_name: &str,
        tool_call_id: &str,
        tool_input: &serde_json::Value,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let start = Instant::now();

        let input = PreToolUseInput {
            hook_event_name: "PreToolUse".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            tool_name: tool_name.to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_input: tool_input.clone(),
        };

        self.log_event(
            "PreToolUse",
            &format!("tool={} id={}", tool_name, tool_call_id),
        );

        // Execute with timeout protection
        let result = self.execute_with_timeout(|| {
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
        });

        // Update metrics
        self.metrics.pre_tool_use_count += 1;
        self.metrics.total_duration += start.elapsed();
        if matches!(result, HookResult::Block { .. }) {
            self.metrics.blocks += 1;
        }

        result
    }

    /// Execute PreToolUse hooks (async version - includes IPC)
    ///
    /// This version also executes TypeScript hooks via the IPC bridge.
    pub async fn execute_pre_tool_use_async(
        &mut self,
        tool_name: &str,
        tool_call_id: &str,
        tool_input: &serde_json::Value,
    ) -> HookResult {
        // First run sync hooks
        let sync_result = self.execute_pre_tool_use(tool_name, tool_call_id, tool_input);
        if !matches!(sync_result, HookResult::Continue) {
            return sync_result;
        }

        // Then run TypeScript hooks via IPC
        if let Some(ref bridge) = self.node_bridge {
            let input = PreToolUseInput {
                hook_event_name: "PreToolUse".to_string(),
                cwd: self.cwd.clone(),
                session_id: self.session_id.clone(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                tool_name: tool_name.to_string(),
                tool_call_id: tool_call_id.to_string(),
                tool_input: tool_input.clone(),
            };

            // Check if any TypeScript hooks match this tool
            let matching_hooks: Vec<_> = self
                .typescript_hooks
                .iter()
                .filter(|h| {
                    h.event == HookEventType::PreToolUse
                        && (h.tools.is_empty() || h.tools.contains(&tool_name.to_string()))
                })
                .collect();

            if !matching_hooks.is_empty() {
                let bridge = bridge.lock().await;
                match bridge.execute_pre_tool_use(&input).await {
                    Ok(result) => {
                        if !matches!(result, HookResult::Continue) {
                            return result;
                        }
                    }
                    Err(e) => {
                        eprintln!("[hooks] TypeScript hook error: {}", e);
                    }
                }
            }
        }

        HookResult::Continue
    }

    /// Execute PostToolUse hooks
    pub fn execute_post_tool_use(
        &mut self,
        tool_name: &str,
        tool_call_id: &str,
        tool_input: &serde_json::Value,
        tool_output: &str,
        is_error: bool,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let start = Instant::now();

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

        self.log_event(
            "PostToolUse",
            &format!("tool={} error={}", tool_name, is_error),
        );

        let result = self.registry.execute_post_tool_use(&input);

        // Update metrics
        self.metrics.post_tool_use_count += 1;
        self.metrics.total_duration += start.elapsed();

        result
    }

    /// Execute with timeout protection
    fn execute_with_timeout<F>(&self, f: F) -> HookResult
    where
        F: FnOnce() -> HookResult,
    {
        let start = Instant::now();
        let result = f();

        if start.elapsed() > self.timeout {
            eprintln!(
                "[hooks] Warning: Hook execution exceeded timeout ({:?})",
                self.timeout
            );
        }

        result
    }

    /// Log an event if logging is enabled
    fn log_event(&self, event_type: &str, details: &str) {
        if let Some(ref log_path) = self.log_file {
            let timestamp = chrono::Utc::now().to_rfc3339();
            let log_line = format!("[{}] {} {}\n", timestamp, event_type, details);

            // Try to append to log file
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)
            {
                use std::io::Write;
                let _ = file.write_all(log_line.as_bytes());
            }
        }
    }

    /// Check if a stop reason indicates overflow
    pub fn is_overflow_stop(&self, stop_reason: &str) -> bool {
        self.overflow_detector.check_stop_reason(stop_reason)
    }

    /// Handle overflow - returns true if auto-compaction should proceed
    pub fn handle_overflow(&mut self) -> bool {
        if !self.enabled {
            return true;
        }

        let input = OverflowInput {
            hook_event_name: "Overflow".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            token_count: self.overflow_detector.current_tokens(),
            max_tokens: self.overflow_detector.max_tokens(),
        };

        self.log_event(
            "Overflow",
            &format!("tokens={}/{}", input.token_count, input.max_tokens),
        );

        let result = self.registry.execute_overflow(&input);
        self.metrics.overflow_count += 1;

        matches!(result, HookResult::Continue)
    }

    /// Get hook statistics
    pub fn stats(&self) -> HookStats {
        HookStats {
            native_hooks: self.registry.has_hooks(HookEventType::PreToolUse) as usize,
            lua_scripts: self.lua_executor.script_count(),
            wasm_plugins: self.wasm_executor.plugin_count(),
            typescript_hooks: self.typescript_hooks.len(),
            enabled: self.enabled,
        }
    }

    /// Check if IPC bridge is available
    pub fn has_bridge(&self) -> bool {
        self.node_bridge.is_some()
    }

    /// Get execution metrics
    pub fn metrics(&self) -> &HookMetrics {
        &self.metrics
    }

    /// Reset metrics
    pub fn reset_metrics(&mut self) {
        self.metrics = HookMetrics::default();
    }

    /// Enable hooks
    pub fn enable(&mut self) {
        self.enabled = true;
    }

    /// Disable hooks
    pub fn disable(&mut self) {
        self.enabled = false;
    }

    /// Check if hooks are enabled
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Get session duration
    pub fn session_duration(&self) -> Option<Duration> {
        self.session_start.map(|s| s.elapsed())
    }

    /// Get turn count
    pub fn turn_count(&self) -> u32 {
        self.turn_count
    }
}

/// Statistics about loaded hooks
#[derive(Debug, Clone)]
pub struct HookStats {
    pub native_hooks: usize,
    pub lua_scripts: usize,
    pub wasm_plugins: usize,
    pub typescript_hooks: usize,
    pub enabled: bool,
}

impl HookStats {
    /// Total number of hooks
    pub fn total(&self) -> usize {
        self.native_hooks + self.lua_scripts + self.wasm_plugins + self.typescript_hooks
    }
}

/// Execution metrics for hooks
#[derive(Debug, Clone, Default)]
pub struct HookMetrics {
    /// Number of PreToolUse hooks executed
    pub pre_tool_use_count: u64,
    /// Number of PostToolUse hooks executed
    pub post_tool_use_count: u64,
    /// Number of overflow events
    pub overflow_count: u64,
    /// Number of blocks
    pub blocks: u64,
    /// Total duration of hook execution
    pub total_duration: Duration,
}

impl HookMetrics {
    /// Average hook execution time
    pub fn average_duration(&self) -> Duration {
        let total_calls = self.pre_tool_use_count + self.post_tool_use_count;
        if total_calls == 0 {
            Duration::ZERO
        } else {
            self.total_duration / total_calls as u32
        }
    }
}

/// Result of reloading hooks
#[derive(Debug, Clone)]
pub struct ReloadResult {
    pub lua_scripts: usize,
    pub wasm_plugins: usize,
}

impl ReloadResult {
    pub fn total(&self) -> usize {
        self.lua_scripts + self.wasm_plugins
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
        let result =
            system.execute_pre_tool_use("Bash", "123", &serde_json::json!({ "command": "ls -la" }));
        assert!(matches!(result, HookResult::Continue));

        // Dangerous command
        let result = system.execute_pre_tool_use(
            "Bash",
            "456",
            &serde_json::json!({ "command": "rm -rf /" }),
        );
        assert!(matches!(result, HookResult::Block { .. }));
    }

    #[test]
    fn test_session_lifecycle() {
        let mut system = IntegratedHookSystem::new("/tmp");

        system.on_session_start("cli");
        assert_eq!(system.turn_count(), 0);

        system.increment_turn();
        system.increment_turn();
        assert_eq!(system.turn_count(), 2);

        assert!(system.session_duration().is_some());

        system.on_session_end("user_exit");
    }

    #[test]
    fn test_metrics() {
        let mut system = IntegratedHookSystem::new("/tmp");

        system.execute_pre_tool_use("Read", "1", &serde_json::json!({}));
        system.execute_pre_tool_use("Write", "2", &serde_json::json!({}));
        system.execute_post_tool_use("Read", "1", &serde_json::json!({}), "ok", false);

        let metrics = system.metrics();
        assert_eq!(metrics.pre_tool_use_count, 2);
        assert_eq!(metrics.post_tool_use_count, 1);
    }
}
