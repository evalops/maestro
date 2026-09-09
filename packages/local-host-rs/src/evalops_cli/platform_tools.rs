//! Platform-owned ToolExecution bridge exposed as a user-scoped MCP server.
//!
//! `computer_shell` never executes a command inside Maestro. The MCP server
//! submits the call to Platform `ToolExecution`, waits on the durable owner,
//! and returns only Platform's `safeOutput`. A stable caller-supplied
//! `operationId` is required so an ambiguous retry replays the original
//! execution instead of creating a second side effect.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

mod client;
mod config;
mod protocol;
mod provision;

use client::{PlatformClient, execution_state, safe_execution_summary};
use protocol::{
    initialize_result, jsonrpc_error, jsonrpc_result, mcp_tool_result, tool_definition,
    write_jsonrpc,
};

pub(super) const SERVER_NAME: &str = "evalops-platform";
pub(super) const SERVER_DISPLAY_NAME: &str = "EvalOps Platform ToolExecution";
pub(super) const TOOL_NAME: &str = "computer_shell";
pub(super) const PLATFORM_TOOL_NAME: &str = "computer.shell";
pub(super) const PLATFORM_TOOL_NAMESPACE: &str = "computer";
pub(super) const PLATFORM_TOOL_CAPABILITY: &str = "computer-shell";
pub(super) const PLATFORM_SERVICE_PATH: &str = "/toolexecution.v1.ToolExecutionService";
pub(super) const GET_PATH: &str = "/GetToolExecution";
pub(super) const LIST_PATH: &str = "/ListToolExecutions";
pub(super) const RESUME_PATH: &str = "/ResumeToolExecution";
pub(super) const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
pub(super) const RESULT_SCHEMA: &str = "evalops.maestro.platform-tool-execution.v1";
pub(super) const DEFAULT_HTTP_TIMEOUT_MS: u64 = 40_000;
pub(super) const DEFAULT_APPROVAL_WAIT_MS: u64 = 900_000;
pub(super) const MAX_APPROVAL_WAIT_MS: u64 = 3_600_000;
pub(super) const DEFAULT_APPROVAL_POLL_MS: u64 = 2_000;
pub(super) const MAX_COMMAND_BYTES: usize = 32 * 1024;
pub(super) const MAX_OPERATION_ID_BYTES: usize = 128;
const MAX_REASON_BYTES: usize = 1_024;

pub(super) const RUN_ENV_VARS: &[&str] = &[
    "MAESTRO_PLATFORM_AGENT_RUN_ID",
    "MAESTRO_AGENT_RUN_ID",
    "EVALOPS_AGENT_RUN_ID",
];
pub(super) const SESSION_ENV_VARS: &[&str] = &[
    "MAESTRO_PLATFORM_SANDBOX_SESSION_ID",
    "MAESTRO_RUNNER_SESSION_ID",
    "MAESTRO_SESSION_ID",
];
pub(super) const HTTP_TIMEOUT_ENV_VARS: &[&str] = &[
    "TOOL_EXECUTION_SERVICE_TIMEOUT_MS",
    "MAESTRO_TOOL_EXECUTION_SERVICE_TIMEOUT_MS",
];
pub(super) const APPROVAL_WAIT_ENV_VARS: &[&str] = &[
    "TOOL_EXECUTION_APPROVAL_WAIT_MS",
    "MAESTRO_TOOL_EXECUTION_APPROVAL_WAIT_MS",
];

pub(super) fn approval_wait_ms() -> u64 {
    APPROVAL_WAIT_ENV_VARS
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_APPROVAL_WAIT_MS)
        .clamp(1_000, MAX_APPROVAL_WAIT_MS)
}

