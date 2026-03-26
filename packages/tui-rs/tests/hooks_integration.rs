//! Integration tests for the hook system
//!
//! These tests verify the complete hook system works correctly,
//! including hook execution, metrics, and session lifecycle.

use maestro_tui::hooks::{
    HookEventType, HookResult, HookStats, IntegratedHookSystem, PreToolUseHook, PreToolUseInput,
};
use std::sync::Arc;

/// Custom test hook that blocks specific commands
struct TestBlockingHook {
    blocked_tool: String,
    reason: String,
}

impl PreToolUseHook for TestBlockingHook {
    fn on_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        if input.tool_name == self.blocked_tool {
            HookResult::Block {
                reason: self.reason.clone(),
            }
        } else {
            HookResult::Continue
        }
    }

    fn matches(&self, tool_name: &str) -> bool {
        tool_name == self.blocked_tool
    }
}

/// Custom test hook that injects context
struct TestContextHook {
    context: String,
}

impl PreToolUseHook for TestContextHook {
    fn on_pre_tool_use(&self, _input: &PreToolUseInput) -> HookResult {
        HookResult::InjectContext {
            context: self.context.clone(),
        }
    }
}

/// Custom test hook that modifies input
struct TestModifyHook;

impl PreToolUseHook for TestModifyHook {
    fn on_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        if input.tool_name == "Bash" {
            let mut new_input = input.tool_input.clone();
            if let Some(cmd) = new_input.get_mut("command") {
                *cmd =
                    serde_json::json!(format!("echo 'modified'; {}", cmd.as_str().unwrap_or("")));
            }
            HookResult::ModifyInput { new_input }
        } else {
            HookResult::Continue
        }
    }
}

#[test]
fn test_integrated_system_creation() {
    let system = IntegratedHookSystem::new("/tmp");
    assert!(system.is_enabled());

    let stats = system.stats();
    assert_eq!(stats.total(), 0);
    assert!(stats.enabled);
}

#[test]
fn test_load_from_config_creates_system() {
    // This will fail to find config but should still create a working system
    let system = IntegratedHookSystem::load_from_config("/nonexistent");
    assert!(system.is_enabled());

    // Should have built-in SafetyHook
    let stats = system.stats();
    assert!(stats.native_hooks >= 1); // SafetyHook is auto-registered
}

#[test]
fn test_safety_hook_blocks_dangerous_commands() {
    let mut system = IntegratedHookSystem::load_from_config("/tmp");

    // Dangerous command should be blocked
    let result = system.execute_pre_tool_use(
        "Bash",
        "test-1",
        &serde_json::json!({ "command": "rm -rf /" }),
    );
    assert!(matches!(result, HookResult::Block { .. }));

    // Safe command should pass
    let result = system.execute_pre_tool_use(
        "Bash",
        "test-2",
        &serde_json::json!({ "command": "ls -la" }),
    );
    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_custom_blocking_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_pre_tool_use(Arc::new(TestBlockingHook {
        blocked_tool: "Write".to_string(),
        reason: "Writing disabled for test".to_string(),
    }));

    let input = PreToolUseInput {
        hook_event_name: "PreToolUse".to_string(),
        cwd: "/tmp".to_string(),
        session_id: Some("test-session".to_string()),
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        tool_name: "Write".to_string(),
        tool_call_id: "call-123".to_string(),
        tool_input: serde_json::json!({ "path": "/test.txt", "content": "test" }),
    };

    let result = registry.execute_pre_tool_use(&input);
    match result {
        HookResult::Block { reason } => {
            assert_eq!(reason, "Writing disabled for test");
        }
        _ => panic!("Expected block result"),
    }
}

#[test]
fn test_context_injection_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_pre_tool_use(Arc::new(TestContextHook {
        context: "Additional context for testing".to_string(),
    }));

    let input = PreToolUseInput {
        hook_event_name: "PreToolUse".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        tool_name: "Read".to_string(),
        tool_call_id: "call-456".to_string(),
        tool_input: serde_json::json!({ "path": "/test.txt" }),
    };

    let result = registry.execute_pre_tool_use(&input);
    match result {
        HookResult::InjectContext { context } => {
            assert_eq!(context, "Additional context for testing");
        }
        _ => panic!("Expected inject context result"),
    }
}

