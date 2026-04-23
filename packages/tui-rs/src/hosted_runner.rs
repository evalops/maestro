//! Hosted runner contract primitives.
//!
//! Platform-created Maestro runners expose a small provider-neutral surface:
//! identity/readiness, drain snapshots, and the shared headless attach routes.
//! This module keeps the Rust runtime aligned with the TypeScript host contract
//! without baking GKE, Daytona, Modal, or other substrate details into Maestro.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

pub const HOSTED_RUNNER_IDENTITY_PATH: &str = "/.well-known/evalops/remote-runner/identity";
pub const HOSTED_RUNNER_DRAIN_PATH: &str = "/.well-known/evalops/remote-runner/drain";

pub const HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION: &str = "evalops.remote-runner.identity.v1";
pub const HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION: &str = "evalops.remote-runner.drain.v1";
pub const HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION: &str =
    "evalops.remote-runner.snapshot-manifest.v1";

const DEFAULT_LISTEN_PORT: u16 = 8080;
const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;

const HEADLESS_PATH_PREFIXES: &[&str] = &["/api/headless/connections", "/api/headless/sessions/"];

/// Resolved hosted-runner configuration passed by Platform/deploy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedRunnerConfig {
    pub runner_session_id: String,
    pub owner_instance_id: Option<String>,
    pub workspace_root: PathBuf,
    pub snapshot_root: PathBuf,
    pub host: Option<String>,
    pub port: u16,
    pub workspace_id: Option<String>,
    pub agent_run_id: Option<String>,
    pub maestro_session_id: Option<String>,
    pub attach_audience: Option<String>,
}

impl HostedRunnerConfig {
    /// Resolve configuration from the current process environment.
    pub fn from_env() -> Result<Self, HostedRunnerError> {
        let env = std::env::vars().collect::<HashMap<_, _>>();
        Self::from_env_map(&env)
    }