pub(super) fn mcp_server_timeout_ms() -> u64 {
    approval_wait_ms().saturating_add(60_000)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ShellArguments {
    pub(super) operation_id: String,
    pub(super) command: String,
    #[serde(default)]
    pub(super) timeout_ms: Option<u64>,
}

pub(super) struct SafeResult {
    pub(super) body: Value,
    pub(super) is_error: bool,
}

pub async fn run(args: &[String]) -> Result<i32> {
    match args.first().map(String::as_str) {
        Some("serve") => {
            serve().await?;
            Ok(0)
        }
        Some("configure") => {
            let force_rotate = args.iter().any(|argument| argument == "--rotate-key");
            let credential_path = provision::ensure_provisioned_credential(force_rotate).await?;
            let config_path = config::configure_user_server()?;
            println!("{}", config::configured_message(&config_path));
            if let Some(path) = credential_path {
                println!(
                    "Provisioned a least-privilege Platform tools key in {}.",
                    path.display()
                );
            } else {
                println!("Using the explicitly configured ToolExecution service token.");
            }
            Ok(0)
        }
        Some("unconfigure") => {
            provision::revoke_provisioned_credential().await?;
            let path = config::remove_user_server()?;
            println!("Removed {SERVER_DISPLAY_NAME} from {}.", path.display());
            Ok(0)
        }
        Some("pending") => pending().await,
        Some("get") => get_command(&args[1..]).await,
        Some("resume") => resume_command(&args[1..]).await,
        Some("doctor") => doctor().await,
        Some("help" | "--help" | "-h") | None => {
            println!("{}", help_text());
            Ok(0)
        }
        Some(other) => {
            eprintln!("Unknown platform-tools subcommand: {other}");
            eprintln!("{}", help_text());
            Ok(2)
        }
    }
}

fn help_text() -> &'static str {
    "deixic-code evalops platform-tools\n\
  maestro evalops platform-tools configure [--rotate-key]\n\
      Authorize exact ToolExecution scopes, provision a least-privilege key,\n\
      and install the user-scoped EvalOps Platform MCP server.\n\
  maestro evalops platform-tools serve\n\
      Run the stdio MCP server (normally started by Maestro).\n\
  maestro evalops platform-tools pending\n\
      List this run's Platform approval waits without exposing resume tokens.\n\
  maestro evalops platform-tools get <execution-id>\n\
      Read a safe Platform ToolExecution snapshot.\n\
  maestro evalops platform-tools resume <execution-id> --approve|--deny [--decided-by ID] [--reason TEXT]\n\
      Resolve a Platform approval wait and return the terminal safe result.\n\
  maestro evalops platform-tools doctor\n\
      Validate configuration and Platform reachability.\n\
  maestro evalops platform-tools unconfigure\n\
      Revoke the provisioned key and remove the user-scoped MCP server.\n\n\
The exposed MCP tool is `mcp__evalops-platform__computer_shell`. It never runs\n\
a command locally: Platform owns policy, approval, sandbox execution, and the\n\
durable result. The tool requires a stable `operationId` for replay safety."
}

async fn doctor() -> Result<i32> {
    let client = match PlatformClient::from_environment() {
        Ok(client) => client,
        Err(error) => {
            eprintln!("Platform ToolExecution configuration is incomplete: {error}");
            return Ok(1);
        }
    };
    match client.list_pending().await {
        Ok(value) => {
            let total = value.get("total").and_then(Value::as_i64).unwrap_or(0);
            println!("Platform ToolExecution reachable. Pending approvals for this run: {total}.");
            Ok(0)
        }
        Err(error) => {
            eprintln!("Platform ToolExecution is not reachable: {error}");
            Ok(1)
        }
    }
}

async fn pending() -> Result<i32> {
    let client = PlatformClient::from_environment()?;
    let response = client.list_pending().await?;
    let executions = response
        .get("executions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let safe = executions
        .iter()
        .map(|execution| safe_execution_summary(execution, None, None))
        .collect::<Vec<_>>();
    println!("{}", serde_json::to_string_pretty(&safe)?);
    Ok(0)
}

async fn get_command(args: &[String]) -> Result<i32> {
    let execution_id = required_positional(args, 0, "execution id")?;
    let client = PlatformClient::from_environment()?;
    let execution = client.get_execution(execution_id, 0).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&safe_execution_summary(&execution, None, None))?
    );
    Ok(0)
}

