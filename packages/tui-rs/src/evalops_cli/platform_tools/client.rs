use std::env;
use std::fmt::{self, Write as _};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use crate::init_cli::load_evalops_snapshot;

use super::provision::load_provisioned_credential;
use super::{
    approval_wait_ms, ShellArguments, DEFAULT_APPROVAL_POLL_MS, DEFAULT_HTTP_TIMEOUT_MS, GET_PATH,
    HTTP_TIMEOUT_ENV_VARS, LIST_PATH, PLATFORM_SERVICE_PATH, PLATFORM_TOOL_CAPABILITY,
    PLATFORM_TOOL_NAME, PLATFORM_TOOL_NAMESPACE, RESULT_SCHEMA, RESUME_PATH, RUN_ENV_VARS,
    SERVER_NAME, SESSION_ENV_VARS, TOOL_NAME,
};

const BASE_URL_ENV_VARS: &[&str] = &[
    "TOOL_EXECUTION_SERVICE_URL",
    "MAESTRO_TOOL_EXECUTION_SERVICE_URL",
    "MAESTRO_PLATFORM_BASE_URL",
    "MAESTRO_EVALOPS_BASE_URL",
    "EVALOPS_BASE_URL",
];
const TOKEN_ENV_VARS: &[&str] = &[
    "TOOL_EXECUTION_SERVICE_TOKEN",
    "MAESTRO_TOOL_EXECUTION_SERVICE_TOKEN",
    "MAESTRO_PLATFORM_ACCESS_TOKEN",
];
const ORGANIZATION_ENV_VARS: &[&str] = &[
    "TOOL_EXECUTION_SERVICE_ORGANIZATION_ID",
    "MAESTRO_TOOL_EXECUTION_ORGANIZATION_ID",
    "MAESTRO_PLATFORM_ORGANIZATION_ID",
    "MAESTRO_EVALOPS_ORG_ID",
    "EVALOPS_ORGANIZATION_ID",
    "EVALOPS_ORG_ID",
    "MAESTRO_ENTERPRISE_ORG_ID",
];
const WORKSPACE_ENV_VARS: &[&str] = &[
    "TOOL_EXECUTION_SERVICE_WORKSPACE_ID",
    "MAESTRO_TOOL_EXECUTION_WORKSPACE_ID",
    "MAESTRO_PLATFORM_WORKSPACE_ID",
    "MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
    "MAESTRO_EVALOPS_WORKSPACE_ID",
    "EVALOPS_WORKSPACE_ID",
    "MAESTRO_WORKSPACE_ID",
];
const AGENT_ENV_VARS: &[&str] = &["MAESTRO_PLATFORM_AGENT_ID", "MAESTRO_AGENT_ID"];
const ACTOR_ENV_VARS: &[&str] = &[
    "MAESTRO_PLATFORM_ACTOR_ID",
    "MAESTRO_EVALOPS_USER_ID",
    "EVALOPS_USER_ID",
    "MAESTRO_USER_ID",
];
const CHANNEL_ENV_VARS: &[&str] = &[
    "MAESTRO_PLATFORM_CHANNEL_ID",
    "MAESTRO_CHANNEL_ID",
    "MAESTRO_THREAD_ID",
];
const APPROVAL_POLL_ENV_VARS: &[&str] = &["MAESTRO_TOOL_EXECUTION_APPROVAL_POLL_MS"];
const EXECUTE_PATH: &str = "/ExecuteTool";

#[derive(Clone)]
struct ServiceUrls {
    execute: Url,
    get: Url,
    list: Url,
    resume: Url,
}

#[derive(Clone)]
struct PlatformConfig {
    urls: ServiceUrls,
    token: String,
    organization_id: String,
    workspace_id: String,
    run_id: String,
    agent_id: String,
    actor_id: String,
    channel_id: String,
    sandbox_session_id: String,
    request_timeout: Duration,
    approval_wait: Duration,
    approval_poll: Duration,
}

#[derive(Clone)]
pub(super) struct PlatformClient {
    http: Client,
    config: PlatformConfig,
}

