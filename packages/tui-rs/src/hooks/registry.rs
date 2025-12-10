//! Hook registry and execution
//!
//! Provides a registry for managing hooks and executing them at the appropriate times.

use super::types::*;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Registry for managing hooks
///
/// Thread-safe registry that stores and executes hooks for different events.
pub struct HookRegistry {
    pre_tool_use_hooks: Vec<Arc<dyn PreToolUseHook>>,
    post_tool_use_hooks: Vec<Arc<dyn PostToolUseHook>>,
    session_start_hooks: Vec<Arc<dyn SessionStartHook>>,
    session_end_hooks: Vec<Arc<dyn SessionEndHook>>,
    overflow_hooks: Vec<Arc<dyn OverflowHook>>,
    pre_message_hooks: Vec<Arc<dyn PreMessageHook>>,
    post_message_hooks: Vec<Arc<dyn PostMessageHook>>,
    on_error_hooks: Vec<Arc<dyn OnErrorHook>>,
    eval_gate_hooks: Vec<Arc<dyn EvalGateHook>>,
    subagent_start_hooks: Vec<Arc<dyn SubagentStartHook>>,
    subagent_stop_hooks: Vec<Arc<dyn SubagentStopHook>>,
    permission_request_hooks: Vec<Arc<dyn PermissionRequestHook>>,
}

impl Default for HookRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl HookRegistry {
    /// Create a new empty hook registry
    pub fn new() -> Self {
        Self {
            pre_tool_use_hooks: Vec::new(),
            post_tool_use_hooks: Vec::new(),
            session_start_hooks: Vec::new(),
            session_end_hooks: Vec::new(),
            overflow_hooks: Vec::new(),
            pre_message_hooks: Vec::new(),
            post_message_hooks: Vec::new(),
            on_error_hooks: Vec::new(),
            eval_gate_hooks: Vec::new(),
            subagent_start_hooks: Vec::new(),
            subagent_stop_hooks: Vec::new(),
            permission_request_hooks: Vec::new(),
        }
    }

    /// Register a PreToolUse hook
    pub fn register_pre_tool_use(&mut self, hook: Arc<dyn PreToolUseHook>) {
        self.pre_tool_use_hooks.push(hook);
    }

    /// Register a PostToolUse hook
    pub fn register_post_tool_use(&mut self, hook: Arc<dyn PostToolUseHook>) {
        self.post_tool_use_hooks.push(hook);
    }

    /// Register a SessionStart hook
    pub fn register_session_start(&mut self, hook: Arc<dyn SessionStartHook>) {
        self.session_start_hooks.push(hook);
    }

    /// Register a SessionEnd hook
    pub fn register_session_end(&mut self, hook: Arc<dyn SessionEndHook>) {
        self.session_end_hooks.push(hook);
    }

    /// Register an Overflow hook
    pub fn register_overflow(&mut self, hook: Arc<dyn OverflowHook>) {
        self.overflow_hooks.push(hook);
    }

    /// Register a PreMessage hook
    pub fn register_pre_message(&mut self, hook: Arc<dyn PreMessageHook>) {
        self.pre_message_hooks.push(hook);
    }

    /// Register a PostMessage hook
    pub fn register_post_message(&mut self, hook: Arc<dyn PostMessageHook>) {
        self.post_message_hooks.push(hook);
    }

    /// Register an OnError hook
    pub fn register_on_error(&mut self, hook: Arc<dyn OnErrorHook>) {
        self.on_error_hooks.push(hook);
    }

    /// Register an EvalGate hook
    pub fn register_eval_gate(&mut self, hook: Arc<dyn EvalGateHook>) {
        self.eval_gate_hooks.push(hook);
    }

    /// Register a SubagentStart hook
    pub fn register_subagent_start(&mut self, hook: Arc<dyn SubagentStartHook>) {
        self.subagent_start_hooks.push(hook);
    }