    /// Resolve configuration from an explicit environment map.
    ///
    /// This mirrors the TypeScript `maestro hosted-runner` contract so tests
    /// and future Rust entrypoints can share the same env names.
    pub fn from_env_map(env: &HashMap<String, String>) -> Result<Self, HostedRunnerError> {
        let runner_session_id = first_env(
            env,
            &["MAESTRO_RUNNER_SESSION_ID", "REMOTE_RUNNER_SESSION_ID"],
        )
        .ok_or_else(|| {
            HostedRunnerError::invalid_config(
                "maestro hosted-runner requires MAESTRO_RUNNER_SESSION_ID",
            )
        })?;

        let workspace_root = resolve_workspace_root(
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

        Ok(Self {
            runner_session_id,
            owner_instance_id: first_env(
                env,
                &[
                    "MAESTRO_REMOTE_RUNNER_OWNER_INSTANCE_ID",
                    "REMOTE_RUNNER_OWNER_INSTANCE_ID",
                ],
            ),
            workspace_root,
            snapshot_root,
            host: listen
                .host
                .or_else(|| env_value(env, "MAESTRO_HOSTED_RUNNER_HOST")),
            port,
            workspace_id: first_env(
                env,
                &["MAESTRO_REMOTE_RUNNER_WORKSPACE_ID", "MAESTRO_WORKSPACE_ID"],
            ),
            agent_run_id: env_value(env, "MAESTRO_AGENT_RUN_ID"),
            maestro_session_id: env_value(env, "MAESTRO_SESSION_ID"),
            attach_audience: env_value(env, "MAESTRO_ATTACH_AUDIENCE"),
        })
    }

    /// Build a config directly for tests or embedding.
    pub fn new(
        runner_session_id: impl Into<String>,
        workspace_root: impl AsRef<Path>,
    ) -> Result<Self, HostedRunnerError> {
        let workspace_root = resolve_workspace_root(Some(path_to_str(workspace_root.as_ref())?))?;
        Ok(Self {
            runner_session_id: non_empty(runner_session_id.into(), "runner_session_id")?,
            owner_instance_id: None,
            snapshot_root: workspace_root.join(".maestro").join("runner-snapshots"),
            workspace_root,
            host: None,
            port: DEFAULT_LISTEN_PORT,
            workspace_id: None,
            agent_run_id: None,
            maestro_session_id: None,
            attach_audience: None,
        })
    }

    pub fn with_owner_instance_id(mut self, owner_instance_id: impl Into<String>) -> Self {
        self.owner_instance_id = Some(owner_instance_id.into());
        self
    }

    pub fn with_snapshot_root(mut self, snapshot_root: impl Into<PathBuf>) -> Self {
        self.snapshot_root = snapshot_root.into();
        self
    }

    pub fn with_workspace_id(mut self, workspace_id: impl Into<String>) -> Self {
        self.workspace_id = Some(workspace_id.into());
        self
    }

    pub fn with_agent_run_id(mut self, agent_run_id: impl Into<String>) -> Self {
        self.agent_run_id = Some(agent_run_id.into());
        self
    }

    pub fn with_maestro_session_id(mut self, maestro_session_id: impl Into<String>) -> Self {
        self.maestro_session_id = Some(maestro_session_id.into());
        self
    }
}

#[derive(Debug, Clone)]
pub struct HostedRunnerRuntime {
    inner: Arc<Mutex<HostedRunnerRuntimeInner>>,
}

#[derive(Debug, Clone)]
struct HostedRunnerRuntimeInner {
    config: HostedRunnerConfig,
    ready: bool,
    draining: bool,
}

impl HostedRunnerRuntime {
    pub fn new(config: HostedRunnerConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HostedRunnerRuntimeInner {
                config,
                ready: true,
                draining: false,
            })),
        }
    }

    pub fn config(&self) -> HostedRunnerConfig {
        self.inner
            .lock()
            .expect("hosted runner mutex poisoned")
            .config
            .clone()
    }

    pub fn set_ready(&self, ready: bool) {
        self.inner
            .lock()
            .expect("hosted runner mutex poisoned")
            .ready = ready;
    }

    pub fn is_draining(&self) -> bool {
        self.inner
            .lock()
            .expect("hosted runner mutex poisoned")
            .draining
    }

    pub fn identity(&self) -> Result<HostedRunnerIdentity, HostedRunnerError> {
        let inner = self.inner.lock().expect("hosted runner mutex poisoned");
        let owner_instance_id = inner.config.owner_instance_id.clone().ok_or_else(|| {
            HostedRunnerError::runtime_not_ready("hosted runner identity unavailable")
        })?;
        Ok(HostedRunnerIdentity {
            protocol_version: HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION.to_string(),
            runner_session_id: inner.config.runner_session_id.clone(),
            owner_instance_id,
            ready: inner.ready && !inner.draining,
            draining: inner.draining,
        })
    }

    pub fn drain(
        &self,
        input: HostedRunnerDrainInput,
    ) -> Result<HostedRunnerDrainResult, HostedRunnerError> {
        let requested_at = Utc::now();
        self.drain_at(input, requested_at, Utc::now())
    }

    pub fn drain_at(
        &self,
        input: HostedRunnerDrainInput,
        requested_at: DateTime<Utc>,
        completed_at: DateTime<Utc>,
    ) -> Result<HostedRunnerDrainResult, HostedRunnerError> {
        {
            let mut inner = self.inner.lock().expect("hosted runner mutex poisoned");
            inner.draining = true;
        }

        let config = self.config();
        let workspace_root = resolve_workspace_root(Some(path_to_str(&config.workspace_root)?))?;
        let export_paths = resolve_workspace_export_paths(&workspace_root, input.export_paths())?;
        fs::create_dir_all(&config.snapshot_root).map_err(|error| {
            HostedRunnerError::internal(format!(
                "failed to create hosted runner snapshot root: {error}"
            ))
        })?;

        let requested_at_string = format_timestamp(requested_at);
        let completed_at_string = format_timestamp(completed_at);
        let snapshot_path = config.snapshot_root.join(safe_manifest_file_name(
            &config.runner_session_id,
            &requested_at_string,
        ));
        let runtime = HostedRunnerManifestRuntime {
            flush_status: RuntimeFlushStatus::Skipped,
            error: None,
            session_id: config.maestro_session_id.clone(),
            session_file: None,
            protocol_version: None,
            cursor: None,
        };
        let manifest = HostedRunnerSnapshotManifest {
            manifest_version: HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION.to_string(),
            protocol_version: HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION.to_string(),
            status: SnapshotManifestStatus::Drained,
            runner_session_id: config.runner_session_id,
            owner_instance_id: config.owner_instance_id,
            workspace_id: config.workspace_id,
            agent_run_id: config.agent_run_id,
            maestro_session_id: config.maestro_session_id,
            workspace_root: workspace_root.display().to_string(),
            snapshot_root: config.snapshot_root.display().to_string(),
            snapshot_path: snapshot_path.display().to_string(),
            requested_at: requested_at_string,
            completed_at: completed_at_string,
            stop_reason: input
                .reason
                .unwrap_or_else(|| "platform_requested_drain".to_string()),
            requested_by: input.requested_by,
            runtime,
            workspace_export: HostedRunnerWorkspaceExport {
                mode: "local_path_contract".to_string(),
                paths: export_paths,
            },
            git: collect_git_state(&workspace_root),
        };

        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|error| HostedRunnerError::internal(error.to_string()))?;
        fs::write(&snapshot_path, format!("{manifest_json}\n")).map_err(|error| {
            HostedRunnerError::internal(format!(
                "failed to write hosted runner snapshot manifest: {error}"
            ))
        })?;

        Ok(HostedRunnerDrainResult {
            status: SnapshotManifestStatus::Drained,
            manifest_path: snapshot_path,
            manifest,
        })
    }

    /// Handle a contract route without committing to a specific Rust HTTP stack.
    ///
    /// A future axum/hyper entrypoint can adapt real requests to this function,
    /// while conformance tests can already exercise the protocol shape.
    pub fn handle_request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> HostedRunnerHttpResponse {
        match (method, path) {
            ("GET", HOSTED_RUNNER_IDENTITY_PATH) => self
                .identity()
                .map(|identity| HostedRunnerHttpResponse::json(200, json!(identity)))
                .unwrap_or_else(HostedRunnerHttpResponse::from_error),
            (_, HOSTED_RUNNER_IDENTITY_PATH) => HostedRunnerHttpResponse::json(
                405,
                json!({
                    "error": "method_not_allowed",
                    "code": "bad_request"
                }),
            ),
            ("POST", HOSTED_RUNNER_DRAIN_PATH) => match parse_drain_body(body) {
                Ok(input) => self
                    .drain(input)
                    .map(|result| {
                        HostedRunnerHttpResponse::json(
                            200,
                            json!({
                                "protocol_version": HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION,
                                "status": result.status,
                                "manifest_path": result.manifest_path,
                                "manifest": result.manifest
                            }),
                        )
                    })
                    .unwrap_or_else(HostedRunnerHttpResponse::from_error),
                Err(error) => HostedRunnerHttpResponse::from_error(error),
            },
            (_, HOSTED_RUNNER_DRAIN_PATH) => HostedRunnerHttpResponse::json(
                405,
                json!({
                    "error": "method_not_allowed",
                    "code": "bad_request"
                }),
            ),
            _ if is_headless_path(path) => HostedRunnerHttpResponse::json(
                501,
                json!({
                    "error": "headless host surface not implemented in Rust yet",
                    "code": "unsupported_capability",
                    "capability": "headless_http_host"
                }),
            ),
            _ => HostedRunnerHttpResponse::json(
                404,
                json!({
                    "error": "not_found",
                    "code": "bad_request"
                }),
            ),
        }
    }
}

