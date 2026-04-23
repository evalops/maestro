//! Single-session hosted runner HTTP surface for Platform-managed runtimes.
//!
//! This module is the Rust-owned counterpart to Maestro's TypeScript hosted
//! runner server. It intentionally exposes the same provider-neutral HTTP
//! contract so Platform and conformance tests can target a Rust runtime without
//! routing through the Node web server.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::headless::messages::{
    ApprovalMode, ClientCapabilities, ClientInfo, ConnectionRole, ConnectionState,
    FromAgentMessage, InitConfig, ServerRequestType, ThinkingLevel, ToAgentMessage,
    UtilityCommandShellMode, UtilityCommandStream, UtilityCommandTerminalMode,
    UtilityFileSearchMatch, UtilityOperation, HEADLESS_PROTOCOL_VERSION,
};
use crate::headless::{AgentState, AgentSupervisor, AsyncTransportError};

pub const HOSTED_RUNNER_IDENTITY_PATH: &str = "/.well-known/evalops/remote-runner/identity";
pub const HOSTED_RUNNER_DRAIN_PATH: &str = "/.well-known/evalops/remote-runner/drain";

pub const HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION: &str = "evalops.remote-runner.identity.v1";
pub const HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION: &str = "evalops.remote-runner.drain.v1";
pub const HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION: &str =
    "evalops.remote-runner.snapshot-manifest.v1";
pub const HOSTED_RUNNER_RETENTION_POLICY_VERSION: &str = "evalops.remote-runner.retention.v1";

const DEFAULT_LISTEN_HOST: &str = "0.0.0.0";
const DEFAULT_LISTEN_PORT: u16 = 8080;
const DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 15_000;
const CONNECTION_IDLE_MS: i64 = (DEFAULT_HEARTBEAT_INTERVAL_MS as i64) * 3;
const MAX_EVENTS: usize = 1024;

#[derive(Debug, Clone)]
pub struct HostedRunnerConfig {
    pub runner_session_id: String,
    pub workspace_root: PathBuf,
    pub bind_addr: SocketAddr,
    pub owner_instance_id: Option<String>,
    pub snapshot_root: Option<PathBuf>,
    pub restore_manifest_path: Option<PathBuf>,
    pub workspace_id: Option<String>,
    pub agent_run_id: Option<String>,
    pub maestro_session_id: Option<String>,
    pub attach_audience: Option<String>,
}

impl HostedRunnerConfig {
    pub fn from_env() -> Result<Self, HostedRunnerConfigError> {
        let env = std::env::vars().collect::<HashMap<_, _>>();
        Self::from_env_map(&env)
    }

    pub fn from_env_map(env: &HashMap<String, String>) -> Result<Self, HostedRunnerConfigError> {
        let runner_session_id = first_env(
            env,
            &["MAESTRO_RUNNER_SESSION_ID", "REMOTE_RUNNER_SESSION_ID"],
        )
        .ok_or_else(|| {
            HostedRunnerConfigError::new("maestro hosted-runner requires MAESTRO_RUNNER_SESSION_ID")
        })?;
        let workspace_root = resolve_config_workspace_root(
            first_env(env, &["MAESTRO_WORKSPACE_ROOT", "WORKSPACE_ROOT"]).as_deref(),
        )?;
        let listen = parse_listen(env_value(env, "MAESTRO_HOSTED_RUNNER_LISTEN").as_deref())?;
        let hosted_runner_port =
            parse_optional_port(env_value(env, "MAESTRO_HOSTED_RUNNER_PORT").as_deref())
                .transpose()?;
        let port_env = parse_optional_port(env_value(env, "PORT").as_deref()).transpose()?;
        let port = listen
            .port
            .or(hosted_runner_port)
            .or(port_env)
            .unwrap_or(DEFAULT_LISTEN_PORT);
        let host = listen
            .host
            .or_else(|| env_value(env, "MAESTRO_HOSTED_RUNNER_HOST"))
            .unwrap_or_else(|| DEFAULT_LISTEN_HOST.to_string());
        let bind_addr = resolve_bind_addr(&host, port)?;
        let snapshot_root = resolve_snapshot_root(
            first_env(
                env,
                &[
                    "MAESTRO_REMOTE_RUNNER_SNAPSHOT_ROOT",
                    "REMOTE_RUNNER_SNAPSHOT_ROOT",
                ],
            )
            .as_deref(),
            &workspace_root,
        );
        let restore_manifest_path = resolve_optional_config_path(
            first_env(
                env,
                &[
                    "MAESTRO_REMOTE_RUNNER_RESTORE_MANIFEST",
                    "REMOTE_RUNNER_RESTORE_MANIFEST",
                ],
            )
            .as_deref(),
            &workspace_root,
        );

        Ok(Self {
            runner_session_id: non_empty(runner_session_id, "runner_session_id")?,
            workspace_root,
            bind_addr,
            owner_instance_id: first_env(
                env,
                &[
                    "MAESTRO_REMOTE_RUNNER_OWNER_INSTANCE_ID",
                    "REMOTE_RUNNER_OWNER_INSTANCE_ID",
                ],
            ),
            snapshot_root: Some(snapshot_root),
            restore_manifest_path,
            workspace_id: first_env(
                env,
                &["MAESTRO_REMOTE_RUNNER_WORKSPACE_ID", "MAESTRO_WORKSPACE_ID"],
            ),
            agent_run_id: env_value(env, "MAESTRO_AGENT_RUN_ID"),
            maestro_session_id: env_value(env, "MAESTRO_SESSION_ID"),
            attach_audience: env_value(env, "MAESTRO_ATTACH_AUDIENCE"),
        })
    }

    pub fn new(
        runner_session_id: impl Into<String>,
        workspace_root: impl AsRef<Path>,
    ) -> Result<Self, HostedRunnerConfigError> {
        Ok(Self {
            runner_session_id: non_empty(runner_session_id.into(), "runner_session_id")?,
            workspace_root: resolve_config_workspace_root(Some(path_to_str(
                workspace_root.as_ref(),
            )?))?,
            bind_addr: format!("{DEFAULT_LISTEN_HOST}:{DEFAULT_LISTEN_PORT}")
                .parse()
                .expect("default hosted runner bind address is valid"),
            owner_instance_id: None,
            snapshot_root: None,
            restore_manifest_path: None,
            workspace_id: None,
            agent_run_id: None,
            maestro_session_id: None,
            attach_audience: None,
        })
    }

    #[must_use]
    pub fn with_bind_addr(mut self, bind_addr: SocketAddr) -> Self {
        self.bind_addr = bind_addr;
        self
    }

    #[must_use]
    pub fn with_owner_instance_id(mut self, owner_instance_id: impl Into<String>) -> Self {
        self.owner_instance_id = Some(owner_instance_id.into());
        self
    }

    #[must_use]
    pub fn with_snapshot_root(mut self, snapshot_root: impl Into<PathBuf>) -> Self {
        self.snapshot_root = Some(snapshot_root.into());
        self
    }

    #[must_use]
    pub fn with_restore_manifest_path(mut self, restore_manifest_path: impl Into<PathBuf>) -> Self {
        self.restore_manifest_path = Some(restore_manifest_path.into());
        self
    }

    #[must_use]
    pub fn with_workspace_id(mut self, workspace_id: impl Into<String>) -> Self {
        self.workspace_id = Some(workspace_id.into());
        self
    }

    #[must_use]
    pub fn with_agent_run_id(mut self, agent_run_id: impl Into<String>) -> Self {
        self.agent_run_id = Some(agent_run_id.into());
        self
    }

    #[must_use]
    pub fn with_maestro_session_id(mut self, maestro_session_id: impl Into<String>) -> Self {
        self.maestro_session_id = Some(maestro_session_id.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedRunnerConfigError {
    message: String,
}

impl HostedRunnerConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for HostedRunnerConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HostedRunnerConfigError {}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedListen {
    host: Option<String>,
    port: Option<u16>,
}

fn first_env(env: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| env_value(env, key))
}

fn env_value(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key).map(|value| value.trim()).and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

fn parse_listen(value: Option<&str>) -> Result<ParsedListen, HostedRunnerConfigError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(ParsedListen {
            host: None,
            port: None,
        });
    };
    if value.chars().all(|char| char.is_ascii_digit()) {
        return Ok(ParsedListen {
            host: None,
            port: Some(parse_port(value, "MAESTRO_HOSTED_RUNNER_LISTEN")?),
        });
    }
    let Some((host, port)) = value.rsplit_once(':') else {
        return Err(HostedRunnerConfigError::new(
            "MAESTRO_HOSTED_RUNNER_LISTEN must be <host:port> or <port>",
        ));
    };
    if host.trim().is_empty() || port.trim().is_empty() {
        return Err(HostedRunnerConfigError::new(
            "MAESTRO_HOSTED_RUNNER_LISTEN must be <host:port> or <port>",
        ));
    }
    Ok(ParsedListen {
        host: Some(host.trim().to_string()),
        port: Some(parse_port(port.trim(), "MAESTRO_HOSTED_RUNNER_LISTEN")?),
    })
}

fn parse_optional_port(value: Option<&str>) -> Option<Result<u16, HostedRunnerConfigError>> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| parse_port(value, "hosted runner port"))
}

fn parse_port(value: &str, label: &str) -> Result<u16, HostedRunnerConfigError> {
    if !value.chars().all(|char| char.is_ascii_digit()) {
        return Err(HostedRunnerConfigError::new(format!(
            "{label} must be a TCP port between 1 and 65535"
        )));
    }
    let port = value.parse::<u32>().map_err(|_| {
        HostedRunnerConfigError::new(format!("{label} must be a TCP port between 1 and 65535"))
    })?;
    if !(1..=65535).contains(&port) {
        return Err(HostedRunnerConfigError::new(format!(
            "{label} must be a TCP port between 1 and 65535"
        )));
    }
    Ok(port as u16)
}

fn resolve_bind_addr(host: &str, port: u16) -> Result<SocketAddr, HostedRunnerConfigError> {
    format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|error| {
            HostedRunnerConfigError::new(format!(
                "hosted runner listen address is invalid: {error}"
            ))
        })?
        .next()
        .ok_or_else(|| HostedRunnerConfigError::new("hosted runner listen address is invalid"))
}

fn resolve_config_workspace_root(path: Option<&str>) -> Result<PathBuf, HostedRunnerConfigError> {
    let path = path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            HostedRunnerConfigError::new("maestro hosted-runner requires MAESTRO_WORKSPACE_ROOT")
        })?;
    let workspace_root = fs::canonicalize(Path::new(path)).map_err(|error| {
        HostedRunnerConfigError::new(format!(
            "hosted runner workspace root is unavailable: {error}"
        ))
    })?;
    let metadata = fs::metadata(&workspace_root).map_err(|error| {
        HostedRunnerConfigError::new(format!(
            "hosted runner workspace root is unavailable: {error}"
        ))
    })?;
    if !metadata.is_dir() {
        return Err(HostedRunnerConfigError::new(
            "hosted runner workspace root is not a directory",
        ));
    }
    Ok(workspace_root)
}

fn resolve_snapshot_root(path: Option<&str>, workspace_root: &Path) -> PathBuf {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
        return workspace_root.join(".maestro").join("runner-snapshots");
    };
    resolve_config_path(path, workspace_root)
}

fn resolve_optional_config_path(path: Option<&str>, workspace_root: &Path) -> Option<PathBuf> {
    path.map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| resolve_config_path(path, workspace_root))
}

fn resolve_config_path(path: &str, workspace_root: &Path) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        workspace_root.join(path)
    }
}

fn path_to_str(path: &Path) -> Result<&str, HostedRunnerConfigError> {
    path.to_str()
        .ok_or_else(|| HostedRunnerConfigError::new("path must be valid UTF-8"))
}

fn non_empty(value: String, field: &str) -> Result<String, HostedRunnerConfigError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(HostedRunnerConfigError::new(format!(
            "{field} must not be empty"
        )));
    }
    Ok(value)
}

#[derive(Debug)]
pub struct HostedRunnerHandle {
    local_addr: SocketAddr,
    shutdown: CancellationToken,
    task: JoinHandle<()>,
}