#[test]
fn test_input_modification_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_pre_tool_use(Arc::new(TestModifyHook));

    let input = PreToolUseInput {
        hook_event_name: "PreToolUse".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        tool_name: "Bash".to_string(),
        tool_call_id: "call-789".to_string(),
        tool_input: serde_json::json!({ "command": "ls" }),
    };

    let result = registry.execute_pre_tool_use(&input);
    match result {
        HookResult::ModifyInput { new_input } => {
            let cmd = new_input.get("command").unwrap().as_str().unwrap();
            assert!(cmd.contains("echo 'modified'"));
            assert!(cmd.contains("ls"));
        }
        _ => panic!("Expected modify input result"),
    }
}

#[test]
fn test_session_lifecycle() {
    let mut system = IntegratedHookSystem::new("/tmp");

    // Start session
    system.set_session_id(Some("test-session-123".to_string()));
    let result = system.on_session_start("cli");
    assert!(matches!(result, HookResult::Continue));

    // Track turns
    assert_eq!(system.turn_count(), 0);
    system.increment_turn();
    system.increment_turn();
    system.increment_turn();
    assert_eq!(system.turn_count(), 3);

    // Session duration should be tracked
    assert!(system.session_duration().is_some());

    // End session
    let result = system.on_session_end("user_exit");
    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_metrics_tracking() {
    let mut system = IntegratedHookSystem::new("/tmp");

    // Execute some hooks
    system.execute_pre_tool_use("Read", "1", &serde_json::json!({}));
    system.execute_pre_tool_use("Write", "2", &serde_json::json!({}));
    system.execute_pre_tool_use("Bash", "3", &serde_json::json!({ "command": "ls" }));

    system.execute_post_tool_use("Read", "1", &serde_json::json!({}), "content", false);
    system.execute_post_tool_use("Write", "2", &serde_json::json!({}), "ok", false);

    let metrics = system.metrics();
    assert_eq!(metrics.pre_tool_use_count, 3);
    assert_eq!(metrics.post_tool_use_count, 2);
    assert!(metrics.total_duration.as_nanos() > 0);
}

#[test]
fn test_metrics_tracks_blocks() {
    let mut system = IntegratedHookSystem::load_from_config("/tmp");

    // This should be blocked by SafetyHook
    system.execute_pre_tool_use("Bash", "1", &serde_json::json!({ "command": "rm -rf /" }));

    let metrics = system.metrics();
    assert!(metrics.blocks >= 1);
}

#[test]
fn test_metrics_reset() {
    let mut system = IntegratedHookSystem::new("/tmp");

    system.execute_pre_tool_use("Read", "1", &serde_json::json!({}));
    assert_eq!(system.metrics().pre_tool_use_count, 1);

    system.reset_metrics();
    assert_eq!(system.metrics().pre_tool_use_count, 0);
    assert_eq!(system.metrics().post_tool_use_count, 0);
}

#[test]
fn test_enable_disable_hooks() {
    let mut system = IntegratedHookSystem::load_from_config("/tmp");
    assert!(system.is_enabled());

    // Disable hooks
    system.disable();
    assert!(!system.is_enabled());

    // Dangerous command should NOT be blocked when hooks are disabled
    let result =
        system.execute_pre_tool_use("Bash", "1", &serde_json::json!({ "command": "rm -rf /" }));
    assert!(matches!(result, HookResult::Continue));

    // Re-enable hooks
    system.enable();
    assert!(system.is_enabled());

    // Now it should be blocked
    let result =
        system.execute_pre_tool_use("Bash", "2", &serde_json::json!({ "command": "rm -rf /" }));
    assert!(matches!(result, HookResult::Block { .. }));
}

#[test]
fn test_overflow_detection() {
    let mut system = IntegratedHookSystem::new("/tmp");
    system.set_model("claude-sonnet-4-20250514");

    // Update tokens to simulate usage
    system.update_tokens(50000, 5000, 10000);

    // Check overflow status (depends on model limits)
    let _status = system.check_overflow();
    // Status will be Normal, Warning, Critical, or Overflow depending on limits

    // Handle overflow should return true (continue with compaction)
    let should_compact = system.handle_overflow();
    assert!(should_compact);
}

#[test]
fn test_hook_stats_total() {
    let stats = HookStats {
        native_hooks: 2,
        lua_scripts: 3,
        wasm_plugins: 1,
        typescript_hooks: 4,
        enabled: true,
    };

    assert_eq!(stats.total(), 10);
}

#[test]
fn test_hook_result_default() {
    let result = HookResult::default();
    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_pre_tool_use_input_serialization() {
    let input = PreToolUseInput {
        hook_event_name: "PreToolUse".to_string(),
        cwd: "/home/user".to_string(),
        session_id: Some("sess-abc".to_string()),
        timestamp: "2024-01-15T10:30:00Z".to_string(),
        tool_name: "Bash".to_string(),
        tool_call_id: "call-xyz".to_string(),
        tool_input: serde_json::json!({ "command": "echo hello" }),
    };

    let json = serde_json::to_string(&input).unwrap();
    assert!(json.contains("PreToolUse"));
    assert!(json.contains("Bash"));
    assert!(json.contains("echo hello"));

    // Round-trip
    let parsed: PreToolUseInput = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.tool_name, "Bash");
    assert_eq!(parsed.session_id, Some("sess-abc".to_string()));
}

#[test]
fn test_multiple_hooks_chain() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();

    // First hook: allows everything
    struct AllowHook;
    impl PreToolUseHook for AllowHook {
        fn on_pre_tool_use(&self, _input: &PreToolUseInput) -> HookResult {
            HookResult::Continue
        }
    }

    // Second hook: blocks "Bash"
    struct BlockBashHook;
    impl PreToolUseHook for BlockBashHook {
        fn on_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
            if input.tool_name == "Bash" {
                HookResult::Block {
                    reason: "Bash blocked".to_string(),
                }
            } else {
                HookResult::Continue
            }
        }
    }

    registry.register_pre_tool_use(Arc::new(AllowHook));
    registry.register_pre_tool_use(Arc::new(BlockBashHook));

    // Read should pass (both allow)
    let read_input = PreToolUseInput {
        hook_event_name: "PreToolUse".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        tool_name: "Read".to_string(),
        tool_call_id: "1".to_string(),
        tool_input: serde_json::json!({}),
    };
    assert!(matches!(
        registry.execute_pre_tool_use(&read_input),
        HookResult::Continue
    ));

    // Bash should be blocked (second hook blocks)
    let bash_input = PreToolUseInput {
        hook_event_name: "PreToolUse".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        tool_name: "Bash".to_string(),
        tool_call_id: "2".to_string(),
        tool_input: serde_json::json!({}),
    };
    assert!(matches!(
        registry.execute_pre_tool_use(&bash_input),
        HookResult::Block { .. }
    ));
}