/// Serve the hosted-runner identity/drain surface on an existing TCP listener.
///
/// This intentionally only adapts HTTP requests onto the provider-neutral
/// route core. The full headless HTTP/SSE host remains a separate layer.
pub async fn serve_hosted_runner_http(
    listener: TcpListener,
    runtime: HostedRunnerRuntime,
    shutdown: CancellationToken,
) -> io::Result<()> {
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return Ok(()),
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let runtime = runtime.clone();
                tokio::spawn(async move {
                    let _ = handle_hosted_runner_http_stream(stream, runtime).await;
                });
            }
        }
    }
}

async fn handle_hosted_runner_http_stream(
    mut stream: TcpStream,
    runtime: HostedRunnerRuntime,
) -> io::Result<()> {
    let response = match read_http_request(&mut stream).await {
        Ok(request) => {
            let body = (!request.body.is_empty()).then_some(request.body.as_str());
            runtime.handle_request(&request.method, &request.path, body)
        }
        Err(error) if error.kind() == io::ErrorKind::InvalidData => HostedRunnerHttpResponse::json(
            400,
            json!({
                "error": error.to_string(),
                "code": "bad_request"
            }),
        ),
        Err(error) => return Err(error),
    };
    write_http_response(&mut stream, response).await
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HostedRunnerHttpRequest {
    method: String,
    path: String,
    body: String,
}

async fn read_http_request(stream: &mut TcpStream) -> io::Result<HostedRunnerHttpRequest> {
    let mut bytes = Vec::with_capacity(4096);
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        if let Some(index) = find_http_header_end(&bytes) {
            break index;
        }
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Err(invalid_http("connection closed before HTTP headers"));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > MAX_HTTP_HEADER_BYTES {
            return Err(invalid_http("HTTP headers exceed hosted runner limit"));
        }
    };

    let header_text = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| invalid_http("HTTP headers must be UTF-8"))?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .filter(|line| !line.trim().is_empty())
        .ok_or_else(|| invalid_http("missing HTTP request line"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| invalid_http("missing HTTP method"))?;
    let target = parts
        .next()
        .ok_or_else(|| invalid_http("missing HTTP target"))?;
    let version = parts
        .next()
        .ok_or_else(|| invalid_http("missing HTTP version"))?;
    if !version.starts_with("HTTP/1.") {
        return Err(invalid_http("only HTTP/1.x requests are supported"));
    }
    let method = method.to_string();
    let path = target.split('?').next().unwrap_or(target).to_string();

    let mut content_length = 0_usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value
                .trim()
                .parse::<usize>()
                .map_err(|_| invalid_http("invalid content-length header"))?;
        }
    }
    if content_length > MAX_HTTP_BODY_BYTES {
        return Err(invalid_http("HTTP body exceeds hosted runner limit"));
    }

    let body_start = header_end + 4;
    while bytes.len() < body_start + content_length {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Err(invalid_http("connection closed before HTTP body"));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    let body = std::str::from_utf8(&bytes[body_start..body_start + content_length])
        .map_err(|_| invalid_http("HTTP body must be UTF-8"))?
        .to_string();

    Ok(HostedRunnerHttpRequest { method, path, body })
}

