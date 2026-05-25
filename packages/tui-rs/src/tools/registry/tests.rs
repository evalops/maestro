use super::*;
use std::path::Path;

use crate::tools::details;

struct EnvGuard {
    log_bytes: Option<String>,
    log_segments: Option<String>,
}

impl EnvGuard {
    fn capture() -> Self {
        Self {
            log_bytes: std::env::var("MAESTRO_BACKGROUND_TASK_LOG_BYTES").ok(),
            log_segments: std::env::var("MAESTRO_BACKGROUND_TASK_LOG_SEGMENTS").ok(),
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.log_bytes {
            std::env::set_var("MAESTRO_BACKGROUND_TASK_LOG_BYTES", value);
        } else {
            std::env::remove_var("MAESTRO_BACKGROUND_TASK_LOG_BYTES");
        }
        if let Some(value) = &self.log_segments {
            std::env::set_var("MAESTRO_BACKGROUND_TASK_LOG_SEGMENTS", value);
        } else {
            std::env::remove_var("MAESTRO_BACKGROUND_TASK_LOG_SEGMENTS");
        }
    }
}

fn write_mcp_config(config_dir: &Path, servers: Vec<serde_json::Value>) -> std::io::Result<()> {
    std::fs::write(
        config_dir.join("mcp.json"),
        serde_json::to_string(&serde_json::json!({ "servers": servers }))
            .expect("serialize mcp config"),
    )
}

fn collect_openai_schema_issues(value: &serde_json::Value, path: &str, issues: &mut Vec<String>) {
    let Some(object) = value.as_object() else {
        return;
    };

    if object.get("type").and_then(serde_json::Value::as_str) == Some("array")
        && !object.contains_key("items")
    {
        issues.push(format!("{path}: array schema missing items"));
    }

    for keyword in ["minItems", "maxItems"] {
        if object.contains_key(keyword) {
            issues.push(format!(
                "{path}: unsupported OpenAI schema keyword {keyword}"
            ));
        }
    }

    for (key, child) in object {
        let child_path = format!("{path}.{key}");
        collect_openai_schema_issues(child, &child_path, issues);
        if let Some(values) = child.as_array() {
            for (idx, nested) in values.iter().enumerate() {
                collect_openai_schema_issues(nested, &format!("{child_path}[{idx}]"), issues);
            }
        }
    }
}

#[cfg(not(windows))]
fn failing_counter_server(server_name: &str, counter_path: &Path) -> serde_json::Value {
    serde_json::json!({
        "name": server_name,
        "transport": "stdio",
        "command": "sh",
        "timeout": 50,
        "args": [
            "-c",
            "count=$(cat \"$1\" 2>/dev/null || echo 0); echo $((count + 1)) > \"$1\"; exit 1",
            "sh",
            counter_path.display().to_string()
        ]
    })
}

#[cfg(not(windows))]
fn read_counter(counter_path: &Path) -> usize {
    std::fs::read_to_string(counter_path)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0)
}

#[test]
fn test_registry_has_default_tools() {
    let registry = ToolRegistry::new();

    assert!(registry.get("bash").is_some());
    assert!(registry.get("read").is_some());
    assert!(registry.get("write").is_some());
    assert!(registry.get("glob").is_some());
    assert!(registry.get("grep").is_some());
    assert!(registry.get("edit").is_some());
}

#[test]
fn test_append_mcp_prompt_summary_includes_metadata_and_arguments() {
    let mut lines = Vec::new();
    append_mcp_prompt_summary(
        &mut lines,
        &crate::mcp::McpPrompt {
            name: "summarize".to_string(),
            title: Some("Summarize Docs".to_string()),
            description: Some("Summarize the selected documentation.".to_string()),
            arguments: Some(vec![crate::mcp::McpPromptArgument {
                name: "topic".to_string(),
                description: Some("Topic to summarize".to_string()),
                required: true,
            }]),
        },
        "- ",
        "  ",
    );

    assert_eq!(
        lines,
        vec![
            "- summarize".to_string(),
            "  title: Summarize Docs".to_string(),
            "  description: Summarize the selected documentation.".to_string(),
            "  args: topic (required): Topic to summarize".to_string(),
        ]
    );
}