// ============================================================================
// Lua Executor Tests (when feature enabled)
// ============================================================================

#[test]
fn test_lua_executor_creation() {
    use maestro_tui::hooks::LuaHookExecutor;

    let executor = LuaHookExecutor::new();
    assert!(!executor.has_hooks());
    assert_eq!(executor.script_count(), 0);
}

#[test]
fn test_lua_executor_load_script() {
    use maestro_tui::hooks::LuaHookExecutor;

    let mut executor = LuaHookExecutor::new();
    let result = executor.load_script(
        r"return { continue = true }",
        HookEventType::PreToolUse,
        vec![],
    );
    assert!(result.is_ok());
    assert_eq!(executor.script_count(), 1);
}

// ============================================================================
// WASM Executor Tests
// ============================================================================

#[test]
fn test_wasm_executor_creation() {
    use maestro_tui::hooks::WasmHookExecutor;

    let executor = WasmHookExecutor::new();
    assert!(!executor.has_plugins());
    assert_eq!(executor.plugin_count(), 0);
}

#[test]
fn test_wasm_result_code_conversion() {
    use maestro_tui::hooks::WasmResultCode;

    assert_eq!(WasmResultCode::from(0), WasmResultCode::Continue);
    assert_eq!(WasmResultCode::from(1), WasmResultCode::Block);
    assert_eq!(WasmResultCode::from(2), WasmResultCode::Modify);
    assert_eq!(WasmResultCode::from(3), WasmResultCode::InjectContext);
    assert_eq!(WasmResultCode::from(-1), WasmResultCode::Error);
    assert_eq!(WasmResultCode::from(999), WasmResultCode::Error);
}

// ============================================================================
// Async Tests (for IPC bridge)
// ============================================================================

#[tokio::test]
async fn test_async_pre_tool_use() {
    let mut system = IntegratedHookSystem::new("/tmp");

    let result = system
        .execute_pre_tool_use_async("Read", "1", &serde_json::json!({ "path": "/test.txt" }))
        .await;

    assert!(matches!(result, HookResult::Continue));
}