impl PlatformConfig {
    fn resolve() -> Result<Self> {
        let snapshot = load_evalops_snapshot().ok().flatten();
        let agent_mcp = snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.agent_mcp.as_ref());
        let raw_base_url = first_env(BASE_URL_ENV_VARS)
            .or_else(|| {
                agent_mcp
                    .and_then(|metadata| metadata.endpoint.as_deref())
                    .and_then(endpoint_origin)
            })
            .context(
                "missing ToolExecution URL (set TOOL_EXECUTION_SERVICE_URL or MAESTRO_PLATFORM_BASE_URL)",
            )?;
        let token = first_env(TOKEN_ENV_VARS)
            .or_else(|| {
                load_provisioned_credential()
                    .ok()
                    .flatten()
                    .map(|credential| credential.api_key)
            })
            .context(
                "missing least-privilege ToolExecution credential (run `maestro evalops platform-tools configure` or set TOOL_EXECUTION_SERVICE_TOKEN)",
            )?;
        let organization_id = first_env(ORGANIZATION_ENV_VARS)
            .or_else(|| {
                snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.organization_id.clone())
            })
            .context("missing Platform organization id")?;
        let workspace_id = first_env(WORKSPACE_ENV_VARS)
            .or_else(|| agent_mcp.and_then(|metadata| metadata.workspace_id.clone()))
            .unwrap_or_else(|| organization_id.clone());
        let run_id = first_env(RUN_ENV_VARS)
            .or_else(|| agent_mcp.and_then(|metadata| metadata.run_id.clone()))
            .context("missing durable AgentRun id (set MAESTRO_AGENT_RUN_ID)")?;
        let agent_id = first_env(AGENT_ENV_VARS)
            .or_else(|| agent_mcp.and_then(|metadata| metadata.agent_id.clone()))
            .unwrap_or_else(|| "maestro".to_string());
        let actor_id = first_env(ACTOR_ENV_VARS)
            .or_else(|| {
                snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.user_id.clone())
            })
            .unwrap_or_else(|| agent_id.clone());
        let channel_id = first_env(CHANNEL_ENV_VARS).unwrap_or_else(|| run_id.clone());
        let sandbox_session_id = first_env(SESSION_ENV_VARS).unwrap_or_else(|| {
            format!(
                "maestro-platform-sandbox-{}",
                &stable_digest(&[&organization_id, &workspace_id, &run_id])[..32]
            )
        });
        let request_timeout = duration_from_env(
            HTTP_TIMEOUT_ENV_VARS,
            DEFAULT_HTTP_TIMEOUT_MS,
            35_000,
            120_000,
        );
        let approval_wait = Duration::from_millis(approval_wait_ms());
        let approval_poll =
            duration_from_env(APPROVAL_POLL_ENV_VARS, DEFAULT_APPROVAL_POLL_MS, 10, 30_000);
        Ok(Self {
            urls: ServiceUrls::resolve(&raw_base_url)?,
            token,
            organization_id,
            workspace_id,
            run_id,
            agent_id,
            actor_id,
            channel_id,
            sandbox_session_id,
            request_timeout,
            approval_wait,
            approval_poll,
        })
    }
}

impl ServiceUrls {
    fn resolve(raw: &str) -> Result<Self> {
        let mut service = raw.trim().trim_end_matches('/').to_string();
        for operation in [EXECUTE_PATH, GET_PATH, LIST_PATH, RESUME_PATH] {
            let full_suffix = format!("{PLATFORM_SERVICE_PATH}{operation}");
            if service.ends_with(&full_suffix) {
                service.truncate(service.len() - operation.len());
                break;
            }
        }
        if !service.ends_with(PLATFORM_SERVICE_PATH) {
            service.push_str(PLATFORM_SERVICE_PATH);
        }
        validate_service_url(&service)?;
        Ok(Self {
            execute: endpoint_url(&service, EXECUTE_PATH)?,
            get: endpoint_url(&service, GET_PATH)?,
            list: endpoint_url(&service, LIST_PATH)?,
            resume: endpoint_url(&service, RESUME_PATH)?,
        })
    }
}