#[tokio::test]
async fn test_mcp_status_includes_scope_transport_and_error() {
    let temp = tempfile::tempdir().expect("tempdir");
    let config_dir = temp.path().join(".composer");
    std::fs::create_dir_all(&config_dir).expect("create config dir");

    let server_name = "status-parity-test-server";
    write_mcp_config(
        &config_dir,
        vec![serde_json::json!({
            "name": server_name,
            "transport": "stdio",
            "command": "missing-test-command"
        })],
    )
    .expect("write mcp config");

    let executor = ToolExecutor::new(temp.path().display().to_string());

    let statuses = executor.mcp_status().await.expect("mcp status");
    let server = statuses
        .into_iter()
        .find(|status| status.name == server_name)
        .expect("status entry");

    assert_eq!(server.scope, crate::mcp::McpConfigScope::Project);
    assert_eq!(server.transport, crate::mcp::McpTransport::Stdio);
    assert!(server.error.is_some());
    assert!(!server.connected);
}

#[tokio::test]
#[cfg(not(windows))]
async fn test_mcp_status_retries_failed_servers_after_cooldown() {
    let temp = tempfile::tempdir().expect("tempdir");
    let config_dir = temp.path().join(".composer");
    std::fs::create_dir_all(&config_dir).expect("create config dir");

    let server_name = "retry-test-server";
    let counter_path = temp.path().join("retry-count.txt");
    write_mcp_config(
        &config_dir,
        vec![failing_counter_server(server_name, &counter_path)],
    )
    .expect("write mcp config");

    let executor = ToolExecutor::new(temp.path().display().to_string());

    let _ = executor.mcp_status().await.expect("first mcp status");
    assert_eq!(read_counter(&counter_path), 1);

    let _ = executor.mcp_status().await.expect("second mcp status");
    assert_eq!(read_counter(&counter_path), 1);

    if let Ok(mut attempts) = executor.mcp_last_connect_attempts.write() {
        attempts.insert(
            server_name.to_string(),
            Instant::now()
                .checked_sub(MCP_RECONNECT_RETRY_COOLDOWN + Duration::from_secs(1))
                .expect("retry backoff timestamp"),
        );
    }

    let _ = executor.mcp_status().await.expect("third mcp status");
    assert_eq!(read_counter(&counter_path), 2);
}

#[tokio::test]
#[cfg(not(windows))]
async fn test_mcp_status_reloads_changed_server_config() {
    let temp = tempfile::tempdir().expect("tempdir");
    let config_dir = temp.path().join(".composer");
    std::fs::create_dir_all(&config_dir).expect("create config dir");

    let server_name = "reload-test-server";
    let first_counter_path = temp.path().join("reload-count-a.txt");
    let second_counter_path = temp.path().join("reload-count-b.txt");
    write_mcp_config(
        &config_dir,
        vec![failing_counter_server(server_name, &first_counter_path)],
    )
    .expect("write initial mcp config");

    let executor = ToolExecutor::new(temp.path().display().to_string());

    let _ = executor.mcp_status().await.expect("first mcp status");
    assert_eq!(read_counter(&first_counter_path), 1);
    assert_eq!(read_counter(&second_counter_path), 0);

    write_mcp_config(
        &config_dir,
        vec![failing_counter_server(server_name, &second_counter_path)],
    )
    .expect("write updated mcp config");

    let _ = executor.mcp_status().await.expect("second mcp status");
    assert_eq!(read_counter(&first_counter_path), 1);
    assert_eq!(read_counter(&second_counter_path), 1);
}

#[tokio::test]
async fn test_mcp_status_clears_removed_server_state() {
    let temp = tempfile::tempdir().expect("tempdir");
    let config_dir = temp.path().join(".composer");
    std::fs::create_dir_all(&config_dir).expect("create config dir");

    let server_name = "removed-status-server";
    write_mcp_config(
        &config_dir,
        vec![serde_json::json!({
            "name": server_name,
            "transport": "stdio",
            "command": "missing-test-command"
        })],
    )
    .expect("write initial mcp config");

    let executor = ToolExecutor::new(temp.path().display().to_string());

    let _ = executor.mcp_status().await.expect("initial mcp status");
    assert!(executor
        .mcp_last_errors
        .read()
        .expect("mcp errors")
        .contains_key(server_name));

    write_mcp_config(&config_dir, Vec::new()).expect("write empty mcp config");

    let statuses = executor.mcp_status().await.expect("updated mcp status");
    assert!(statuses.is_empty());
    assert!(!executor
        .mcp_last_errors
        .read()
        .expect("mcp errors")
        .contains_key(server_name));
    assert!(!executor
        .mcp_synced_configs
        .read()
        .expect("mcp configs")
        .contains_key(server_name));
}