async fn resume_command(args: &[String]) -> Result<i32> {
    let execution_id = required_positional(args, 0, "execution id")?;
    let approve = args.iter().any(|argument| argument == "--approve");
    let deny = args.iter().any(|argument| argument == "--deny");
    if approve == deny {
        bail!("resume requires exactly one of --approve or --deny");
    }
    let decided_by = option_value(args, "--decided-by")?.map(str::to_owned);
    let reason = option_value(args, "--reason")?
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if approve {
                "Approved from Deixic Code Platform tools CLI".to_string()
            } else {
                "Denied from Deixic Code Platform tools CLI".to_string()
            }
        });
    if reason.len() > MAX_REASON_BYTES {
        bail!("--reason must be at most {MAX_REASON_BYTES} bytes");
    }

    let client = PlatformClient::from_environment()?;
    let waiting = client.get_execution(execution_id, 0).await?;
    let approval = waiting
        .get("approvalWait")
        .and_then(Value::as_object)
        .context("execution is not waiting for approval")?;
    let approval_request_id = approval
        .get("approvalRequestId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .context("approval wait has no request id")?
        .to_string();
    let resume_token = approval
        .get("resumeToken")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .context("approval wait has no resume token")?
        .to_string();
    let decided_by = decided_by.unwrap_or_else(|| client.actor_id().to_string());
    let execution = client
        .resume_execution(
            execution_id,
            &approval_request_id,
            &resume_token,
            approve,
            &decided_by,
            &reason,
        )
        .await?;
    let execution = client.wait_for_settlement(execution).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&safe_execution_summary(&execution, None, None))?
    );
    Ok(i32::from(
        execution_state(&execution) != "TOOL_EXECUTION_STATE_SUCCEEDED",
    ))
}

async fn serve() -> Result<()> {
    let client = PlatformClient::from_environment()
        .context("Platform ToolExecution MCP server configuration")?;
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let stdout = Arc::new(Mutex::new(tokio::io::BufWriter::new(tokio::io::stdout())));
    let tool_gate = Arc::new(Mutex::new(()));

    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message = match serde_json::from_str::<Value>(line) {
            Ok(message) => message,
            Err(_) => {
                write_jsonrpc(
                    &mut *stdout.lock().await,
                    &jsonrpc_error(Value::Null, -32700, "Parse error"),
                )
                .await?;
                continue;
            }
        };
        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if method == "tools/call" {
            let client = client.clone();
            let params = message.get("params").cloned();
            let stdout = Arc::clone(&stdout);
            let tool_gate = Arc::clone(&tool_gate);
            tokio::spawn(async move {
                let _tool_guard = tool_gate.lock().await;
                let response = match handle_tool_call(&client, params.as_ref()).await {
                    Ok(result) => jsonrpc_result(id, mcp_tool_result(result)),
                    Err(error) => {
                        eprintln!("Platform ToolExecution MCP call failed: {error}");
                        jsonrpc_result(
                            id,
                            mcp_tool_result(SafeResult {
                                body: json!({
                                    "schema": RESULT_SCHEMA,
                                    "state": "TOOL_EXECUTION_STATE_FAILED",
                                    "failureCode": "platform_tool_execution_invalid_request",
                                    "retryWithSameOperationId": false
                                }),
                                is_error: true,
                            }),
                        )
                    }
                };
                let mut stdout = stdout.lock().await;
                if let Err(error) = write_jsonrpc(&mut *stdout, &response).await {
                    eprintln!("Platform ToolExecution MCP response write failed: {error}");
                }
            });
            continue;
        }
        let response = match method {
            "initialize" => jsonrpc_result(id, initialize_result()),
            "ping" => jsonrpc_result(id, json!({})),
            "tools/list" => jsonrpc_result(id, json!({"tools": [tool_definition()]})),
            "resources/list" => jsonrpc_result(id, json!({"resources": []})),
            "prompts/list" => jsonrpc_result(id, json!({"prompts": []})),
            _ => jsonrpc_error(id, -32601, "Method not found"),
        };
        write_jsonrpc(&mut *stdout.lock().await, &response).await?;
    }
    Ok(())
}

