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
    types::{
        EvalGateInput, HookEventType, HookResult, OnErrorInput, OverflowInput,
        PermissionRequestInput, PostMessageInput, PostToolUseInput, PreMessageInput,
        PreToolUseInput, SessionEndInput, SessionStartInput, SubagentStartInput, SubagentStopInput,
        UserPromptSubmitHook, UserPromptSubmitInput,
    },
    wasm::WasmHookExecutor,
};
use anyhow::Result;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Integrated hook system for the native agent
///
/// Combines all hook backends (native, Lua, WASM, IPC) into a unified executor.
/// Lua and WASM executors are lazily initialized on first use to minimize
/// startup overhead (~21µs → ~200ns for basic creation).
pub struct IntegratedHookSystem {
    /// Native Rust hooks
    pub registry: HookRegistry,
    /// Lua script executor (lazy-initialized)
    lua_executor: Option<LuaHookExecutor>,
    /// WASM plugin executor (lazy-initialized)
    wasm_executor: Option<WasmHookExecutor>,
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

/// Prompt hook that injects static context on user prompt submission
struct PromptHook {
    prompt: String,
}

impl UserPromptSubmitHook for PromptHook {
    fn on_user_prompt_submit(&self, _input: &UserPromptSubmitInput) -> HookResult {
        HookResult::InjectContext {
            context: self.prompt.clone(),
        }
    }
}

impl IntegratedHookSystem {
    /// Create a new hook system for a given working directory
    ///
    /// This is extremely fast (~200ns) because Lua and WASM executors
    /// are lazily initialized only when scripts/plugins are actually loaded.
    #[must_use]
    pub fn new(cwd: &str) -> Self {
        Self {
            registry: HookRegistry::new(),
            lua_executor: None,
            wasm_executor: None,
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

    /// Get or initialize the Lua executor
    fn lua_executor_mut(&mut self) -> &mut LuaHookExecutor {
        self.lua_executor.get_or_insert_with(LuaHookExecutor::new)
    }

    /// Get or initialize the WASM executor
    fn wasm_executor_mut(&mut self) -> &mut WasmHookExecutor {
        self.wasm_executor.get_or_insert_with(WasmHookExecutor::new)
    }

    /// Create and load hooks from configuration files
    #[must_use]
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
                eprintln!("[hooks] Warning: Failed to load config: {e}");
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
                HookSource::Prompt(prompt) => {
                    if hook.definition.event == HookEventType::UserPromptSubmit {
                        self.registry
                            .register_user_prompt_submit(Arc::new(PromptHook {
                                prompt: prompt.clone(),
                            }));
                    } else {
                        eprintln!(
                            "[hooks] Prompt hooks are only supported for UserPromptSubmit in Rust TUI"
                        );
                    }
                }
                HookSource::LuaInline(script) => {
                    if let Err(e) = self.lua_executor_mut().load_script(
                        script,
                        hook.definition.event,
                        hook.definition.tools.clone(),
                    ) {
                        eprintln!("[hooks] Failed to load Lua script: {e}");
                    }
                }
                HookSource::LuaFile(path) => {
                    if let Err(e) = self.lua_executor_mut().load_file(
                        path,
                        hook.definition.event,
                        hook.definition.tools.clone(),
                    ) {
                        eprintln!("[hooks] Failed to load Lua file {}: {}", path.display(), e);
                    }
                }
                HookSource::Wasm(path) => {
                    if let Err(e) = self.wasm_executor_mut().load_plugin(
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
        let lua_reloaded = self
            .lua_executor
            .as_mut()
            .map(super::lua::LuaHookExecutor::reload)
            .transpose()?
            .unwrap_or(0);
        let wasm_reloaded = self
            .wasm_executor
            .as_mut()
            .map(super::wasm::WasmHookExecutor::reload)
            .transpose()?
            .unwrap_or(0);

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
    #[must_use]
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
            .map_or(0, |s| s.elapsed().as_millis() as u64);

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

    /// Execute `PreToolUse` hooks (sync version - no IPC)
    ///
    /// Returns the hook result which may block, modify, or continue execution.
    /// Note: This sync version does not execute TypeScript hooks via IPC.
    /// Use `execute_pre_tool_use_async` for full hook support.
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

        self.log_event("PreToolUse", &format!("tool={tool_name} id={tool_call_id}"));

        // Execute with timeout protection
        let result = self.execute_with_timeout(|| {
            // Execute native hooks first
            let native_result = self.registry.execute_pre_tool_use(&input);
            if !matches!(native_result, HookResult::Continue) {
                return native_result;
            }

            // Execute Lua hooks (if any loaded)
            if let Some(ref lua) = self.lua_executor {
                let lua_result = lua.execute_pre_tool_use(&input);
                if !matches!(lua_result, HookResult::Continue) {
                    return lua_result;
                }
            }

            // Execute WASM hooks (if any loaded)
            if let Some(ref wasm) = self.wasm_executor {
                let wasm_result = wasm.execute_pre_tool_use(&input);
                if !matches!(wasm_result, HookResult::Continue) {
                    return wasm_result;
                }
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

    /// Execute `PreToolUse` hooks (async version - includes IPC)
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
                        eprintln!("[hooks] TypeScript hook error: {e}");
                    }
                }
            }
        }

        HookResult::Continue
    }

    /// Execute `PostToolUse` hooks
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

        self.log_event("PostToolUse", &format!("tool={tool_name} error={is_error}"));

        let result = self.registry.execute_post_tool_use(&input);

        // Update metrics
        self.metrics.post_tool_use_count += 1;
        self.metrics.total_duration += start.elapsed();

        result
    }

    /// Execute with timeout and panic protection
    ///
    /// Wraps hook execution with:
    /// - Panic catching: panics in hooks don't crash the agent
    /// - Timeout warnings: logs if execution takes too long
    fn execute_with_timeout<F>(&self, f: F) -> HookResult
    where
        F: FnOnce() -> HookResult,
    {
        let start = Instant::now();

        // Catch panics from hook execution
        let result = panic::catch_unwind(AssertUnwindSafe(f));

        if start.elapsed() > self.timeout {
            eprintln!(
                "[hooks] Warning: Hook execution exceeded timeout ({:?})",
                self.timeout
            );
        }

        match result {
            Ok(hook_result) => hook_result,
            Err(panic_info) => {
                // Extract panic message if possible
                let panic_msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                    (*s).to_string()
                } else if let Some(s) = panic_info.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "Unknown panic".to_string()
                };

                eprintln!("[hooks] Error: Hook panicked: {panic_msg}");
                self.log_event("HookPanic", &panic_msg);

                // Continue execution despite the panic
                HookResult::Continue
            }
        }
    }