#[test]
fn test_registry_tool_count() {
    let registry = ToolRegistry::new();
    let count = registry.tools().count();
    assert_eq!(count, 38); // includes parity tools + IDE stubs
}

#[test]
fn test_ask_user_schema_declares_nested_array_items() {
    let registry = ToolRegistry::new();
    let schema = &registry
        .get("ask_user")
        .expect("ask_user tool")
        .tool
        .input_schema;

    let questions = &schema["properties"]["questions"];
    assert_eq!(questions["type"], "array");
    assert!(questions.get("items").is_some());
    assert!(questions.get("minItems").is_none());
    assert!(questions.get("maxItems").is_none());
    assert_eq!(questions["items"]["properties"]["options"]["type"], "array");
    assert!(questions["items"]["properties"]["options"]
        .get("items")
        .is_some());
    assert!(questions["items"]["properties"]
        .get("multi_select")
        .is_none());
    assert!(questions["items"]["properties"]
        .get("multiSelect")
        .is_some());
    assert_eq!(
        questions["items"]["properties"]["options"]["items"]["required"],
        serde_json::json!(["label", "description"])
    );
}

#[test]
fn test_registered_tool_schemas_are_openai_safe() {
    let registry = ToolRegistry::new();
    let mut issues = Vec::new();

    for (name, definition) in registry.named_tools() {
        collect_openai_schema_issues(
            &definition.tool.input_schema,
            &format!("tool.{name}.parameters"),
            &mut issues,
        );
    }

    assert!(issues.is_empty(), "{}", issues.join("\n"));
}

#[test]
fn test_build_glob_pattern_relative() {
    let base = "/tmp/root";
    let pattern = "**/*.rs";
    let expected = Path::new(base).join(pattern).to_string_lossy().to_string();
    assert_eq!(build_glob_pattern(base, pattern), expected);
}

#[test]
#[cfg(not(windows))]
fn test_build_glob_pattern_absolute_unix() {
    let base = "/tmp/root";
    let pattern = "/tmp/root/**/*.rs";
    assert_eq!(build_glob_pattern(base, pattern), pattern);
}

#[test]
#[cfg(windows)]
fn test_build_glob_pattern_absolute_windows() {
    let base = r"C:\root";
    let pattern = r"C:\root\**\*.rs";
    assert_eq!(build_glob_pattern(base, pattern), pattern);
}

#[test]
fn test_registry_requires_approval_read() {
    let registry = ToolRegistry::new();
    let args = serde_json::json!({"file_path": "/etc/passwd"});
    assert!(!registry.requires_approval("read", &args));
}

#[test]
fn test_registry_requires_approval_bash_dynamic() {
    let registry = ToolRegistry::new();
    let safe = serde_json::json!({"command": "ls -la"});
    let unsafe_cmd = serde_json::json!({"command": "cargo build"});

    assert!(!registry.requires_approval("bash", &safe));
    assert!(registry.requires_approval("bash", &unsafe_cmd));
}

#[test]
fn test_registry_missing_required_fields() {
    let registry = ToolRegistry::new();
    // read requires path (file_path is accepted as alias)
    let missing = registry.missing_required("read", &serde_json::json!({}));
    assert_eq!(missing, vec!["path".to_string()]);

    // present field -> no missing
    let ok = registry.missing_required("read", &serde_json::json!({"file_path": "/tmp/file.txt"}));
    assert!(ok.is_empty());
}

#[test]
fn test_registry_requires_approval_write() {
    let registry = ToolRegistry::new();
    let args = serde_json::json!({"file_path": "/tmp/test.txt", "content": "hello"});
    assert!(registry.requires_approval("write", &args));
}