fn endpoint_url(service: &str, operation: &str) -> Result<Url> {
    Url::parse(&format!("{service}{operation}"))
        .with_context(|| format!("invalid Platform ToolExecution operation URL: {operation}"))
}

fn validate_service_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).context("invalid Platform ToolExecution URL")?;
    if !url.username().is_empty() || url.password().is_some() {
        bail!("Platform ToolExecution URL must not contain credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("Platform ToolExecution URL must not contain query or fragment components");
    }
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        bail!("Platform ToolExecution URL must use HTTPS (loopback HTTP is allowed)");
    }
    Ok(url)
}

impl PlatformClient {
    pub(super) fn from_environment() -> Result<Self> {
        Self::new(PlatformConfig::resolve()?)
    }

    fn new(config: PlatformConfig) -> Result<Self> {
        let http = Client::builder()
            .timeout(config.request_timeout)
            .build()
            .context("create Platform ToolExecution HTTP client")?;
        Ok(Self { http, config })
    }

    pub(super) fn actor_id(&self) -> &str {
        &self.config.actor_id
    }

    pub(super) fn retryable_submission_error(&self, error: &anyhow::Error) -> bool {
        error
            .chain()
            .find_map(|cause| cause.downcast_ref::<PlatformHttpError>())
            .is_none_or(|error| {
                error.status == StatusCode::REQUEST_TIMEOUT
                    || error.status == StatusCode::TOO_MANY_REQUESTS
                    || error.status.is_server_error()
            })
    }

    pub(super) async fn execute_shell(&self, arguments: &ShellArguments) -> Result<(Value, bool)> {
        let request = self.shell_request(arguments);
        let response = self.post(&self.config.urls.execute, &request).await?;
        let execution = response
            .get("execution")
            .cloned()
            .context("ExecuteTool returned no execution")?;
        let replay = response
            .get("idempotentReplay")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok((execution, replay))
    }

    fn shell_request(&self, arguments: &ShellArguments) -> Value {
        let idempotency_key = format!(
            "maestro-shell-{}",
            stable_digest(&[
                &self.config.organization_id,
                &self.config.workspace_id,
                &self.config.run_id,
                &arguments.operation_id,
            ])
        );
        let mut command_arguments = json!({"command": arguments.command});
        if let Some(timeout_ms) = arguments.timeout_ms {
            command_arguments["timeoutMs"] = json!(timeout_ms);
        }
        let mut request = json!({
            "linkage": {
                "workspaceId": self.config.workspace_id,
                "organizationId": self.config.organization_id,
                "agentId": self.config.agent_id,
                "runId": self.config.run_id,
                "stepId": arguments.operation_id,
                "actorId": self.config.actor_id,
                "surfaceType": "SURFACE_MAESTRO",
                "channelId": self.config.channel_id,
                "correlationId": self.config.run_id
            },
            "tool": {
                "namespace": PLATFORM_TOOL_NAMESPACE,
                "name": PLATFORM_TOOL_NAME,
                "capability": PLATFORM_TOOL_CAPABILITY,
                "operation": PLATFORM_TOOL_CAPABILITY,
                "idempotent": false,
                "mutatesResource": true
            },
            "arguments": command_arguments,
            "riskLevel": "RISK_LEVEL_HIGH",
            "retryPolicy": {
                "maxAttempts": 1,
                "allowNonIdempotentRetry": false
            },
            "idempotencyKey": idempotency_key,
            "metadata": {
                "source": "maestro-platform-mcp",
                "tool_call_id": arguments.operation_id,
                "tool_wire_name": format!("mcp__{SERVER_NAME}__{TOOL_NAME}"),
                "execution": "platform-governed",
                "computer_sandbox_session_id": self.config.sandbox_session_id,
                "maestro_agent_run_id": self.config.run_id,
                "maestro_runtime_owner": "platform"
            }
        });
        let traceparent = first_env(&["TRACEPARENT"]);
        let tracestate = first_env(&["TRACESTATE"]);
        if traceparent.is_some() || tracestate.is_some() {
            request["traceContext"] = json!({
                "traceparent": traceparent.unwrap_or_default(),
                "tracestate": tracestate.unwrap_or_default()
            });
        }
        request
    }

