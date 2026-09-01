use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::super::{ExecutionSource, FromAgent, ToolExecution};
#[cfg(test)]
use crate::agent::CredentialVault;
use crate::mcp::McpToolAnnotations;
use crate::tools::{BatchConfig, BatchExecutor, BatchToolCall, ToolExecutor};

#[derive(Debug)]
pub(super) struct QueuedReadOnlyToolExecution {
    pub(super) call_id: String,
    pub(super) tool_name: String,
    pub(super) args: serde_json::Value,
    pub(super) safe_args: serde_json::Value,
    // Resolve before scheduling so tools receive concrete command arguments.
    pub(super) resolved_args: serde_json::Value,
    pub(super) extra_context: Option<String>,
}

fn native_read_only_tool_concurrency_limit() -> usize {
    std::env::var("MAESTRO_NATIVE_READ_ONLY_TOOL_CONCURRENCY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| value.clamp(1, 16))
        .unwrap_or(8)
}

fn native_read_only_batch_config() -> BatchConfig {
    BatchConfig::default()
        .with_concurrency(native_read_only_tool_concurrency_limit())
        .continue_on_error(true)
        .emit_events(true)
}

fn is_known_native_read_only_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "read"
            | "glob"
            | "grep"
            | "diff"
            | "list"
            | "find"
            | "search"
            | "parallel_ripgrep"
            | "websearch"
            | "web_fetch"
            | "webfetch"
            | "read_image"
            | "mcp_list_resources"
            | "mcp_list_prompts"
            | "mcp_read_resource"
            | "mcp_get_prompt"
            | "vscode_get_diagnostics"
            | "vscode_get_definition"
            | "vscode_find_references"
            | "vscode_read_file_range"
            | "jetbrains_get_diagnostics"
            | "jetbrains_get_definition"
            | "jetbrains_find_references"
            | "jetbrains_read_file_range"
    )
}

pub(super) fn is_native_parallel_read_only_tool_call(
    tool_name: &str,
    requires_approval: bool,
    annotations: Option<&McpToolAnnotations>,
    explicit_inline_read_only: bool,
) -> bool {
    if requires_approval {
        return false;
    }

    let tool_key = tool_name.to_lowercase();
    if is_known_native_read_only_tool(&tool_key) {
        return true;
    }

    if tool_key.starts_with("mcp__") {
        return annotations.is_some_and(|annotations| {
            annotations.read_only_hint == Some(true) && annotations.destructive_hint != Some(true)
        });
    }

    explicit_inline_read_only
}

pub(super) fn is_explicit_inline_read_only_tool(
    tool_name: &str,
    tool_executor: &ToolExecutor,
) -> bool {
    tool_executor.inline_tools().any(|tool| {
        tool.definition.name.eq_ignore_ascii_case(tool_name)
            && tool.definition.annotations.read_only
            && !tool.definition.annotations.destructive
    })
}