async fn handle_tool_call(client: &PlatformClient, params: Option<&Value>) -> Result<SafeResult> {
    let params = params
        .and_then(Value::as_object)
        .context("tools/call params must be an object")?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if name != TOOL_NAME {
        bail!("unknown Platform tool: {name}");
    }
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let arguments: ShellArguments = serde_json::from_value(arguments)
        .context("computer_shell arguments do not match the schema")?;
    let arguments = normalize_shell_arguments(arguments)?;

    match client.execute_shell(&arguments).await {
        Ok((execution, replay)) => match client.wait_for_settlement(execution.clone()).await {
            Ok(execution) => {
                let summary =
                    safe_execution_summary(&execution, Some(replay), Some(&arguments.operation_id));
                let is_error = execution_state(&execution) != "TOOL_EXECUTION_STATE_SUCCEEDED";
                Ok(SafeResult {
                    body: summary,
                    is_error,
                })
            }
            Err(error) => {
                eprintln!(
                    "Platform ToolExecution settlement status is unknown for operation {}: {error}",
                    arguments.operation_id
                );
                Ok(settlement_indeterminate_result(
                    &execution,
                    replay,
                    &arguments.operation_id,
                ))
            }
        },
        Err(error) => {
            let retryable = client.retryable_submission_error(&error);
            eprintln!(
                "Platform ToolExecution submission failed for operation {}: {error}",
                arguments.operation_id
            );
            Ok(SafeResult {
                body: json!({
                    "schema": RESULT_SCHEMA,
                    "operationId": arguments.operation_id,
                    "state": if retryable { "TOOL_EXECUTION_STATE_UNKNOWN" } else { "TOOL_EXECUTION_STATE_FAILED" },
                    "failureCode": if retryable { "platform_tool_execution_submission_indeterminate" } else { "platform_tool_execution_submission_rejected" },
                    "retryWithSameOperationId": retryable
                }),
                is_error: true,
            })
        }
    }
}

fn normalize_shell_arguments(mut arguments: ShellArguments) -> Result<ShellArguments> {
    validate_shell_arguments(&arguments)?;
    arguments.operation_id = arguments.operation_id.trim().to_string();
    arguments.command = arguments.command.trim().to_string();
    Ok(arguments)
}

fn settlement_indeterminate_result(
    execution: &Value,
    idempotent_replay: bool,
    operation_id: &str,
) -> SafeResult {
    SafeResult {
        body: json!({
            "schema": RESULT_SCHEMA,
            "executionId": execution.get("id").and_then(Value::as_str).unwrap_or_default(),
            "operationId": operation_id,
            "state": "TOOL_EXECUTION_STATE_UNKNOWN",
            "terminal": false,
            "failureCode": "platform_tool_execution_settlement_indeterminate",
            "idempotentReplay": idempotent_replay,
            "retryWithSameOperationId": true
        }),
        is_error: true,
    }
}

fn validate_shell_arguments(arguments: &ShellArguments) -> Result<()> {
    let operation_id = arguments.operation_id.trim();
    if operation_id.is_empty() || operation_id.len() > MAX_OPERATION_ID_BYTES {
        bail!("operationId must be 1..={MAX_OPERATION_ID_BYTES} bytes");
    }
    if !operation_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        bail!("operationId may contain only A-Z, a-z, 0-9, -, _, and .");
    }
    let command = arguments.command.trim();
    if command.is_empty() || command.len() > MAX_COMMAND_BYTES {
        bail!("command must be 1..={MAX_COMMAND_BYTES} bytes");
    }
    if arguments
        .timeout_ms
        .is_some_and(|timeout| timeout == 0 || timeout > 900_000)
    {
        bail!("timeoutMs must be between 1 and 900000");
    }
    Ok(())
}