async fn write_http_response(
    stream: &mut TcpStream,
    response: HostedRunnerHttpResponse,
) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body).map_err(io::Error::other)?;
    let headers = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        http_reason(response.status),
        body.len()
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.shutdown().await
}

fn find_http_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn invalid_http(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn http_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        _ => "Unknown",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerIdentity {
    pub protocol_version: String,
    pub runner_session_id: String,
    pub owner_instance_id: String,
    pub ready: bool,
    pub draining: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostedRunnerDrainInput {
    pub reason: Option<String>,
    pub requested_by: Option<String>,
    pub export_paths: Option<Vec<String>>,
}

impl HostedRunnerDrainInput {
    fn export_paths(&self) -> Option<&[String]> {
        self.export_paths.as_deref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerDrainResult {
    pub status: SnapshotManifestStatus,
    pub manifest_path: PathBuf,
    pub manifest: HostedRunnerSnapshotManifest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerSnapshotManifest {
    pub manifest_version: String,
    pub protocol_version: String,
    pub status: SnapshotManifestStatus,
    pub runner_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maestro_session_id: Option<String>,
    pub workspace_root: String,
    pub snapshot_root: String,
    pub snapshot_path: String,
    pub requested_at: String,
    pub completed_at: String,
    pub stop_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
    pub runtime: HostedRunnerManifestRuntime,
    pub workspace_export: HostedRunnerWorkspaceExport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<HostedRunnerGitState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotManifestStatus {
    Drained,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerManifestRuntime {
    pub flush_status: RuntimeFlushStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeFlushStatus {
    Completed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerWorkspaceExport {
    pub mode: String,
    pub paths: Vec<HostedRunnerWorkspaceExportPath>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerWorkspaceExportPath {
    pub input: String,
    pub path: String,
    pub relative_path: String,
    #[serde(rename = "type")]
    pub entry_type: HostedRunnerWorkspaceExportPathType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostedRunnerWorkspaceExportPathType {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerGitState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedRunnerHttpResponse {
    pub status: u16,
    pub body: Value,
}

impl HostedRunnerHttpResponse {
    pub fn json(status: u16, body: Value) -> Self {
        Self { status, body }
    }

    pub fn from_error(error: HostedRunnerError) -> Self {
        Self::json(
            error.http_status(),
            json!({
                "error": error.message,
                "code": error.code.as_str()
            }),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedRunnerErrorCode {
    InvalidConfig,
    BadRequest,
    RuntimeNotReady,
    WorkspaceViolation,
    UnsupportedCapability,
    Internal,
}

impl HostedRunnerErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidConfig => "invalid_config",
            Self::BadRequest => "bad_request",
            Self::RuntimeNotReady => "runtime_not_ready",
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

    pub fn runtime_not_ready(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::RuntimeNotReady, message)
    }

    pub fn workspace_violation(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::WorkspaceViolation, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::Internal, message)
    }

    pub fn http_status(&self) -> u16 {
        match self.code {
            HostedRunnerErrorCode::InvalidConfig
            | HostedRunnerErrorCode::BadRequest
            | HostedRunnerErrorCode::WorkspaceViolation => 400,
            HostedRunnerErrorCode::RuntimeNotReady => 503,
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

fn parse_listen(value: Option<&str>) -> Result<ParsedListen, HostedRunnerError> {
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
        return Err(HostedRunnerError::invalid_config(
            "MAESTRO_HOSTED_RUNNER_LISTEN must be <host:port> or <port>",
        ));
    };
    if host.trim().is_empty() || port.trim().is_empty() {
        return Err(HostedRunnerError::invalid_config(
            "MAESTRO_HOSTED_RUNNER_LISTEN must be <host:port> or <port>",
        ));
    }
    Ok(ParsedListen {
        host: Some(host.trim().to_string()),
        port: Some(parse_port(port.trim(), "MAESTRO_HOSTED_RUNNER_LISTEN")?),
    })
}

fn parse_optional_port(value: Option<&str>) -> Option<Result<u16, HostedRunnerError>> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| parse_port(value, "hosted runner port"))
}

fn parse_port(value: &str, label: &str) -> Result<u16, HostedRunnerError> {
    if !value.chars().all(|char| char.is_ascii_digit()) {
        return Err(HostedRunnerError::invalid_config(format!(
            "{label} must be a TCP port between 1 and 65535"
        )));
    }
    let port = value.parse::<u32>().map_err(|_| {
        HostedRunnerError::invalid_config(format!("{label} must be a TCP port between 1 and 65535"))
    })?;
    if !(1..=65535).contains(&port) {
        return Err(HostedRunnerError::invalid_config(format!(
            "{label} must be a TCP port between 1 and 65535"
        )));
    }
    Ok(port as u16)
}

fn resolve_workspace_root(path: Option<&str>) -> Result<PathBuf, HostedRunnerError> {
    let path = path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            HostedRunnerError::invalid_config(
                "maestro hosted-runner requires MAESTRO_WORKSPACE_ROOT",
            )
        })?;
    let workspace_root = fs::canonicalize(Path::new(path)).map_err(|error| {
        HostedRunnerError::invalid_config(format!(
            "hosted runner workspace root is unavailable: {error}"
        ))
    })?;
    let metadata = fs::metadata(&workspace_root).map_err(|error| {
        HostedRunnerError::invalid_config(format!(
            "hosted runner workspace root is unavailable: {error}"
        ))
    })?;
    if !metadata.is_dir() {
        return Err(HostedRunnerError::invalid_config(
            "hosted runner workspace root is not a directory",
        ));
    }
    Ok(workspace_root)
}

fn resolve_snapshot_root(path: Option<&str>, workspace_root: &Path) -> PathBuf {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
        return workspace_root.join(".maestro").join("runner-snapshots");
    };
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        workspace_root.join(path)
    }
}

fn path_to_str(path: &Path) -> Result<&str, HostedRunnerError> {
    path.to_str()
        .ok_or_else(|| HostedRunnerError::invalid_config("path must be valid UTF-8"))
}

fn non_empty(value: String, field: &str) -> Result<String, HostedRunnerError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(HostedRunnerError::invalid_config(format!(
            "{field} must not be empty"
        )));
    }
    Ok(value)
}

fn parse_drain_body(body: Option<&str>) -> Result<HostedRunnerDrainInput, HostedRunnerError> {
    let body = body.map(str::trim).unwrap_or("");
    if body.is_empty() {
        return Ok(HostedRunnerDrainInput::default());
    }
    let value = serde_json::from_str::<Value>(body)
        .map_err(|error| HostedRunnerError::bad_request(format!("invalid JSON body: {error}")))?;
    parse_hosted_runner_drain_input(&value)
}

pub fn parse_hosted_runner_drain_input(
    value: &Value,
) -> Result<HostedRunnerDrainInput, HostedRunnerError> {
    let Value::Object(record) = value else {
        return Err(HostedRunnerError::bad_request(
            "drain payload must be a JSON object",
        ));
    };
    let reason = match get_string(record.get("reason"), "reason")? {
        Some(value) => Some(value),
        None => get_string(record.get("stop_reason"), "stop_reason")?,
    };
    let requested_by = match get_string(record.get("requested_by"), "requested_by")? {
        Some(value) => Some(value),
        None => get_string(record.get("requestedBy"), "requestedBy")?,
    };
    let export_paths = match get_string_array(record.get("export_paths"), "export_paths")? {
        Some(value) => Some(value),
        None => get_string_array(record.get("exportPaths"), "exportPaths")?,
    };
    Ok(HostedRunnerDrainInput {
        reason,
        requested_by,
        export_paths,
    })
}

fn get_string(value: Option<&Value>, field: &str) -> Result<Option<String>, HostedRunnerError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(value) = value.as_str() else {
        return Err(HostedRunnerError::bad_request(format!(
            "{field} must be a string"
        )));
    };
    let value = value.trim();
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(value.to_string()))
    }
}

fn get_string_array(
    value: Option<&Value>,
    field: &str,
) -> Result<Option<Vec<String>>, HostedRunnerError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(values) = value.as_array() else {
        return Err(HostedRunnerError::bad_request(format!(
            "{field} must be an array of strings"
        )));
    };
    let mut strings = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let Some(value) = value.as_str() else {
            return Err(HostedRunnerError::bad_request(format!(
                "{field}[{index}] must be a non-empty string"
            )));
        };
        let value = value.trim();
        if value.is_empty() {
            return Err(HostedRunnerError::bad_request(format!(
                "{field}[{index}] must be a non-empty string"
            )));
        }
        if value.contains('\0') {
            return Err(HostedRunnerError::bad_request(format!(
                "{field}[{index}] contains a null byte"
            )));
        }
        strings.push(value.to_string());
    }
    Ok((!strings.is_empty()).then_some(strings))
}

fn resolve_workspace_export_paths(
    workspace_root: &Path,
    export_paths: Option<&[String]>,
) -> Result<Vec<HostedRunnerWorkspaceExportPath>, HostedRunnerError> {
    let default_path;
    let requested = if let Some(export_paths) = export_paths {
        export_paths
    } else {
        default_path = vec![".".to_string()];
        &default_path
    };

    requested
        .iter()
        .map(|input| resolve_workspace_export_path(workspace_root, input))
        .collect()
}

fn resolve_workspace_export_path(
    workspace_root: &Path,
    input: &str,
) -> Result<HostedRunnerWorkspaceExportPath, HostedRunnerError> {
    let logical_path = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        workspace_root.join(input)
    };
    let real_path = fs::canonicalize(&logical_path).map_err(|error| {
        HostedRunnerError::bad_request(format!("export path is unavailable: {input} ({error})"))
    })?;
    if !real_path.starts_with(workspace_root) {
        return Err(HostedRunnerError::workspace_violation(format!(
            "export path escapes hosted runner workspace root: {input}"
        )));
    }
    let metadata = fs::metadata(&real_path).map_err(|error| {
        HostedRunnerError::bad_request(format!("export path is unavailable: {input} ({error})"))
    })?;
    let relative_path = real_path
        .strip_prefix(workspace_root)
        .ok()
        .and_then(|path| {
            let rendered = path.display().to_string();
            (!rendered.is_empty()).then_some(rendered)
        })
        .unwrap_or_else(|| ".".to_string());

    Ok(HostedRunnerWorkspaceExportPath {
        input: input.to_string(),
        path: real_path.display().to_string(),
        relative_path,
        entry_type: if metadata.is_dir() {
            HostedRunnerWorkspaceExportPathType::Directory
        } else {
            HostedRunnerWorkspaceExportPathType::File
        },
    })
}

