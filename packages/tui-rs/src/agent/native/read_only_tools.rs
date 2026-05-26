use std::collections::HashMap;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::super::{FromAgent, ToolResult};
use crate::mcp::McpToolAnnotations;
use crate::tools::{BatchConfig, BatchExecutor, BatchToolCall, ToolExecutor};

#[derive(Debug)]
pub(super) struct QueuedReadOnlyToolExecution {
    pub(super) call_id: String,
    pub(super) tool_name: String,
    pub(super) args: serde_json::Value,
    pub(super) safe_args: serde_json::Value,
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
        return annotations.is_some_and(|annotation| {
            annotation.read_only_hint == Some(true) && annotation.destructive_hint != Some(true)
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
    cwd: &str,
    event_tx: &mpsc::UnboundedSender<FromAgent>,
    pending: &[QueuedReadOnlyToolExecution],
    cancel_token: Option<CancellationToken>,
) -> HashMap<String, ToolResult> {
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
        BatchExecutor::with_config(cwd.to_string(), native_read_only_batch_config());
    let results = if let Some(cancel_token) = cancel_token {
        batch_executor
            .execute_with_cancel(calls, Some(event_tx.clone()), cancel_token)
            .await
    } else {
        batch_executor.execute(calls, Some(event_tx.clone())).await
    };

    results
        .into_iter()
        .map(|result| (result.call_id, result.result))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[tokio::test]
    async fn test_rust_client_read_only_wave_live_pre_post_conditions() {
        let temp = tempfile::tempdir().unwrap();
        let composer_dir = temp.path().join(".composer");
        std::fs::create_dir_all(&composer_dir).unwrap();
        std::fs::write(
            composer_dir.join("tools.json"),
            r#"{
                "tools": [{
                    "name": "read_probe",
                    "description": "Delayed read-only probe for native batching tests",
                    "command": "sleep 0.08; cat",
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
                    resolved_args: args,
                    extra_context: None,
                }
            })
            .collect();

        let tool_executor = ToolExecutor::new(temp.path().to_str().unwrap());
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
        let results =
            execute_native_read_only_tool_wave(temp.path().to_str().unwrap(), &tx, &pending, None)
                .await;

        assert_eq!(results.len(), 4);
        assert!(results.values().all(|result| result.success));

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
}