#[test]
fn test_registry_requires_approval_bash_safe() {
    let registry = ToolRegistry::new();
    let args = serde_json::json!({"command": "ls -la"});
    assert!(!registry.requires_approval("bash", &args));
}

#[test]
fn test_registry_requires_approval_bash_unsafe() {
    let registry = ToolRegistry::new();
    let args = serde_json::json!({"command": "rm -rf /tmp/test"});
    assert!(registry.requires_approval("bash", &args));
}

#[test]
fn test_registry_unknown_tool() {
    let registry = ToolRegistry::new();
    assert!(registry.get("unknown").is_none());
    // Unknown tools require approval
    let args = serde_json::json!({});
    assert!(registry.requires_approval("unknown", &args));
}

#[tokio::test]
async fn test_executor_read_file() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("test.txt");
    std::fs::write(&file_path, "line 1\nline 2\nline 3").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({"file_path": file_path.to_str().unwrap()});
    let result = executor.execute("read", &args, None, "test-call").await;

    assert!(result.success);
    assert!(result.output.contains("line 1"));
    assert!(result.output.contains("line 2"));
    assert!(result.output.contains("line 3"));
}

#[tokio::test]
async fn test_executor_read_file_as_base64() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("binary.bin");
    let bytes = [0_u8, 1, 2, 3, 4, 5];
    std::fs::write(&file_path, bytes).unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": file_path.to_str().unwrap(),
        "as_base64": true
    });
    let result = executor.execute("read", &args, None, "test-call").await;

    assert!(result.success);
    let expected = STANDARD.encode(bytes);
    assert_eq!(result.output, expected);
}

#[tokio::test]
async fn test_executor_read_file_binary_requires_base64() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("binary.bin");
    let bytes = [0_u8, 1, 2, 3, 4, 5];
    std::fs::write(&file_path, bytes).unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": file_path.to_str().unwrap()
    });
    let result = executor.execute("read", &args, None, "test-call").await;

    assert!(!result.success);
    assert!(result
        .error
        .unwrap_or_default()
        .to_lowercase()
        .contains("binary file detected"));
}

#[tokio::test]
#[cfg(not(windows))]
async fn test_background_tasks_wait_for_rotation() {
    let _env_guard = EnvGuard::capture();
    // MIN_LOG_BYTES is 50_000, so the limit must be at least that to enable rotation.
    // Write more data than the limit to guarantee rotation triggers.
    std::env::set_var("MAESTRO_BACKGROUND_TASK_LOG_BYTES", "50000");
    std::env::set_var("MAESTRO_BACKGROUND_TASK_LOG_SEGMENTS", "1");

    let dir = tempfile::tempdir().unwrap();
    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let command = "sh -c \"head -c 60000 /dev/zero; sleep 0.2\"";
    let start_args = serde_json::json!({
        "action": "start",
        "command": command,
        "cwd": dir.path().to_str().unwrap(),
        "shell": false
    });
    let start_result = executor
        .execute("background_tasks", &start_args, None, "bg-start")
        .await;
    assert!(
        start_result.success,
        "start failed: {:?}",
        start_result.error
    );
    let task_id = start_result
        .details
        .as_ref()
        .and_then(|details| details.get("id"))
        .and_then(|id| id.as_str())
        .unwrap()
        .to_string();

    let wait_args = serde_json::json!({
        "action": "waitForRotation",
        "taskId": task_id,
        "timeoutMs": 2000
    });
    let wait_result = executor
        .execute("background_tasks", &wait_args, None, "bg-wait")
        .await;
    assert!(wait_result.success, "wait failed: {:?}", wait_result.error);
    let details = wait_result.details.unwrap_or_default();
    assert!(details.get("archivePath").is_some());
}

#[tokio::test]
async fn test_executor_read_file_no_line_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("plain.txt");
    std::fs::write(&file_path, "alpha\nbeta").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": file_path.to_str().unwrap(),
        "line_numbers": false,
        "wrap_in_code_fence": false
    });
    let result = executor.execute("read", &args, None, "test-call").await;

    assert!(result.success);
    assert!(result.output.contains("alpha\nbeta"));
    assert!(!result.output.contains('\t'));
}