pub(super) async fn execute_native_read_only_tool_wave(
    tool_executor: Arc<ToolExecutor>,
    event_tx: &mpsc::UnboundedSender<FromAgent>,
    pending: &[QueuedReadOnlyToolExecution],
    cancel_token: Option<CancellationToken>,
) -> HashMap<String, ToolExecution> {
    let credential_generation = tool_executor.credential_generation();
    let calls = pending
        .iter()
        .map(|call| {
            BatchToolCall::new(
                call.call_id.clone(),
                call.tool_name.clone(),
                call.resolved_args.clone(),
            )
        })
        .collect();
    let batch_executor =
        BatchExecutor::from_shared_executor(tool_executor, native_read_only_batch_config());
    let results = if let Some(cancel_token) = cancel_token {
        batch_executor
            .execute_with_cancel_at_generation(
                calls,
                Some(event_tx.clone()),
                cancel_token,
                credential_generation,
            )
            .await
    } else {
        batch_executor
            .execute_at_generation(calls, Some(event_tx.clone()), credential_generation)
            .await
    };

    results
        .into_iter()
        .map(|result| {
            let execution = result.execution.unwrap_or_else(|| {
                ToolExecution::from_legacy(
                    &result.call_id,
                    &result.tool_name,
                    ExecutionSource::Native,
                    result.result,
                )
            });
            (result.call_id, execution)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ToolOutcome;
    use crate::mcp::McpToolAnnotations;

    #[test]
    fn test_native_parallel_read_only_classifier_preconditions() {
        assert!(is_native_parallel_read_only_tool_call(
            "read", false, None, false
        ));
        assert!(!is_native_parallel_read_only_tool_call(
            "read_probe",
            false,
            None,
            false
        ));
        assert!(is_native_parallel_read_only_tool_call(
            "read_probe",
            false,
            None,
            true
        ));

        assert!(!is_native_parallel_read_only_tool_call(
            "write", true, None, true
        ));
        assert!(!is_native_parallel_read_only_tool_call(
            "bash", false, None, false
        ));

        let read_only_mcp = McpToolAnnotations {
            read_only_hint: Some(true),
            destructive_hint: Some(false),
            ..Default::default()
        };
        assert!(is_native_parallel_read_only_tool_call(
            "mcp__repo__inspect",
            false,
            Some(&read_only_mcp),
            false
        ));

        let destructive_mcp = McpToolAnnotations {
            read_only_hint: Some(true),
            destructive_hint: Some(true),
            ..Default::default()
        };
        assert!(!is_native_parallel_read_only_tool_call(
            "mcp__repo__mutate",
            false,
            Some(&destructive_mcp),
            true
        ));
    }

    /// Serializes tests in this module that swap process-global `$HOME` to
    /// mark a temp workspace trusted (see `mark_workspace_trusted`).
    static ENV_MUTEX: std::sync::LazyLock<std::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

    /// Mark `workspace` trusted the same way a real user would (global
    /// config, keyed on the canonical workspace path), by pointing `$HOME`
    /// at a throwaway directory containing only that trust grant.
    ///
    /// This test's inline tool is self-authored by the test itself (not
    /// attacker-controlled), so simulating a trusted workspace is the
    /// correct fixture -- this is a regression test for the read-only
    /// batching classifier, not for the trust gate (see
    /// `tools::inline::tests` for that). Returns a guard that restores the
    /// previous `$HOME` on drop.
    fn mark_workspace_trusted(workspace: &std::path::Path) -> impl Drop {
        struct HomeGuard {
            _lock: std::sync::MutexGuard<'static, ()>,
            previous_home: Option<String>,
            _fake_home: tempfile::TempDir,
        }
        impl Drop for HomeGuard {
            fn drop(&mut self) {
                match &self.previous_home {
                    Some(home) => std::env::set_var("HOME", home),
                    None => std::env::remove_var("HOME"),
                }
            }
        }

        let lock = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let fake_home = tempfile::tempdir().unwrap();
        let canonical = dunce::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        let composer_dir = fake_home.path().join(".composer");
        std::fs::create_dir_all(&composer_dir).unwrap();
        std::fs::write(
            composer_dir.join("config.toml"),
            format!(
                "[projects.\"{}\"]\ntrust_level = \"trusted\"\n",
                canonical.display()
            ),
        )
        .unwrap();

        let previous_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", fake_home.path());

        HomeGuard {
            _lock: lock,
            previous_home,
            _fake_home: fake_home,
        }
    }

    #[tokio::test]
    async fn test_rust_client_read_only_wave_live_pre_post_conditions() {
        let temp = tempfile::tempdir().unwrap();
        let _home_guard = mark_workspace_trusted(temp.path());
        let composer_dir = temp.path().join(".composer");
        std::fs::create_dir_all(&composer_dir).unwrap();
        std::fs::write(
            composer_dir.join("tools.json"),
            r#"{
                "tools": [{
                    "name": "read_probe",
                    "description": "Delayed read-only probe for native batching tests",
                    "command": "sleep 0.08; printf GITHUB_TOKEN=ghs_123456789012345678901234567890123456",
                    "parameters": {
                        "phase": {"type": "string"},
                        "index": {"type": "number"}
                    },
                    "annotations": {
                        "readOnly": true
                    }
                }]
            }"#,
        )
        .unwrap();

        let pending: Vec<QueuedReadOnlyToolExecution> = (0..4)
            .map(|index| {
                let args = serde_json::json!({
                    "phase": "inspect",
                    "index": index
                });
                QueuedReadOnlyToolExecution {
                    call_id: format!("inspect-{index}"),
                    tool_name: "read_probe".to_string(),
                    args: args.clone(),
                    safe_args: args.clone(),
                    resolved_args: args.clone(),
                    extra_context: None,
                }
            })
            .collect();

        let credential_vault = CredentialVault::new();
        let tool_executor = Arc::new(ToolExecutor::with_credential_vault(
            temp.path().to_str().unwrap(),
            credential_vault.clone(),
        ));
        assert_eq!(pending.len(), 4);
        assert!(pending.iter().all(|call| {
            is_native_parallel_read_only_tool_call(
                &call.tool_name,
                false,
                None,
                is_explicit_inline_read_only_tool(&call.tool_name, &tool_executor),
            )
        }));

        let (tx, mut rx) = mpsc::unbounded_channel();
        let results = execute_native_read_only_tool_wave(tool_executor, &tx, &pending, None).await;

        assert_eq!(results.len(), 4);
        assert!(
            results
                .values()
                .all(|result| matches!(result.outcome, ToolOutcome::Succeeded { .. }))
        );
        assert!(
            results
                .values()
                .all(|result| result.model_content().contains("{{CRED:"))
        );
        assert!(results.values().all(|result| {
            credential_vault
                .resolve_all(&result.model_content())
                .contains("ghs_123456789012345678901234567890123456")
        }));

        let mut starts = 0;
        let mut ends = 0;
        let mut event_order = Vec::new();
        while let Ok(event) = rx.try_recv() {
            match event {
                FromAgent::ToolStart { .. } => {
                    starts += 1;
                    event_order.push("start");
                }
                FromAgent::ToolEnd { .. } => {
                    ends += 1;
                    event_order.push("end");
                }
                _ => {}
            }
        }
        assert_eq!(starts, 4);
        assert_eq!(ends, 4);
        let first_end = event_order
            .iter()
            .position(|event| *event == "end")
            .expect("read-only wave should emit a ToolEnd event");
        let starts_before_first_end = event_order[..first_end]
            .iter()
            .filter(|event| **event == "start")
            .count();
        assert_eq!(
            starts_before_first_end, 4,
            "read-only wave should start every member before the first completion"
        );
    }

    #[tokio::test]
    async fn cancelled_read_only_wave_retains_queued_receipts_and_terminal_events() {
        let temp = tempfile::tempdir().unwrap();
        let pending = vec![QueuedReadOnlyToolExecution {
            call_id: "inspect-0".to_string(),
            tool_name: "glob".to_string(),
            args: serde_json::json!({"pattern": "*.rs"}),
            safe_args: serde_json::json!({"pattern": "*.rs"}),
            resolved_args: serde_json::json!({"pattern": "*.rs"}),
            extra_context: None,
        }];
        let (tx, mut rx) = mpsc::unbounded_channel();
        let cancel_token = CancellationToken::new();
        cancel_token.cancel();

        let results = execute_native_read_only_tool_wave(
            Arc::new(ToolExecutor::new(temp.path().to_str().unwrap())),
            &tx,
            &pending,
            Some(cancel_token),
        )
        .await;

        let execution = results.get("inspect-0").unwrap();
        assert!(matches!(
            execution.outcome,
            ToolOutcome::Cancelled {
                phase: super::super::ExecutionPhase::Queued
            }
        ));

        let events: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(events.iter().any(|event| matches!(
            event,
            FromAgent::ToolEnd {
                call_id,
                success: false,
                receipt: Some(receipt),
                ..
            } if call_id == "inspect-0" && receipt.call_id == "inspect-0"
        )));
    }
}