    /// Register a SubagentStop hook
    pub fn register_subagent_stop(&mut self, hook: Arc<dyn SubagentStopHook>) {
        self.subagent_stop_hooks.push(hook);
    }

    /// Register a PermissionRequest hook
    pub fn register_permission_request(&mut self, hook: Arc<dyn PermissionRequestHook>) {
        self.permission_request_hooks.push(hook);
    }

    /// Execute PreToolUse hooks
    ///
    /// Returns the first blocking result, or Continue if all hooks pass.
    pub fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        for hook in &self.pre_tool_use_hooks {
            if hook.matches(&input.tool_name) {
                let result = hook.on_pre_tool_use(input);
                match &result {
                    HookResult::Continue => continue,
                    HookResult::Block { .. } => return result,
                    HookResult::ModifyInput { .. } => return result,
                    HookResult::InjectContext { .. } => return result,
                }
            }
        }
        HookResult::Continue
    }

    /// Execute PostToolUse hooks
    pub fn execute_post_tool_use(&self, input: &PostToolUseInput) -> HookResult {
        for hook in &self.post_tool_use_hooks {
            if hook.matches(&input.tool_name) {
                let result = hook.on_post_tool_use(input);
                match &result {
                    HookResult::Continue => continue,
                    _ => return result,
                }
            }
        }
        HookResult::Continue
    }

    /// Execute SessionStart hooks
    pub fn execute_session_start(&self, input: &SessionStartInput) -> HookResult {
        for hook in &self.session_start_hooks {
            let result = hook.on_session_start(input);
            match &result {
                HookResult::Continue => continue,
                _ => return result,
            }
        }
        HookResult::Continue
    }

    /// Execute SessionEnd hooks
    pub fn execute_session_end(&self, input: &SessionEndInput) -> HookResult {
        for hook in &self.session_end_hooks {
            let result = hook.on_session_end(input);
            match &result {
                HookResult::Continue => continue,
                _ => return result,
            }
        }
        HookResult::Continue
    }

    /// Execute Overflow hooks
    pub fn execute_overflow(&self, input: &OverflowInput) -> HookResult {
        for hook in &self.overflow_hooks {
            let result = hook.on_overflow(input);
            match &result {
                HookResult::Continue => continue,
                _ => return result,
            }
        }
        HookResult::Continue
    }

    /// Execute PreMessage hooks
    pub fn execute_pre_message(&self, input: &PreMessageInput) -> HookResult {
        for hook in &self.pre_message_hooks {
            let result = hook.on_pre_message(input);
            match &result {
                HookResult::Continue => continue,
                _ => return result,
            }
        }
        HookResult::Continue
    }

    /// Execute PostMessage hooks
    pub fn execute_post_message(&self, input: &PostMessageInput) -> HookResult {
        for hook in &self.post_message_hooks {
            let result = hook.on_post_message(input);
            match &result {
                HookResult::Continue => continue,
                _ => return result,
            }
        }
        HookResult::Continue
    }

    /// Execute OnError hooks
    pub fn execute_on_error(&self, input: &OnErrorInput) -> HookResult {
        for hook in &self.on_error_hooks {
            let result = hook.on_error(input);
            match &result {
                HookResult::Continue => continue,
                _ => return result,
            }
        }
        HookResult::Continue
    }

    /// Execute EvalGate hooks
    pub fn execute_eval_gate(&self, input: &EvalGateInput) -> HookResult {
        for hook in &self.eval_gate_hooks {
            let result = hook.on_eval_gate(input);
            match &result {
                HookResult::Continue => continue,
                _ => return result,
            }
        }
        HookResult::Continue
    }

    /// Execute SubagentStart hooks
    pub fn execute_subagent_start(&self, input: &SubagentStartInput) -> HookResult {
        for hook in &self.subagent_start_hooks {
            let result = hook.on_subagent_start(input);
            match &result {
                HookResult::Continue => continue,
                _ => return result,
            }
        }
        HookResult::Continue
    }

    /// Execute SubagentStop hooks
    pub fn execute_subagent_stop(&self, input: &SubagentStopInput) -> HookResult {
        for hook in &self.subagent_stop_hooks {
            let result = hook.on_subagent_stop(input);
            match &result {
                HookResult::Continue => continue,
                _ => return result,
            }
        }
        HookResult::Continue
    }

    /// Execute PermissionRequest hooks
    pub fn execute_permission_request(&self, input: &PermissionRequestInput) -> HookResult {
        for hook in &self.permission_request_hooks {
            let result = hook.on_permission_request(input);
            match &result {
                HookResult::Continue => continue,
                _ => return result,
            }
        }
        HookResult::Continue
    }

    /// Check if any hooks are registered for an event type
    pub fn has_hooks(&self, event_type: HookEventType) -> bool {
        match event_type {
            HookEventType::PreToolUse => !self.pre_tool_use_hooks.is_empty(),
            HookEventType::PostToolUse => !self.post_tool_use_hooks.is_empty(),
            HookEventType::SessionStart => !self.session_start_hooks.is_empty(),
            HookEventType::SessionEnd => !self.session_end_hooks.is_empty(),
            HookEventType::Overflow => !self.overflow_hooks.is_empty(),
            HookEventType::PreMessage => !self.pre_message_hooks.is_empty(),
            HookEventType::PostMessage => !self.post_message_hooks.is_empty(),
            HookEventType::OnError => !self.on_error_hooks.is_empty(),
            HookEventType::EvalGate => !self.eval_gate_hooks.is_empty(),
            HookEventType::SubagentStart => !self.subagent_start_hooks.is_empty(),
            HookEventType::SubagentStop => !self.subagent_stop_hooks.is_empty(),
            HookEventType::PermissionRequest => !self.permission_request_hooks.is_empty(),
            // These don't have dedicated hook vectors yet
            HookEventType::PostToolUseFailure
            | HookEventType::UserPromptSubmit
            | HookEventType::PreCompact
            | HookEventType::Notification => false,
        }
    }

    /// Get count of all registered hooks
    pub fn total_hook_count(&self) -> usize {
        self.pre_tool_use_hooks.len()
            + self.post_tool_use_hooks.len()
            + self.session_start_hooks.len()
            + self.session_end_hooks.len()
            + self.overflow_hooks.len()
            + self.pre_message_hooks.len()
            + self.post_message_hooks.len()
            + self.on_error_hooks.len()
            + self.eval_gate_hooks.len()
            + self.subagent_start_hooks.len()
            + self.subagent_stop_hooks.len()
            + self.permission_request_hooks.len()
    }
}