impl HostedRunnerHandle {
    #[must_use]
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://{}", self.local_addr)
    }

    pub async fn shutdown(self) {
        self.shutdown.cancel();
        let _ = self.task.await;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedRunnerIdentity {
    pub protocol_version: String,
    pub runner_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_instance_id: Option<String>,
    pub ready: bool,
    pub draining: bool,
}

#[derive(Clone)]
struct SharedRunner {
    config: Arc<HostedRunnerConfig>,
    state: Arc<Mutex<RunnerState>>,
    events: broadcast::Sender<StreamEnvelope>,
    message_executor: Arc<dyn HostedRunnerHeadlessMessageExecutor>,
}

struct RunnerState {
    ready: bool,
    draining: bool,
    session_id: String,
    cursor: u64,
    last_init: Option<InitConfig>,
    last_status: Option<String>,
    last_error: Option<String>,
    last_error_type: Option<String>,
    restored_snapshot: Option<RuntimeSnapshot>,
    controller_connection_id: Option<String>,
    connections: HashMap<String, ConnectionRecord>,
    subscriptions: HashMap<String, SubscriptionRecord>,
    active_utility_commands: HashMap<String, ActiveUtilityCommandSnapshot>,
    active_file_watches: HashMap<String, ActiveFileWatchSnapshot>,
    envelopes: VecDeque<StreamEnvelope>,
}

#[derive(Clone)]
struct ConnectionRecord {
    id: String,
    role: ConnectionRole,
    client_protocol_version: Option<String>,
    client_info: Option<ClientInfo>,
    capabilities: Option<ClientCapabilities>,
    opt_out_notifications: Vec<String>,
    subscription_ids: HashSet<String>,
    last_seen_at: DateTime<Utc>,
}

struct ConnectionUpsert {
    connection_id: String,
    role: ConnectionRole,
    client_protocol_version: Option<String>,
    client_info: Option<ClientInfo>,
    capabilities: Option<ClientCapabilities>,
    opt_out_notifications: Vec<String>,
    take_control: bool,
}

#[derive(Clone)]
struct SubscriptionRecord {
    connection_id: String,
    role: ConnectionRole,
    attached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuntimeSnapshot {
    #[serde(rename = "protocolVersion")]
    protocol_version: String,
    session_id: String,
    cursor: u64,
    last_init: Option<RuntimeInitSnapshot>,
    state: RuntimeStateSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuntimeInitSnapshot {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    append_system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_level: Option<ThinkingLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval_mode: Option<ApprovalMode>,
}

impl From<&InitConfig> for RuntimeInitSnapshot {
    fn from(config: &InitConfig) -> Self {
        Self {
            message_type: "init".to_string(),
            system_prompt: config.system_prompt.clone(),
            append_system_prompt: config.append_system_prompt.clone(),
            thinking_level: config.thinking_level,
            approval_mode: config.approval_mode,
        }
    }
}

impl RuntimeInitSnapshot {
    fn to_init_config(&self) -> Option<InitConfig> {
        (self.message_type == "init").then(|| InitConfig {
            system_prompt: self.system_prompt.clone(),
            append_system_prompt: self.append_system_prompt.clone(),
            thinking_level: self.thinking_level,
            approval_mode: self.approval_mode,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuntimeStateSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_info: Option<ClientInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<ClientCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    opt_out_notifications: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_role: Option<ConnectionRole>,
    connection_count: usize,
    subscriber_count: usize,
    controller_subscription_id: Option<String>,
    controller_connection_id: Option<String>,
    connections: Vec<ConnectionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_response: Option<serde_json::Value>,
    pending_approvals: Vec<serde_json::Value>,
    pending_client_tools: Vec<serde_json::Value>,
    pending_mcp_elicitations: Vec<serde_json::Value>,
    pending_user_inputs: Vec<serde_json::Value>,
    pending_tool_retries: Vec<serde_json::Value>,
    tracked_tools: Vec<serde_json::Value>,
    active_tools: Vec<serde_json::Value>,
    active_utility_commands: Vec<ActiveUtilityCommandSnapshot>,
    active_file_watches: Vec<ActiveFileWatchSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_response_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_ttft_ms: Option<u64>,
    is_ready: bool,
    is_responding: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotManifest {
    protocol_version: String,
    runner_session_id: String,
    workspace_id: Option<String>,
    agent_run_id: Option<String>,
    maestro_session_id: String,
    reason: Option<String>,
    requested_by: Option<String>,
    created_at: String,
    workspace_root: PathBuf,
    runtime: RuntimeFlushManifest,
    workspace_export: WorkspaceExportManifest,
    snapshot: RuntimeSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retention_policy: Option<RetentionPolicyManifest>,
}

impl SnapshotManifest {
    fn validate_for_workspace(&self, workspace_root: &Path) -> HostedResult<()> {
        if self.protocol_version != HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION {
            return Err(HostedError::new(
                400,
                "invalid_snapshot_manifest",
                format!(
                    "unsupported snapshot manifest protocol version: {}",
                    self.protocol_version
                ),
            ));
        }
        if self.workspace_export.mode != "local_path_contract" {
            return Err(HostedError::new(
                400,
                "invalid_snapshot_manifest",
                format!(
                    "unsupported workspace export mode: {}",
                    self.workspace_export.mode
                ),
            ));
        }
        for path in &self.workspace_export.paths {
            let _ =
                resolve_workspace_path(workspace_root, None, Some(path.relative_path.as_str()))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RetentionPolicyManifest {
    policy_version: String,
    managed_by: String,
    visibility: RetentionPolicyVisibility,
    redaction: RetentionPolicyRedaction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RetentionPolicyVisibility {
    control_plane_metadata: String,
    workspace_export: String,
    runtime_snapshot: String,
    runtime_logs: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RetentionPolicyRedaction {
    required_before_external_persistence: Vec<String>,
    forbidden_plaintext: Vec<String>,
}

fn default_retention_policy_manifest() -> RetentionPolicyManifest {
    RetentionPolicyManifest {
        policy_version: HOSTED_RUNNER_RETENTION_POLICY_VERSION.to_string(),
        managed_by: "platform".to_string(),
        visibility: RetentionPolicyVisibility {
            control_plane_metadata: "operator".to_string(),
            workspace_export: "tenant".to_string(),
            runtime_snapshot: "internal".to_string(),
            runtime_logs: "operator".to_string(),
        },
        redaction: RetentionPolicyRedaction {
            required_before_external_persistence: vec![
                "runtime_snapshot".to_string(),
                "runtime_logs".to_string(),
            ],
            forbidden_plaintext: vec![
                "provider_credentials".to_string(),
                "tool_secrets".to_string(),
                "attach_tokens".to_string(),
                "artifact_access_tokens".to_string(),
                "raw_environment".to_string(),
            ],
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeFlushStatus {
    Completed,
    #[serde(alias = "interrupted")]
    Failed,
    Skipped,
}

impl RuntimeFlushStatus {
    fn is_completed(self) -> bool {
        matches!(self, Self::Completed)
    }

    fn restore_last_status(self) -> &'static str {
        match self {
            Self::Completed => "Restored from snapshot",
            Self::Failed => "Restore interrupted before runtime flush completed",
            Self::Skipped => "Restore incomplete: runtime flush skipped",
        }
    }

    fn restore_last_error(self, error: Option<&str>) -> Option<String> {
        if self.is_completed() {
            return None;
        }
        error
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| {
                Some(match self {
                    Self::Completed => unreachable!("completed restore has no restore error"),
                    Self::Failed => "runtime flush failed before restore".to_string(),
                    Self::Skipped => {
                        "runtime flush was skipped; no runtime activity was persisted".to_string()
                    }
                })
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuntimeFlushManifest {
    flush_status: RuntimeFlushStatus,
    error: Option<String>,
    session_id: String,
    session_file: Option<PathBuf>,
    protocol_version: Option<String>,
    cursor: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceExportManifest {
    mode: String,
    paths: Vec<WorkspaceExportPathManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceExportPathManifest {
    input: String,
    path: PathBuf,
    relative_path: String,
    #[serde(rename = "type")]
    path_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActiveUtilityCommandSnapshot {
    command_id: String,
    command: String,
    cwd: Option<String>,
    shell_mode: UtilityCommandShellMode,
    terminal_mode: UtilityCommandTerminalMode,
    pid: Option<u32>,
    columns: Option<u32>,
    rows: Option<u32>,
    owner_connection_id: Option<String>,
    output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActiveFileWatchSnapshot {
    watch_id: String,
    root_dir: String,
    include_patterns: Option<Vec<String>>,
    exclude_patterns: Option<Vec<String>>,
    debounce_ms: u32,
    owner_connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StreamEnvelope {
    Snapshot {
        snapshot: RuntimeSnapshot,
    },
    Reset {
        reason: String,
        snapshot: RuntimeSnapshot,
    },
    Message {
        cursor: u64,
        message: Box<FromAgentMessage>,
    },
    Heartbeat {
        cursor: u64,
    },
}

#[derive(Debug, Deserialize)]
struct ConnectionCreateRequest {
    #[serde(rename = "protocolVersion")]
    protocol_version: Option<String>,
    #[serde(rename = "clientInfo")]
    client_info: Option<ClientInfo>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
    #[serde(rename = "thinkingLevel")]
    _thinking_level: Option<ThinkingLevel>,
    capabilities: Option<HttpClientCapabilities>,
    #[serde(rename = "optOutNotifications", default)]
    opt_out_notifications: Vec<String>,
    role: Option<ConnectionRole>,
    #[serde(rename = "takeControl", default)]
    take_control: bool,
}

#[derive(Debug, Deserialize)]
struct SubscribeRequest {
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
    #[serde(rename = "protocolVersion")]
    protocol_version: Option<String>,
    #[serde(rename = "clientInfo")]
    client_info: Option<ClientInfo>,
    capabilities: Option<HttpClientCapabilities>,
    #[serde(rename = "optOutNotifications", default)]
    opt_out_notifications: Vec<String>,
    role: Option<ConnectionRole>,
    #[serde(rename = "takeControl", default)]
    take_control: bool,
}

#[derive(Debug, Deserialize)]
struct HeartbeatRequest {
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
    #[serde(rename = "subscriptionId")]
    subscription_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DisconnectRequest {
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
    #[serde(rename = "subscriptionId")]
    subscription_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DrainRequest {
    reason: Option<String>,
    requested_by: Option<String>,
    export_paths: Option<Vec<String>>,
}

struct UtilityCommandInvocation {
    connection_id: Option<String>,
    command_id: String,
    command: String,
    cwd: Option<String>,
    env: HashMap<String, String>,
    shell_mode: UtilityCommandShellMode,
    terminal_mode: UtilityCommandTerminalMode,
    columns: Option<u32>,
    rows: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
struct HttpClientCapabilities {
    #[serde(rename = "serverRequests")]
    server_requests: Option<Vec<ServerRequestType>>,
    #[serde(rename = "utilityOperations")]
    utility_operations: Option<Vec<UtilityOperation>>,
    #[serde(rename = "rawAgentEvents")]
    raw_agent_events: Option<bool>,
}

impl From<HttpClientCapabilities> for ClientCapabilities {
    fn from(value: HttpClientCapabilities) -> Self {
        Self {
            server_requests: value.server_requests,
            utility_operations: value.utility_operations,
            raw_agent_events: value.raw_agent_events,
        }
    }
}

#[derive(Debug, Clone)]
pub struct HostedRunnerHeadlessMessageContext {
    pub session_id: String,
    pub connection_id: String,
    pub subscription_id: Option<String>,
    pub role: ConnectionRole,
    pub controller_connection_id: Option<String>,
    pub client_protocol_version: Option<String>,
    pub client_info: Option<ClientInfo>,
    pub capabilities: Option<ClientCapabilities>,
    pub opt_out_notifications: Option<Vec<String>>,
    pub lease_expires_at: String,
    pub workspace_root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostedRunnerHeadlessMessageExecution {
    TransportOnly,
    RuntimeHandled,
}

#[derive(Debug, Clone)]
pub struct HostedRunnerHeadlessMessageResult {
    pub execution: HostedRunnerHeadlessMessageExecution,
    pub messages: Vec<FromAgentMessage>,
    pub message: String,
}

impl HostedRunnerHeadlessMessageResult {
    pub fn transport_only(messages: Vec<FromAgentMessage>, message: impl Into<String>) -> Self {
        Self {
            execution: HostedRunnerHeadlessMessageExecution::TransportOnly,
            messages,
            message: message.into(),
        }
    }

    pub fn runtime_handled(messages: Vec<FromAgentMessage>, message: impl Into<String>) -> Self {
        Self {
            execution: HostedRunnerHeadlessMessageExecution::RuntimeHandled,
            messages,
            message: message.into(),
        }
    }
}

pub trait HostedRunnerHeadlessMessageExecutor: Send + Sync {
    fn execute(
        &self,
        context: &HostedRunnerHeadlessMessageContext,
        message: ToAgentMessage,
    ) -> Result<HostedRunnerHeadlessMessageResult, HostedRunnerError>;

    fn drain(&self) -> Result<Vec<FromAgentMessage>, HostedRunnerError> {
        Ok(Vec::new())
    }

    fn state(&self) -> Result<Option<AgentState>, HostedRunnerError> {
        Ok(None)
    }
}

#[derive(Clone)]
pub struct AgentSupervisorHostedRunnerMessageExecutor {
    supervisor: Arc<Mutex<AgentSupervisor>>,
}

impl AgentSupervisorHostedRunnerMessageExecutor {
    #[must_use]
    pub fn new(supervisor: Arc<Mutex<AgentSupervisor>>) -> Self {
        Self { supervisor }
    }

    #[must_use]
    pub fn supervisor(&self) -> Arc<Mutex<AgentSupervisor>> {
        Arc::clone(&self.supervisor)
    }
}

impl std::fmt::Debug for AgentSupervisorHostedRunnerMessageExecutor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentSupervisorHostedRunnerMessageExecutor")
            .finish_non_exhaustive()
    }
}

impl HostedRunnerHeadlessMessageExecutor for AgentSupervisorHostedRunnerMessageExecutor {
    fn execute(
        &self,
        context: &HostedRunnerHeadlessMessageContext,
        message: ToAgentMessage,
    ) -> Result<HostedRunnerHeadlessMessageResult, HostedRunnerError> {
        let include_hosted_hello = matches!(message, ToAgentMessage::Hello { .. });
        let mut supervisor = self
            .supervisor
            .lock()
            .map_err(|_| HostedRunnerError::internal("agent supervisor mutex poisoned"))?;
        let mut messages = supervisor
            .send_and_drain_agent_messages(message)
            .map_err(hosted_runner_error_from_async_transport)?;
        if include_hosted_hello {
            messages.insert(0, hosted_hello_ok_for_context(context));
        }
        Ok(HostedRunnerHeadlessMessageResult::runtime_handled(
            messages,
            "Rust hosted runner forwarded the headless message to AgentSupervisor",
        ))
    }

    fn drain(&self) -> Result<Vec<FromAgentMessage>, HostedRunnerError> {
        let mut supervisor = self
            .supervisor
            .lock()
            .map_err(|_| HostedRunnerError::internal("agent supervisor mutex poisoned"))?;
        Ok(supervisor.drain_available_agent_messages())
    }

    fn state(&self) -> Result<Option<AgentState>, HostedRunnerError> {
        let supervisor = self
            .supervisor
            .lock()
            .map_err(|_| HostedRunnerError::internal("agent supervisor mutex poisoned"))?;
        Ok(Some(supervisor.state().clone()))
    }
}

#[derive(Debug, Default)]
struct TransportOnlyHostedRunnerMessageExecutor;

impl HostedRunnerHeadlessMessageExecutor for TransportOnlyHostedRunnerMessageExecutor {
    fn execute(
        &self,
        _context: &HostedRunnerHeadlessMessageContext,
        _message: ToAgentMessage,
    ) -> Result<HostedRunnerHeadlessMessageResult, HostedRunnerError> {
        Ok(HostedRunnerHeadlessMessageResult::transport_only(
            vec![FromAgentMessage::Status {
                message:
                    "Rust hosted runner accepted the headless message; agent execution is not attached yet"
                        .to_string(),
            }],
            "Rust hosted runner accepted the headless message; agent execution is not attached yet",
        ))
    }
}

fn hosted_hello_ok_for_context(context: &HostedRunnerHeadlessMessageContext) -> FromAgentMessage {
    FromAgentMessage::HelloOk {
        protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
        connection_id: Some(context.connection_id.clone()),
        client_protocol_version: context.client_protocol_version.clone(),
        client_info: context.client_info.clone(),
        capabilities: context.capabilities.clone(),
        opt_out_notifications: context.opt_out_notifications.clone(),
        role: Some(context.role),
        controller_connection_id: context.controller_connection_id.clone(),
        lease_expires_at: Some(context.lease_expires_at.clone()),
    }
}

fn hosted_runner_error_from_async_transport(error: AsyncTransportError) -> HostedRunnerError {
    HostedRunnerError::runtime_not_ready(format!("agent supervisor is not ready: {error}"))
}

fn json_value<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn json_string_value<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug)]
struct HostedError {
    status: u16,
    code: &'static str,
    message: String,
}

type HostedResult<T> = Result<T, HostedError>;

pub async fn start_hosted_runner(config: HostedRunnerConfig) -> io::Result<HostedRunnerHandle> {
    start_hosted_runner_with_message_executor(
        config,
        Arc::new(TransportOnlyHostedRunnerMessageExecutor),
    )
    .await
}

pub async fn start_hosted_runner_with_message_executor(
    config: HostedRunnerConfig,
    message_executor: Arc<dyn HostedRunnerHeadlessMessageExecutor>,
) -> io::Result<HostedRunnerHandle> {
    let workspace_root = tokio::fs::canonicalize(&config.workspace_root).await?;
    if !tokio::fs::metadata(&workspace_root).await?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace root must be a directory",
        ));
    }

    let mut config = config;
    config.workspace_root = workspace_root;
    let restore_manifest = load_restore_manifest(&config).await?;
    let listener = TcpListener::bind(config.bind_addr).await?;
    let local_addr = listener.local_addr()?;
    let shutdown = CancellationToken::new();
    let server_shutdown = shutdown.clone();
    let shared = SharedRunner::new_with_message_executor_and_restore(
        config,
        message_executor,
        restore_manifest,
    );
    let task = tokio::spawn(async move {
        serve(listener, shared, server_shutdown).await;
    });

    Ok(HostedRunnerHandle {
        local_addr,
        shutdown,
        task,
    })
}

impl SharedRunner {
    #[cfg(test)]
    fn new(config: HostedRunnerConfig) -> Self {
        Self::new_with_message_executor_and_restore(
            config,
            Arc::new(TransportOnlyHostedRunnerMessageExecutor),
            None,
        )
    }

    fn new_with_message_executor_and_restore(
        config: HostedRunnerConfig,
        message_executor: Arc<dyn HostedRunnerHeadlessMessageExecutor>,
        restore_manifest: Option<SnapshotManifest>,
    ) -> Self {
        let session_id = config
            .maestro_session_id
            .clone()
            .or_else(|| {
                restore_manifest
                    .as_ref()
                    .map(|manifest| manifest.maestro_session_id.clone())
            })
            .unwrap_or_else(|| config.runner_session_id.clone());
        let (events, _) = broadcast::channel(MAX_EVENTS);
        let restored_snapshot = restore_manifest
            .as_ref()
            .map(|manifest| manifest.snapshot.clone());
        let restored_cursor = restore_manifest
            .as_ref()
            .and_then(|manifest| manifest.runtime.cursor)
            .or_else(|| restored_snapshot.as_ref().map(|snapshot| snapshot.cursor));
        let last_init = restored_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.last_init.as_ref())
            .and_then(RuntimeInitSnapshot::to_init_config);
        let restore_status = restore_manifest
            .as_ref()
            .map(|manifest| manifest.runtime.flush_status);
        let restore_ready = restore_status
            .map(RuntimeFlushStatus::is_completed)
            .unwrap_or(true);
        let restore_last_error = restore_manifest.as_ref().and_then(|manifest| {
            manifest
                .runtime
                .flush_status
                .restore_last_error(manifest.runtime.error.as_deref())
        });
        let restore_last_error_type = restore_last_error.as_ref().map(|_| "protocol".to_string());
        let shared = Self {
            config: Arc::new(config),
            state: Arc::new(Mutex::new(RunnerState {
                ready: restore_ready,
                draining: false,
                session_id,
                cursor: restored_cursor.unwrap_or(0),
                last_init,
                last_status: Some(
                    restore_status
                        .map(RuntimeFlushStatus::restore_last_status)
                        .unwrap_or("Ready")
                        .to_string(),
                ),
                last_error: restore_last_error,
                last_error_type: restore_last_error_type,
                restored_snapshot,
                controller_connection_id: None,
                connections: HashMap::new(),
                subscriptions: HashMap::new(),
                active_utility_commands: HashMap::new(),
                active_file_watches: HashMap::new(),
                envelopes: VecDeque::new(),
            })),
            events,
            message_executor,
        };
        if restore_manifest.is_some() {
            let envelope = shared.reset_envelope("restored_from_snapshot");
            let mut state = shared.state.lock().expect("hosted runner state poisoned");
            state.envelopes.push_back(envelope);
        }
        shared
    }

    fn identity(&self) -> HostedRunnerIdentity {
        let state = self.state.lock().expect("hosted runner state poisoned");
        HostedRunnerIdentity {
            protocol_version: HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION.to_string(),
            runner_session_id: self.config.runner_session_id.clone(),
            owner_instance_id: self.config.owner_instance_id.clone(),
            ready: state.ready,
            draining: state.draining,
        }
    }

    fn ensure_attachable(&self) -> HostedResult<()> {
        let state = self.state.lock().expect("hosted runner state poisoned");
        if !state.ready || state.draining {
            return Err(HostedError::new(
                503,
                "runtime_not_ready",
                "hosted runner is not accepting new attachments",
            ));
        }
        Ok(())
    }

    fn snapshot(&self, state: &RunnerState) -> RuntimeSnapshot {
        let agent_state = self.message_executor.state().ok().flatten();
        let agent_state = agent_state.as_ref();
        let restored_state = state
            .restored_snapshot
            .as_ref()
            .map(|snapshot| &snapshot.state);
        let prefer_restored_host_state = state.restored_snapshot.is_some();
        let host_ready = state.ready && !state.draining;
        let controller_subscription_id = state
            .controller_connection_id
            .as_ref()
            .and_then(|connection_id| state.connections.get(connection_id))
            .and_then(|connection| {
                connection
                    .subscription_ids
                    .iter()
                    .find(|subscription_id| {
                        state
                            .subscriptions
                            .get(*subscription_id)
                            .map(|subscription| subscription.role == ConnectionRole::Controller)
                            .unwrap_or(false)
                    })
                    .cloned()
            });
        let preferred_connection = state
            .controller_connection_id
            .as_ref()
            .and_then(|connection_id| state.connections.get(connection_id))
            .or_else(|| state.connections.values().next());
        let connections = state
            .connections
            .values()
            .map(|connection| {
                let attached_subscription_count = connection
                    .subscription_ids
                    .iter()
                    .filter(|subscription_id| {
                        state
                            .subscriptions
                            .get(*subscription_id)
                            .map(|subscription| subscription.attached)
                            .unwrap_or(false)
                    })
                    .count();
                ConnectionState {
                    connection_id: connection.id.clone(),
                    role: connection.role,
                    client_protocol_version: connection.client_protocol_version.clone(),
                    client_info: connection.client_info.clone(),
                    capabilities: connection.capabilities.clone(),
                    opt_out_notifications: (!connection.opt_out_notifications.is_empty())
                        .then(|| connection.opt_out_notifications.clone()),
                    subscription_count: connection.subscription_ids.len(),
                    attached_subscription_count,
                    controller_lease_granted: state.controller_connection_id.as_deref()
                        == Some(connection.id.as_str()),
                    lease_expires_at: Some(lease_expires_at(connection)),
                }
            })
            .collect();
        let protocol_version = agent_state
            .and_then(|state| state.protocol_version.clone())
            .or_else(|| restored_state.and_then(|state| state.protocol_version.clone()))
            .unwrap_or_else(|| HEADLESS_PROTOCOL_VERSION.to_string());
        let git_branch = agent_state
            .and_then(|state| state.git_branch.clone())
            .or_else(|| restored_state.and_then(|state| state.git_branch.clone()))
            .or_else(|| crate::git::current_branch(&self.config.workspace_root));

        RuntimeSnapshot {
            protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
            session_id: state.session_id.clone(),
            cursor: state.cursor,
            last_init: state.last_init.as_ref().map(RuntimeInitSnapshot::from),
            state: RuntimeStateSnapshot {
                protocol_version: Some(protocol_version),
                client_protocol_version: preferred_connection
                    .and_then(|connection| connection.client_protocol_version.clone())
                    .or_else(|| agent_state.and_then(|state| state.client_protocol_version.clone()))
                    .or_else(|| {
                        restored_state.and_then(|state| state.client_protocol_version.clone())
                    }),
                client_info: preferred_connection
                    .and_then(|connection| connection.client_info.clone())
                    .or_else(|| agent_state.and_then(|state| state.client_info.clone()))
                    .or_else(|| restored_state.and_then(|state| state.client_info.clone())),
                capabilities: preferred_connection
                    .and_then(|connection| connection.capabilities.clone())
                    .or_else(|| agent_state.and_then(|state| state.capabilities.clone()))
                    .or_else(|| restored_state.and_then(|state| state.capabilities.clone())),
                opt_out_notifications: preferred_connection
                    .and_then(|connection| {
                        (!connection.opt_out_notifications.is_empty())
                            .then(|| connection.opt_out_notifications.clone())
                    })
                    .or_else(|| agent_state.and_then(|state| state.opt_out_notifications.clone()))
                    .or_else(|| {
                        restored_state.and_then(|state| state.opt_out_notifications.clone())
                    }),
                connection_role: preferred_connection
                    .map(|connection| connection.role)
                    .or_else(|| agent_state.and_then(|state| state.connection_role))
                    .or_else(|| restored_state.and_then(|state| state.connection_role)),
                connection_count: state.connections.len(),
                subscriber_count: state.subscriptions.len(),
                controller_subscription_id,
                controller_connection_id: state.controller_connection_id.clone(),
                connections,
                model: agent_state
                    .and_then(|state| state.model.clone())
                    .or_else(|| restored_state.and_then(|state| state.model.clone()))
                    .or_else(|| Some("rust-hosted-runner".to_string())),
                provider: agent_state
                    .and_then(|state| state.provider.clone())
                    .or_else(|| restored_state.and_then(|state| state.provider.clone()))
                    .or_else(|| Some("rust".to_string())),
                session_id: if prefer_restored_host_state {
                    Some(state.session_id.clone())
                } else {
                    agent_state
                        .and_then(|state| state.session_id.clone())
                        .or_else(|| restored_state.and_then(|state| state.session_id.clone()))
                        .or_else(|| Some(state.session_id.clone()))
                },
                cwd: agent_state
                    .and_then(|state| state.cwd.clone())
                    .or_else(|| restored_state.and_then(|state| state.cwd.clone()))
                    .or_else(|| Some(self.config.workspace_root.to_string_lossy().to_string())),
                git_branch,
                current_response: agent_state
                    .and_then(|state| state.current_response.as_ref())
                    .map(json_value)
                    .or_else(|| restored_state.and_then(|state| state.current_response.clone())),
                pending_approvals: agent_state
                    .map(|state| state.pending_approvals.iter().map(json_value).collect())
                    .or_else(|| restored_state.map(|state| state.pending_approvals.clone()))
                    .unwrap_or_default(),
                pending_client_tools: agent_state
                    .map(|state| state.pending_client_tools.iter().map(json_value).collect())
                    .or_else(|| restored_state.map(|state| state.pending_client_tools.clone()))
                    .unwrap_or_default(),
                pending_mcp_elicitations: restored_state
                    .map(|state| state.pending_mcp_elicitations.clone())
                    .unwrap_or_default(),
                pending_user_inputs: agent_state
                    .map(|state| state.pending_user_inputs.iter().map(json_value).collect())
                    .or_else(|| restored_state.map(|state| state.pending_user_inputs.clone()))
                    .unwrap_or_default(),
                pending_tool_retries: agent_state
                    .map(|state| state.pending_tool_retries.iter().map(json_value).collect())
                    .or_else(|| restored_state.map(|state| state.pending_tool_retries.clone()))
                    .unwrap_or_default(),
                tracked_tools: agent_state
                    .map(|state| state.tracked_tools.values().map(json_value).collect())
                    .or_else(|| restored_state.map(|state| state.tracked_tools.clone()))
                    .unwrap_or_default(),
                active_tools: agent_state
                    .map(|state| {
                        state
                            .active_tools
                            .values()
                            .map(|tool| {
                                json!({
                                    "call_id": tool.call_id,
                                    "tool": tool.tool,
                                    "output": tool.output,
                                })
                            })
                            .collect()
                    })
                    .or_else(|| restored_state.map(|state| state.active_tools.clone()))
                    .unwrap_or_default(),
                active_utility_commands: state.active_utility_commands.values().cloned().collect(),
                active_file_watches: state.active_file_watches.values().cloned().collect(),
                last_error: if host_ready {
                    agent_state
                        .and_then(|state| state.last_error.clone())
                        .or_else(|| state.last_error.clone())
                        .or_else(|| restored_state.and_then(|state| state.last_error.clone()))
                } else {
                    state
                        .last_error
                        .clone()
                        .or_else(|| agent_state.and_then(|state| state.last_error.clone()))
                        .or_else(|| restored_state.and_then(|state| state.last_error.clone()))
                },
                last_error_type: if host_ready {
                    agent_state
                        .and_then(|state| state.last_error_type)
                        .map(|error_type| json_string_value(&error_type))
                        .or_else(|| state.last_error_type.clone())
                        .or_else(|| restored_state.and_then(|state| state.last_error_type.clone()))
                } else {
                    state
                        .last_error_type
                        .clone()
                        .or_else(|| {
                            agent_state
                                .and_then(|state| state.last_error_type)
                                .map(|error_type| json_string_value(&error_type))
                        })
                        .or_else(|| restored_state.and_then(|state| state.last_error_type.clone()))
                },
                last_status: if host_ready && prefer_restored_host_state {
                    state
                        .last_status
                        .clone()
                        .or_else(|| agent_state.and_then(|state| state.last_status.clone()))
                        .or_else(|| restored_state.and_then(|state| state.last_status.clone()))
                } else if host_ready {
                    agent_state
                        .and_then(|state| state.last_status.clone())
                        .or_else(|| state.last_status.clone())
                        .or_else(|| restored_state.and_then(|state| state.last_status.clone()))
                } else {
                    state
                        .last_status
                        .clone()
                        .or_else(|| agent_state.and_then(|state| state.last_status.clone()))
                        .or_else(|| restored_state.and_then(|state| state.last_status.clone()))
                },
                last_response_duration_ms: agent_state
                    .and_then(|state| state.last_response_duration_ms)
                    .or_else(|| restored_state.and_then(|state| state.last_response_duration_ms)),
                last_ttft_ms: agent_state
                    .and_then(|state| state.last_ttft_ms)
                    .or_else(|| restored_state.and_then(|state| state.last_ttft_ms)),
                is_ready: host_ready
                    && agent_state
                        .map(|state| state.is_ready)
                        .or_else(|| restored_state.map(|state| state.is_ready))
                        .unwrap_or(true),
                is_responding: agent_state
                    .map(|state| state.is_responding)
                    .or_else(|| restored_state.map(|state| state.is_responding))
                    .unwrap_or(false),
            },
        }
    }

    fn publish_message(&self, state: &mut RunnerState, message: FromAgentMessage) {
        state.cursor += 1;
        let envelope = StreamEnvelope::Message {
            cursor: state.cursor,
            message: Box::new(message),
        };
        state.envelopes.push_back(envelope.clone());
        while state.envelopes.len() > MAX_EVENTS {
            state.envelopes.pop_front();
        }
        let _ = self.events.send(envelope);
    }

    fn publish_snapshot(&self, state: &mut RunnerState) {
        let envelope = StreamEnvelope::Snapshot {
            snapshot: self.snapshot(state),
        };
        state.envelopes.push_back(envelope.clone());
        while state.envelopes.len() > MAX_EVENTS {
            state.envelopes.pop_front();
        }
        let _ = self.events.send(envelope);
    }

    fn reset_envelope(&self, reason: impl Into<String>) -> StreamEnvelope {
        let state = self.state.lock().expect("hosted runner state poisoned");
        StreamEnvelope::Reset {
            reason: reason.into(),
            snapshot: self.snapshot(&state),
        }
    }

    fn subscribe_from(
        &self,
        cursor: u64,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        let state = self.state.lock().expect("hosted runner state poisoned");
        let rx = self.events.subscribe();
        (self.replay_from_state(&state, cursor), rx)
    }

    fn replay_from_state(&self, state: &RunnerState, cursor: u64) -> Vec<StreamEnvelope> {
        let first_cursor = state.envelopes.iter().find_map(|envelope| match envelope {
            StreamEnvelope::Message { cursor, .. } | StreamEnvelope::Heartbeat { cursor } => {
                Some(*cursor)
            }
            StreamEnvelope::Snapshot { .. } | StreamEnvelope::Reset { .. } => None,
        });
        if let Some(first_cursor) = first_cursor {
            if cursor > 0 && cursor < first_cursor.saturating_sub(1) {
                return vec![StreamEnvelope::Reset {
                    reason: "replay_gap".to_string(),
                    snapshot: self.snapshot(state),
                }];
            }
        }
        state
            .envelopes
            .iter()
            .filter(|envelope| match envelope {
                StreamEnvelope::Message {
                    cursor: event_cursor,
                    ..
                }
                | StreamEnvelope::Heartbeat {
                    cursor: event_cursor,
                } => *event_cursor > cursor,
                StreamEnvelope::Snapshot { .. } | StreamEnvelope::Reset { .. } => true,
            })
            .cloned()
            .collect()
    }
}

impl HostedError {
    fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl From<HostedRunnerError> for HostedError {
    fn from(error: HostedRunnerError) -> Self {
        Self::new(error.http_status(), error.code.as_str(), error.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedRunnerErrorCode {
    InvalidConfig,
    BadRequest,
    NotFound,
    RuntimeNotReady,
    LeaseConflict,
    WorkspaceViolation,
    UnsupportedCapability,
    Internal,
}

impl HostedRunnerErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidConfig => "invalid_config",
            Self::BadRequest => "bad_request",
            Self::NotFound => "not_found",
            Self::RuntimeNotReady => "runtime_not_ready",
            Self::LeaseConflict => "controller_lease_held",
            Self::WorkspaceViolation => "workspace_violation",
            Self::UnsupportedCapability => "unsupported_capability",
            Self::Internal => "internal_error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedRunnerError {
    pub code: HostedRunnerErrorCode,
    pub message: String,
}

impl HostedRunnerError {
    fn new(code: HostedRunnerErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_config(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::InvalidConfig, message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::BadRequest, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::NotFound, message)
    }

    pub fn runtime_not_ready(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::RuntimeNotReady, message)
    }

    pub fn lease_conflict(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::LeaseConflict, message)
    }

    pub fn workspace_violation(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::WorkspaceViolation, message)
    }

    pub fn unsupported_capability(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::UnsupportedCapability, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::Internal, message)
    }

    pub fn http_status(&self) -> u16 {
        match self.code {
            HostedRunnerErrorCode::InvalidConfig | HostedRunnerErrorCode::BadRequest => 400,
            HostedRunnerErrorCode::WorkspaceViolation => 403,
            HostedRunnerErrorCode::NotFound => 404,
            HostedRunnerErrorCode::RuntimeNotReady => 503,
            HostedRunnerErrorCode::LeaseConflict => 409,
            HostedRunnerErrorCode::UnsupportedCapability => 501,
            HostedRunnerErrorCode::Internal => 500,
        }
    }
}

impl std::fmt::Display for HostedRunnerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for HostedRunnerError {}

async fn serve(listener: TcpListener, shared: SharedRunner, shutdown: CancellationToken) {
    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            accepted = listener.accept() => {
                let Ok((socket, _addr)) = accepted else {
                    continue;
                };
                let shared = shared.clone();
                tokio::spawn(async move {
                    let _ = handle_socket(socket, shared).await;
                });
            }
        }
    }
}

async fn handle_socket(mut socket: TcpStream, shared: SharedRunner) -> io::Result<()> {
    let Some(request) = read_request(&mut socket).await? else {
        return Ok(());
    };

    let response = route_request(request, shared).await;
    match response {
        Ok(ResponseBody::Json { status, body }) => {
            write_json_value(&mut socket, status, body).await
        }
        Ok(ResponseBody::Sse {
            replay,
            mut rx,
            shared,
        }) => {
            write_sse_headers(&mut socket).await?;
            for envelope in replay {
                write_sse_event(&mut socket, &envelope).await?;
            }
            loop {
                match rx.recv().await {
                    Ok(envelope) => write_sse_event(&mut socket, &envelope).await?,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        let envelope = shared.reset_envelope(format!("broadcast_lag:{skipped}"));
                        write_sse_event(&mut socket, &envelope).await?;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            Ok(())
        }
        Err(error) => write_error(&mut socket, error).await,
    }
}

enum ResponseBody {
    Json {
        status: u16,
        body: serde_json::Value,
    },
    Sse {
        replay: Vec<StreamEnvelope>,
        rx: broadcast::Receiver<StreamEnvelope>,
        shared: SharedRunner,
    },
}

async fn route_request(request: HttpRequest, shared: SharedRunner) -> HostedResult<ResponseBody> {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", HOSTED_RUNNER_IDENTITY_PATH) => json_response(200, shared.identity()),
        ("GET", "/readyz" | "/healthz") => {
            let identity = shared.identity();
            if identity.ready && !identity.draining {
                json_response(200, json!({"ok": true}))
            } else {
                Err(HostedError::new(
                    503,
                    "runtime_not_ready",
                    "hosted runner is draining or not ready",
                ))
            }
        }
        ("POST", HOSTED_RUNNER_DRAIN_PATH) => {
            let input = parse_json::<DrainRequest>(&request.body)?;
            handle_drain(shared, input).await
        }
        ("POST", "/api/headless/connections") => {
            shared.ensure_attachable()?;
            let input = parse_json::<ConnectionCreateRequest>(&request.body)?;
            handle_connection_create(shared, input)
        }
        ("GET", path)
            if path.starts_with("/api/headless/sessions/") && path.ends_with("/state") =>
        {
            let session_id = session_id_from_path(path, "/state")?;
            handle_state(shared, session_id)
        }
        ("POST", path)
            if path.starts_with("/api/headless/sessions/") && path.ends_with("/subscribe") =>
        {
            shared.ensure_attachable()?;
            let session_id = session_id_from_path(path, "/subscribe")?;
            let input = parse_json::<SubscribeRequest>(&request.body)?;
            handle_subscribe(shared, session_id, input)
        }
        ("GET", path)
            if path.starts_with("/api/headless/sessions/") && path.ends_with("/events") =>
        {
            let session_id = session_id_from_path(path, "/events")?;
            handle_events(shared, session_id, request.query)
        }
        ("POST", path)
            if path.starts_with("/api/headless/sessions/")
                && (path.ends_with("/messages") || path.ends_with("/message")) =>
        {
            let session_id = if path.ends_with("/messages") {
                session_id_from_path(path, "/messages")?
            } else {
                session_id_from_path(path, "/message")?
            };
            let message = parse_json::<ToAgentMessage>(&request.body)?;
            handle_message(shared, session_id, request.headers, message).await
        }
        ("POST", path)
            if path.starts_with("/api/headless/sessions/") && path.ends_with("/heartbeat") =>
        {
            let session_id = session_id_from_path(path, "/heartbeat")?;
            let input = parse_json::<HeartbeatRequest>(&request.body)?;
            handle_heartbeat(shared, session_id, input)
        }
        ("POST", path)
            if path.starts_with("/api/headless/sessions/") && path.ends_with("/disconnect") =>
        {
            let session_id = session_id_from_path(path, "/disconnect")?;
            let input = parse_json::<DisconnectRequest>(&request.body)?;
            handle_disconnect(shared, session_id, input)
        }
        _ => Err(HostedError::new(404, "not_found", "route not found")),
    }
}

async fn handle_drain(shared: SharedRunner, input: DrainRequest) -> HostedResult<ResponseBody> {
    let export_paths = input
        .export_paths
        .clone()
        .unwrap_or_else(|| vec![".".to_string()]);
    for export_path in &export_paths {
        let _ = resolve_workspace_path(
            &shared.config.workspace_root,
            None,
            Some(export_path.as_str()),
        )?;
    }

    let drained_messages = shared.message_executor.drain().map_err(HostedError::from)?;
    {
        let mut state = shared.state.lock().expect("hosted runner state poisoned");
        if state.cursor > 0 || !state.connections.is_empty() || !drained_messages.is_empty() {
            let reason = input
                .reason
                .as_deref()
                .unwrap_or("platform_requested_drain");
            shared.publish_message(
                &mut state,
                FromAgentMessage::Status {
                    message: format!("Hosted runner is draining: {reason}"),
                },
            );
        }
        for message in drained_messages {
            shared.publish_message(&mut state, message);
        }
    }

    let (manifest_path, manifest) = write_snapshot_manifest(&shared, &input).await?;
    {
        let mut state = shared.state.lock().expect("hosted runner state poisoned");
        state.draining = true;
        state.ready = false;
        state.last_status = Some("Drained".to_string());
        shared.publish_snapshot(&mut state);
    }
    json_response(
        200,
        json!({
            "protocol_version": HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION,
            "status": "drained",
            "runner_session_id": shared.config.runner_session_id,
            "requested_by": input.requested_by,
            "reason": input.reason,
            "manifest_path": manifest_path.to_string_lossy(),
            "manifest": manifest,
        }),
    )
}

fn handle_connection_create(
    shared: SharedRunner,
    input: ConnectionCreateRequest,
) -> HostedResult<ResponseBody> {
    let mut state = shared.state.lock().expect("hosted runner state poisoned");
    ensure_session_id(&state, input.session_id.as_deref())?;
    let connection_id = input
        .connection_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("conn_{}", Uuid::new_v4().simple()));
    let role = input.role.unwrap_or(ConnectionRole::Controller);
    upsert_connection(
        &mut state,
        ConnectionUpsert {
            connection_id: connection_id.clone(),
            role,
            client_protocol_version: input.protocol_version,
            client_info: input.client_info,
            capabilities: input.capabilities.map(Into::into),
            opt_out_notifications: input.opt_out_notifications,
            take_control: input.take_control,
        },
    )?;
    let snapshot = shared.snapshot(&state);
    let controller_lease_granted = role == ConnectionRole::Controller
        && state.controller_connection_id.as_deref() == Some(&connection_id);
    let lease_expires_at = state.connections.get(&connection_id).map(lease_expires_at);
    json_response(
        200,
        json!({
            "session_id": state.session_id,
            "connection_id": connection_id,
            "role": role,
            "controller_lease_granted": controller_lease_granted,
            "controller_connection_id": state.controller_connection_id,
            "lease_expires_at": lease_expires_at,
            "heartbeat_interval_ms": DEFAULT_HEARTBEAT_INTERVAL_MS,
            "snapshot": snapshot,
        }),
    )
}

fn handle_subscribe(
    shared: SharedRunner,
    session_id: &str,
    input: SubscribeRequest,
) -> HostedResult<ResponseBody> {
    let mut state = shared.state.lock().expect("hosted runner state poisoned");
    ensure_session_id(&state, Some(session_id))?;
    let role = input.role.unwrap_or(ConnectionRole::Controller);
    let connection_id = input
        .connection_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("conn_{}", Uuid::new_v4().simple()));
    upsert_connection(
        &mut state,
        ConnectionUpsert {
            connection_id: connection_id.clone(),
            role,
            client_protocol_version: input.protocol_version,
            client_info: input.client_info,
            capabilities: input.capabilities.map(Into::into),
            opt_out_notifications: input.opt_out_notifications,
            take_control: input.take_control,
        },
    )?;
    let subscription_id = format!("sub_{}", Uuid::new_v4().simple());
    state.subscriptions.insert(
        subscription_id.clone(),
        SubscriptionRecord {
            connection_id: connection_id.clone(),
            role,
            attached: true,
        },
    );
    if let Some(connection) = state.connections.get_mut(&connection_id) {
        connection.subscription_ids.insert(subscription_id.clone());
    }
    if role == ConnectionRole::Controller {
        state.controller_connection_id = Some(connection_id.clone());
    }
    state.last_status = Some("Attached".to_string());
    let connection_count = state.connections.len();
    let controller_connection_id = state.controller_connection_id.clone();
    let lease_expires_at = state.connections.get(&connection_id).map(lease_expires_at);
    shared.publish_message(
        &mut state,
        FromAgentMessage::ConnectionInfo {
            connection_id: Some(connection_id.clone()),
            client_protocol_version: None,
            client_info: None,
            capabilities: None,
            opt_out_notifications: None,
            role: Some(role),
            connection_count: Some(connection_count),
            controller_connection_id,
            lease_expires_at: lease_expires_at.clone(),
            connections: None,
        },
    );
    let snapshot = shared.snapshot(&state);
    json_response(
        200,
        json!({
            "connection_id": connection_id,
            "subscription_id": subscription_id,
            "role": role,
            "controller_lease_granted": role == ConnectionRole::Controller,
            "controller_subscription_id": snapshot.state.controller_subscription_id,
            "controller_connection_id": snapshot.state.controller_connection_id,
            "lease_expires_at": lease_expires_at,
            "heartbeat_interval_ms": DEFAULT_HEARTBEAT_INTERVAL_MS,
            "snapshot": snapshot,
        }),
    )
}

fn handle_state(shared: SharedRunner, session_id: &str) -> HostedResult<ResponseBody> {
    let state = shared.state.lock().expect("hosted runner state poisoned");
    ensure_session_id(&state, Some(session_id))?;
    json_response(200, shared.snapshot(&state))
}

fn handle_events(
    shared: SharedRunner,
    session_id: &str,
    query: HashMap<String, String>,
) -> HostedResult<ResponseBody> {
    let state = shared.state.lock().expect("hosted runner state poisoned");
    ensure_session_id(&state, Some(session_id))?;
    drop(state);
    if query
        .get("cursor")
        .map(|value| value.trim_start().starts_with('-'))
        .unwrap_or(false)
    {
        let replay = vec![shared.reset_envelope("replay_gap")];
        let rx = shared.events.subscribe();
        return Ok(ResponseBody::Sse { replay, rx, shared });
    }
    let cursor = query
        .get("cursor")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let (replay, rx) = shared.subscribe_from(cursor);
    Ok(ResponseBody::Sse { replay, rx, shared })
}

async fn handle_message(
    shared: SharedRunner,
    session_id: &str,
    headers: HashMap<String, String>,
    message: ToAgentMessage,
) -> HostedResult<ResponseBody> {
    let (connection_header_id, subscription_id) = connection_from_headers(&headers);
    let connection_id;
    let mut executor_request = None;
    let mut execution = HostedRunnerHeadlessMessageExecution::TransportOnly;
    let mut published_messages = 0usize;
    let mut response_message =
        "Rust hosted runner accepted the headless message; agent execution is not attached yet"
            .to_string();
    {
        let mut state = shared.state.lock().expect("hosted runner state poisoned");
        ensure_session_id(&state, Some(session_id))?;
        let resolved_connection_id = resolve_message_connection_id(
            &state,
            connection_header_id.clone(),
            subscription_id.clone(),
        )?;
        assert_controller(&state, Some(resolved_connection_id.as_str()))?;
        if state.draining {
            return Err(HostedError::new(
                503,
                "runtime_not_ready",
                "hosted runner is draining",
            ));
        }
        connection_id = Some(resolved_connection_id.clone());
        match &message {
            ToAgentMessage::Hello {
                protocol_version,
                client_info,
                capabilities,
                role,
                opt_out_notifications,
            } => {
                let lease_expires_at =
                    state
                        .connections
                        .get_mut(&resolved_connection_id)
                        .map(|connection| {
                            connection.client_protocol_version = protocol_version.clone();
                            connection.client_info = client_info.clone();
                            connection.capabilities = capabilities.clone();
                            connection.opt_out_notifications =
                                opt_out_notifications.clone().unwrap_or_default();
                            connection.role = role.unwrap_or(connection.role);
                            connection.last_seen_at = Utc::now();
                            lease_expires_at(connection)
                        });
                let controller_connection_id = state.controller_connection_id.clone();
                shared.publish_message(
                    &mut state,
                    FromAgentMessage::HelloOk {
                        protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
                        connection_id: Some(resolved_connection_id.clone()),
                        client_protocol_version: protocol_version.clone(),
                        client_info: client_info.clone(),
                        capabilities: capabilities.clone(),
                        opt_out_notifications: opt_out_notifications.clone(),
                        role: (*role).or(Some(ConnectionRole::Controller)),
                        controller_connection_id,
                        lease_expires_at,
                    },
                );
            }
            ToAgentMessage::Init {
                system_prompt,
                append_system_prompt,
                thinking_level,
                approval_mode,
            } => {
                state.last_init = Some(InitConfig {
                    system_prompt: system_prompt.clone(),
                    append_system_prompt: append_system_prompt.clone(),
                    thinking_level: *thinking_level,
                    approval_mode: *approval_mode,
                });
                state.last_status = Some("Initialized".to_string());
            }
            ToAgentMessage::Prompt { content, .. } => {
                state.last_status = Some(format!("Prompt: {content}"));
                executor_request = Some((
                    Arc::clone(&shared.message_executor),
                    message_context(
                        &state,
                        &resolved_connection_id,
                        subscription_id.clone(),
                        &shared.config.workspace_root,
                    )?,
                ));
            }
            ToAgentMessage::UtilityCommandTerminate { command_id, .. } => {
                state.active_utility_commands.remove(command_id);
                shared.publish_message(
                    &mut state,
                    FromAgentMessage::UtilityCommandExited {
                        command_id: command_id.clone(),
                        success: false,
                        exit_code: None,
                        signal: None,
                        reason: Some("terminated".to_string()),
                    },
                );
            }
            ToAgentMessage::UtilityCommandStdin { .. }
            | ToAgentMessage::UtilityCommandResize { .. }
            | ToAgentMessage::ToolResponse { .. }
            | ToAgentMessage::ClientToolResult { .. }
            | ToAgentMessage::ServerRequestResponse { .. }
            | ToAgentMessage::Interrupt
            | ToAgentMessage::Cancel
            | ToAgentMessage::Shutdown => {
                executor_request = Some((
                    Arc::clone(&shared.message_executor),
                    message_context(
                        &state,
                        &resolved_connection_id,
                        subscription_id.clone(),
                        &shared.config.workspace_root,
                    )?,
                ));
            }
            ToAgentMessage::UtilityCommandStart { .. }
            | ToAgentMessage::UtilityFileSearch { .. }
            | ToAgentMessage::UtilityFileRead { .. }
            | ToAgentMessage::UtilityFileWatchStart { .. }
            | ToAgentMessage::UtilityFileWatchStop { .. } => {}
        }
    }

    if let Some((executor, context)) = executor_request {
        let result = executor
            .execute(&context, message.clone())
            .map_err(HostedError::from)?;
        published_messages = result.messages.len();
        execution = result.execution;
        response_message = result.message;

        let mut state = shared.state.lock().expect("hosted runner state poisoned");
        ensure_session_id(&state, Some(session_id))?;
        assert_controller(&state, Some(context.connection_id.as_str()))?;
        if state.draining {
            return Err(HostedError::new(
                503,
                "runtime_not_ready",
                "hosted runner is draining",
            ));
        }
        for message in result.messages {
            shared.publish_message(&mut state, message);
        }
    }

    match message {
        ToAgentMessage::UtilityCommandStart {
            command_id,
            command,
            cwd,
            env,
            shell_mode,
            terminal_mode,
            columns,
            rows,
            ..
        } => {
            run_utility_command(
                shared.clone(),
                UtilityCommandInvocation {
                    connection_id: connection_id.clone(),
                    command_id,
                    command,
                    cwd,
                    env: env.unwrap_or_default(),
                    shell_mode: shell_mode.unwrap_or(UtilityCommandShellMode::Shell),
                    terminal_mode: terminal_mode.unwrap_or(UtilityCommandTerminalMode::Pipe),
                    columns,
                    rows,
                },
            )
            .await?;
        }
        ToAgentMessage::UtilityFileRead {
            read_id,
            path,
            cwd,
            offset,
            limit,
        } => handle_file_read(shared.clone(), read_id, path, cwd, offset, limit).await?,
        ToAgentMessage::UtilityFileSearch {
            search_id,
            query,
            cwd,
            limit,
        } => handle_file_search(shared.clone(), search_id, query, cwd, limit).await?,
        ToAgentMessage::UtilityFileWatchStart {
            watch_id,
            root_dir,
            include_patterns,
            exclude_patterns,
            debounce_ms,
        } => handle_file_watch_start(
            shared.clone(),
            connection_id.clone(),
            watch_id,
            root_dir,
            include_patterns,
            exclude_patterns,
            debounce_ms.unwrap_or(250),
        )?,
        ToAgentMessage::UtilityFileWatchStop { watch_id } => {
            handle_file_watch_stop(shared.clone(), watch_id)?;
        }
        _ => {}
    }

    let snapshot = {
        let state = shared.state.lock().expect("hosted runner state poisoned");
        shared.snapshot(&state)
    };
    let cursor = snapshot.cursor;
    json_response(
        200,
        json!({
            "ok": true,
            "success": true,
            "accepted": true,
            "cursor": cursor,
            "execution": execution,
            "published_messages": published_messages,
            "message": response_message,
            "snapshot": snapshot,
        }),
    )
}

fn handle_heartbeat(
    shared: SharedRunner,
    session_id: &str,
    input: HeartbeatRequest,
) -> HostedResult<ResponseBody> {
    let mut state = shared.state.lock().expect("hosted runner state poisoned");
    ensure_session_id(&state, Some(session_id))?;
    let connection_id = resolve_connection_id(&state, input.connection_id, input.subscription_id)?;
    let controller_lease_granted =
        state.controller_connection_id.as_deref() == Some(connection_id.as_str());
    let controller_connection_id = state.controller_connection_id.clone();
    let connection = state.connections.get_mut(&connection_id).ok_or_else(|| {
        HostedError::new(404, "stale_connection", "Headless connection not found")
    })?;
    connection.last_seen_at = Utc::now();
    let lease_expires_at = lease_expires_at(connection);
    json_response(
        200,
        json!({
            "connection_id": connection_id,
            "controller_lease_granted": controller_lease_granted,
            "controller_connection_id": controller_connection_id,
            "lease_expires_at": lease_expires_at,
            "heartbeat_interval_ms": DEFAULT_HEARTBEAT_INTERVAL_MS,
        }),
    )
}

fn handle_disconnect(
    shared: SharedRunner,
    session_id: &str,
    input: DisconnectRequest,
) -> HostedResult<ResponseBody> {
    let mut state = shared.state.lock().expect("hosted runner state poisoned");
    ensure_session_id(&state, Some(session_id))?;
    let connection_id = resolve_connection_id(&state, input.connection_id, input.subscription_id)?;
    let mut disconnected_subscription_ids = Vec::new();
    if let Some(connection) = state.connections.remove(&connection_id) {
        for subscription_id in connection.subscription_ids {
            state.subscriptions.remove(&subscription_id);
            disconnected_subscription_ids.push(subscription_id);
        }
    }
    if state.controller_connection_id.as_deref() == Some(connection_id.as_str()) {
        state.controller_connection_id = None;
    }
    shared.publish_snapshot(&mut state);
    json_response(
        200,
        json!({
            "success": true,
            "connection_id": connection_id,
            "controller_connection_id": state.controller_connection_id,
            "disconnected_subscription_ids": disconnected_subscription_ids,
        }),
    )
}

fn upsert_connection(state: &mut RunnerState, input: ConnectionUpsert) -> HostedResult<()> {
    let ConnectionUpsert {
        connection_id,
        role,
        client_protocol_version,
        client_info,
        capabilities,
        opt_out_notifications,
        take_control,
    } = input;
    let was_controller = state.controller_connection_id.as_deref() == Some(connection_id.as_str());
    if role == ConnectionRole::Controller {
        if let Some(controller_connection_id) = state.controller_connection_id.as_ref() {
            if controller_connection_id != &connection_id && !take_control {
                return Err(HostedError::new(
                    409,
                    "runtime_owned_elsewhere",
                    "Controller lease is already held by another connection",
                ));
            }
        }
        state.controller_connection_id = Some(connection_id.clone());
    } else if was_controller {
        state.controller_connection_id = None;
    }
    let now = Utc::now();
    let existing = state.connections.remove(&connection_id);
    let subscription_ids = existing
        .as_ref()
        .map(|connection| connection.subscription_ids.clone())
        .unwrap_or_default();
    let client_protocol_version = client_protocol_version.or_else(|| {
        existing
            .as_ref()
            .and_then(|connection| connection.client_protocol_version.clone())
    });
    let client_info = client_info.or_else(|| {
        existing
            .as_ref()
            .and_then(|connection| connection.client_info.clone())
    });
    let capabilities = capabilities.or_else(|| {
        existing
            .as_ref()
            .and_then(|connection| connection.capabilities.clone())
    });
    let opt_out_notifications = if opt_out_notifications.is_empty() {
        existing
            .as_ref()
            .map(|connection| connection.opt_out_notifications.clone())
            .unwrap_or_default()
    } else {
        opt_out_notifications
    };
    state.connections.insert(
        connection_id.clone(),
        ConnectionRecord {
            id: connection_id,
            role,
            client_protocol_version,
            client_info,
            capabilities,
            opt_out_notifications,
            subscription_ids,
            last_seen_at: now,
        },
    );
    Ok(())
}

fn lease_expires_at(connection: &ConnectionRecord) -> String {
    (connection.last_seen_at + ChronoDuration::milliseconds(CONNECTION_IDLE_MS))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

async fn run_utility_command(
    shared: SharedRunner,
    invocation: UtilityCommandInvocation,
) -> HostedResult<()> {
    let UtilityCommandInvocation {
        connection_id,
        command_id,
        command,
        cwd,
        env,
        shell_mode,
        terminal_mode,
        columns,
        rows,
    } = invocation;
    let cwd_path = resolve_workspace_path(&shared.config.workspace_root, None, cwd.as_deref())?;
    {
        let mut state = shared.state.lock().expect("hosted runner state poisoned");
        let snapshot = ActiveUtilityCommandSnapshot {
            command_id: command_id.clone(),
            command: command.clone(),
            cwd: Some(cwd_path.to_string_lossy().to_string()),
            shell_mode,
            terminal_mode,
            pid: None,
            columns,
            rows,
            owner_connection_id: connection_id.clone(),
            output: String::new(),
        };
        state
            .active_utility_commands
            .insert(command_id.clone(), snapshot);
        shared.publish_message(
            &mut state,
            FromAgentMessage::UtilityCommandStarted {
                command_id: command_id.clone(),
                command: command.clone(),
                cwd: Some(cwd_path.to_string_lossy().to_string()),
                shell_mode,
                terminal_mode,
                pid: None,
                columns,
                rows,
                owner_connection_id: connection_id.clone(),
            },
        );
    }

    tokio::spawn(async move {
        let output = spawn_command(&command, &cwd_path, env, shell_mode).await;
        let mut state = shared.state.lock().expect("hosted runner state poisoned");
        match output {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let success = output.status.success();
                let exit_code = output.status.code();
                if let Some(active) = state.active_utility_commands.get_mut(&command_id) {
                    active.output.push_str(&stdout);
                    active.output.push_str(&stderr);
                }
                if !stdout.is_empty() {
                    shared.publish_message(
                        &mut state,
                        FromAgentMessage::UtilityCommandOutput {
                            command_id: command_id.clone(),
                            stream: UtilityCommandStream::Stdout,
                            content: stdout,
                        },
                    );
                }
                if !stderr.is_empty() {
                    shared.publish_message(
                        &mut state,
                        FromAgentMessage::UtilityCommandOutput {
                            command_id: command_id.clone(),
                            stream: UtilityCommandStream::Stderr,
                            content: stderr,
                        },
                    );
                }
                state.active_utility_commands.remove(&command_id);
                shared.publish_message(
                    &mut state,
                    FromAgentMessage::UtilityCommandExited {
                        command_id,
                        success,
                        exit_code,
                        signal: None,
                        reason: None,
                    },
                );
            }
            Err(error) => {
                state.active_utility_commands.remove(&command_id);
                shared.publish_message(
                    &mut state,
                    FromAgentMessage::UtilityCommandExited {
                        command_id,
                        success: false,
                        exit_code: None,
                        signal: None,
                        reason: Some(error.message),
                    },
                );
            }
        }
    });
    Ok(())
}

async fn spawn_command(
    command: &str,
    cwd: &Path,
    env: HashMap<String, String>,
    shell_mode: UtilityCommandShellMode,
) -> HostedResult<std::process::Output> {
    let mut child = if shell_mode == UtilityCommandShellMode::Direct {
        let Some(parts) = shlex::split(command) else {
            return Err(HostedError::new(
                400,
                "unsupported_capability",
                "could not parse direct command",
            ));
        };
        let mut iter = parts.into_iter();
        let Some(program) = iter.next() else {
            return Err(HostedError::new(400, "bad_request", "command is empty"));
        };
        let mut child = Command::new(program);
        child.args(iter);
        child
    } else {
        let mut child = Command::new("sh");
        child.arg("-lc").arg(command);
        child
    };
    child.current_dir(cwd).envs(env);
    child
        .output()
        .await
        .map_err(|error| HostedError::new(500, "runtime_failed", error.to_string()))
}

async fn handle_file_read(
    shared: SharedRunner,
    read_id: String,
    path: String,
    cwd: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> HostedResult<()> {
    let full_path =
        resolve_workspace_path(&shared.config.workspace_root, cwd.as_deref(), Some(&path))?;
    let content = tokio::fs::read_to_string(&full_path)
        .await
        .map_err(|error| HostedError::new(404, "not_found", error.to_string()))?;
    let lines: Vec<&str> = content.lines().collect();
    let requested_offset = offset.unwrap_or(1).max(1) as usize;
    let start = if lines.is_empty() {
        0
    } else {
        requested_offset - 1
    };
    let limit = limit.unwrap_or(200) as usize;
    let selected = lines
        .iter()
        .skip(start)
        .take(limit)
        .copied()
        .collect::<Vec<_>>();
    let rendered = selected.join("\n");
    let relative_path = relative_workspace_path(&shared.config.workspace_root, &full_path);
    let mut state = shared.state.lock().expect("hosted runner state poisoned");
    shared.publish_message(
        &mut state,
        FromAgentMessage::UtilityFileReadResult {
            read_id,
            path: full_path.to_string_lossy().to_string(),
            relative_path,
            cwd: shared.config.workspace_root.to_string_lossy().to_string(),
            content: rendered,
            start_line: if lines.is_empty() {
                0
            } else {
                start as u32 + 1
            },
            end_line: (start + selected.len()) as u32,
            total_lines: lines.len() as u32,
            truncated: start + selected.len() < lines.len(),
        },
    );
    Ok(())
}

async fn handle_file_search(
    shared: SharedRunner,
    search_id: String,
    query: String,
    cwd: Option<String>,
    limit: Option<u32>,
) -> HostedResult<()> {
    let root = resolve_workspace_path(&shared.config.workspace_root, cwd.as_deref(), Some("."))?;
    let results = search_workspace_files(
        &shared.config.workspace_root,
        &root,
        &query,
        limit.unwrap_or(50) as usize,
    );
    let mut state = shared.state.lock().expect("hosted runner state poisoned");
    shared.publish_message(
        &mut state,
        FromAgentMessage::UtilityFileSearchResults {
            search_id,
            query,
            cwd: root.to_string_lossy().to_string(),
            results,
            truncated: false,
        },
    );
    Ok(())
}

fn handle_file_watch_start(
    shared: SharedRunner,
    connection_id: Option<String>,
    watch_id: String,
    root_dir: Option<String>,
    include_patterns: Option<Vec<String>>,
    exclude_patterns: Option<Vec<String>>,
    debounce_ms: u32,
) -> HostedResult<()> {
    let root = resolve_workspace_path(
        &shared.config.workspace_root,
        None,
        root_dir.as_deref().or(Some(".")),
    )?;
    let root_dir = root.to_string_lossy().to_string();
    let mut state = shared.state.lock().expect("hosted runner state poisoned");
    state.active_file_watches.insert(
        watch_id.clone(),
        ActiveFileWatchSnapshot {
            watch_id: watch_id.clone(),
            root_dir: root_dir.clone(),
            include_patterns: include_patterns.clone(),
            exclude_patterns: exclude_patterns.clone(),
            debounce_ms,
            owner_connection_id: connection_id.clone(),
        },
    );
    shared.publish_message(
        &mut state,
        FromAgentMessage::UtilityFileWatchStarted {
            watch_id,
            root_dir,
            include_patterns,
            exclude_patterns,
            debounce_ms,
            owner_connection_id: connection_id,
        },
    );
    Ok(())
}

fn handle_file_watch_stop(shared: SharedRunner, watch_id: String) -> HostedResult<()> {
    let mut state = shared.state.lock().expect("hosted runner state poisoned");
    state.active_file_watches.remove(&watch_id);
    shared.publish_message(
        &mut state,
        FromAgentMessage::UtilityFileWatchStopped {
            watch_id,
            reason: Some("Stopped by controller".to_string()),
        },
    );
    Ok(())
}

async fn write_snapshot_manifest(
    shared: &SharedRunner,
    input: &DrainRequest,
) -> HostedResult<(PathBuf, serde_json::Value)> {
    let root = shared.config.snapshot_root.clone().unwrap_or_else(|| {
        shared
            .config
            .workspace_root
            .join(".maestro/runner-snapshots")
    });
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|error| HostedError::new(500, "runtime_failed", error.to_string()))?;
    let filename = format!(
        "{}-{}.json",
        safe_manifest_component(&shared.config.runner_session_id),
        Utc::now().timestamp_millis()
    );
    let path = root.join(filename);
    let (maestro_session_id, snapshot) = {
        let state = shared.state.lock().expect("hosted runner state poisoned");
        (state.session_id.clone(), shared.snapshot(&state))
    };
    let has_runtime_activity = snapshot.cursor > 0;
    let export_paths = input
        .export_paths
        .clone()
        .unwrap_or_else(|| vec![".".to_string()]);
    let mut workspace_export_paths = Vec::with_capacity(export_paths.len());
    for export_path in &export_paths {
        let resolved_path = resolve_workspace_path(
            &shared.config.workspace_root,
            None,
            Some(export_path.as_str()),
        )?;
        let metadata = tokio::fs::metadata(&resolved_path).await.ok();
        let path_type = metadata
            .as_ref()
            .map(|metadata| {
                if metadata.is_dir() {
                    "directory"
                } else if metadata.is_file() {
                    "file"
                } else {
                    "other"
                }
            })
            .unwrap_or("missing");
        let relative_path = resolved_path
            .strip_prefix(&shared.config.workspace_root)
            .ok()
            .and_then(|path| {
                if path.as_os_str().is_empty() {
                    Some(".".to_string())
                } else {
                    path.to_str().map(ToOwned::to_owned)
                }
            })
            .unwrap_or_else(|| export_path.clone());
        workspace_export_paths.push(WorkspaceExportPathManifest {
            input: export_path.clone(),
            path: resolved_path,
            relative_path,
            path_type: path_type.to_string(),
        });
    }
    let manifest = SnapshotManifest {
        protocol_version: HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION.to_string(),
        runner_session_id: shared.config.runner_session_id.clone(),
        workspace_id: shared.config.workspace_id.clone(),
        agent_run_id: shared.config.agent_run_id.clone(),
        maestro_session_id: maestro_session_id.clone(),
        reason: input.reason.clone(),
        requested_by: input.requested_by.clone(),
        created_at: Utc::now().to_rfc3339(),
        workspace_root: shared.config.workspace_root.clone(),
        runtime: RuntimeFlushManifest {
            flush_status: if has_runtime_activity {
                RuntimeFlushStatus::Completed
            } else {
                RuntimeFlushStatus::Skipped
            },
            error: None,
            session_id: maestro_session_id,
            session_file: None,
            protocol_version: has_runtime_activity.then(|| HEADLESS_PROTOCOL_VERSION.to_string()),
            cursor: has_runtime_activity.then_some(snapshot.cursor),
        },
        workspace_export: WorkspaceExportManifest {
            mode: "local_path_contract".to_string(),
            paths: workspace_export_paths,
        },
        snapshot,
        retention_policy: Some(default_retention_policy_manifest()),
    };
    let body_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| HostedError::new(500, "runtime_failed", error.to_string()))?;
    let manifest = parse_snapshot_manifest_bytes(&body_bytes, &shared.config.workspace_root)
        .map_err(|error| HostedError::new(500, "runtime_failed", error.message))?;
    let body = serde_json::to_value(&manifest)
        .map_err(|error| HostedError::new(500, "runtime_failed", error.to_string()))?;
    tokio::fs::write(&path, body_bytes)
        .await
        .map_err(|error| HostedError::new(500, "runtime_failed", error.to_string()))?;
    Ok((path, body))
}

fn parse_snapshot_manifest_bytes(
    bytes: &[u8],
    workspace_root: &Path,
) -> HostedResult<SnapshotManifest> {
    let manifest = serde_json::from_slice::<SnapshotManifest>(bytes).map_err(|error| {
        HostedError::new(
            400,
            "invalid_snapshot_manifest",
            format!("invalid snapshot manifest json: {error}"),
        )
    })?;
    let workspace_root = workspace_root.canonicalize().map_err(|error| {
        HostedError::new(
            400,
            "invalid_snapshot_manifest",
            format!("invalid restore workspace root: {error}"),
        )
    })?;
    manifest.validate_for_workspace(&workspace_root)?;
    Ok(manifest)
}

async fn load_restore_manifest(
    config: &HostedRunnerConfig,
) -> io::Result<Option<SnapshotManifest>> {
    let Some(path) = &config.restore_manifest_path else {
        return Ok(None);
    };
    let path = if path.is_absolute() {
        path.clone()
    } else {
        config.workspace_root.join(path)
    };
    let bytes = tokio::fs::read(&path).await.map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("failed to read hosted runner restore manifest: {error}"),
        )
    })?;
    parse_snapshot_manifest_bytes(&bytes, &config.workspace_root)
        .map(Some)
        .map_err(hosted_error_to_io)
}

fn hosted_error_to_io(error: HostedError) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("{}: {}", error.code, error.message),
    )
}

fn safe_manifest_component(value: &str) -> String {
    let component = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if component.is_empty() {
        "runner".to_string()
    } else {
        component
    }
}

fn search_workspace_files(
    workspace_root: &Path,
    root: &Path,
    query: &str,
    limit: usize,
) -> Vec<UtilityFileSearchMatch> {
    let mut results = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let relative = relative_workspace_path(workspace_root, &path);
            if query.is_empty() || relative.contains(query) {
                results.push(UtilityFileSearchMatch {
                    path: relative,
                    score: 100,
                });
                if results.len() >= limit {
                    return results;
                }
            }
        }
    }
    results
}

fn ensure_session_id(state: &RunnerState, requested: Option<&str>) -> HostedResult<()> {
    if requested.is_some_and(|session_id| session_id != state.session_id) {
        return Err(HostedError::new(
            404,
            "stale_session",
            "Headless session not found",
        ));
    }
    Ok(())
}

fn assert_controller(state: &RunnerState, connection_id: Option<&str>) -> HostedResult<()> {
    let Some(connection_id) = connection_id else {
        return Err(HostedError::new(
            403,
            "access_denied",
            "missing headless connection id",
        ));
    };
    let Some(connection) = state.connections.get(connection_id) else {
        return Err(HostedError::new(
            404,
            "stale_connection",
            "Headless connection not found",
        ));
    };
    if connection.role == ConnectionRole::Viewer {
        return Err(HostedError::new(
            403,
            "access_denied",
            "Viewer headless connections cannot send messages",
        ));
    }
    if state.controller_connection_id.as_deref() != Some(connection_id) {
        return Err(HostedError::new(
            403,
            "runtime_owned_elsewhere",
            "Controller lease is currently held by another connection",
        ));
    }
    Ok(())
}

fn resolve_connection_id(
    state: &RunnerState,
    connection_id: Option<String>,
    subscription_id: Option<String>,
) -> HostedResult<String> {
    if let Some(connection_id) = connection_id {
        return Ok(connection_id);
    }
    if let Some(subscription_id) = subscription_id {
        if let Some(subscription) = state.subscriptions.get(&subscription_id) {
            return Ok(subscription.connection_id.clone());
        }
    }
    Err(HostedError::new(
        404,
        "stale_connection",
        "Headless connection not found",
    ))
}

fn resolve_message_connection_id(
    state: &RunnerState,
    connection_id: Option<String>,
    subscription_id: Option<String>,
) -> HostedResult<String> {
    let resolved_connection_id =
        resolve_connection_id(state, connection_id.clone(), subscription_id.clone())?;
    if let Some(subscription_id) = subscription_id {
        let subscription = state.subscriptions.get(&subscription_id).ok_or_else(|| {
            HostedError::new(404, "stale_connection", "Headless subscription not found")
        })?;
        if subscription.connection_id != resolved_connection_id {
            return Err(HostedError::new(
                403,
                "access_denied",
                "Headless subscription does not belong to the message connection",
            ));
        }
    }
    Ok(resolved_connection_id)
}

fn message_context(
    state: &RunnerState,
    connection_id: &str,
    subscription_id: Option<String>,
    workspace_root: &Path,
) -> HostedResult<HostedRunnerHeadlessMessageContext> {
    let connection = state.connections.get(connection_id).ok_or_else(|| {
        HostedError::new(404, "stale_connection", "Headless connection not found")
    })?;
    Ok(HostedRunnerHeadlessMessageContext {
        session_id: state.session_id.clone(),
        connection_id: connection.id.clone(),
        subscription_id,
        role: connection.role,
        controller_connection_id: state.controller_connection_id.clone(),
        client_protocol_version: connection.client_protocol_version.clone(),
        client_info: connection.client_info.clone(),
        capabilities: connection.capabilities.clone(),
        opt_out_notifications: (!connection.opt_out_notifications.is_empty())
            .then(|| connection.opt_out_notifications.clone()),
        lease_expires_at: lease_expires_at(connection),
        workspace_root: workspace_root.to_path_buf(),
    })
}

fn connection_from_headers(headers: &HashMap<String, String>) -> (Option<String>, Option<String>) {
    (
        headers
            .get("x-maestro-headless-connection-id")
            .or_else(|| headers.get("x-composer-headless-connection-id"))
            .cloned(),
        headers
            .get("x-maestro-headless-subscriber-id")
            .or_else(|| headers.get("x-composer-headless-subscriber-id"))
            .cloned(),
    )
}

fn session_id_from_path<'a>(path: &'a str, suffix: &str) -> HostedResult<&'a str> {
    let Some(prefix_removed) = path.strip_prefix("/api/headless/sessions/") else {
        return Err(HostedError::new(404, "not_found", "route not found"));
    };
    let Some(session_id) = prefix_removed.strip_suffix(suffix) else {
        return Err(HostedError::new(404, "not_found", "route not found"));
    };
    Ok(session_id.trim_end_matches('/'))
}

fn resolve_workspace_path(
    workspace_root: &Path,
    cwd: Option<&str>,
    requested: Option<&str>,
) -> HostedResult<PathBuf> {
    let base = match cwd {
        Some(cwd) if !cwd.trim().is_empty() => workspace_root.join(cwd),
        _ => workspace_root.to_path_buf(),
    };
    let requested = requested.unwrap_or(".");
    let candidate = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        base.join(requested)
    };
    let normalized = canonicalize_existing_prefix(&candidate)?;
    if !normalized.starts_with(workspace_root) {
        return Err(HostedError::new(
            403,
            "workspace_violation",
            "Path is outside hosted workspace root",
        ));
    }
    Ok(normalized)
}

fn canonicalize_existing_prefix(path: &Path) -> HostedResult<PathBuf> {
    let mut current = path.to_path_buf();
    let mut missing_components = Vec::<OsString>::new();
    loop {
        match current.canonicalize() {
            Ok(mut canonical) => {
                for component in missing_components.iter().rev() {
                    canonical.push(component);
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let Some(component) = current.file_name().map(OsString::from) else {
                    return Err(HostedError::new(
                        404,
                        "not_found",
                        "requested workspace path does not exist",
                    ));
                };
                missing_components.push(component);
                if !current.pop() {
                    return Err(HostedError::new(
                        404,
                        "not_found",
                        "requested workspace path does not exist",
                    ));
                }
            }
            Err(error) => {
                return Err(HostedError::new(404, "not_found", error.to_string()));
            }
        }
    }
}

fn relative_workspace_path(workspace_root: &Path, path: &Path) -> String {
    path.strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_string_lossy()
        .trim_start_matches('/')
        .to_string()
}

fn parse_json<T: for<'de> Deserialize<'de>>(body: &[u8]) -> HostedResult<T> {
    if body.is_empty() {
        return serde_json::from_slice(b"{}")
            .map_err(|error| HostedError::new(400, "bad_request", error.to_string()));
    }
    serde_json::from_slice(body)
        .map_err(|error| HostedError::new(400, "bad_request", error.to_string()))
}

fn json_response<T: Serialize>(status: u16, body: T) -> HostedResult<ResponseBody> {
    let body = serde_json::to_value(body)
        .map_err(|error| HostedError::new(500, "runtime_failed", error.to_string()))?;
    Ok(ResponseBody::Json { status, body })
}

async fn read_request(socket: &mut TcpStream) -> io::Result<Option<HttpRequest>> {
    let mut buffer = Vec::new();
    let mut header_end = None;
    loop {
        let mut chunk = [0_u8; 1024];
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            if buffer.is_empty() {
                return Ok(None);
            }
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = find_header_end(&buffer) {
            header_end = Some(position);
            break;
        }
        if buffer.len() > 64 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request headers too large",
            ));
        }
    }
    let Some(header_end) = header_end else {
        return Ok(None);
    };
    let headers_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = headers_text.split("\r\n");
    let Some(request_line) = lines.next() else {
        return Ok(None);
    };
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("").to_string();
    let target = request_parts.next().unwrap_or("/");
    let (path, query) = parse_target(target);
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;
    let mut body = buffer[body_start..].to_vec();
    while body.len() < content_length {
        let mut chunk = vec![0_u8; content_length - body.len()];
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Ok(Some(HttpRequest {
        method,
        path,
        query,
        headers,
        body,
    }))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_target(target: &str) -> (String, HashMap<String, String>) {
    let (path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let mut query = HashMap::new();
    for pair in raw_query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        query.insert(key.to_string(), value.to_string());
    }
    (path.to_string(), query)
}

async fn write_json_value(
    socket: &mut TcpStream,
    status: u16,
    body: serde_json::Value,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(&body)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_response(socket, status, "application/json", &bytes).await
}

async fn write_error(socket: &mut TcpStream, error: HostedError) -> io::Result<()> {
    let body = serde_json::to_vec(&json!({
        "error": error.message,
        "error_type": error.code,
        "code": error.code,
    }))
    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_response(socket, error.status, "application/json", &body).await
}

async fn write_response(
    socket: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let reason = status_reason(status);
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(headers.as_bytes()).await?;
    socket.write_all(body).await
}

async fn write_sse_headers(socket: &mut TcpStream) -> io::Result<()> {
    socket
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n",
        )
        .await
}

async fn write_sse_event(socket: &mut TcpStream, envelope: &StreamEnvelope) -> io::Result<()> {
    let payload = serde_json::to_string(envelope)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    socket.write_all(b"data: ").await?;
    socket.write_all(payload.as_bytes()).await?;
    socket.write_all(b"\n\n").await
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

#[cfg(test)]
mod tests {
    use reqwest::StatusCode;
    use tempfile::tempdir;

    use super::*;
    use crate::headless::RemoteTransportConfig;

    #[derive(Debug)]
    struct ScriptedRuntimeExecutor;

    impl HostedRunnerHeadlessMessageExecutor for ScriptedRuntimeExecutor {
        fn execute(
            &self,
            context: &HostedRunnerHeadlessMessageContext,
            message: ToAgentMessage,
        ) -> Result<HostedRunnerHeadlessMessageResult, HostedRunnerError> {
            match message {
                ToAgentMessage::Prompt { content, .. } => {
                    assert_eq!(context.session_id, "sess_test");
                    assert_eq!(context.connection_id, "conn_exec");
                    assert!(context.subscription_id.as_deref().is_some());
                    Ok(HostedRunnerHeadlessMessageResult::runtime_handled(
                        vec![
                            FromAgentMessage::ResponseStart {
                                response_id: "resp-hosted-1".to_string(),
                            },
                            FromAgentMessage::ResponseChunk {
                                response_id: "resp-hosted-1".to_string(),
                                content: format!("runtime: {content}"),
                                is_thinking: false,
                            },
                            FromAgentMessage::ResponseEnd {
                                response_id: "resp-hosted-1".to_string(),
                                usage: None,
                                tools_summary: None,
                                duration_ms: Some(7),
                                ttft_ms: Some(3),
                            },
                        ],
                        "Rust hosted runner message handled by runtime executor",
                    ))
                }
                _ => Ok(HostedRunnerHeadlessMessageResult::transport_only(
                    Vec::new(),
                    "scripted executor ignored message",
                )),
            }
        }
    }

    struct StatefulRuntimeExecutor {
        state: Mutex<AgentState>,
    }

    impl StatefulRuntimeExecutor {
        fn new(state: AgentState) -> Self {
            Self {
                state: Mutex::new(state),
            }
        }
    }

    impl HostedRunnerHeadlessMessageExecutor for StatefulRuntimeExecutor {
        fn execute(
            &self,
            _context: &HostedRunnerHeadlessMessageContext,
            _message: ToAgentMessage,
        ) -> Result<HostedRunnerHeadlessMessageResult, HostedRunnerError> {
            Ok(HostedRunnerHeadlessMessageResult::runtime_handled(
                Vec::new(),
                "accepted by stateful runtime",
            ))
        }

        fn state(&self) -> Result<Option<AgentState>, HostedRunnerError> {
            Ok(Some(self.state.lock().expect("state").clone()))
        }
    }

    fn test_config(workspace_root: PathBuf) -> HostedRunnerConfig {
        HostedRunnerConfig {
            runner_session_id: "mrs_test".to_string(),
            workspace_root,
            bind_addr: "127.0.0.1:0".parse().expect("bind addr"),
            owner_instance_id: Some("owner_test".to_string()),
            snapshot_root: None,
            restore_manifest_path: None,
            workspace_id: Some("ws_test".to_string()),
            agent_run_id: Some("run_test".to_string()),
            maestro_session_id: Some("sess_test".to_string()),
            attach_audience: None,
        }
    }

    #[test]
    fn supervisor_executor_reports_runtime_not_ready_until_connected() {
        let workspace = tempdir().expect("workspace");
        let supervisor = Arc::new(Mutex::new(AgentSupervisor::new(
            crate::headless::SupervisorConfig::default(),
        )));
        let executor = AgentSupervisorHostedRunnerMessageExecutor::new(supervisor);
        let context = HostedRunnerHeadlessMessageContext {
            session_id: "sess_test".to_string(),
            connection_id: "conn_exec".to_string(),
            subscription_id: Some("sub_exec".to_string()),
            role: ConnectionRole::Controller,
            controller_connection_id: Some("conn_exec".to_string()),
            client_protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
            client_info: None,
            capabilities: None,
            opt_out_notifications: None,
            lease_expires_at: Utc::now().to_rfc3339(),
            workspace_root: workspace.path().to_path_buf(),
        };

        let error = executor
            .execute(
                &context,
                ToAgentMessage::Prompt {
                    content: "hello".to_string(),
                    attachments: None,
                },
            )
            .expect_err("supervisor should not be connected");
        assert_eq!(error.code, HostedRunnerErrorCode::RuntimeNotReady);
    }

    #[test]
    fn resolves_env_config_with_hosted_runner_contract_names() {
        let workspace = tempdir().expect("workspace");
        let mut env = HashMap::new();
        env.insert(
            "MAESTRO_RUNNER_SESSION_ID".to_string(),
            "mrs_123".to_string(),
        );
        env.insert(
            "MAESTRO_REMOTE_RUNNER_OWNER_INSTANCE_ID".to_string(),
            "pod_1".to_string(),
        );
        env.insert(
            "MAESTRO_WORKSPACE_ROOT".to_string(),
            workspace.path().display().to_string(),
        );
        env.insert(
            "MAESTRO_HOSTED_RUNNER_LISTEN".to_string(),
            "127.0.0.1:9090".to_string(),
        );
        env.insert(
            "MAESTRO_REMOTE_RUNNER_WORKSPACE_ID".to_string(),
            "workspace_1".to_string(),
        );
        env.insert(
            "MAESTRO_REMOTE_RUNNER_SNAPSHOT_ROOT".to_string(),
            ".snapshots".to_string(),
        );
        env.insert(
            "MAESTRO_REMOTE_RUNNER_RESTORE_MANIFEST".to_string(),
            ".snapshots/restore.json".to_string(),
        );

        let config = HostedRunnerConfig::from_env_map(&env).expect("config");
        assert_eq!(config.runner_session_id, "mrs_123");
        assert_eq!(config.owner_instance_id.as_deref(), Some("pod_1"));
        assert_eq!(
            config.workspace_root,
            workspace.path().canonicalize().unwrap()
        );
        assert_eq!(config.bind_addr, "127.0.0.1:9090".parse().unwrap());
        assert_eq!(
            config.snapshot_root.as_deref(),
            Some(
                workspace
                    .path()
                    .canonicalize()
                    .unwrap()
                    .join(".snapshots")
                    .as_path()
            )
        );
        assert_eq!(config.workspace_id.as_deref(), Some("workspace_1"));
        assert_eq!(
            config.restore_manifest_path.as_deref(),
            Some(
                workspace
                    .path()
                    .canonicalize()
                    .unwrap()
                    .join(".snapshots/restore.json")
                    .as_path()
            )
        );
    }

    #[test]
    fn sse_lag_reset_envelope_includes_current_snapshot() {
        let workspace = tempdir().expect("workspace");
        let shared = SharedRunner::new(test_config(workspace.path().to_path_buf()));
        {
            let mut state = shared.state.lock().expect("state");
            shared.publish_message(
                &mut state,
                FromAgentMessage::Status {
                    message: "ready".to_string(),
                },
            );
        }

        let envelope = shared.reset_envelope("broadcast_lag:3");
        let StreamEnvelope::Reset { reason, snapshot } = envelope else {
            panic!("expected reset envelope");
        };
        assert_eq!(reason, "broadcast_lag:3");
        assert_eq!(snapshot.cursor, 1);
    }

    #[tokio::test]
    async fn events_negative_cursor_returns_replay_gap_reset() {
        let workspace = tempdir().expect("workspace");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let mut events_response = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/events?cursor=-999",
                handle.base_url()
            ))
            .send()
            .await
            .expect("events response");
        assert_eq!(events_response.status(), StatusCode::OK);
        let event_text = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let mut event_text = String::new();
            while !event_text.contains(r#""reason":"replay_gap""#) {
                let chunk = events_response
                    .chunk()
                    .await
                    .expect("event chunk read")
                    .expect("event chunk");
                event_text.push_str(&String::from_utf8_lossy(&chunk));
            }
            event_text
        })
        .await
        .expect("event chunk timeout");
        assert!(event_text.contains(r#""type":"reset""#));
        assert!(event_text.contains(r#""reason":"replay_gap""#));

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn identity_and_drain_follow_runner_contract() {
        let workspace = tempdir().expect("workspace");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let identity: HostedRunnerIdentity = client
            .get(format!(
                "{}/.well-known/evalops/remote-runner/identity",
                handle.base_url()
            ))
            .send()
            .await
            .expect("identity response")
            .json()
            .await
            .expect("identity json");
        assert_eq!(identity.runner_session_id, "mrs_test");
        assert_eq!(identity.owner_instance_id.as_deref(), Some("owner_test"));
        assert!(identity.ready);
        assert!(!identity.draining);

        let drain: serde_json::Value = client
            .post(format!(
                "{}/.well-known/evalops/remote-runner/drain",
                handle.base_url()
            ))
            .json(&json!({"reason": "test", "requested_by": "platform", "export_paths": ["."]}))
            .send()
            .await
            .expect("drain response")
            .json()
            .await
            .expect("drain json");
        assert_eq!(drain["status"], "drained");
        let manifest_path = drain["manifest_path"].as_str().expect("manifest path");
        assert!(Path::new(manifest_path).exists());
        let manifest_bytes = std::fs::read(manifest_path).expect("manifest contents");
        let typed_manifest = parse_snapshot_manifest_bytes(&manifest_bytes, workspace.path())
            .expect("typed manifest");
        let manifest: serde_json::Value =
            serde_json::from_slice(&manifest_bytes).expect("manifest json");
        assert_eq!(drain["manifest"], manifest);
        assert_eq!(
            typed_manifest.protocol_version,
            HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION
        );
        assert_eq!(
            manifest["protocol_version"],
            HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION
        );
        assert_eq!(manifest["workspace_export"]["mode"], "local_path_contract");
        assert_eq!(
            manifest["workspace_export"]["paths"][0]["relative_path"],
            "."
        );
        assert_eq!(
            manifest["workspace_export"]["paths"][0]["type"],
            "directory"
        );
        assert_eq!(
            manifest["retention_policy"]["policy_version"],
            HOSTED_RUNNER_RETENTION_POLICY_VERSION
        );
        assert_eq!(
            manifest["retention_policy"]["visibility"]["runtime_snapshot"],
            "internal"
        );

        let post_drain_identity: HostedRunnerIdentity = client
            .get(format!(
                "{}/.well-known/evalops/remote-runner/identity",
                handle.base_url()
            ))
            .send()
            .await
            .expect("identity response")
            .json()
            .await
            .expect("identity json");
        assert!(!post_drain_identity.ready);
        assert!(post_drain_identity.draining);

        let post_drain_state: serde_json::Value = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/state",
                handle.base_url()
            ))
            .send()
            .await
            .expect("state response")
            .json()
            .await
            .expect("state json");
        assert_eq!(post_drain_state["state"]["is_ready"], false);
        assert_eq!(post_drain_state["state"]["last_status"], "Drained");

        let attach = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({"sessionId": "sess_test", "role": "controller"}))
            .send()
            .await
            .expect("attach response");
        assert_eq!(attach.status(), StatusCode::SERVICE_UNAVAILABLE);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn drain_manifest_records_runtime_cursor_after_activity() {
        let workspace = tempdir().expect("workspace");
        std::fs::write(workspace.path().join("notes.md"), "notes").expect("workspace file");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let connection: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({
                "sessionId": "sess_test",
                "connectionId": "conn_drain",
                "role": "controller"
            }))
            .send()
            .await
            .expect("connection response")
            .json()
            .await
            .expect("connection json");
        assert_eq!(connection["connection_id"], "conn_drain");

        let message: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/messages",
                handle.base_url()
            ))
            .header("x-maestro-headless-connection-id", "conn_drain")
            .json(&json!({"type": "prompt", "content": "before drain"}))
            .send()
            .await
            .expect("message response")
            .json()
            .await
            .expect("message json");
        assert!(message["cursor"].as_u64().unwrap_or_default() > 0);

        let drain: serde_json::Value = client
            .post(format!(
                "{}/.well-known/evalops/remote-runner/drain",
                handle.base_url()
            ))
            .json(&json!({"reason": "cursor-check", "export_paths": ["notes.md"]}))
            .send()
            .await
            .expect("drain response")
            .json()
            .await
            .expect("drain json");
        let manifest_path = drain["manifest_path"].as_str().expect("manifest path");
        let manifest_bytes = std::fs::read(manifest_path).expect("manifest contents");
        let typed_manifest = parse_snapshot_manifest_bytes(&manifest_bytes, workspace.path())
            .expect("typed manifest");
        let manifest: serde_json::Value =
            serde_json::from_slice(&manifest_bytes).expect("manifest json");
        assert_eq!(manifest["runtime"]["flush_status"], "completed");
        assert_eq!(
            typed_manifest.runtime.flush_status,
            RuntimeFlushStatus::Completed
        );
        assert_eq!(
            manifest["runtime"]["protocol_version"],
            HEADLESS_PROTOCOL_VERSION
        );
        assert!(manifest["runtime"]["cursor"].as_u64().unwrap_or_default() >= 2);
        assert_eq!(drain["manifest"], manifest);
        assert_eq!(
            manifest["workspace_export"]["paths"][0]["input"],
            "notes.md"
        );
        assert_eq!(
            manifest["workspace_export"]["paths"][0]["relative_path"],
            "notes.md"
        );
        assert_eq!(manifest["workspace_export"]["paths"][0]["type"], "file");
        assert_eq!(
            manifest["retention_policy"]["redaction"]["required_before_external_persistence"],
            json!(["runtime_snapshot", "runtime_logs"])
        );
        let mut escaped_manifest = manifest.clone();
        escaped_manifest["workspace_export"]["paths"][0]["relative_path"] = json!("../secret.txt");
        let escaped_bytes = serde_json::to_vec(&escaped_manifest).expect("escaped manifest json");
        let error =
            parse_snapshot_manifest_bytes(&escaped_bytes, workspace.path()).expect_err("escape");
        assert_eq!(error.code, "workspace_violation");

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn restore_manifest_seeds_runtime_state_and_replay_marker() {
        let workspace = tempdir().expect("workspace");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let connection: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({
                "sessionId": "sess_test",
                "connectionId": "conn_restore",
                "role": "controller"
            }))
            .send()
            .await
            .expect("connection response")
            .json()
            .await
            .expect("connection json");
        assert_eq!(connection["connection_id"], "conn_restore");

        let message: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/messages",
                handle.base_url()
            ))
            .header("x-maestro-headless-connection-id", "conn_restore")
            .json(&json!({"type": "prompt", "content": "before restore"}))
            .send()
            .await
            .expect("message response")
            .json()
            .await
            .expect("message json");
        assert!(message["cursor"].as_u64().unwrap_or_default() > 0);

        let drain: serde_json::Value = client
            .post(format!(
                "{}/.well-known/evalops/remote-runner/drain",
                handle.base_url()
            ))
            .json(&json!({"reason": "restore-check"}))
            .send()
            .await
            .expect("drain response")
            .json()
            .await
            .expect("drain json");
        let manifest_path = PathBuf::from(drain["manifest_path"].as_str().expect("manifest path"));
        let restored_cursor = drain["manifest"]["runtime"]["cursor"]
            .as_u64()
            .expect("manifest cursor");
        handle.shutdown().await;

        let mut restore_config = test_config(workspace.path().to_path_buf());
        restore_config.runner_session_id = "mrs_restored".to_string();
        restore_config.maestro_session_id = None;
        restore_config.restore_manifest_path = Some(manifest_path);
        let restored = start_hosted_runner(restore_config)
            .await
            .expect("start restored hosted runner");

        let identity: HostedRunnerIdentity = client
            .get(format!(
                "{}/.well-known/evalops/remote-runner/identity",
                restored.base_url()
            ))
            .send()
            .await
            .expect("identity response")
            .json()
            .await
            .expect("identity json");
        assert_eq!(identity.runner_session_id, "mrs_restored");
        assert!(identity.ready);
        assert!(!identity.draining);

        let state: serde_json::Value = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/state",
                restored.base_url()
            ))
            .send()
            .await
            .expect("state response")
            .json()
            .await
            .expect("state json");
        assert_eq!(state["session_id"], "sess_test");
        assert_eq!(state["cursor"], restored_cursor);
        assert_eq!(state["state"]["last_status"], "Restored from snapshot");
        assert_eq!(state["state"]["is_ready"], true);

        let mut events_response = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/events?cursor=0",
                restored.base_url()
            ))
            .send()
            .await
            .expect("events response");
        assert_eq!(events_response.status(), StatusCode::OK);
        let event_text = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let mut event_text = String::new();
            while !event_text.contains(r#""reason":"restored_from_snapshot""#) {
                let chunk = events_response
                    .chunk()
                    .await
                    .expect("event chunk read")
                    .expect("event chunk");
                event_text.push_str(&String::from_utf8_lossy(&chunk));
            }
            event_text
        })
        .await
        .expect("event chunk timeout");
        assert!(event_text.contains(r#""type":"reset""#));
        assert!(event_text.contains(r#""reason":"restored_from_snapshot""#));
        assert!(event_text.contains("Restored from snapshot"));

        let subscription: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/subscribe",
                restored.base_url()
            ))
            .json(&json!({"role": "controller"}))
            .send()
            .await
            .expect("subscribe response")
            .json()
            .await
            .expect("subscribe json");
        assert_eq!(subscription["controller_lease_granted"], true);
        assert_eq!(subscription["snapshot"]["session_id"], "sess_test");

        restored.shutdown().await;
    }

    #[test]
    fn snapshot_manifest_parser_accepts_typescript_hosted_shape() {
        let workspace = tempdir().expect("workspace");
        let readme_path = workspace.path().join("README.md");
        std::fs::write(&readme_path, "# workspace\n").expect("workspace file");
        let manifest = json!({
            "protocol_version": HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
            "runner_session_id": "mrs_ts",
            "workspace_id": "ws_ts",
            "agent_run_id": "run_ts",
            "maestro_session_id": "session_ts",
            "reason": "ttl_expired",
            "requested_by": "platform",
            "created_at": "2026-04-23T00:00:00.000Z",
            "workspace_root": workspace.path(),
            "runtime": {
                "flush_status": "completed",
                "session_id": "session_ts",
                "session_file": workspace.path().join(".maestro/sessions/session.jsonl"),
                "protocol_version": HEADLESS_PROTOCOL_VERSION,
                "cursor": 7
            },
            "workspace_export": {
                "mode": "local_path_contract",
                "paths": [{
                    "input": "README.md",
                    "path": readme_path,
                    "relative_path": "README.md",
                    "type": "file"
                }]
            },
            "retention_policy": {
                "policy_version": HOSTED_RUNNER_RETENTION_POLICY_VERSION,
                "managed_by": "platform",
                "visibility": {
                    "control_plane_metadata": "operator",
                    "workspace_export": "tenant",
                    "runtime_snapshot": "internal",
                    "runtime_logs": "operator"
                },
                "redaction": {
                    "required_before_external_persistence": [
                        "runtime_snapshot",
                        "runtime_logs"
                    ],
                    "forbidden_plaintext": [
                        "provider_credentials",
                        "tool_secrets",
                        "attach_tokens",
                        "artifact_access_tokens",
                        "raw_environment"
                    ]
                }
            },
            "snapshot": {
                "protocolVersion": HEADLESS_PROTOCOL_VERSION,
                "session_id": "session_ts",
                "cursor": 7,
                "last_init": null,
                "state": {
                    "protocol_version": HEADLESS_PROTOCOL_VERSION,
                    "connection_count": 0,
                    "subscriber_count": 0,
                    "connections": [],
                    "model": "gpt-5.4",
                    "provider": "openai",
                    "session_id": "session_ts",
                    "cwd": workspace.path(),
                    "pending_approvals": [],
                    "pending_client_tools": [],
                    "pending_mcp_elicitations": [],
                    "pending_user_inputs": [],
                    "pending_tool_retries": [],
                    "tracked_tools": [],
                    "active_tools": [],
                    "active_utility_commands": [],
                    "active_file_watches": [],
                    "last_status": "Ready",
                    "is_ready": true,
                    "is_responding": false
                }
            }
        });
        let bytes = serde_json::to_vec(&manifest).expect("manifest json");
        let parsed =
            parse_snapshot_manifest_bytes(&bytes, workspace.path()).expect("typed manifest");

        assert_eq!(
            parsed.protocol_version,
            HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION
        );
        assert_eq!(parsed.runtime.flush_status, RuntimeFlushStatus::Completed);
        assert_eq!(
            parsed
                .retention_policy
                .as_ref()
                .expect("retention policy")
                .policy_version,
            HOSTED_RUNNER_RETENTION_POLICY_VERSION
        );
        assert_eq!(parsed.snapshot.session_id, "session_ts");
        assert_eq!(parsed.snapshot.cursor, 7);
        assert_eq!(parsed.workspace_export.paths[0].relative_path, "README.md");
    }

    #[tokio::test]
    async fn failed_restore_manifest_stays_not_ready_and_rejects_attach() {
        let workspace = tempdir().expect("workspace");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let connection: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({
                "sessionId": "sess_test",
                "connectionId": "conn_partial_restore",
                "role": "controller"
            }))
            .send()
            .await
            .expect("connection response")
            .json()
            .await
            .expect("connection json");
        assert_eq!(connection["connection_id"], "conn_partial_restore");

        let message: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/messages",
                handle.base_url()
            ))
            .header("x-maestro-headless-connection-id", "conn_partial_restore")
            .json(&json!({"type": "prompt", "content": "before interrupted restore"}))
            .send()
            .await
            .expect("message response")
            .json()
            .await
            .expect("message json");
        assert!(message["cursor"].as_u64().unwrap_or_default() > 0);

        let drain: serde_json::Value = client
            .post(format!(
                "{}/.well-known/evalops/remote-runner/drain",
                handle.base_url()
            ))
            .json(&json!({"reason": "preempted"}))
            .send()
            .await
            .expect("drain response")
            .json()
            .await
            .expect("drain json");
        let manifest_path = PathBuf::from(drain["manifest_path"].as_str().expect("manifest path"));
        let restored_cursor = drain["manifest"]["runtime"]["cursor"]
            .as_u64()
            .expect("manifest cursor");
        let mut partial_manifest = drain["manifest"].clone();
        partial_manifest["runtime"]["flush_status"] = json!("failed");
        partial_manifest["runtime"]["error"] = json!("flush timed out");
        tokio::fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&partial_manifest).expect("manifest json"),
        )
        .await
        .expect("write partial manifest");
        handle.shutdown().await;

        let mut restore_config = test_config(workspace.path().to_path_buf());
        restore_config.runner_session_id = "mrs_partial_restored".to_string();
        restore_config.maestro_session_id = None;
        restore_config.restore_manifest_path = Some(manifest_path);
        let restored = start_hosted_runner(restore_config)
            .await
            .expect("start restored hosted runner");

        let identity: HostedRunnerIdentity = client
            .get(format!(
                "{}/.well-known/evalops/remote-runner/identity",
                restored.base_url()
            ))
            .send()
            .await
            .expect("identity response")
            .json()
            .await
            .expect("identity json");
        assert_eq!(identity.runner_session_id, "mrs_partial_restored");
        assert!(!identity.ready);
        assert!(!identity.draining);

        let state: serde_json::Value = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/state",
                restored.base_url()
            ))
            .send()
            .await
            .expect("state response")
            .json()
            .await
            .expect("state json");
        assert_eq!(state["session_id"], "sess_test");
        assert_eq!(state["cursor"], restored_cursor);
        assert_eq!(
            state["state"]["last_status"],
            "Restore interrupted before runtime flush completed"
        );
        assert_eq!(state["state"]["last_error"], "flush timed out");
        assert_eq!(state["state"]["last_error_type"], "protocol");
        assert_eq!(state["state"]["is_ready"], false);

        let ready = client
            .get(format!("{}/readyz", restored.base_url()))
            .send()
            .await
            .expect("ready response");
        assert_eq!(ready.status(), StatusCode::SERVICE_UNAVAILABLE);

        let attach = client
            .post(format!("{}/api/headless/connections", restored.base_url()))
            .json(&json!({"sessionId": "sess_test", "role": "controller"}))
            .send()
            .await
            .expect("attach response");
        assert_eq!(attach.status(), StatusCode::SERVICE_UNAVAILABLE);

        let mut events_response = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/events?cursor=0",
                restored.base_url()
            ))
            .send()
            .await
            .expect("events response");
        assert_eq!(events_response.status(), StatusCode::OK);
        let event_text = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let mut event_text = String::new();
            while !event_text.contains(r#""reason":"restored_from_snapshot""#) {
                let chunk = events_response
                    .chunk()
                    .await
                    .expect("event chunk read")
                    .expect("event chunk");
                event_text.push_str(&String::from_utf8_lossy(&chunk));
            }
            event_text
        })
        .await
        .expect("event chunk timeout");
        assert!(event_text.contains(r#""type":"reset""#));
        assert!(event_text.contains("Restore interrupted before runtime flush completed"));

        restored.shutdown().await;
    }

    #[tokio::test]
    async fn skipped_restore_manifest_stays_not_ready() {
        let workspace = tempdir().expect("workspace");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let drain: serde_json::Value = client
            .post(format!(
                "{}/.well-known/evalops/remote-runner/drain",
                handle.base_url()
            ))
            .json(&json!({"reason": "empty-runtime"}))
            .send()
            .await
            .expect("drain response")
            .json()
            .await
            .expect("drain json");
        assert_eq!(drain["manifest"]["runtime"]["flush_status"], "skipped");
        let manifest_path = PathBuf::from(drain["manifest_path"].as_str().expect("manifest path"));
        handle.shutdown().await;

        let mut restore_config = test_config(workspace.path().to_path_buf());
        restore_config.runner_session_id = "mrs_skipped_restored".to_string();
        restore_config.maestro_session_id = None;
        restore_config.restore_manifest_path = Some(manifest_path);
        let restored = start_hosted_runner(restore_config)
            .await
            .expect("start restored hosted runner");

        let identity: HostedRunnerIdentity = client
            .get(format!(
                "{}/.well-known/evalops/remote-runner/identity",
                restored.base_url()
            ))
            .send()
            .await
            .expect("identity response")
            .json()
            .await
            .expect("identity json");
        assert!(!identity.ready);

        let state: serde_json::Value = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/state",
                restored.base_url()
            ))
            .send()
            .await
            .expect("state response")
            .json()
            .await
            .expect("state json");
        assert_eq!(
            state["state"]["last_status"],
            "Restore incomplete: runtime flush skipped"
        );
        assert_eq!(
            state["state"]["last_error"],
            "runtime flush was skipped; no runtime activity was persisted"
        );
        assert_eq!(state["state"]["last_error_type"], "protocol");
        assert_eq!(state["state"]["is_ready"], false);

        restored.shutdown().await;
    }

    #[tokio::test]
    async fn message_executor_publishes_runtime_handled_events() {
        let workspace = tempdir().expect("workspace");
        let handle = start_hosted_runner_with_message_executor(
            test_config(workspace.path().to_path_buf()),
            Arc::new(ScriptedRuntimeExecutor),
        )
        .await
        .expect("start hosted runner");
        let client = reqwest::Client::new();

        let connection: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({
                "sessionId": "sess_test",
                "connectionId": "conn_exec",
                "role": "controller"
            }))
            .send()
            .await
            .expect("connection response")
            .json()
            .await
            .expect("connection json");
        assert_eq!(connection["connection_id"], "conn_exec");

        let subscription: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/subscribe",
                handle.base_url()
            ))
            .json(&json!({
                "connectionId": "conn_exec",
                "subscriptionId": "sub_exec",
                "role": "controller"
            }))
            .send()
            .await
            .expect("subscription response")
            .json()
            .await
            .expect("subscription json");
        let subscription_id = subscription["subscription_id"]
            .as_str()
            .expect("subscription id")
            .to_string();

        let message: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/messages",
                handle.base_url()
            ))
            .header("x-maestro-headless-connection-id", "conn_exec")
            .header("x-maestro-headless-subscriber-id", subscription_id)
            .json(&json!({"type": "prompt", "content": "hello"}))
            .send()
            .await
            .expect("message response")
            .json()
            .await
            .expect("message json");
        assert_eq!(message["success"], true);
        assert_eq!(message["execution"], "runtime_handled");
        assert_eq!(message["published_messages"], 3);

        let mut events_response = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/events?cursor=0",
                handle.base_url()
            ))
            .send()
            .await
            .expect("events response");
        assert_eq!(events_response.status(), StatusCode::OK);
        let mut event_text = String::new();
        for _ in 0..8 {
            let chunk =
                tokio::time::timeout(std::time::Duration::from_secs(1), events_response.chunk())
                    .await
                    .expect("event chunk timeout")
                    .expect("event chunk read");
            let Some(chunk) = chunk else {
                break;
            };
            event_text.push_str(&String::from_utf8_lossy(&chunk));
            if event_text.contains("\"type\":\"response_end\"") {
                break;
            }
        }
        assert!(event_text.contains("\"type\":\"response_start\""));
        assert!(event_text.contains("\"type\":\"response_chunk\""));
        assert!(event_text.contains("\"content\":\"runtime: hello\""));
        assert!(event_text.contains("\"type\":\"response_end\""));

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn state_snapshot_merges_supervisor_agent_state_with_hosted_connections() {
        let workspace = tempdir().expect("workspace");
        let mut current_response =
            crate::headless::StreamingResponse::new("resp-state-1".to_string());
        current_response.append("working on hosted state", false);
        let supervisor_state = AgentState {
            model: Some("gpt-5.4".to_string()),
            provider: Some("openai".to_string()),
            session_id: Some("supervisor-session-1".to_string()),
            cwd: Some("/runtime/workspace".to_string()),
            git_branch: Some("feature/runtime-state".to_string()),
            current_response: Some(current_response),
            pending_approvals: vec![crate::headless::PendingApproval {
                call_id: "call-1".to_string(),
                request_id: Some("approval-1".to_string()),
                tool: "bash".to_string(),
                args: json!({"cmd": "cargo test"}),
            }],
            last_status: Some("thinking".to_string()),
            is_ready: true,
            is_responding: true,
            ..AgentState::default()
        };
        let handle = start_hosted_runner_with_message_executor(
            test_config(workspace.path().to_path_buf()),
            Arc::new(StatefulRuntimeExecutor::new(supervisor_state)),
        )
        .await
        .expect("start hosted runner");
        let client = reqwest::Client::new();

        let controller: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({
                "sessionId": "sess_test",
                "connectionId": "conn_state",
                "role": "controller"
            }))
            .send()
            .await
            .expect("controller response")
            .json()
            .await
            .expect("controller json");
        assert_eq!(controller["snapshot"]["state"]["model"], "gpt-5.4");
        assert_eq!(controller["snapshot"]["state"]["connection_count"], 1);

        let subscribe: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/subscribe",
                handle.base_url()
            ))
            .json(&json!({"connectionId": "conn_state", "role": "controller"}))
            .send()
            .await
            .expect("subscribe response")
            .json()
            .await
            .expect("subscribe json");
        assert_eq!(
            subscribe["snapshot"]["state"]["controller_connection_id"],
            "conn_state"
        );
        assert!(subscribe["snapshot"]["state"]["controller_subscription_id"]
            .as_str()
            .is_some());

        let state: serde_json::Value = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/state",
                handle.base_url()
            ))
            .send()
            .await
            .expect("state response")
            .json()
            .await
            .expect("state json");
        assert_eq!(state["state"]["model"], "gpt-5.4");
        assert_eq!(state["state"]["provider"], "openai");
        assert_eq!(state["state"]["session_id"], "supervisor-session-1");
        assert_eq!(state["state"]["cwd"], "/runtime/workspace");
        assert_eq!(state["state"]["git_branch"], "feature/runtime-state");
        assert_eq!(
            state["state"]["current_response"]["response_id"],
            "resp-state-1"
        );
        assert_eq!(state["state"]["pending_approvals"][0]["call_id"], "call-1");
        assert_eq!(state["state"]["last_status"], "thinking");
        assert_eq!(state["state"]["is_ready"], true);
        assert_eq!(state["state"]["is_responding"], true);
        assert_eq!(state["state"]["connection_count"], 1);
        assert_eq!(state["state"]["subscriber_count"], 1);
        assert_eq!(state["state"]["controller_connection_id"], "conn_state");
        assert_eq!(
            state["state"]["connections"][0]["controller_lease_granted"],
            true
        );

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn remote_transport_attaches_and_receives_workspace_events() {
        let workspace = tempdir().expect("workspace");
        tokio::fs::write(workspace.path().join("notes.md"), "alpha\nbeta\n")
            .await
            .expect("write fixture");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let mut transport = crate::headless::RemoteAgentTransport::connect(RemoteTransportConfig {
            base_url: handle.base_url(),
            session_id: Some("sess_test".to_string()),
            role: Some("controller".to_string()),
            client_name: "rust-hosted-runner-test".to_string(),
            opt_out_notifications: vec!["heartbeat".to_string()],
            ..RemoteTransportConfig::default()
        })
        .await
        .expect("connect");

        assert_eq!(transport.session_id(), "sess_test");
        transport
            .read_file(
                "read_notes".to_string(),
                "notes.md".to_string(),
                None,
                None,
                None,
            )
            .expect("send read request");

        let mut saw_read = false;
        for _ in 0..8 {
            let incoming =
                tokio::time::timeout(std::time::Duration::from_secs(1), transport.recv_incoming())
                    .await
                    .expect("incoming timeout")
                    .expect("incoming event");
            if let crate::headless::RemoteIncoming::Message(
                FromAgentMessage::UtilityFileReadResult { content, .. },
            ) = incoming
            {
                saw_read = content.contains("alpha");
                break;
            }
        }
        assert!(saw_read, "expected hosted runner file read event");

        transport
            .shutdown_and_wait()
            .await
            .expect("shutdown transport");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn hosted_messages_reject_workspace_escape_before_file_work() {
        let workspace = tempdir().expect("workspace");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let connection: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({"sessionId": "sess_test", "role": "controller"}))
            .send()
            .await
            .expect("connection response")
            .json()
            .await
            .expect("connection json");
        let connection_id = connection["connection_id"]
            .as_str()
            .expect("connection id")
            .to_string();
        let subscription: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/subscribe",
                handle.base_url()
            ))
            .json(&json!({"connectionId": connection_id, "role": "controller"}))
            .send()
            .await
            .expect("subscription response")
            .json()
            .await
            .expect("subscription json");
        let subscription_id = subscription["subscription_id"]
            .as_str()
            .expect("subscription id")
            .to_string();

        let response = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/messages",
                handle.base_url()
            ))
            .header("x-maestro-headless-connection-id", connection_id)
            .header("x-maestro-headless-subscriber-id", subscription_id)
            .json(&json!({
                "type": "utility_file_read",
                "read_id": "escape",
                "path": "../secret.txt"
            }))
            .send()
            .await
            .expect("message response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body: serde_json::Value = response.json().await.expect("error body");
        assert_eq!(body["error_type"], "workspace_violation");

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn hosted_messages_reject_symlink_escape_for_missing_child() {
        let workspace = tempdir().expect("workspace");
        let outside = tempdir().expect("outside");
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("outside-link"))
            .expect("symlink fixture");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let connection: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({"sessionId": "sess_test", "role": "controller"}))
            .send()
            .await
            .expect("connection response")
            .json()
            .await
            .expect("connection json");
        let connection_id = connection["connection_id"]
            .as_str()
            .expect("connection id")
            .to_string();
        let subscription: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/subscribe",
                handle.base_url()
            ))
            .json(&json!({"connectionId": connection_id, "role": "controller"}))
            .send()
            .await
            .expect("subscription response")
            .json()
            .await
            .expect("subscription json");
        let subscription_id = subscription["subscription_id"]
            .as_str()
            .expect("subscription id")
            .to_string();

        let response = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/messages",
                handle.base_url()
            ))
            .header("x-maestro-headless-connection-id", connection_id)
            .header("x-maestro-headless-subscriber-id", subscription_id)
            .json(&json!({
                "type": "utility_file_read",
                "read_id": "symlink-escape",
                "path": "outside-link/missing.txt"
            }))
            .send()
            .await
            .expect("message response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body: serde_json::Value = response.json().await.expect("error body");
        assert_eq!(body["error_type"], "workspace_violation");

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn duplicate_subscribe_preserves_disconnect_cleanup() {
        let workspace = tempdir().expect("workspace");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let connection: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({
                "sessionId": "sess_test",
                "connectionId": "conn_multi",
                "role": "controller",
                "protocolVersion": "2026-03-30",
                "clientInfo": {"name": "lease-test", "version": "1.0.0"},
                "capabilities": {
                    "serverRequests": ["approval"],
                    "utilityOperations": ["file_read"],
                    "rawAgentEvents": true
                }
            }))
            .send()
            .await
            .expect("connection response")
            .json()
            .await
            .expect("connection json");
        assert_eq!(connection["connection_id"], "conn_multi");
        assert!(connection["lease_expires_at"].as_str().is_some());

        for _ in 0..2 {
            let subscription = client
                .post(format!(
                    "{}/api/headless/sessions/sess_test/subscribe",
                    handle.base_url()
                ))
                .json(&json!({
                    "connectionId": "conn_multi",
                    "role": "controller"
                }))
                .send()
                .await
                .expect("subscription response");
            assert_eq!(subscription.status(), StatusCode::OK);
        }

        let state: serde_json::Value = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/state",
                handle.base_url()
            ))
            .send()
            .await
            .expect("state response")
            .json()
            .await
            .expect("state json");
        assert_eq!(state["state"]["subscriber_count"], 2);
        let connection_state = state["state"]["connections"]
            .as_array()
            .expect("connections")
            .iter()
            .find(|connection| connection["connection_id"] == "conn_multi")
            .expect("conn_multi state");
        assert_eq!(connection_state["subscription_count"], 2);
        assert_eq!(connection_state["client_protocol_version"], "2026-03-30");
        assert_eq!(connection_state["client_info"]["name"], "lease-test");
        assert_eq!(connection_state["capabilities"]["raw_agent_events"], true);
        assert!(connection_state["lease_expires_at"].as_str().is_some());

        let heartbeat: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/heartbeat",
                handle.base_url()
            ))
            .json(&json!({"connectionId": "conn_multi"}))
            .send()
            .await
            .expect("heartbeat response")
            .json()
            .await
            .expect("heartbeat json");
        assert_eq!(heartbeat["controller_lease_granted"], true);
        assert!(heartbeat["lease_expires_at"].as_str().is_some());

        let disconnected: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/disconnect",
                handle.base_url()
            ))
            .json(&json!({"connectionId": "conn_multi"}))
            .send()
            .await
            .expect("disconnect response")
            .json()
            .await
            .expect("disconnect json");
        assert_eq!(
            disconnected["disconnected_subscription_ids"]
                .as_array()
                .expect("disconnected subscriptions")
                .len(),
            2
        );

        let state_after_disconnect: serde_json::Value = client
            .get(format!(
                "{}/api/headless/sessions/sess_test/state",
                handle.base_url()
            ))
            .send()
            .await
            .expect("state response")
            .json()
            .await
            .expect("state json");
        assert_eq!(state_after_disconnect["state"]["subscriber_count"], 0);

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn drain_manifest_filename_stays_inside_snapshot_root() {
        let workspace = tempdir().expect("workspace");
        let snapshot_root = workspace.path().join("snapshots");
        let mut config = test_config(workspace.path().to_path_buf());
        config.runner_session_id = "../evil/session.v1".to_string();
        config.snapshot_root = Some(snapshot_root.clone());
        let handle = start_hosted_runner(config)
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let drain: serde_json::Value = client
            .post(format!(
                "{}/.well-known/evalops/remote-runner/drain",
                handle.base_url()
            ))
            .json(&json!({"reason": "sanitize-session"}))
            .send()
            .await
            .expect("drain response")
            .json()
            .await
            .expect("drain json");
        let manifest_path = PathBuf::from(drain["manifest_path"].as_str().expect("manifest path"));
        assert_eq!(manifest_path.parent(), Some(snapshot_root.as_path()));
        assert!(manifest_path.exists());
        assert!(manifest_path
            .file_name()
            .expect("manifest filename")
            .to_string_lossy()
            .starts_with("___evil_session_v1-"));

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn controller_takeover_is_explicit_and_viewers_cannot_mutate() {
        let workspace = tempdir().expect("workspace");
        let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
            .await
            .expect("start hosted runner");
        let client = reqwest::Client::new();

        let first_controller: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({
                "sessionId": "sess_test",
                "connectionId": "conn_first",
                "role": "controller"
            }))
            .send()
            .await
            .expect("first controller response")
            .json()
            .await
            .expect("first controller json");
        assert_eq!(first_controller["controller_connection_id"], "conn_first");

        let rejected_takeover = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({
                "sessionId": "sess_test",
                "connectionId": "conn_second",
                "role": "controller"
            }))
            .send()
            .await
            .expect("rejected takeover response");
        assert_eq!(rejected_takeover.status(), StatusCode::CONFLICT);

        let accepted_takeover: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({
                "sessionId": "sess_test",
                "connectionId": "conn_second",
                "role": "controller",
                "takeControl": true
            }))
            .send()
            .await
            .expect("accepted takeover response")
            .json()
            .await
            .expect("accepted takeover json");
        assert_eq!(accepted_takeover["controller_connection_id"], "conn_second");

        let controller_message: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/messages",
                handle.base_url()
            ))
            .header("x-maestro-headless-connection-id", "conn_second")
            .json(&json!({"type": "prompt", "content": "cursor please"}))
            .send()
            .await
            .expect("controller message response")
            .json()
            .await
            .expect("controller message json");
        assert_eq!(controller_message["ok"], true);
        assert!(controller_message["cursor"].as_u64().unwrap_or_default() > 0);

        let viewer: serde_json::Value = client
            .post(format!("{}/api/headless/connections", handle.base_url()))
            .json(&json!({
                "sessionId": "sess_test",
                "connectionId": "conn_viewer",
                "role": "viewer"
            }))
            .send()
            .await
            .expect("viewer response")
            .json()
            .await
            .expect("viewer json");
        assert_eq!(viewer["role"], "viewer");
        let viewer_subscription: serde_json::Value = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/subscribe",
                handle.base_url()
            ))
            .json(&json!({
                "connectionId": "conn_viewer",
                "role": "viewer"
            }))
            .send()
            .await
            .expect("viewer subscription response")
            .json()
            .await
            .expect("viewer subscription json");
        let viewer_subscription_id = viewer_subscription["subscription_id"]
            .as_str()
            .expect("viewer subscription id");
        let viewer_message = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/messages",
                handle.base_url()
            ))
            .header("x-maestro-headless-connection-id", "conn_viewer")
            .header("x-maestro-headless-subscriber-id", viewer_subscription_id)
            .json(&json!({"type": "prompt", "content": "nope"}))
            .send()
            .await
            .expect("viewer message response");
        assert_eq!(viewer_message.status(), StatusCode::FORBIDDEN);

        handle.shutdown().await;
    }
}