#[tokio::test]
async fn test_async_with_bridge_start() {
    let mut system = IntegratedHookSystem::load_from_config("/tmp");

    // Start bridge (may fail if Node.js not available, which is fine)
    let _ = system.start_bridge().await;

    // Should still work even if bridge fails
    let result = system
        .execute_pre_tool_use_async("Read", "1", &serde_json::json!({}))
        .await;

    assert!(matches!(result, HookResult::Continue));

    // Stop bridge
    let _ = system.stop_bridge().await;
}

// ============================================================================
// New Event Tests: PreMessage, PostMessage, OnError, etc.
// ============================================================================

#[test]
fn test_pre_message_hook_execution() {
    let mut system = IntegratedHookSystem::new("/tmp");

    let result = system.execute_pre_message("Hello, world!", &[], Some("claude-3-opus"));

    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_post_message_hook_execution() {
    let mut system = IntegratedHookSystem::new("/tmp");

    let result =
        system.execute_post_message("Here's my response...", 1000, 500, 2500, Some("end_turn"));

    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_on_error_hook_execution() {
    let mut system = IntegratedHookSystem::new("/tmp");

    let result =
        system.execute_on_error("Connection timeout", "NetworkError", Some("api_call"), true);

    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_eval_gate_hook_execution() {
    let mut system = IntegratedHookSystem::new("/tmp");

    let result = system.execute_eval_gate(
        "Bash",
        "call_123",
        &serde_json::json!({ "command": "ls" }),
        "file1.txt\nfile2.txt",
    );

    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_subagent_start_hook_execution() {
    let mut system = IntegratedHookSystem::new("/tmp");

    let result =
        system.execute_subagent_start("explore", "Find all TypeScript files", Some("parent_123"));

    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_subagent_stop_hook_execution() {
    let mut system = IntegratedHookSystem::new("/tmp");

    let result =
        system.execute_subagent_stop("explore", "agent_456", Some("Found 15 files"), 5000, true);

    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_permission_request_hook_execution() {
    let mut system = IntegratedHookSystem::new("/tmp");

    let result = system.execute_permission_request(
        "Bash",
        "call_789",
        &serde_json::json!({ "command": "rm -rf ./temp" }),
        "Destructive operation",
    );

    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_hooks_disabled_returns_continue() {
    let mut system = IntegratedHookSystem::new("/tmp");
    system.disable();

    // All hooks should return Continue when disabled
    assert!(matches!(
        system.execute_pre_message("test", &[], None),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_post_message("test", 0, 0, 0, None),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_on_error("test", "test", None, true),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_eval_gate("Bash", "1", &serde_json::json!({}), ""),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_subagent_start("test", "test", None),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_subagent_stop("test", "1", None, 0, true),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_permission_request("Bash", "1", &serde_json::json!({}), "test"),
        HookResult::Continue
    ));
}

// ============================================================================
// Registry Tests for New Events
// ============================================================================

use maestro_tui::hooks::{OnErrorHook, OnErrorInput, PreMessageHook, PreMessageInput};

struct TestPreMessageHook {
    block_long_messages: bool,
}

impl PreMessageHook for TestPreMessageHook {
    fn on_pre_message(&self, input: &PreMessageInput) -> HookResult {
        if self.block_long_messages && input.message.len() > 1000 {
            HookResult::Block {
                reason: "Message too long".to_string(),
            }
        } else {
            HookResult::Continue
        }
    }
}

#[test]
fn test_registry_pre_message_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_pre_message(Arc::new(TestPreMessageHook {
        block_long_messages: true,
    }));

    // Short message should pass
    let short_input = PreMessageInput {
        hook_event_name: "PreMessage".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        message: "Hello".to_string(),
        attachments: vec![],
        model: None,
    };
    assert!(matches!(
        registry.execute_pre_message(&short_input),
        HookResult::Continue
    ));

    // Long message should be blocked
    let long_input = PreMessageInput {
        hook_event_name: "PreMessage".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        message: "x".repeat(1001),
        attachments: vec![],
        model: None,
    };
    assert!(matches!(
        registry.execute_pre_message(&long_input),
        HookResult::Block { .. }
    ));
}

struct TestOnErrorHook {
    suppress_network_errors: bool,
}

impl OnErrorHook for TestOnErrorHook {
    fn on_error(&self, input: &OnErrorInput) -> HookResult {
        if self.suppress_network_errors && input.error_kind == "NetworkError" {
            HookResult::Block {
                reason: "Suppressed network error".to_string(),
            }
        } else {
            HookResult::Continue
        }
    }
}

#[test]
fn test_registry_on_error_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_on_error(Arc::new(TestOnErrorHook {
        suppress_network_errors: true,
    }));

    // Non-network error should pass
    let other_error = OnErrorInput {
        hook_event_name: "OnError".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        error: "Some error".to_string(),
        error_kind: "ValidationError".to_string(),
        context: None,
        recoverable: true,
    };
    assert!(matches!(
        registry.execute_on_error(&other_error),
        HookResult::Continue
    ));

    // Network error should be suppressed
    let network_error = OnErrorInput {
        hook_event_name: "OnError".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        error: "Connection timeout".to_string(),
        error_kind: "NetworkError".to_string(),
        context: None,
        recoverable: true,
    };
    assert!(matches!(
        registry.execute_on_error(&network_error),
        HookResult::Block { .. }
    ));
}

#[test]
fn test_registry_has_hooks_for_new_events() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();

    // Initially no hooks
    assert!(!registry.has_hooks(HookEventType::PreMessage));
    assert!(!registry.has_hooks(HookEventType::PostMessage));
    assert!(!registry.has_hooks(HookEventType::OnError));
    assert!(!registry.has_hooks(HookEventType::EvalGate));
    assert!(!registry.has_hooks(HookEventType::SubagentStart));
    assert!(!registry.has_hooks(HookEventType::SubagentStop));
    assert!(!registry.has_hooks(HookEventType::PermissionRequest));

    // Add hooks
    registry.register_pre_message(Arc::new(TestPreMessageHook {
        block_long_messages: false,
    }));
    registry.register_on_error(Arc::new(TestOnErrorHook {
        suppress_network_errors: false,
    }));

    // Now we should have hooks
    assert!(registry.has_hooks(HookEventType::PreMessage));
    assert!(registry.has_hooks(HookEventType::OnError));
}

#[test]
fn test_registry_total_hook_count() {
    use maestro_tui::hooks::{HookRegistry, SafetyHook};

    let mut registry = HookRegistry::new();
    assert_eq!(registry.total_hook_count(), 0);

    registry.register_pre_tool_use(Arc::new(SafetyHook));
    assert_eq!(registry.total_hook_count(), 1);

    registry.register_pre_message(Arc::new(TestPreMessageHook {
        block_long_messages: false,
    }));
    assert_eq!(registry.total_hook_count(), 2);

    registry.register_on_error(Arc::new(TestOnErrorHook {
        suppress_network_errors: false,
    }));
    assert_eq!(registry.total_hook_count(), 3);
}

// ============================================================================
// Additional Hook Implementation Tests
// ============================================================================

use maestro_tui::hooks::{
    EvalGateHook, EvalGateInput, OverflowHook, OverflowInput, PermissionRequestHook,
    PermissionRequestInput, PostMessageHook, PostMessageInput, PostToolUseHook, PostToolUseInput,
    SessionEndHook, SessionEndInput, SessionStartHook, SessionStartInput, SubagentStartHook,
    SubagentStartInput, SubagentStopHook, SubagentStopInput,
};

// PostToolUse hook test
struct TestPostToolUseHook {
    inject_context: bool,
}

impl PostToolUseHook for TestPostToolUseHook {
    fn on_post_tool_use(&self, input: &PostToolUseInput) -> HookResult {
        if self.inject_context && input.tool_name == "Bash" {
            HookResult::InjectContext {
                context: format!("Command completed: {}", input.tool_output),
            }
        } else {
            HookResult::Continue
        }
    }
}

#[test]
fn test_registry_post_tool_use_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_post_tool_use(Arc::new(TestPostToolUseHook {
        inject_context: true,
    }));

    let input = PostToolUseInput {
        hook_event_name: "PostToolUse".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        tool_name: "Bash".to_string(),
        tool_call_id: "1".to_string(),
        tool_input: serde_json::json!({"command": "ls"}),
        tool_output: "file1.txt\nfile2.txt".to_string(),
        is_error: false,
    };

    let result = registry.execute_post_tool_use(&input);
    assert!(matches!(result, HookResult::InjectContext { .. }));
}

// PostMessage hook test
struct TestPostMessageHook {
    log_responses: bool,
}

impl PostMessageHook for TestPostMessageHook {
    fn on_post_message(&self, input: &PostMessageInput) -> HookResult {
        if self.log_responses {
            // In real code, would log to file
            println!(
                "Response: {} tokens in {}ms",
                input.output_tokens, input.duration_ms
            );
        }
        HookResult::Continue
    }
}

#[test]
fn test_registry_post_message_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_post_message(Arc::new(TestPostMessageHook {
        log_responses: true,
    }));

    let input = PostMessageInput {
        hook_event_name: "PostMessage".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        response: "Here is my response...".to_string(),
        input_tokens: 1000,
        output_tokens: 500,
        duration_ms: 2500,
        stop_reason: Some("end_turn".to_string()),
    };

    let result = registry.execute_post_message(&input);
    assert!(matches!(result, HookResult::Continue));
}

// SessionStart hook test
struct TestSessionStartHook {
    block_cli: bool,
}

impl SessionStartHook for TestSessionStartHook {
    fn on_session_start(&self, input: &SessionStartInput) -> HookResult {
        if self.block_cli && input.source == "cli" {
            HookResult::Block {
                reason: "CLI sessions blocked".to_string(),
            }
        } else {
            HookResult::Continue
        }
    }
}

#[test]
fn test_registry_session_start_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_session_start(Arc::new(TestSessionStartHook { block_cli: true }));

    // CLI should be blocked
    let cli_input = SessionStartInput {
        hook_event_name: "SessionStart".to_string(),
        cwd: "/tmp".to_string(),
        session_id: Some("sess_123".to_string()),
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        source: "cli".to_string(),
    };
    assert!(matches!(
        registry.execute_session_start(&cli_input),
        HookResult::Block { .. }
    ));

    // API should pass
    let api_input = SessionStartInput {
        hook_event_name: "SessionStart".to_string(),
        cwd: "/tmp".to_string(),
        session_id: Some("sess_456".to_string()),
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        source: "api".to_string(),
    };
    assert!(matches!(
        registry.execute_session_start(&api_input),
        HookResult::Continue
    ));
}

// SessionEnd hook test
struct TestSessionEndHook;

impl SessionEndHook for TestSessionEndHook {
    fn on_session_end(&self, input: &SessionEndInput) -> HookResult {
        println!(
            "Session ended: {} after {} turns",
            input.reason, input.turn_count
        );
        HookResult::Continue
    }
}

#[test]
fn test_registry_session_end_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_session_end(Arc::new(TestSessionEndHook));

    let input = SessionEndInput {
        hook_event_name: "SessionEnd".to_string(),
        cwd: "/tmp".to_string(),
        session_id: Some("sess_123".to_string()),
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        reason: "user_quit".to_string(),
        duration_ms: 60000,
        turn_count: 5,
    };

    let result = registry.execute_session_end(&input);
    assert!(matches!(result, HookResult::Continue));
}