fn safe_manifest_file_name(runner_session_id: &str, requested_at: &str) -> String {
    format!(
        "{}-{}.json",
        safe_component(runner_session_id),
        safe_component(requested_at)
    )
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '.' | '_' | '-') {
                char
            } else {
                '_'
            }
        })
        .collect()
}

fn format_timestamp(timestamp: DateTime<Utc>) -> String {
    timestamp.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn git_output(workspace_root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let stdout = stdout.trim();
    (!stdout.is_empty()).then(|| stdout.to_string())
}

fn collect_git_state(workspace_root: &Path) -> Option<HostedRunnerGitState> {
    let commit = git_output(workspace_root, &["rev-parse", "HEAD"]);
    let branch = git_output(workspace_root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .filter(|branch| branch != "HEAD");
    let dirty = git_output(workspace_root, &["status", "--porcelain"]).is_some();
    if commit.is_none() && branch.is_none() && !dirty {
        None
    } else {
        Some(HostedRunnerGitState {
            commit,
            branch,
            dirty,
        })
    }
}

fn is_headless_path(path: &str) -> bool {
    HEADLESS_PATH_PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    fn runtime() -> (TempDir, HostedRunnerRuntime) {
        let temp_dir = TempDir::new().unwrap();
        fs::write(temp_dir.path().join("file.txt"), "hello\n").unwrap();
        let config = HostedRunnerConfig::new("mrs/test:1", temp_dir.path())
            .unwrap()
            .with_owner_instance_id("owner-1")
            .with_workspace_id("workspace-1")
            .with_agent_run_id("agent-run-1")
            .with_maestro_session_id("maestro-session-1");
        (temp_dir, HostedRunnerRuntime::new(config))
    }

    #[test]
    fn resolves_env_config_with_contract_names() {
        let temp_dir = TempDir::new().unwrap();
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
            temp_dir.path().display().to_string(),
        );
        env.insert(
            "MAESTRO_HOSTED_RUNNER_LISTEN".to_string(),
            "0.0.0.0:9090".to_string(),
        );
        env.insert(
            "MAESTRO_REMOTE_RUNNER_WORKSPACE_ID".to_string(),
            "workspace_1".to_string(),
        );
        let config = HostedRunnerConfig::from_env_map(&env).unwrap();
        assert_eq!(config.runner_session_id, "mrs_123");
        assert_eq!(config.owner_instance_id.as_deref(), Some("pod_1"));
        assert_eq!(
            config.workspace_root,
            temp_dir.path().canonicalize().unwrap()
        );
        assert_eq!(
            config.snapshot_root,
            temp_dir
                .path()
                .canonicalize()
                .unwrap()
                .join(".maestro")
                .join("runner-snapshots")
        );
        assert_eq!(config.host.as_deref(), Some("0.0.0.0"));
        assert_eq!(config.port, 9090);
        assert_eq!(config.workspace_id.as_deref(), Some("workspace_1"));
    }

    #[test]
    fn identity_reflects_ready_and_draining_state() {
        let (_temp_dir, runtime) = runtime();
        let identity = runtime.identity().unwrap();
        assert_eq!(
            identity.protocol_version,
            HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION
        );
        assert_eq!(identity.runner_session_id, "mrs/test:1");
        assert_eq!(identity.owner_instance_id, "owner-1");
        assert!(identity.ready);
        assert!(!identity.draining);

        runtime.set_ready(false);
        let identity = runtime.identity().unwrap();
        assert!(!identity.ready);
        assert!(!identity.draining);
    }

    #[test]
    fn drain_writes_manifest_and_marks_runtime_non_attachable() {
        let (temp_dir, runtime) = runtime();
        let requested_at = DateTime::parse_from_rfc3339("2026-04-23T12:34:56.789Z")
            .unwrap()
            .with_timezone(&Utc);
        let completed_at = DateTime::parse_from_rfc3339("2026-04-23T12:34:57.001Z")
            .unwrap()
            .with_timezone(&Utc);
        let result = runtime
            .drain_at(
                HostedRunnerDrainInput {
                    reason: Some("ttl_expired".to_string()),
                    requested_by: Some("platform".to_string()),
                    export_paths: Some(vec!["file.txt".to_string()]),
                },
                requested_at,
                completed_at,
            )
            .unwrap();

        assert!(runtime.is_draining());
        let identity = runtime.identity().unwrap();
        assert!(!identity.ready);
        assert!(identity.draining);

        assert_eq!(result.status, SnapshotManifestStatus::Drained);
        assert!(result.manifest_path.exists());
        assert!(result
            .manifest_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("mrs_test_1-2026-04-23T12_34_56.789Z"));
        assert_eq!(
            result.manifest.manifest_version,
            HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION
        );
        assert_eq!(
            result.manifest.protocol_version,
            HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION
        );
        assert_eq!(result.manifest.stop_reason, "ttl_expired");
        assert_eq!(result.manifest.requested_by.as_deref(), Some("platform"));
        assert_eq!(
            result.manifest.workspace_export.paths[0].relative_path,
            "file.txt"
        );
        assert_eq!(
            result.manifest.workspace_export.paths[0].entry_type,
            HostedRunnerWorkspaceExportPathType::File
        );

        let written = fs::read_to_string(&result.manifest_path).unwrap();
        let written: HostedRunnerSnapshotManifest = serde_json::from_str(&written).unwrap();
        assert_eq!(written, result.manifest);
        assert!(result.manifest_path.starts_with(
            temp_dir
                .path()
                .join(".maestro")
                .join("runner-snapshots")
                .canonicalize()
                .unwrap_or_else(|_| temp_dir.path().join(".maestro").join("runner-snapshots"))
        ));
    }

    #[test]
    fn drain_rejects_workspace_escape() {
        let temp_dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "secret\n").unwrap();
        let runtime = HostedRunnerRuntime::new(
            HostedRunnerConfig::new("mrs_123", temp_dir.path())
                .unwrap()
                .with_owner_instance_id("owner-1"),
        );

        let error = runtime
            .drain(HostedRunnerDrainInput {
                export_paths: Some(vec![outside_file.display().to_string()]),
                ..HostedRunnerDrainInput::default()
            })
            .unwrap_err();
        assert_eq!(error.code, HostedRunnerErrorCode::WorkspaceViolation);
        assert!(runtime.is_draining());
    }

    #[test]
    fn parses_drain_payload_snake_and_camel_names() {
        let input = parse_hosted_runner_drain_input(&json!({
            "stop_reason": "budget_exhausted",
            "requestedBy": "platform",
            "exportPaths": ["."]
        }))
        .unwrap();
        assert_eq!(input.reason.as_deref(), Some("budget_exhausted"));
        assert_eq!(input.requested_by.as_deref(), Some("platform"));
        assert_eq!(input.export_paths.as_deref(), Some(&[".".to_string()][..]));
    }

    #[test]
    fn request_handler_exposes_identity_and_drain_shapes() {
        let (_temp_dir, runtime) = runtime();
        let identity = runtime.handle_request("GET", HOSTED_RUNNER_IDENTITY_PATH, None);
        assert_eq!(identity.status, 200);
        assert_eq!(
            identity.body["protocol_version"],
            HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION
        );

        let drain = runtime.handle_request(
            "POST",
            HOSTED_RUNNER_DRAIN_PATH,
            Some(r#"{"reason":"user_stop","export_paths":["."]}"#),
        );
        assert_eq!(drain.status, 200);
        assert_eq!(
            drain.body["protocol_version"],
            HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION
        );
        assert_eq!(drain.body["status"], "drained");
        assert_eq!(
            drain.body["manifest"]["manifest_version"],
            HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION
        );
    }

    #[test]
    fn request_handler_marks_headless_host_routes_as_unsupported_for_now() {
        let (_temp_dir, runtime) = runtime();
        let response = runtime.handle_request("POST", "/api/headless/connections", Some("{}"));
        assert_eq!(response.status, 501);
        assert_eq!(response.body["code"], "unsupported_capability");
        assert_eq!(response.body["capability"], "headless_http_host");
    }

    #[tokio::test]
    async fn http_listener_serves_identity_and_drain_routes() {
        let (_temp_dir, runtime) = runtime();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let shutdown = CancellationToken::new();
        let server = tokio::spawn(serve_hosted_runner_http(
            listener,
            runtime.clone(),
            shutdown.clone(),
        ));

        let client = reqwest::Client::new();
        let identity = client
            .get(format!("http://{address}{HOSTED_RUNNER_IDENTITY_PATH}"))
            .send()
            .await
            .unwrap();
        assert_eq!(identity.status(), reqwest::StatusCode::OK);
        let identity = identity.json::<Value>().await.unwrap();
        assert_eq!(
            identity["protocol_version"],
            HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION
        );
        assert_eq!(identity["ready"], true);

        let drain = client
            .post(format!("http://{address}{HOSTED_RUNNER_DRAIN_PATH}"))
            .json(&json!({
                "reason": "user_stop",
                "export_paths": ["."]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(drain.status(), reqwest::StatusCode::OK);
        let drain = drain.json::<Value>().await.unwrap();
        assert_eq!(
            drain["protocol_version"],
            HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION
        );
        assert_eq!(drain["status"], "drained");
        assert_eq!(
            drain["manifest"]["manifest_version"],
            HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION
        );
        assert!(runtime.is_draining());

        shutdown.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn http_listener_reports_headless_routes_as_unsupported() {
        let (_temp_dir, runtime) = runtime();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let shutdown = CancellationToken::new();
        let server = tokio::spawn(serve_hosted_runner_http(
            listener,
            runtime,
            shutdown.clone(),
        ));

        let response = reqwest::Client::new()
            .post(format!("http://{address}/api/headless/connections"))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_IMPLEMENTED);
        let body = response.json::<Value>().await.unwrap();
        assert_eq!(body["code"], "unsupported_capability");
        assert_eq!(body["capability"], "headless_http_host");

        shutdown.cancel();
        server.await.unwrap().unwrap();
    }
}