/// Thread-safe wrapper for HookRegistry
pub struct SharedHookRegistry {
    inner: Arc<RwLock<HookRegistry>>,
}

impl Default for SharedHookRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SharedHookRegistry {
    /// Create a new shared hook registry
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HookRegistry::new())),
        }
    }

    /// Get a clone of the inner Arc for sharing
    pub fn clone_inner(&self) -> Arc<RwLock<HookRegistry>> {
        Arc::clone(&self.inner)
    }

    /// Register a PreToolUse hook
    pub async fn register_pre_tool_use(&self, hook: Arc<dyn PreToolUseHook>) {
        let mut registry = self.inner.write().await;
        registry.register_pre_tool_use(hook);
    }

    /// Register a PostToolUse hook
    pub async fn register_post_tool_use(&self, hook: Arc<dyn PostToolUseHook>) {
        let mut registry = self.inner.write().await;
        registry.register_post_tool_use(hook);
    }

    /// Execute PreToolUse hooks
    pub async fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        let registry = self.inner.read().await;
        registry.execute_pre_tool_use(input)
    }

    /// Execute PostToolUse hooks
    pub async fn execute_post_tool_use(&self, input: &PostToolUseInput) -> HookResult {
        let registry = self.inner.read().await;
        registry.execute_post_tool_use(input)
    }

    /// Execute Overflow hooks
    pub async fn execute_overflow(&self, input: &OverflowInput) -> HookResult {
        let registry = self.inner.read().await;
        registry.execute_overflow(input)
    }
}