// Overflow hook test
struct TestOverflowHook {
    block_overflow: bool,
}

impl OverflowHook for TestOverflowHook {
    fn on_overflow(&self, input: &OverflowInput) -> HookResult {
        if self.block_overflow && input.token_count > input.max_tokens {
            HookResult::Block {
                reason: "Overflow blocked - manual compaction required".to_string(),
            }
        } else {
            HookResult::Continue
        }
    }
}

#[test]
fn test_registry_overflow_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_overflow(Arc::new(TestOverflowHook {
        block_overflow: true,
    }));

    // Over limit should block
    let over_input = OverflowInput {
        hook_event_name: "Overflow".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        token_count: 150_000,
        max_tokens: 100_000,
    };
    assert!(matches!(
        registry.execute_overflow(&over_input),
        HookResult::Block { .. }
    ));

    // Under limit should pass
    let under_input = OverflowInput {
        hook_event_name: "Overflow".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        token_count: 50000,
        max_tokens: 100_000,
    };
    assert!(matches!(
        registry.execute_overflow(&under_input),
        HookResult::Continue
    ));
}

// EvalGate hook test
struct TestEvalGateHook {
    require_output: bool,
}

impl EvalGateHook for TestEvalGateHook {
    fn on_eval_gate(&self, input: &EvalGateInput) -> HookResult {
        if self.require_output && input.tool_output.is_empty() {
            HookResult::Block {
                reason: "Tool produced no output".to_string(),
            }
        } else {
            HookResult::Continue
        }
    }
}