    pub(super) async fn get_execution(
        &self,
        execution_id: &str,
        wait_timeout_ms: u32,
    ) -> Result<Value> {
        let response = self
            .post(
                &self.config.urls.get,
                &json!({
                    "id": execution_id,
                    "organizationId": self.config.organization_id,
                    "workspaceId": self.config.workspace_id,
                    "waitTimeoutMs": wait_timeout_ms.min(30_000)
                }),
            )
            .await?;
        response
            .get("execution")
            .cloned()
            .context("GetToolExecution returned no execution")
    }

    pub(super) async fn list_pending(&self) -> Result<Value> {
        self.post(
            &self.config.urls.list,
            &json!({
                "workspaceId": self.config.workspace_id,
                "runId": self.config.run_id,
                "agentId": self.config.agent_id,
                "toolNamespace": PLATFORM_TOOL_NAMESPACE,
                "toolName": PLATFORM_TOOL_NAME,
                "state": "TOOL_EXECUTION_STATE_WAITING_APPROVAL",
                "limit": 50,
                "offset": 0,
                "organizationId": self.config.organization_id
            }),
        )
        .await
    }

    pub(super) async fn resume_execution(
        &self,
        execution_id: &str,
        approval_request_id: &str,
        resume_token: &str,
        approved: bool,
        decided_by: &str,
        reason: &str,
    ) -> Result<Value> {
        let response = self
            .post(
                &self.config.urls.resume,
                &json!({
                    "executionId": execution_id,
                    "approvalRequestId": approval_request_id,
                    "resumeToken": resume_token,
                    "approved": approved,
                    "decidedBy": decided_by,
                    "reason": reason
                }),
            )
            .await?;
        response
            .get("execution")
            .cloned()
            .context("ResumeToolExecution returned no execution")
    }

    pub(super) async fn wait_for_settlement(&self, mut execution: Value) -> Result<Value> {
        let deadline = Instant::now() + self.config.approval_wait;
        loop {
            let state = execution_state(&execution);
            if execution_terminal(state) || Instant::now() >= deadline {
                return Ok(execution);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let execution_id = execution
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .context("ToolExecution has no durable execution id")?
                .to_string();
            if state == "TOOL_EXECUTION_STATE_WAITING_APPROVAL" {
                tokio::time::sleep(self.config.approval_poll.min(remaining)).await;
                execution = self.get_execution(&execution_id, 0).await?;
            } else {
                let wait_ms = remaining.as_millis().min(25_000) as u32;
                execution = self.get_execution(&execution_id, wait_ms).await?;
                if !execution_terminal(execution_state(&execution)) {
                    tokio::time::sleep(
                        Duration::from_millis(100)
                            .min(deadline.saturating_duration_since(Instant::now())),
                    )
                    .await;
                }
            }
        }
    }

    async fn post(&self, url: &Url, body: &Value) -> Result<Value> {
        let response = self
            .http
            .post(url.clone())
            .bearer_auth(&self.config.token)
            .header("connect-protocol-version", "1")
            .header("x-organization-id", &self.config.organization_id)
            .header("x-workspace-id", &self.config.workspace_id)
            .json(body)
            .send()
            .await
            .with_context(|| {
                format!("Platform ToolExecution transport failed for {}", url.path())
            })?;
        let status = response.status();
        let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            let code = value
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            return Err(platform_http_error(status, code));
        }
        Ok(value)
    }
}

#[derive(Debug)]
struct PlatformHttpError {
    status: StatusCode,
    code: String,
}

impl fmt::Display for PlatformHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Platform ToolExecution request failed (status={}, code={})",
            self.status.as_u16(),
            self.code
        )
    }
}

impl std::error::Error for PlatformHttpError {}