    /// Execute a hook with full error boundary protection
    ///
    /// This is the safest way to run hook code that might panic.
    /// Returns Continue on any error to ensure the agent keeps running.
    pub fn safe_execute<F>(&self, name: &str, f: F) -> HookResult
    where
        F: FnOnce() -> HookResult + panic::UnwindSafe,
    {
        match panic::catch_unwind(f) {
            Ok(result) => result,
            Err(panic_info) => {
                let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                    format!("{name}: {s}")
                } else if let Some(s) = panic_info.downcast_ref::<String>() {
                    format!("{name}: {s}")
                } else {
                    format!("{name}: Unknown panic")
                };

                eprintln!("[hooks] PANIC in {msg}");
                HookResult::Continue
            }
        }
    }

    /// Log an event if logging is enabled
    fn log_event(&self, event_type: &str, details: &str) {
        if let Some(ref log_path) = self.log_file {
            let timestamp = chrono::Utc::now().to_rfc3339();
            let log_line = format!("[{timestamp}] {event_type} {details}\n");

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
    #[must_use]
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

    /// Execute `UserPromptSubmit` hooks - called when user submits a prompt
    pub fn execute_user_prompt_submit(
        &mut self,
        prompt: &str,
        attachment_count: u32,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let input = UserPromptSubmitInput {
            hook_event_name: "UserPromptSubmit".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            prompt: prompt.to_string(),
            attachment_count,
        };

        self.log_event(
            "UserPromptSubmit",
            &format!("len={} attachments={attachment_count}", prompt.len()),
        );

        self.execute_with_timeout(|| self.registry.execute_user_prompt_submit(&input))
    }

    /// Execute `PreMessage` hooks - called before sending user message to model
    pub fn execute_pre_message(
        &mut self,
        message: &str,
        attachments: &[String],
        model: Option<&str>,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let input = PreMessageInput {
            hook_event_name: "PreMessage".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            message: message.to_string(),
            attachments: attachments.to_vec(),
            model: model.map(String::from),
        };

        self.log_event("PreMessage", &format!("len={}", message.len()));

        self.execute_with_timeout(|| self.registry.execute_pre_message(&input))
    }

    /// Execute `PostMessage` hooks - called after assistant response
    pub fn execute_post_message(
        &mut self,
        response: &str,
        input_tokens: u64,
        output_tokens: u64,
        duration_ms: u64,
        stop_reason: Option<&str>,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let input = PostMessageInput {
            hook_event_name: "PostMessage".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            response: response.to_string(),
            input_tokens,
            output_tokens,
            duration_ms,
            stop_reason: stop_reason.map(String::from),
        };

        self.log_event(
            "PostMessage",
            &format!("tokens={input_tokens}+{output_tokens} duration={duration_ms}ms"),
        );

        self.registry.execute_post_message(&input)
    }

    /// Execute `OnError` hooks - called when an error occurs
    pub fn execute_on_error(
        &mut self,
        error: &str,
        error_kind: &str,
        context: Option<&str>,
        recoverable: bool,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let input = OnErrorInput {
            hook_event_name: "OnError".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            error: error.to_string(),
            error_kind: error_kind.to_string(),
            context: context.map(String::from),
            recoverable,
        };

        self.log_event(
            "OnError",
            &format!("kind={error_kind} recoverable={recoverable}"),
        );

        self.registry.execute_on_error(&input)
    }

    /// Execute `EvalGate` hooks - called after tool execution for evaluation
    pub fn execute_eval_gate(
        &mut self,
        tool_name: &str,
        tool_call_id: &str,
        tool_input: &serde_json::Value,
        tool_output: &str,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let input = EvalGateInput {
            hook_event_name: "EvalGate".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            tool_name: tool_name.to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_input: tool_input.clone(),
            tool_output: tool_output.to_string(),
        };

        self.log_event("EvalGate", &format!("tool={tool_name}"));

        self.registry.execute_eval_gate(&input)
    }

    /// Execute `SubagentStart` hooks - called before spawning a subagent
    pub fn execute_subagent_start(
        &mut self,
        subagent_type: &str,
        task: &str,
        parent_agent_id: Option<&str>,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let input = SubagentStartInput {
            hook_event_name: "SubagentStart".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            subagent_type: subagent_type.to_string(),
            task: task.to_string(),
            parent_agent_id: parent_agent_id.map(String::from),
        };

        self.log_event("SubagentStart", &format!("type={subagent_type}"));

        self.registry.execute_subagent_start(&input)
    }

    /// Execute `SubagentStop` hooks - called when a subagent completes
    pub fn execute_subagent_stop(
        &mut self,
        subagent_type: &str,
        subagent_id: &str,
        result: Option<&str>,
        duration_ms: u64,
        success: bool,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let input = SubagentStopInput {
            hook_event_name: "SubagentStop".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            subagent_type: subagent_type.to_string(),
            subagent_id: subagent_id.to_string(),
            result: result.map(String::from),
            duration_ms,
            success,
        };

        self.log_event(
            "SubagentStop",
            &format!("type={subagent_type} success={success} duration={duration_ms}ms"),
        );

        self.registry.execute_subagent_stop(&input)
    }

    /// Execute `PermissionRequest` hooks - called when permission is required
    pub fn execute_permission_request(
        &mut self,
        tool_name: &str,
        tool_call_id: &str,
        tool_input: &serde_json::Value,
        reason: &str,
    ) -> HookResult {
        if !self.enabled {
            return HookResult::Continue;
        }

        let input = PermissionRequestInput {
            hook_event_name: "PermissionRequest".to_string(),
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            tool_name: tool_name.to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_input: tool_input.clone(),
            reason: reason.to_string(),
        };

        self.log_event(
            "PermissionRequest",
            &format!("tool={tool_name} reason={reason}"),
        );

        self.registry.execute_permission_request(&input)
    }

    /// Get hook statistics
    #[must_use]
    pub fn stats(&self) -> HookStats {
        HookStats {
            native_hooks: self.registry.total_hook_count(),
            lua_scripts: self
                .lua_executor
                .as_ref()
                .map_or(0, super::lua::LuaHookExecutor::script_count),
            wasm_plugins: self
                .wasm_executor
                .as_ref()
                .map_or(0, super::wasm::WasmHookExecutor::plugin_count),
            typescript_hooks: self.typescript_hooks.len(),
            enabled: self.enabled,
        }
    }

    /// Check if IPC bridge is available
    #[must_use]
    pub fn has_bridge(&self) -> bool {
        self.node_bridge.is_some()
    }

    /// Get execution metrics
    #[must_use]
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
    #[must_use]
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Get session duration
    #[must_use]
    pub fn session_duration(&self) -> Option<Duration> {
        self.session_start.map(|s| s.elapsed())
    }

    /// Get turn count
    #[must_use]
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
    #[must_use]
    pub fn total(&self) -> usize {
        self.native_hooks + self.lua_scripts + self.wasm_plugins + self.typescript_hooks
    }
}

/// Execution metrics for hooks
#[derive(Debug, Clone, Default)]
pub struct HookMetrics {
    /// Number of `PreToolUse` hooks executed
    pub pre_tool_use_count: u64,
    /// Number of `PostToolUse` hooks executed
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
    #[must_use]
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
    #[must_use]
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