#[test]
fn test_registry_eval_gate_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_eval_gate(Arc::new(TestEvalGateHook {
        require_output: true,
    }));

    // Empty output should block
    let empty_input = EvalGateInput {
        hook_event_name: "EvalGate".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        tool_name: "Bash".to_string(),
        tool_call_id: "1".to_string(),
        tool_input: serde_json::json!({"command": "true"}),
        tool_output: String::new(),
    };
    assert!(matches!(
        registry.execute_eval_gate(&empty_input),
        HookResult::Block { .. }
    ));

    // Non-empty output should pass
    let output_input = EvalGateInput {
        hook_event_name: "EvalGate".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        tool_name: "Bash".to_string(),
        tool_call_id: "2".to_string(),
        tool_input: serde_json::json!({"command": "ls"}),
        tool_output: "file.txt".to_string(),
    };
    assert!(matches!(
        registry.execute_eval_gate(&output_input),
        HookResult::Continue
    ));
}

// SubagentStart hook test
struct TestSubagentStartHook {
    blocked_types: Vec<String>,
}

impl SubagentStartHook for TestSubagentStartHook {
    fn on_subagent_start(&self, input: &SubagentStartInput) -> HookResult {
        if self.blocked_types.contains(&input.subagent_type) {
            HookResult::Block {
                reason: format!("Subagent type '{}' is blocked", input.subagent_type),
            }
        } else {
            HookResult::Continue
        }
    }
}