fn platform_http_error(status: StatusCode, code: &str) -> anyhow::Error {
    anyhow::Error::new(PlatformHttpError {
        status,
        code: bounded_identifier(code),
    })
}

pub(super) fn safe_execution_summary(
    execution: &Value,
    idempotent_replay: Option<bool>,
    operation_id: Option<&str>,
) -> Value {
    let state = execution_state(execution);
    let mut summary = json!({
        "schema": RESULT_SCHEMA,
        "executionId": execution.get("id").and_then(Value::as_str).unwrap_or_default(),
        "state": state,
        "terminal": execution_terminal(state),
        "retryWithSameOperationId": !execution_terminal(state)
    });
    if let Some(operation_id) = operation_id {
        summary["operationId"] = json!(operation_id);
    }
    if let Some(replay) = idempotent_replay {
        summary["idempotentReplay"] = json!(replay);
    }
    if state == "TOOL_EXECUTION_STATE_WAITING_APPROVAL" {
        summary["approvalRequired"] = json!(true);
        if let Some(request_id) = execution
            .pointer("/approvalWait/approvalRequestId")
            .and_then(Value::as_str)
        {
            summary["approvalRequestId"] = json!(bounded_identifier(request_id));
        }
        summary["nextAction"] = json!(
            "Approve in Platform, or run `maestro evalops platform-tools resume <execution-id> --approve`."
        );
    }
    if state == "TOOL_EXECUTION_STATE_SUCCEEDED" {
        if let Some(safe_output) = execution.pointer("/output/safeOutput") {
            summary["safeOutput"] = safe_output.clone();
        }
    } else if let Some(code) = execution.get("failureCode").and_then(Value::as_str) {
        summary["failureCode"] = json!(bounded_identifier(code));
    }
    summary
}

pub(super) fn execution_state(execution: &Value) -> &str {
    execution
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("TOOL_EXECUTION_STATE_UNSPECIFIED")
}

fn execution_terminal(state: &str) -> bool {
    matches!(
        state,
        "TOOL_EXECUTION_STATE_SUCCEEDED"
            | "TOOL_EXECUTION_STATE_FAILED"
            | "TOOL_EXECUTION_STATE_DENIED"
            | "TOOL_EXECUTION_STATE_CANCELLED"
    )
}

fn bounded_identifier(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
        .take(128)
        .collect()
}

fn first_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn duration_from_env(names: &[&str], default_ms: u64, min_ms: u64, max_ms: u64) -> Duration {
    let milliseconds = first_env(names)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default_ms)
        .clamp(min_ms, max_ms);
    Duration::from_millis(milliseconds)
}

fn endpoint_origin(endpoint: &str) -> Option<String> {
    let url = Url::parse(endpoint).ok()?;
    Some(url.origin().ascii_serialization())
}

