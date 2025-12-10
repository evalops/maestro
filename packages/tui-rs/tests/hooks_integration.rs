//! Integration tests for the hook system
//!
//! These tests verify the complete hook system works correctly,
//! including hook execution, metrics, and session lifecycle.

use composer_tui::hooks::{
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
                *cmd = serde_json::json!(format!("echo 'modified'; {}", cmd.as_str().unwrap_or("")));
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
    let result = system.execute_pre_tool_use("Bash", "test-2", &serde_json::json!({ "command": "ls -la" }));
    assert!(matches!(result, HookResult::Continue));
}

#[test]
fn test_custom_blocking_hook() {
    use composer_tui::hooks::HookRegistry;

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
    use composer_tui::hooks::HookRegistry;

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
    use composer_tui::hooks::HookRegistry;

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
    system.execute_pre_tool_use(
        "Bash",
        "1",
        &serde_json::json!({ "command": "rm -rf /" }),
    );

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
    let result = system.execute_pre_tool_use(
        "Bash",
        "1",
        &serde_json::json!({ "command": "rm -rf /" }),
    );
    assert!(matches!(result, HookResult::Continue));

    // Re-enable hooks
    system.enable();
    assert!(system.is_enabled());

    // Now it should be blocked
    let result = system.execute_pre_tool_use(
        "Bash",
        "2",
        &serde_json::json!({ "command": "rm -rf /" }),
    );
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
    use composer_tui::hooks::HookRegistry;

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
    use composer_tui::hooks::LuaHookExecutor;

    let executor = LuaHookExecutor::new();
    assert!(!executor.has_hooks());
    assert_eq!(executor.script_count(), 0);
}

#[test]
fn test_lua_executor_load_script() {
    use composer_tui::hooks::LuaHookExecutor;

    let mut executor = LuaHookExecutor::new();
    let result = executor.load_script(
        r#"return { continue = true }"#,
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
    use composer_tui::hooks::WasmHookExecutor;

    let executor = WasmHookExecutor::new();
    assert!(!executor.has_plugins());
    assert_eq!(executor.plugin_count(), 0);
}

#[test]
fn test_wasm_result_code_conversion() {
    use composer_tui::hooks::WasmResultCode;

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