#[test]
fn test_registry_subagent_start_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_subagent_start(Arc::new(TestSubagentStartHook {
        blocked_types: vec!["dangerous".to_string()],
    }));

    // Blocked type
    let blocked_input = SubagentStartInput {
        hook_event_name: "SubagentStart".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        subagent_type: "dangerous".to_string(),
        task: "Do something".to_string(),
        parent_agent_id: None,
    };
    assert!(matches!(
        registry.execute_subagent_start(&blocked_input),
        HookResult::Block { .. }
    ));

    // Allowed type
    let allowed_input = SubagentStartInput {
        hook_event_name: "SubagentStart".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        subagent_type: "explore".to_string(),
        task: "Find files".to_string(),
        parent_agent_id: Some("parent_123".to_string()),
    };
    assert!(matches!(
        registry.execute_subagent_start(&allowed_input),
        HookResult::Continue
    ));
}

// SubagentStop hook test
struct TestSubagentStopHook;

impl SubagentStopHook for TestSubagentStopHook {
    fn on_subagent_stop(&self, input: &SubagentStopInput) -> HookResult {
        if !input.success {
            println!(
                "Subagent {} failed after {}ms",
                input.subagent_id, input.duration_ms
            );
        }
        HookResult::Continue
    }
}

#[test]
fn test_registry_subagent_stop_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_subagent_stop(Arc::new(TestSubagentStopHook));

    let input = SubagentStopInput {
        hook_event_name: "SubagentStop".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        subagent_type: "explore".to_string(),
        subagent_id: "agent_456".to_string(),
        result: Some("Found 15 files".to_string()),
        duration_ms: 5000,
        success: true,
    };

    let result = registry.execute_subagent_stop(&input);
    assert!(matches!(result, HookResult::Continue));
}

// PermissionRequest hook test
struct TestPermissionRequestHook {
    auto_approve_tools: Vec<String>,
}

impl PermissionRequestHook for TestPermissionRequestHook {
    fn on_permission_request(&self, input: &PermissionRequestInput) -> HookResult {
        if self.auto_approve_tools.contains(&input.tool_name) {
            // Auto-approve by continuing (not blocking)
            HookResult::Continue
        } else if input.tool_name == "Bash" && input.reason.contains("destructive") {
            HookResult::Block {
                reason: "Destructive bash commands require manual approval".to_string(),
            }
        } else {
            HookResult::Continue
        }
    }
}

#[test]
fn test_registry_permission_request_hook() {
    use maestro_tui::hooks::HookRegistry;

    let mut registry = HookRegistry::new();
    registry.register_permission_request(Arc::new(TestPermissionRequestHook {
        auto_approve_tools: vec!["Read".to_string()],
    }));

    // Auto-approved tool
    let read_input = PermissionRequestInput {
        hook_event_name: "PermissionRequest".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        tool_name: "Read".to_string(),
        tool_call_id: "1".to_string(),
        tool_input: serde_json::json!({"path": "/etc/passwd"}),
        reason: "Reading system file".to_string(),
    };
    assert!(matches!(
        registry.execute_permission_request(&read_input),
        HookResult::Continue
    ));

    // Destructive bash blocked
    let bash_input = PermissionRequestInput {
        hook_event_name: "PermissionRequest".to_string(),
        cwd: "/tmp".to_string(),
        session_id: None,
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        tool_name: "Bash".to_string(),
        tool_call_id: "2".to_string(),
        tool_input: serde_json::json!({"command": "rm -rf /"}),
        reason: "destructive operation".to_string(),
    };
    assert!(matches!(
        registry.execute_permission_request(&bash_input),
        HookResult::Block { .. }
    ));
}