#[tokio::test]
async fn test_executor_read_file_relative_path() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("relative.txt");
    std::fs::write(&file_path, "hello from relative").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({"file_path": "relative.txt"});
    let result = executor.execute("read", &args, None, "test-call").await;

    assert!(result.success);
    assert!(result.output.contains("hello from relative"));
}

#[tokio::test]
async fn test_executor_read_file_too_large() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("large.txt");
    let data = vec![b'a'; (MAX_READ_SIZE_BYTES + 1) as usize];
    std::fs::write(&file_path, data).unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({"file_path": file_path.to_str().unwrap()});
    let result = executor.execute("read", &args, None, "test-call").await;

    assert!(!result.success);
    assert!(result
        .error
        .unwrap_or_default()
        .to_lowercase()
        .contains("too large"));
}

#[tokio::test]
async fn test_executor_write_file() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("output.txt");

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": file_path.to_str().unwrap(),
        "content": "test content"
    });
    let result = executor.execute("write", &args, None, "test-call").await;

    assert!(result.success);
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert_eq!(content, "test content");
}

#[tokio::test]
async fn test_executor_write_file_relative_path() {
    let dir = tempfile::tempdir().unwrap();
    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": "nested/output.txt",
        "content": "relative write"
    });
    let result = executor.execute("write", &args, None, "test-call").await;

    assert!(result.success);
    let content = std::fs::read_to_string(dir.path().join("nested/output.txt")).unwrap();
    assert_eq!(content, "relative write");
}

#[tokio::test]
async fn test_executor_unknown_tool() {
    let executor = ToolExecutor::new(".");
    let args = serde_json::json!({});
    let result = executor
        .execute("nonexistent", &args, None, "test-call")
        .await;

    assert!(!result.success);
    assert!(result.error.unwrap().contains("Unknown tool"));
}

#[tokio::test]
async fn test_executor_edit_file() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("edit_test.txt");
    std::fs::write(&file_path, "hello world").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": file_path.to_str().unwrap(),
        "old_string": "world",
        "new_string": "rust"
    });
    let result = executor.execute("edit", &args, None, "test-call").await;

    assert!(result.success);
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert_eq!(content, "hello rust");
}

#[tokio::test]
async fn test_executor_edit_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("edit_test.txt");
    std::fs::write(&file_path, "hello world").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": file_path.to_str().unwrap(),
        "old_string": "nonexistent",
        "new_string": "rust"
    });
    let result = executor.execute("edit", &args, None, "test-call").await;

    assert!(!result.success);
    assert!(result.error.unwrap().contains("not found"));
}

#[tokio::test]
async fn test_executor_edit_non_unique() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("edit_test.txt");
    std::fs::write(&file_path, "foo bar foo").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": file_path.to_str().unwrap(),
        "old_string": "foo",
        "new_string": "baz"
    });
    let result = executor.execute("edit", &args, None, "test-call").await;

    assert!(result.success);
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert_eq!(content, "baz bar foo");
}

#[tokio::test]
async fn test_executor_edit_replace_all() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("edit_test.txt");
    std::fs::write(&file_path, "foo bar foo").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": file_path.to_str().unwrap(),
        "old_string": "foo",
        "new_string": "baz",
        "replace_all": true
    });
    let result = executor.execute("edit", &args, None, "test-call").await;

    assert!(result.success);
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert_eq!(content, "baz bar baz");
}

#[test]
fn test_registry_requires_approval_edit() {
    let registry = ToolRegistry::new();
    let args = serde_json::json!({
        "file_path": "/tmp/test.txt",
        "old_string": "foo",
        "new_string": "bar"
    });
    assert!(registry.requires_approval("edit", &args));
}

#[test]
fn test_shell_escape() {
    assert_eq!(shell_escape(""), "''");
    assert_eq!(shell_escape("simple"), "'simple'");
    assert_eq!(shell_escape("with space"), "'with space'");
    assert_eq!(shell_escape("a'b"), "'a'\\''b'");
}

#[test]
fn test_extract_grep_path_unix() {
    assert_eq!(
        extract_grep_path("src/main.rs:12:fn main()"),
        Some("src/main.rs")
    );
}