fn required_positional<'a>(args: &'a [String], index: usize, label: &str) -> Result<&'a str> {
    args.get(index)
        .map(String::as_str)
        .filter(|value| !value.starts_with('-'))
        .with_context(|| format!("missing {label}"))
}

fn option_value<'a>(args: &'a [String], key: &str) -> Result<Option<&'a str>> {
    if let Some(index) = args.iter().position(|argument| argument == key) {
        return args
            .get(index + 1)
            .map(String::as_str)
            .filter(|value| !value.starts_with('-') && !value.is_empty())
            .map(Some)
            .with_context(|| format!("{key} requires a value"));
    }
    if let Some(value) = args
        .iter()
        .find_map(|argument| argument.strip_prefix(&format!("{key}=")))
    {
        if value.is_empty() {
            bail!("{key} requires a value");
        }
        return Ok(Some(value));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_argument_validation_is_fail_closed() {
        assert!(
            validate_shell_arguments(&ShellArguments {
                operation_id: String::new(),
                command: "echo hi".to_string(),
                timeout_ms: None,
            })
            .is_err()
        );
        assert!(
            validate_shell_arguments(&ShellArguments {
                operation_id: "invalid operation".to_string(),
                command: "echo hi".to_string(),
                timeout_ms: None,
            })
            .is_err()
        );
        assert!(
            validate_shell_arguments(&ShellArguments {
                operation_id: "valid-op".to_string(),
                command: "echo hi".to_string(),
                timeout_ms: Some(0),
            })
            .is_err()
        );
    }

    #[test]
    fn help_names_the_exact_native_mcp_tool() {
        let help = help_text();
        assert!(help.contains("mcp__evalops-platform__computer_shell"));
        assert!(help.contains("operationId"));
        assert!(help.contains("never runs"));
        assert!(help.contains("least-privilege"));
    }

    #[test]
    fn option_values_require_a_value() {
        let args = vec!["--decided-by".to_string()];
        assert!(option_value(&args, "--decided-by").is_err());
        let args = vec!["--decided-by=operator-1".to_string()];
        assert_eq!(
            option_value(&args, "--decided-by").unwrap(),
            Some("operator-1")
        );
    }

    #[test]
    fn shell_arguments_are_normalized_before_submission() {
        let arguments = ShellArguments {
            operation_id: "  operation-1  ".to_string(),
            command: "  echo hi  ".to_string(),
            timeout_ms: None,
        };
        let arguments = normalize_shell_arguments(arguments).unwrap();
        assert_eq!(arguments.operation_id, "operation-1");
        assert_eq!(arguments.command, "echo hi");
    }

    #[test]
    fn settlement_failure_preserves_identity_and_requires_same_operation_replay() {
        let execution = json!({
            "id": "execution-1",
            "state": "TOOL_EXECUTION_STATE_RUNNING",
            "output": {"rawOutput": "must not escape"},
            "errorMessage": "must not escape"
        });
        let result = settlement_indeterminate_result(&execution, false, "operation-1");

        assert!(result.is_error);
        assert_eq!(result.body["executionId"], "execution-1");
        assert_eq!(result.body["operationId"], "operation-1");
        assert_eq!(result.body["state"], "TOOL_EXECUTION_STATE_UNKNOWN");
        assert_eq!(result.body["terminal"], false);
        assert_eq!(result.body["retryWithSameOperationId"], true);
        assert_eq!(
            result.body["failureCode"],
            "platform_tool_execution_settlement_indeterminate"
        );
        assert!(!result.body.to_string().contains("must not escape"));
    }
}