// ============================================================================
// IntegratedHookSystem comprehensive tests
// ============================================================================

#[test]
fn test_integrated_system_all_events_when_disabled() {
    let mut system = IntegratedHookSystem::new("/tmp");
    system.disable();
    assert!(!system.is_enabled());

    // All events should return Continue when disabled
    assert!(matches!(
        system.execute_pre_tool_use("Bash", "1", &serde_json::json!({})),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_post_tool_use("Bash", "1", &serde_json::json!({}), "output", false),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_pre_message("test", &[], None),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_post_message("test", 0, 0, 0, None),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_on_error("error", "kind", None, true),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_eval_gate("Bash", "1", &serde_json::json!({}), ""),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_subagent_start("type", "task", None),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_subagent_stop("type", "id", None, 0, true),
        HookResult::Continue
    ));
    assert!(matches!(
        system.execute_permission_request("Bash", "1", &serde_json::json!({}), "reason"),
        HookResult::Continue
    ));

    // Re-enable and verify
    system.enable();
    assert!(system.is_enabled());
}

#[test]
fn test_integrated_system_session_lifecycle_complete() {
    let mut system = IntegratedHookSystem::new("/tmp");

    // Start session
    system.on_session_start("test");
    assert_eq!(system.turn_count(), 0);

    // Simulate turns
    for _ in 0..5 {
        system.increment_turn();
    }
    assert_eq!(system.turn_count(), 5);

    // Check duration
    let duration = system.session_duration();
    assert!(duration.is_some());

    // End session
    system.on_session_end("completed");
}

#[test]
fn test_integrated_system_metrics_comprehensive() {
    let mut system = IntegratedHookSystem::new("/tmp");

    // Execute various hooks
    system.execute_pre_tool_use("Bash", "1", &serde_json::json!({}));
    system.execute_pre_tool_use("Read", "2", &serde_json::json!({}));
    system.execute_post_tool_use("Bash", "1", &serde_json::json!({}), "output", false);

    let metrics = system.metrics();
    assert_eq!(metrics.pre_tool_use_count, 2);
    assert_eq!(metrics.post_tool_use_count, 1);

    // Reset and verify
    system.reset_metrics();
    let metrics = system.metrics();
    assert_eq!(metrics.pre_tool_use_count, 0);
    assert_eq!(metrics.post_tool_use_count, 0);
}

#[test]
fn test_integrated_system_with_safety_hook() {
    // Test that the built-in safety hook works through IntegratedHookSystem
    let mut system = IntegratedHookSystem::load_from_config("/tmp");

    // The system should have default safety hooks
    // Safe command should pass
    let result =
        system.execute_pre_tool_use("Bash", "1", &serde_json::json!({"command": "ls -la"}));
    assert!(matches!(result, HookResult::Continue));

    // Dangerous command should be blocked by built-in safety hook
    let result =
        system.execute_pre_tool_use("Bash", "2", &serde_json::json!({"command": "rm -rf /"}));
    assert!(matches!(result, HookResult::Block { .. }));
}

#[test]
fn test_integrated_system_stats() {
    let system = IntegratedHookSystem::new("/tmp");

    let stats = system.stats();
    // Verify stats struct is accessible and fields are present
    let _ = stats.enabled;
    let _ = stats.total();
    let _ = stats.native_hooks;
    let _ = stats.lua_scripts;
    let _ = stats.wasm_plugins;
    let _ = stats.typescript_hooks;
}

#[test]
fn test_hook_result_variants() {
    // Test all HookResult variants
    let continue_result = HookResult::Continue;
    assert!(matches!(continue_result, HookResult::Continue));

    let block_result = HookResult::Block {
        reason: "test".to_string(),
    };
    assert!(matches!(block_result, HookResult::Block { .. }));

    let modify_result = HookResult::ModifyInput {
        new_input: serde_json::json!({}),
    };
    assert!(matches!(modify_result, HookResult::ModifyInput { .. }));

    let context_result = HookResult::InjectContext {
        context: "test".to_string(),
    };
    assert!(matches!(context_result, HookResult::InjectContext { .. }));
}