#[test]
fn test_extract_grep_path_colon_in_match() {
    assert_eq!(
        extract_grep_path("src/lib.rs:5:let x: i32 = 5;"),
        Some("src/lib.rs")
    );
}

#[test]
fn test_extract_grep_path_windows() {
    assert_eq!(
        extract_grep_path(r"C:\repo\main.rs:12:fn main()"),
        Some(r"C:\repo\main.rs")
    );
}

#[test]
#[cfg(windows)]
fn test_to_shell_path_drive_letter() {
    assert_eq!(to_shell_path(r"C:\repo\file.txt"), "/c/repo/file.txt");
}

#[test]
#[cfg(not(windows))]
fn test_to_shell_path_passthrough() {
    assert_eq!(to_shell_path("src/main.rs"), "src/main.rs");
}

#[test]
#[cfg(not(windows))]
fn test_normalize_git_path_strips_cwd() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("foo.txt");
    std::fs::write(&file_path, "data").unwrap();

    let (display, shell) =
        normalize_git_path(dir.path().to_str().unwrap(), file_path.to_str().unwrap()).unwrap();

    assert_eq!(display, "foo.txt");
    assert_eq!(shell, "foo.txt");
}

// ========== Cache Integration Tests ==========

#[tokio::test]
async fn test_executor_cache_hit() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("cache_test.txt");
    std::fs::write(&file_path, "cached content").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({"file_path": file_path.to_str().unwrap()});

    // First call - cache miss
    let result1 = executor.execute("read", &args, None, "call-1").await;
    assert!(result1.success);
    let stats1 = executor.cache_stats();
    assert_eq!(stats1.misses, 1);
    assert_eq!(stats1.hits, 0);

    // Second call - cache hit
    let result2 = executor.execute("read", &args, None, "call-2").await;
    assert!(result2.success);
    assert_eq!(result1.output, result2.output);
    let stats2 = executor.cache_stats();
    assert_eq!(stats2.misses, 1);
    assert_eq!(stats2.hits, 1);
}

#[tokio::test]
async fn test_executor_cache_invalidation_on_write() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("invalidate_test.txt");
    std::fs::write(&file_path, "original content").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let read_args = serde_json::json!({"file_path": file_path.to_str().unwrap()});

    // Read file - populates cache
    let result1 = executor.execute("read", &read_args, None, "call-1").await;
    assert!(result1.success);
    assert!(result1.output.contains("original content"));

    // Write to file - should invalidate cache
    let write_args = serde_json::json!({
        "file_path": file_path.to_str().unwrap(),
        "content": "new content"
    });
    let write_result = executor.execute("write", &write_args, None, "call-2").await;
    assert!(write_result.success);

    // Read again - should get new content (cache was invalidated)
    let result2 = executor.execute("read", &read_args, None, "call-3").await;
    assert!(result2.success);
    assert!(result2.output.contains("new content"));
}

#[tokio::test]
async fn test_executor_cache_invalidation_on_edit() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("edit_cache_test.txt");
    std::fs::write(&file_path, "hello world").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let read_args = serde_json::json!({"file_path": file_path.to_str().unwrap()});

    // Read file - populates cache
    let result1 = executor.execute("read", &read_args, None, "call-1").await;
    assert!(result1.success);
    assert!(result1.output.contains("hello world"));

    // Edit file - should invalidate cache
    let edit_args = serde_json::json!({
        "file_path": file_path.to_str().unwrap(),
        "old_string": "world",
        "new_string": "rust"
    });
    let edit_result = executor.execute("edit", &edit_args, None, "call-2").await;
    assert!(edit_result.success);

    // Read again - should get updated content (cache was invalidated)
    let result2 = executor.execute("read", &read_args, None, "call-3").await;
    assert!(result2.success);
    assert!(result2.output.contains("hello rust"));
}