fn stable_digest(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(u64::try_from(part.len()).unwrap_or(u64::MAX).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut digest, byte| {
            write!(&mut digest, "{byte:02x}").expect("writing to String cannot fail");
            digest
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> PlatformConfig {
        PlatformConfig {
            urls: ServiceUrls::resolve("http://127.0.0.1:3000").unwrap(),
            token: "test-token".to_string(),
            organization_id: "org-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            run_id: "run-1".to_string(),
            agent_id: "maestro-1".to_string(),
            actor_id: "user-1".to_string(),
            channel_id: "thread-1".to_string(),
            sandbox_session_id: "sandbox-1".to_string(),
            request_timeout: Duration::from_secs(40),
            approval_wait: Duration::from_secs(1),
            approval_poll: Duration::from_millis(1),
        }
    }

    #[test]
    fn shell_request_is_platform_executed_and_replay_safe() {
        let client = PlatformClient::new(test_config()).unwrap();
        let arguments = ShellArguments {
            operation_id: "install-deps-1".to_string(),
            command: "cargo test --workspace --locked".to_string(),
            timeout_ms: Some(120_000),
        };
        let first = client.shell_request(&arguments);
        let second = client.shell_request(&arguments);
        assert_eq!(first["idempotencyKey"], second["idempotencyKey"]);
        assert_eq!(first["tool"]["name"], PLATFORM_TOOL_NAME);
        assert_eq!(first["tool"]["idempotent"], false);
        assert_eq!(first["retryPolicy"]["maxAttempts"], 1);
        assert_eq!(first["retryPolicy"]["allowNonIdempotentRetry"], false);
        assert_eq!(first["linkage"]["surfaceType"], "SURFACE_MAESTRO");
        assert_eq!(first["metadata"]["execution"], "platform-governed");
        assert!(first["metadata"].get("maestro_local_outcome").is_none());
    }

    #[test]
    fn permanent_platform_rejections_are_not_retryable() {
        let client = PlatformClient::new(test_config()).unwrap();
        assert!(!client.retryable_submission_error(&platform_http_error(
            StatusCode::FORBIDDEN,
            "policy_denied",
        )));
        assert!(client.retryable_submission_error(&platform_http_error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
        )));
        assert!(client.retryable_submission_error(&anyhow::anyhow!("transport failure")));
    }

    #[test]
    fn request_timeout_configuration_never_undercuts_long_polling() {
        assert_eq!(
            duration_from_env(&[], 1_000, 35_000, 120_000),
            Duration::from_secs(35)
        );
    }

    #[test]
    fn safe_summary_never_exposes_raw_output_error_text_or_resume_token() {
        let execution = json!({
            "id": "exec-1",
            "state": "TOOL_EXECUTION_STATE_WAITING_APPROVAL",
            "approvalWait": {
                "approvalRequestId": "approval-1",
                "resumeToken": "super-secret-resume-token",
                "reason": "contains command text"
            },
            "output": {
                "safeOutput": {"stdout": "safe"},
                "rawOutput": {"stdout": "secret raw output"}
            },
            "errorMessage": "secret upstream detail",
            "failureCode": "TOOL_EXECUTION_FAILURE_CODE_POLICY_DENIED"
        });
        let summary = safe_execution_summary(&execution, Some(false), Some("op-1"));
        let encoded = summary.to_string();
        assert!(encoded.contains("approval-1"));
        assert!(!encoded.contains("super-secret-resume-token"));
        assert!(!encoded.contains("contains command text"));
        assert!(!encoded.contains("secret raw output"));
        assert!(!encoded.contains("secret upstream detail"));
    }

    #[test]
    fn succeeded_summary_includes_only_platform_safe_output() {
        let execution = json!({
            "id": "exec-2",
            "state": "TOOL_EXECUTION_STATE_SUCCEEDED",
            "output": {
                "safeOutput": {"stdout": "tests passed", "exitCode": 0},
                "rawOutput": {"stdout": "raw secret"}
            }
        });
        let summary = safe_execution_summary(&execution, Some(true), Some("op-2"));
        assert_eq!(summary["safeOutput"]["stdout"], "tests passed");
        assert_eq!(summary["idempotentReplay"], true);
        assert!(!summary.to_string().contains("raw secret"));
    }

    #[test]
    fn service_url_accepts_base_service_and_execute_endpoint_forms() {
        let base = ServiceUrls::resolve("https://platform.example").unwrap();
        let service =
            ServiceUrls::resolve("https://platform.example/toolexecution.v1.ToolExecutionService")
                .unwrap();
        let execute = ServiceUrls::resolve(
            "https://platform.example/toolexecution.v1.ToolExecutionService/ExecuteTool",
        )
        .unwrap();
        assert_eq!(base.execute, service.execute);
        assert_eq!(service.execute, execute.execute);
        assert_eq!(
            base.get.path(),
            format!("{PLATFORM_SERVICE_PATH}{GET_PATH}")
        );
    }

    #[test]
    fn service_url_rejects_credentials_queries_and_non_loopback_http() {
        assert!(ServiceUrls::resolve("http://platform.example").is_err());
        assert!(ServiceUrls::resolve("https://user:secret@platform.example").is_err());
        assert!(ServiceUrls::resolve("https://platform.example?token=secret").is_err());
        assert!(ServiceUrls::resolve("http://127.0.0.1:3000").is_ok());
    }
}