// ============================================================================
// Built-in Hooks
// ============================================================================

/// A hook that logs all tool calls
pub struct LoggingHook {
    pub log_file: Option<String>,
}

impl PreToolUseHook for LoggingHook {
    fn on_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        let log_line = format!(
            "[{}] Tool: {} - Input: {}",
            input.timestamp,
            input.tool_name,
            serde_json::to_string(&input.tool_input).unwrap_or_default()
        );

        if let Some(ref path) = self.log_file {
            // Would write to file in real implementation
            let _ = path;
        }

        eprintln!("{}", log_line);
        HookResult::Continue
    }
}

/// A hook that blocks dangerous bash commands
pub struct SafetyHook;

impl PreToolUseHook for SafetyHook {
    fn on_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        if input.tool_name != "Bash" && input.tool_name != "bash" {
            return HookResult::Continue;
        }

        if let Some(command) = input.tool_input.get("command").and_then(|v| v.as_str()) {
            // Block extremely dangerous commands
            let dangerous_patterns = [
                "rm -rf /",
                "rm -rf /*",
                ":(){ :|:& };:",
                "> /dev/sda",
                "mkfs.",
                "dd if=/dev/zero of=/dev/sd",
            ];

            for pattern in &dangerous_patterns {
                if command.contains(pattern) {
                    return HookResult::Block {
                        reason: format!("Blocked dangerous command pattern: {}", pattern),
                    };
                }
            }
        }

        HookResult::Continue
    }

    fn matches(&self, tool_name: &str) -> bool {
        tool_name == "Bash" || tool_name == "bash"
    }
}

/// A hook that auto-compacts on overflow
pub struct AutoCompactHook;

impl OverflowHook for AutoCompactHook {
    fn on_overflow(&self, input: &OverflowInput) -> HookResult {
        eprintln!(
            "[auto-compact] Overflow detected: {} / {} tokens",
            input.token_count, input.max_tokens
        );
        // Return Continue to allow the agent to handle compaction
        HookResult::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safety_hook_blocks_dangerous() {
        let hook = SafetyHook;
        let input = PreToolUseInput {
            hook_event_name: "PreToolUse".to_string(),
            cwd: "/tmp".to_string(),
            session_id: None,
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            tool_name: "Bash".to_string(),
            tool_call_id: "123".to_string(),
            tool_input: serde_json::json!({ "command": "rm -rf /" }),
        };

        let result = hook.on_pre_tool_use(&input);
        assert!(matches!(result, HookResult::Block { .. }));
    }

    #[test]
    fn test_safety_hook_allows_safe() {
        let hook = SafetyHook;
        let input = PreToolUseInput {
            hook_event_name: "PreToolUse".to_string(),
            cwd: "/tmp".to_string(),
            session_id: None,
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            tool_name: "Bash".to_string(),
            tool_call_id: "123".to_string(),
            tool_input: serde_json::json!({ "command": "ls -la" }),
        };

        let result = hook.on_pre_tool_use(&input);
        assert!(matches!(result, HookResult::Continue));
    }

    #[test]
    fn test_registry_executes_hooks() {
        let mut registry = HookRegistry::new();
        registry.register_pre_tool_use(Arc::new(SafetyHook));

        let input = PreToolUseInput {
            hook_event_name: "PreToolUse".to_string(),
            cwd: "/tmp".to_string(),
            session_id: None,
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            tool_name: "Bash".to_string(),
            tool_call_id: "123".to_string(),
            tool_input: serde_json::json!({ "command": "rm -rf /" }),
        };

        let result = registry.execute_pre_tool_use(&input);
        assert!(matches!(result, HookResult::Block { .. }));
    }
}