#[tokio::test]
async fn test_executor_cache_not_used_for_bash() {
    let dir = tempfile::tempdir().unwrap();
    let executor = ToolExecutor::new(dir.path().to_str().unwrap());

    let args = serde_json::json!({"command": "echo hello"});

    // First call
    executor.execute("bash", &args, None, "call-1").await;

    // Second call - should NOT be cached (bash is excluded)
    executor.execute("bash", &args, None, "call-2").await;

    let stats = executor.cache_stats();
    // Bash calls should not affect cache stats (they're excluded)
    assert_eq!(stats.hits, 0);
    assert_eq!(stats.misses, 0);
}

#[test]
fn test_executor_clear_cache() {
    let executor = ToolExecutor::new("/tmp");

    // Verify cache starts empty
    let stats1 = executor.cache_stats();
    assert_eq!(stats1.entries, 0);

    // Clear cache (no-op when empty, but should not panic)
    executor.clear_cache();

    let stats2 = executor.cache_stats();
    assert_eq!(stats2.entries, 0);
}

#[test]
fn test_executor_with_custom_cache_config() {
    use std::time::Duration;

    let config = CacheConfig {
        max_entries: 10,
        ttl: Duration::from_secs(30),
        enabled: true,
        excluded_tools: vec!["bash".to_string()],
    };

    let executor = ToolExecutor::with_cache_config("/tmp", config);
    let stats = executor.cache_stats();
    assert_eq!(stats.max_entries, 10);
}

// ============================================================
// Tool Details Tests
// ============================================================

#[tokio::test]
async fn test_read_details_populated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.txt");
    std::fs::write(&path, "line1\nline2\nline3\n").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": path.to_str().unwrap()
    });

    let result = executor.execute("read", &args, None, "test-call").await;
    assert!(result.success);
    assert!(result.details.is_some());

    let details: details::ReadDetails = serde_json::from_value(result.details.unwrap()).unwrap();
    assert_eq!(details.path, path.to_str().unwrap());
    assert!(details.size_bytes.is_some());
    assert_eq!(details.lines_read, Some(3));
    assert!(!details.truncated);
    assert!(details.duration_ms.is_some());
}

#[tokio::test]
async fn test_write_details_populated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("new_file.txt");

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": path.to_str().unwrap(),
        "content": "hello world"
    });

    let result = executor.execute("write", &args, None, "test-call").await;
    assert!(result.success);
    assert!(result.details.is_some());

    let details: details::WriteDetails = serde_json::from_value(result.details.unwrap()).unwrap();
    assert_eq!(details.path, path.to_str().unwrap());
    assert_eq!(details.bytes_written, Some(11));
    assert!(details.created); // New file was created
    assert!(details.duration_ms.is_some());
}

#[tokio::test]
async fn test_write_details_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("existing.txt");
    std::fs::write(&path, "old content").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": path.to_str().unwrap(),
        "content": "new content"
    });

    let result = executor.execute("write", &args, None, "test-call").await;
    assert!(result.success);
    assert!(result.details.is_some());

    let details: details::WriteDetails = serde_json::from_value(result.details.unwrap()).unwrap();
    assert!(!details.created); // File already existed
}

#[tokio::test]
async fn test_edit_details_populated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("edit_test.txt");
    std::fs::write(&path, "hello world").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": path.to_str().unwrap(),
        "old_string": "world",
        "new_string": "rust"
    });

    let result = executor.execute("edit", &args, None, "test-call").await;
    assert!(result.success);
    assert!(result.details.is_some());

    let details: details::EditDetails = serde_json::from_value(result.details.unwrap()).unwrap();
    assert_eq!(details.path, path.to_str().unwrap());
    assert_eq!(details.replacements, Some(1));
    assert!(details.duration_ms.is_some());
}

#[tokio::test]
async fn test_edit_details_with_line_changes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("multiline.txt");
    std::fs::write(&path, "single line").unwrap();

    let executor = ToolExecutor::new(dir.path().to_str().unwrap());
    let args = serde_json::json!({
        "file_path": path.to_str().unwrap(),
        "old_string": "single line",
        "new_string": "line one\nline two\nline three"
    });

    let result = executor.execute("edit", &args, None, "test-call").await;
    assert!(result.success);
    assert!(result.details.is_some());

    let details: details::EditDetails = serde_json::from_value(result.details.unwrap()).unwrap();
    assert_eq!(details.lines_added, Some(2)); // Added 2 lines
}
