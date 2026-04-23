//! Hosted runner contract primitives.
//!
//! Platform-created Maestro runners expose a small provider-neutral surface:
//! identity/readiness, drain snapshots, and the shared headless attach routes.
//! This module keeps the Rust runtime aligned with the TypeScript host contract
//! without baking GKE, Daytona, Modal, or other substrate details into Maestro.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::headless::{
    ClientCapabilities, ClientInfo, ConnectionRole, FromAgentMessage, ServerRequestType,
    ToAgentMessage, UtilityOperation, HEADLESS_PROTOCOL_VERSION,
};

pub const HOSTED_RUNNER_IDENTITY_PATH: &str = "/.well-known/evalops/remote-runner/identity";
pub const HOSTED_RUNNER_DRAIN_PATH: &str = "/.well-known/evalops/remote-runner/drain";

pub const HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION: &str = "evalops.remote-runner.identity.v1";
pub const HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION: &str = "evalops.remote-runner.drain.v1";
pub const HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION: &str =
    "evalops.remote-runner.snapshot-manifest.v1";

const DEFAULT_LISTEN_PORT: u16 = 8080;
const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
const HEADLESS_CONNECTIONS_PATH: &str = "/api/headless/connections";
const HEADLESS_SESSIONS_PREFIX: &str = "/api/headless/sessions/";
const HEADLESS_HEARTBEAT_INTERVAL_MS: u64 = 15_000;
const HEADLESS_CONNECTION_IDLE_MS: i64 = (HEADLESS_HEARTBEAT_INTERVAL_MS as i64) * 3;
const MAX_HEADLESS_REPLAY_EVENTS: usize = 128;

const HEADLESS_PATH_PREFIXES: &[&str] = &[HEADLESS_CONNECTIONS_PATH, HEADLESS_SESSIONS_PREFIX];

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
    headless_session_id: String,
    headless_connections: HashMap<String, HostedRunnerHeadlessConnectionRecord>,
    controller_connection_id: Option<String>,
    next_connection_sequence: u64,
    next_subscription_sequence: u64,
    headless_events: Vec<HostedRunnerHeadlessStreamEnvelope>,
    next_headless_cursor: u64,
}

impl HostedRunnerRuntime {
    pub fn new(config: HostedRunnerConfig) -> Self {
        let headless_session_id = config
            .maestro_session_id
            .clone()
            .unwrap_or_else(|| config.runner_session_id.clone());
        Self {
            inner: Arc::new(Mutex::new(HostedRunnerRuntimeInner {
                config,
                ready: true,
                draining: false,
                headless_session_id,
                headless_connections: HashMap::new(),
                controller_connection_id: None,
                next_connection_sequence: 1,
                next_subscription_sequence: 1,
                headless_events: Vec::new(),
                next_headless_cursor: 1,
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
        let stop_reason = input
            .reason
            .clone()
            .unwrap_or_else(|| "platform_requested_drain".to_string());
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
        let runtime = {
            let mut inner = self.inner.lock().expect("hosted runner mutex poisoned");
            inner.publish_drain_status_if_active(&stop_reason);
            inner.drain_manifest_runtime()
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
            stop_reason,
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
        self.handle_request_with_headers(method, path, body, &HashMap::new())
    }

    fn handle_request_with_headers(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
        headers: &HashMap<String, String>,
    ) -> HostedRunnerHttpResponse {
        let route_path = http_route_path(path);
        match (method, route_path) {
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
            ("POST", HEADLESS_CONNECTIONS_PATH) => match parse_headless_body::<
                HostedRunnerHeadlessConnectionInput,
            >(body, "headless connection")
            {
                Ok(input) => self
                    .register_headless_connection(input)
                    .map(|snapshot| HostedRunnerHttpResponse::json(200, json!(snapshot)))
                    .unwrap_or_else(HostedRunnerHttpResponse::from_error),
                Err(error) => HostedRunnerHttpResponse::from_error(error),
            },
            (_, HEADLESS_CONNECTIONS_PATH) => method_not_allowed(),
            _ if route_path.starts_with(HEADLESS_SESSIONS_PREFIX) => {
                match parse_headless_session_route(route_path) {
                    Some((session_id, "subscribe")) if method == "POST" => self
                        .subscribe_headless_session(session_id, body)
                        .map(|snapshot| HostedRunnerHttpResponse::json(200, json!(snapshot)))
                        .unwrap_or_else(HostedRunnerHttpResponse::from_error),
                    Some((_session_id, "subscribe")) => method_not_allowed(),
                    Some((session_id, "heartbeat")) if method == "POST" => self
                        .heartbeat_headless_session(session_id, body)
                        .map(|snapshot| HostedRunnerHttpResponse::json(200, json!(snapshot)))
                        .unwrap_or_else(HostedRunnerHttpResponse::from_error),
                    Some((_session_id, "heartbeat")) => method_not_allowed(),
                    Some((session_id, "disconnect")) if method == "POST" => self
                        .disconnect_headless_session(session_id, body)
                        .map(|snapshot| HostedRunnerHttpResponse::json(200, json!(snapshot)))
                        .unwrap_or_else(HostedRunnerHttpResponse::from_error),
                    Some((_session_id, "disconnect")) => method_not_allowed(),
                    Some((session_id, "state")) if method == "GET" => self
                        .headless_session_state(session_id)
                        .map(|snapshot| HostedRunnerHttpResponse::json(200, json!(snapshot)))
                        .unwrap_or_else(HostedRunnerHttpResponse::from_error),
                    Some((_session_id, "state")) => method_not_allowed(),
                    Some((session_id, "events")) if method == "GET" => self
                        .headless_session_events(session_id, path)
                        .map(|events| HostedRunnerHttpResponse::event_stream(json!(events)))
                        .unwrap_or_else(HostedRunnerHttpResponse::from_error),
                    Some((_session_id, "events")) => method_not_allowed(),
                    Some((session_id, "message" | "messages")) if method == "POST" => self
                        .post_headless_session_message(session_id, body, headers)
                        .map(|result| HostedRunnerHttpResponse::json(200, result))
                        .unwrap_or_else(HostedRunnerHttpResponse::from_error),
                    Some((_session_id, "message" | "messages")) => method_not_allowed(),
                    _ => HostedRunnerHttpResponse::json(
                        404,
                        json!({
                            "error": "not_found",
                            "code": "not_found"
                        }),
                    ),
                }
            }
            _ if is_headless_path(route_path) => HostedRunnerHttpResponse::json(
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
                    "code": "not_found"
                }),
            ),
        }
    }

    fn register_headless_connection(
        &self,
        input: HostedRunnerHeadlessConnectionInput,
    ) -> Result<HostedRunnerHeadlessConnectionSnapshot, HostedRunnerError> {
        let mut inner = self.inner.lock().expect("hosted runner mutex poisoned");
        let connection_id = ensure_headless_connection(&mut inner, input)?;
        Ok(inner.headless_connection_snapshot(&connection_id))
    }

    fn subscribe_headless_session(
        &self,
        session_id: &str,
        body: Option<&str>,
    ) -> Result<HostedRunnerHeadlessSubscriptionSnapshot, HostedRunnerError> {
        let input =
            parse_headless_body::<HostedRunnerHeadlessConnectionInput>(body, "headless subscribe")?;
        let mut inner = self.inner.lock().expect("hosted runner mutex poisoned");
        inner.ensure_headless_session(session_id)?;
        let connection_id = ensure_headless_connection(&mut inner, input)?;
        let subscription_id = inner.next_subscription_id();
        let connection = inner
            .headless_connections
            .get_mut(&connection_id)
            .ok_or_else(|| HostedRunnerError::not_found("headless connection not found"))?;
        connection.subscription_ids.insert(subscription_id.clone());
        Ok(inner.headless_subscription_snapshot(&connection_id, &subscription_id))
    }

    fn heartbeat_headless_session(
        &self,
        session_id: &str,
        body: Option<&str>,
    ) -> Result<HostedRunnerHeadlessHeartbeatSnapshot, HostedRunnerError> {
        let input = parse_headless_body::<HostedRunnerHeadlessConnectionReferenceInput>(
            body,
            "headless heartbeat",
        )?;
        let mut inner = self.inner.lock().expect("hosted runner mutex poisoned");
        inner.ensure_headless_session(session_id)?;
        let connection_id = inner.resolve_connection_reference(&input)?;
        let now = Utc::now();
        let connection = inner
            .headless_connections
            .get_mut(&connection_id)
            .ok_or_else(|| HostedRunnerError::not_found("headless connection not found"))?;
        connection.last_seen_at = now;
        Ok(inner.headless_heartbeat_snapshot(&connection_id))
    }

    fn disconnect_headless_session(
        &self,
        session_id: &str,
        body: Option<&str>,
    ) -> Result<HostedRunnerHeadlessDisconnectSnapshot, HostedRunnerError> {
        let input = parse_headless_body::<HostedRunnerHeadlessConnectionReferenceInput>(
            body,
            "headless disconnect",
        )?;
        let mut inner = self.inner.lock().expect("hosted runner mutex poisoned");
        inner.ensure_headless_session(session_id)?;
        let connection_id = inner.resolve_connection_reference(&input)?;
        let Some(connection) = inner.headless_connections.remove(&connection_id) else {
            return Err(HostedRunnerError::not_found(
                "headless connection not found",
            ));
        };
        if inner.controller_connection_id() == Some(connection_id.as_str()) {
            inner.clear_controller_connection();
        }
        let mut disconnected_subscription_ids =
            connection.subscription_ids.into_iter().collect::<Vec<_>>();
        disconnected_subscription_ids.sort();
        Ok(HostedRunnerHeadlessDisconnectSnapshot {
            success: true,
            connection_id,
            controller_connection_id: inner.controller_connection_id().map(str::to_string),
            disconnected_subscription_ids,
        })
    }

    fn headless_session_state(
        &self,
        session_id: &str,
    ) -> Result<HostedRunnerHeadlessRuntimeSnapshot, HostedRunnerError> {
        let inner = self.inner.lock().expect("hosted runner mutex poisoned");
        inner.ensure_headless_session(session_id)?;
        Ok(inner.headless_runtime_snapshot(None))
    }

    fn headless_session_events(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<HostedRunnerHeadlessStreamEnvelope>, HostedRunnerError> {
        let cursor = parse_optional_query_u64(path, "cursor")?;
        let subscription_id = query_value(path, "subscriptionId")
            .or_else(|| query_value(path, "subscription_id"))
            .map(|value| validate_headless_id(&value, "subscriptionId"))
            .transpose()?;

        let inner = self.inner.lock().expect("hosted runner mutex poisoned");
        inner.ensure_headless_session(session_id)?;
        let connection_id = subscription_id
            .as_deref()
            .map(|subscription_id| inner.resolve_subscription(subscription_id))
            .transpose()?;
        Ok(inner.headless_stream_events(cursor, connection_id.as_deref()))
    }

    fn post_headless_session_message(
        &self,
        session_id: &str,
        body: Option<&str>,
        headers: &HashMap<String, String>,
    ) -> Result<Value, HostedRunnerError> {
        let message = parse_headless_message_body(body)?;
        let to_agent_message =
            serde_json::from_value::<ToAgentMessage>(message.clone()).map_err(|error| {
                HostedRunnerError::bad_request(format!(
                    "invalid headless message JSON body: {error}"
                ))
            })?;
        let reference = headless_connection_reference_from_headers(headers);

        let mut inner = self.inner.lock().expect("hosted runner mutex poisoned");
        inner.ensure_headless_session(session_id)?;
        inner.ensure_attachable()?;
        let connection_id = inner.resolve_connection_reference(&reference)?;
        inner.ensure_controller_message_connection(
            &connection_id,
            reference.subscription_id.as_deref(),
        )?;
        let from_agent_message =
            inner.hosted_response_for_message(&connection_id, to_agent_message)?;
        let cursor = inner.publish_headless_message(json!(from_agent_message));

        Ok(json!({
            "success": true,
            "accepted": true,
            "cursor": cursor,
            "execution": "transport_only",
            "message": "Rust hosted runner accepted the headless message; agent execution is not attached yet"
        }))
    }
}

#[derive(Debug, Clone)]
struct HostedRunnerHeadlessConnectionRecord {
    id: String,
    role: ConnectionRole,
    client_protocol_version: Option<String>,
    client_info: Option<ClientInfo>,
    capabilities: Option<ClientCapabilities>,
    opt_out_notifications: Option<Vec<String>>,
    subscription_ids: HashSet<String>,
    last_seen_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct HostedRunnerHeadlessConnectionInput {
    #[serde(rename = "protocolVersion", alias = "protocol_version", default)]
    protocol_version: Option<String>,
    #[serde(rename = "clientInfo", alias = "client_info", default)]
    client_info: Option<ClientInfo>,
    #[serde(rename = "sessionId", alias = "session_id", default)]
    session_id: Option<String>,
    #[serde(rename = "connectionId", alias = "connection_id", default)]
    connection_id: Option<String>,
    #[serde(default)]
    capabilities: Option<HostedRunnerClientCapabilities>,
    #[serde(
        rename = "optOutNotifications",
        alias = "opt_out_notifications",
        default
    )]
    opt_out_notifications: Vec<String>,
    #[serde(default)]
    role: Option<ConnectionRole>,
    #[serde(rename = "takeControl", alias = "take_control", default)]
    take_control: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct HostedRunnerClientCapabilities {
    #[serde(rename = "serverRequests", alias = "server_requests", default)]
    server_requests: Vec<ServerRequestType>,
    #[serde(rename = "utilityOperations", alias = "utility_operations", default)]
    utility_operations: Vec<UtilityOperation>,
    #[serde(rename = "rawAgentEvents", alias = "raw_agent_events", default)]
    raw_agent_events: Option<bool>,
}

impl HostedRunnerClientCapabilities {
    fn into_client_capabilities(self) -> Option<ClientCapabilities> {
        let has_capabilities = !self.server_requests.is_empty()
            || !self.utility_operations.is_empty()
            || self.raw_agent_events.is_some();
        has_capabilities.then(|| ClientCapabilities {
            server_requests: (!self.server_requests.is_empty()).then_some(self.server_requests),
            utility_operations: (!self.utility_operations.is_empty())
                .then_some(self.utility_operations),
            raw_agent_events: self.raw_agent_events,
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
struct HostedRunnerHeadlessConnectionReferenceInput {
    #[serde(rename = "connectionId", alias = "connection_id", default)]
    connection_id: Option<String>,
    #[serde(rename = "subscriptionId", alias = "subscription_id", default)]
    subscription_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerHeadlessRuntimeSnapshot {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub session_id: String,
    pub cursor: u64,
    pub state: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostedRunnerHeadlessStreamEnvelope {
    Snapshot {
        snapshot: HostedRunnerHeadlessRuntimeSnapshot,
    },
    Message {
        cursor: u64,
        message: Value,
    },
    Heartbeat {
        cursor: u64,
    },
    Reset {
        reason: String,
        snapshot: HostedRunnerHeadlessRuntimeSnapshot,
    },
}

impl HostedRunnerHeadlessStreamEnvelope {
    fn cursor(&self) -> u64 {
        match self {
            Self::Snapshot { snapshot } | Self::Reset { snapshot, .. } => snapshot.cursor,
            Self::Message { cursor, .. } | Self::Heartbeat { cursor } => *cursor,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerHeadlessConnectionState {
    pub connection_id: String,
    pub role: ConnectionRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_info: Option<ClientInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ClientCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opt_out_notifications: Option<Vec<String>>,
    pub subscription_count: usize,
    pub attached_subscription_count: usize,
    pub controller_lease_granted: bool,
    pub lease_expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerHeadlessConnectionSnapshot {
    pub session_id: String,
    pub connection_id: String,
    pub role: ConnectionRole,
    pub controller_lease_granted: bool,
    pub controller_connection_id: Option<String>,
    pub lease_expires_at: String,
    pub heartbeat_interval_ms: u64,
    pub snapshot: HostedRunnerHeadlessRuntimeSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerHeadlessSubscriptionSnapshot {
    pub connection_id: String,
    pub subscription_id: String,
    pub opt_out_notifications: Option<Vec<String>>,
    pub role: ConnectionRole,
    pub controller_lease_granted: bool,
    pub controller_subscription_id: Option<String>,
    pub controller_connection_id: Option<String>,
    pub lease_expires_at: String,
    pub heartbeat_interval_ms: u64,
    pub snapshot: HostedRunnerHeadlessRuntimeSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerHeadlessHeartbeatSnapshot {
    pub connection_id: String,
    pub controller_lease_granted: bool,
    pub controller_connection_id: Option<String>,
    pub lease_expires_at: String,
    pub heartbeat_interval_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedRunnerHeadlessDisconnectSnapshot {
    pub success: bool,
    pub connection_id: String,
    pub controller_connection_id: Option<String>,
    pub disconnected_subscription_ids: Vec<String>,
}

impl HostedRunnerRuntimeInner {
    fn ensure_attachable(&self) -> Result<(), HostedRunnerError> {
        if self.draining {
            return Err(HostedRunnerError::runtime_not_ready(
                "hosted runner is draining",
            ));
        }
        if !self.ready {
            return Err(HostedRunnerError::runtime_not_ready(
                "hosted runner is not ready",
            ));
        }
        Ok(())
    }

    fn ensure_headless_session(&self, session_id: &str) -> Result<(), HostedRunnerError> {
        if session_id == self.headless_session_id {
            Ok(())
        } else {
            Err(HostedRunnerError::not_found(format!(
                "headless session not found: {session_id}"
            )))
        }
    }

    fn next_connection_id(&mut self) -> String {
        let id = format!("hconn_{}", self.next_connection_sequence);
        self.next_connection_sequence += 1;
        id
    }

    fn next_subscription_id(&mut self) -> String {
        let id = format!("hsub_{}", self.next_subscription_sequence);
        self.next_subscription_sequence += 1;
        id
    }

    fn current_headless_cursor(&self) -> u64 {
        self.next_headless_cursor.saturating_sub(1)
    }

    fn allocate_headless_cursor(&mut self) -> u64 {
        let cursor = self.next_headless_cursor;
        self.next_headless_cursor += 1;
        cursor
    }

    fn push_headless_event(&mut self, envelope: HostedRunnerHeadlessStreamEnvelope) {
        self.headless_events.push(envelope);
        let excess = self
            .headless_events
            .len()
            .saturating_sub(MAX_HEADLESS_REPLAY_EVENTS);
        if excess > 0 {
            self.headless_events.drain(..excess);
        }
    }

    fn publish_headless_message(&mut self, message: Value) -> u64 {
        let cursor = self.allocate_headless_cursor();
        self.push_headless_event(HostedRunnerHeadlessStreamEnvelope::Message { cursor, message });
        cursor
    }

    fn has_headless_runtime_activity(&self) -> bool {
        !self.headless_connections.is_empty() || self.current_headless_cursor() > 0
    }

    fn publish_drain_status_if_active(&mut self, stop_reason: &str) {
        if !self.has_headless_runtime_activity() {
            return;
        }
        let message = FromAgentMessage::Status {
            message: format!("Hosted runner is draining: {stop_reason}"),
        };
        self.publish_headless_message(json!(message));
    }

    fn drain_manifest_runtime(&self) -> HostedRunnerManifestRuntime {
        let has_activity = self.has_headless_runtime_activity();
        HostedRunnerManifestRuntime {
            flush_status: if has_activity {
                RuntimeFlushStatus::Completed
            } else {
                RuntimeFlushStatus::Skipped
            },
            error: None,
            session_id: self.config.maestro_session_id.clone().or_else(|| {
                has_activity
                    .then(|| self.headless_session_id.clone())
                    .filter(|session_id| !session_id.is_empty())
            }),
            session_file: None,
            protocol_version: has_activity.then(|| HEADLESS_PROTOCOL_VERSION.to_string()),
            cursor: has_activity.then(|| self.current_headless_cursor()),
        }
    }

    fn controller_connection_id(&self) -> Option<&str> {
        self.controller_connection_id
            .as_deref()
            .filter(|id| self.headless_connections.contains_key(*id))
    }

    fn clear_controller_connection(&mut self) {
        self.controller_connection_id = None;
    }

    fn connection_lease_expires_at(connection: &HostedRunnerHeadlessConnectionRecord) -> String {
        format_timestamp(
            connection.last_seen_at + ChronoDuration::milliseconds(HEADLESS_CONNECTION_IDLE_MS),
        )
    }

    fn controller_subscription_id(&self) -> Option<String> {
        let controller_id = self.controller_connection_id()?;
        self.headless_connections
            .get(controller_id)
            .and_then(|connection| connection.subscription_ids.iter().next().cloned())
    }

    fn connection_states(&self) -> Vec<HostedRunnerHeadlessConnectionState> {
        let controller_id = self.controller_connection_id();
        let mut states = self
            .headless_connections
            .values()
            .map(|connection| HostedRunnerHeadlessConnectionState {
                connection_id: connection.id.clone(),
                role: connection.role,
                client_protocol_version: connection.client_protocol_version.clone(),
                client_info: connection.client_info.clone(),
                capabilities: connection.capabilities.clone(),
                opt_out_notifications: connection.opt_out_notifications.clone(),
                subscription_count: connection.subscription_ids.len(),
                attached_subscription_count: connection.subscription_ids.len(),
                controller_lease_granted: controller_id == Some(connection.id.as_str()),
                lease_expires_at: Some(Self::connection_lease_expires_at(connection)),
            })
            .collect::<Vec<_>>();
        states.sort_by(|left, right| left.connection_id.cmp(&right.connection_id));
        states
    }

    fn preferred_connection(
        &self,
        connection_id: Option<&str>,
    ) -> Option<&HostedRunnerHeadlessConnectionRecord> {
        connection_id
            .and_then(|id| self.headless_connections.get(id))
            .or_else(|| {
                self.controller_connection_id()
                    .and_then(|id| self.headless_connections.get(id))
            })
            .or_else(|| self.headless_connections.values().next())
    }

    fn headless_runtime_snapshot(
        &self,
        connection_id: Option<&str>,
    ) -> HostedRunnerHeadlessRuntimeSnapshot {
        let preferred = self.preferred_connection(connection_id);
        let subscriber_count = self
            .headless_connections
            .values()
            .map(|connection| connection.subscription_ids.len())
            .sum::<usize>();
        let git_branch =
            collect_git_state(&self.config.workspace_root).and_then(|state| state.branch);
        HostedRunnerHeadlessRuntimeSnapshot {
            protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
            session_id: self.headless_session_id.clone(),
            cursor: self.current_headless_cursor(),
            state: json!({
                "protocol_version": HEADLESS_PROTOCOL_VERSION,
                "client_protocol_version": preferred.and_then(|connection| connection.client_protocol_version.clone()),
                "client_info": preferred.and_then(|connection| connection.client_info.clone()),
                "capabilities": preferred.and_then(|connection| connection.capabilities.clone()),
                "opt_out_notifications": preferred.and_then(|connection| connection.opt_out_notifications.clone()),
                "connection_role": preferred.map(|connection| connection.role),
                "connection_count": self.headless_connections.len(),
                "subscriber_count": subscriber_count,
                "controller_subscription_id": self.controller_subscription_id(),
                "controller_connection_id": self.controller_connection_id(),
                "connections": self.connection_states(),
                "session_id": self.headless_session_id.clone(),
                "cwd": self.config.workspace_root.display().to_string(),
                "git_branch": git_branch,
                "is_ready": self.ready && !self.draining,
                "is_responding": false
            }),
        }
    }

    fn headless_stream_events(
        &self,
        cursor: Option<u64>,
        connection_id: Option<&str>,
    ) -> Vec<HostedRunnerHeadlessStreamEnvelope> {
        let Some(cursor) = cursor else {
            return vec![HostedRunnerHeadlessStreamEnvelope::Snapshot {
                snapshot: self.headless_runtime_snapshot(connection_id),
            }];
        };

        let replay_gap = self
            .headless_events
            .first()
            .map(HostedRunnerHeadlessStreamEnvelope::cursor)
            .is_some_and(|oldest_cursor| cursor.saturating_add(1) < oldest_cursor);
        if replay_gap {
            return vec![HostedRunnerHeadlessStreamEnvelope::Reset {
                reason: "replay_gap".to_string(),
                snapshot: self.headless_runtime_snapshot(connection_id),
            }];
        }

        let events = self
            .headless_events
            .iter()
            .filter(|event| event.cursor() > cursor)
            .cloned()
            .collect::<Vec<_>>();
        if events.is_empty() {
            vec![HostedRunnerHeadlessStreamEnvelope::Heartbeat {
                cursor: self.current_headless_cursor(),
            }]
        } else {
            events
        }
    }

    fn headless_connection_snapshot(
        &self,
        connection_id: &str,
    ) -> HostedRunnerHeadlessConnectionSnapshot {
        let connection = self
            .headless_connections
            .get(connection_id)
            .expect("headless connection exists");
        HostedRunnerHeadlessConnectionSnapshot {
            session_id: self.headless_session_id.clone(),
            connection_id: connection.id.clone(),
            role: connection.role,
            controller_lease_granted: self.controller_connection_id()
                == Some(connection.id.as_str()),
            controller_connection_id: self.controller_connection_id().map(str::to_string),
            lease_expires_at: Self::connection_lease_expires_at(connection),
            heartbeat_interval_ms: HEADLESS_HEARTBEAT_INTERVAL_MS,
            snapshot: self.headless_runtime_snapshot(Some(connection_id)),
        }
    }

    fn headless_subscription_snapshot(
        &self,
        connection_id: &str,
        subscription_id: &str,
    ) -> HostedRunnerHeadlessSubscriptionSnapshot {
        let connection = self
            .headless_connections
            .get(connection_id)
            .expect("headless connection exists");
        HostedRunnerHeadlessSubscriptionSnapshot {
            connection_id: connection.id.clone(),
            subscription_id: subscription_id.to_string(),
            opt_out_notifications: connection.opt_out_notifications.clone(),
            role: connection.role,
            controller_lease_granted: self.controller_connection_id()
                == Some(connection.id.as_str()),
            controller_subscription_id: self.controller_subscription_id(),
            controller_connection_id: self.controller_connection_id().map(str::to_string),
            lease_expires_at: Self::connection_lease_expires_at(connection),
            heartbeat_interval_ms: HEADLESS_HEARTBEAT_INTERVAL_MS,
            snapshot: self.headless_runtime_snapshot(Some(connection_id)),
        }
    }

    fn headless_heartbeat_snapshot(
        &self,
        connection_id: &str,
    ) -> HostedRunnerHeadlessHeartbeatSnapshot {
        let connection = self
            .headless_connections
            .get(connection_id)
            .expect("headless connection exists");
        HostedRunnerHeadlessHeartbeatSnapshot {
            connection_id: connection.id.clone(),
            controller_lease_granted: self.controller_connection_id()
                == Some(connection.id.as_str()),
            controller_connection_id: self.controller_connection_id().map(str::to_string),
            lease_expires_at: Self::connection_lease_expires_at(connection),
            heartbeat_interval_ms: HEADLESS_HEARTBEAT_INTERVAL_MS,
        }
    }

    fn resolve_connection_reference(
        &self,
        input: &HostedRunnerHeadlessConnectionReferenceInput,
    ) -> Result<String, HostedRunnerError> {
        if let Some(connection_id) = input.connection_id.as_deref() {
            let connection_id = validate_headless_id(connection_id, "connectionId")?;
            if self.headless_connections.contains_key(&connection_id) {
                return Ok(connection_id);
            }
        }
        if let Some(subscription_id) = input.subscription_id.as_deref() {
            let subscription_id = validate_headless_id(subscription_id, "subscriptionId")?;
            for connection in self.headless_connections.values() {
                if connection.subscription_ids.contains(&subscription_id) {
                    return Ok(connection.id.clone());
                }
            }
        }
        Err(HostedRunnerError::not_found(
            "headless connection not found",
        ))
    }

    fn resolve_subscription(&self, subscription_id: &str) -> Result<String, HostedRunnerError> {
        for connection in self.headless_connections.values() {
            if connection.subscription_ids.contains(subscription_id) {
                return Ok(connection.id.clone());
            }
        }
        Err(HostedRunnerError::not_found(
            "headless subscription not found",
        ))
    }

    fn ensure_controller_message_connection(
        &self,
        connection_id: &str,
        subscription_id: Option<&str>,
    ) -> Result<(), HostedRunnerError> {
        let connection = self
            .headless_connections
            .get(connection_id)
            .ok_or_else(|| HostedRunnerError::not_found("headless connection not found"))?;
        if connection.role != ConnectionRole::Controller {
            return Err(HostedRunnerError::lease_conflict(
                "headless messages require the controller connection",
            ));
        }
        if self.controller_connection_id() != Some(connection_id) {
            return Err(HostedRunnerError::lease_conflict(
                "headless controller lease is held by another connection",
            ));
        }
        if let Some(subscription_id) = subscription_id {
            if !connection.subscription_ids.contains(subscription_id) {
                return Err(HostedRunnerError::not_found(
                    "headless subscription not found",
                ));
            }
        }
        Ok(())
    }

    fn hosted_response_for_message(
        &self,
        connection_id: &str,
        message: ToAgentMessage,
    ) -> Result<FromAgentMessage, HostedRunnerError> {
        let connection = self
            .headless_connections
            .get(connection_id)
            .ok_or_else(|| HostedRunnerError::not_found("headless connection not found"))?;
        Ok(match message {
            ToAgentMessage::Hello { .. } => FromAgentMessage::HelloOk {
                protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
                connection_id: Some(connection.id.clone()),
                client_protocol_version: connection.client_protocol_version.clone(),
                client_info: connection.client_info.clone(),
                capabilities: connection.capabilities.clone(),
                opt_out_notifications: connection.opt_out_notifications.clone(),
                role: Some(connection.role),
                controller_connection_id: self.controller_connection_id().map(str::to_string),
                lease_expires_at: Some(Self::connection_lease_expires_at(connection)),
            },
            _ => FromAgentMessage::Status {
                message: "Rust hosted runner accepted the headless message; agent execution is not attached yet".to_string(),
            },
        })
    }
}

fn ensure_headless_connection(
    inner: &mut HostedRunnerRuntimeInner,
    input: HostedRunnerHeadlessConnectionInput,
) -> Result<String, HostedRunnerError> {
    inner.ensure_attachable()?;
    let requested_session_id = input
        .session_id
        .as_deref()
        .unwrap_or(&inner.headless_session_id);
    inner.ensure_headless_session(requested_session_id)?;

    let role = input.role.unwrap_or(ConnectionRole::Controller);
    let capabilities = input
        .capabilities
        .and_then(HostedRunnerClientCapabilities::into_client_capabilities);
    validate_headless_capabilities(role, capabilities.as_ref())?;

    let requested_connection_id = match input.connection_id {
        Some(connection_id) => {
            let connection_id = validate_headless_id(&connection_id, "connectionId")?;
            if !inner.headless_connections.contains_key(&connection_id) {
                return Err(HostedRunnerError::not_found(
                    "headless connection not found",
                ));
            }
            Some(connection_id)
        }
        None => None,
    };

    if let Some(existing) = requested_connection_id
        .as_deref()
        .and_then(|connection_id| inner.headless_connections.get(connection_id))
    {
        if existing.role != role {
            return Err(HostedRunnerError::bad_request(
                "headless connection role does not match existing connection",
            ));
        }
    }

    let existing_controller_id = inner.controller_connection_id().map(str::to_string);
    if role == ConnectionRole::Controller
        && existing_controller_id
            .as_deref()
            .is_some_and(|controller_id| requested_connection_id.as_deref() != Some(controller_id))
        && !input.take_control
    {
        return Err(HostedRunnerError::lease_conflict(
            "Controller lease is already held by another connection",
        ));
    }

    let connection_id = requested_connection_id.unwrap_or_else(|| inner.next_connection_id());
    let now = Utc::now();
    let opt_out_notifications =
        (!input.opt_out_notifications.is_empty()).then_some(input.opt_out_notifications);
    let connection = inner
        .headless_connections
        .entry(connection_id.clone())
        .or_insert_with(|| HostedRunnerHeadlessConnectionRecord {
            id: connection_id.clone(),
            role,
            client_protocol_version: None,
            client_info: None,
            capabilities: None,
            opt_out_notifications: None,
            subscription_ids: HashSet::new(),
            last_seen_at: now,
        });
    connection.client_protocol_version = input.protocol_version.or_else(|| {
        connection
            .client_protocol_version
            .clone()
            .or_else(|| Some(HEADLESS_PROTOCOL_VERSION.to_string()))
    });
    connection.client_info = input.client_info.or_else(|| connection.client_info.clone());
    connection.capabilities = capabilities.or_else(|| connection.capabilities.clone());
    connection.opt_out_notifications =
        opt_out_notifications.or_else(|| connection.opt_out_notifications.clone());
    connection.last_seen_at = now;

    if role == ConnectionRole::Controller {
        inner.controller_connection_id = Some(connection_id.clone());
    }

    Ok(connection_id)
}

fn validate_headless_capabilities(
    role: ConnectionRole,
    capabilities: Option<&ClientCapabilities>,
) -> Result<(), HostedRunnerError> {
    let Some(capabilities) = capabilities else {
        return Ok(());
    };
    if role == ConnectionRole::Viewer {
        if capabilities
            .server_requests
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|request| {
                matches!(
                    request,
                    ServerRequestType::ClientTool
                        | ServerRequestType::UserInput
                        | ServerRequestType::ToolRetry
                )
            })
        {
            return Err(HostedRunnerError::bad_request(
                "viewer headless connections cannot negotiate mutating server requests",
            ));
        }
        if capabilities
            .utility_operations
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|operation| matches!(operation, UtilityOperation::CommandExec))
        {
            return Err(HostedRunnerError::bad_request(
                "viewer headless connections cannot negotiate command execution",
            ));
        }
    }
    Ok(())
}

fn validate_headless_id(value: &str, field: &str) -> Result<String, HostedRunnerError> {
    let value = value.trim();
    if value.is_empty() || value.contains('\0') {
        return Err(HostedRunnerError::bad_request(format!(
            "{field} must be a non-empty string"
        )));
    }
    Ok(value.to_string())
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
            runtime.handle_request_with_headers(
                &request.method,
                &request.path,
                body,
                &request.headers,
            )
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
    headers: HashMap<String, String>,
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
    let path = target.to_string();

    let mut headers = HashMap::new();
    let mut content_length = 0_usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().to_string();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value
                .parse::<usize>()
                .map_err(|_| invalid_http("invalid content-length header"))?;
        }
        headers.insert(name, value);
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

    Ok(HostedRunnerHttpRequest {
        method,
        path,
        headers,
        body,
    })
}

async fn write_http_response(
    stream: &mut TcpStream,
    response: HostedRunnerHttpResponse,
) -> io::Result<()> {
    let (content_type, cache_control, body) = match response.response_body {
        HostedRunnerHttpResponseBody::Json => (
            "application/json",
            "no-store",
            serde_json::to_vec(&response.body).map_err(io::Error::other)?,
        ),
        HostedRunnerHttpResponseBody::EventStream => {
            let body = render_sse_body(&response.body)?;
            ("text/event-stream", "no-cache", body.into_bytes())
        }
    };
    let headers = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {content_type}\r\nCache-Control: {cache_control}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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

fn render_sse_body(body: &Value) -> io::Result<String> {
    let events = body
        .as_array()
        .ok_or_else(|| io::Error::other("event stream response body must be a JSON array"))?;
    let mut rendered = String::new();
    for event in events {
        rendered.push_str("data: ");
        rendered.push_str(&serde_json::to_string(event).map_err(io::Error::other)?);
        rendered.push_str("\n\n");
    }
    Ok(rendered)
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
        409 => "Conflict",
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
    response_body: HostedRunnerHttpResponseBody,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostedRunnerHttpResponseBody {
    Json,
    EventStream,
}

impl HostedRunnerHttpResponse {
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            response_body: HostedRunnerHttpResponseBody::Json,
        }
    }

    fn event_stream(body: Value) -> Self {
        Self {
            status: 200,
            body,
            response_body: HostedRunnerHttpResponseBody::EventStream,
        }
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

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(HostedRunnerErrorCode::Internal, message)
    }

    pub fn http_status(&self) -> u16 {
        match self.code {
            HostedRunnerErrorCode::InvalidConfig
            | HostedRunnerErrorCode::BadRequest
            | HostedRunnerErrorCode::WorkspaceViolation => 400,
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

fn parse_headless_body<T: DeserializeOwned>(
    body: Option<&str>,
    label: &str,
) -> Result<T, HostedRunnerError> {
    let body = body
        .map(str::trim)
        .filter(|body| !body.is_empty())
        .unwrap_or("{}");
    serde_json::from_str::<T>(body).map_err(|error| {
        HostedRunnerError::bad_request(format!("invalid {label} JSON body: {error}"))
    })
}

fn parse_headless_message_body(body: Option<&str>) -> Result<Value, HostedRunnerError> {
    let body = body
        .map(str::trim)
        .filter(|body| !body.is_empty())
        .ok_or_else(|| HostedRunnerError::bad_request("headless message body is required"))?;
    let value = serde_json::from_str::<Value>(body).map_err(|error| {
        HostedRunnerError::bad_request(format!("invalid headless message JSON body: {error}"))
    })?;
    if !value.is_object() {
        return Err(HostedRunnerError::bad_request(
            "headless message body must be a JSON object",
        ));
    }
    Ok(value)
}

fn parse_headless_session_route(path: &str) -> Option<(&str, &str)> {
    let path = http_route_path(path);
    let suffix = path.strip_prefix(HEADLESS_SESSIONS_PREFIX)?;
    let (session_id, action) = suffix.split_once('/')?;
    if session_id.is_empty() || action.is_empty() || action.contains('/') {
        return None;
    }
    Some((session_id, action))
}

fn http_route_path(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

fn query_value(path: &str, name: &str) -> Option<String> {
    let query = path.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then(|| value.to_string())
    })
}

fn parse_optional_query_u64(path: &str, name: &str) -> Result<Option<u64>, HostedRunnerError> {
    query_value(path, name)
        .map(|value| {
            let value = value.trim();
            if value.is_empty() {
                return Err(HostedRunnerError::bad_request(format!(
                    "{name} query parameter must be an unsigned integer"
                )));
            }
            value.parse::<u64>().map_err(|_| {
                HostedRunnerError::bad_request(format!(
                    "{name} query parameter must be an unsigned integer"
                ))
            })
        })
        .transpose()
}

fn headless_connection_reference_from_headers(
    headers: &HashMap<String, String>,
) -> HostedRunnerHeadlessConnectionReferenceInput {
    HostedRunnerHeadlessConnectionReferenceInput {
        connection_id: first_header(
            headers,
            &[
                "x-maestro-headless-connection-id",
                "x-composer-headless-connection-id",
                "x-evalops-headless-connection-id",
            ],
        ),
        subscription_id: first_header(
            headers,
            &[
                "x-maestro-headless-subscriber-id",
                "x-composer-headless-subscriber-id",
                "x-maestro-headless-subscription-id",
                "x-composer-headless-subscription-id",
                "x-evalops-headless-subscriber-id",
            ],
        ),
    }
}

fn first_header(headers: &HashMap<String, String>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| headers.get(*name))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn method_not_allowed() -> HostedRunnerHttpResponse {
    HostedRunnerHttpResponse::json(
        405,
        json!({
            "error": "method_not_allowed",
            "code": "bad_request"
        }),
    )
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
            result.manifest.runtime.flush_status,
            RuntimeFlushStatus::Skipped
        );
        assert_eq!(
            result.manifest.runtime.session_id.as_deref(),
            Some("maestro-session-1")
        );
        assert_eq!(result.manifest.runtime.protocol_version, None);
        assert_eq!(result.manifest.runtime.cursor, None);
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
    fn drain_blocks_headless_messages_and_records_runtime_cursor() {
        let (_temp_dir, runtime) = runtime();
        let controller = runtime.handle_request(
            "POST",
            "/api/headless/connections",
            Some(
                &json!({
                    "protocolVersion": HEADLESS_PROTOCOL_VERSION,
                    "role": "controller"
                })
                .to_string(),
            ),
        );
        assert_eq!(controller.status, 200);

        let subscribe = runtime.handle_request(
            "POST",
            "/api/headless/sessions/maestro-session-1/subscribe",
            Some(r#"{"connectionId":"hconn_1","role":"controller"}"#),
        );
        assert_eq!(subscribe.status, 200);

        let mut headers = HashMap::new();
        headers.insert(
            "x-maestro-headless-connection-id".to_string(),
            "hconn_1".to_string(),
        );
        headers.insert(
            "x-maestro-headless-subscriber-id".to_string(),
            "hsub_1".to_string(),
        );
        let hello = runtime.handle_request_with_headers(
            "POST",
            "/api/headless/sessions/maestro-session-1/messages",
            Some(r#"{"type":"hello"}"#),
            &headers,
        );
        assert_eq!(hello.status, 200);
        assert_eq!(hello.body["cursor"], 1);

        let requested_at = DateTime::parse_from_rfc3339("2026-04-23T13:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let completed_at = DateTime::parse_from_rfc3339("2026-04-23T13:00:00.500Z")
            .unwrap()
            .with_timezone(&Utc);
        let result = runtime
            .drain_at(
                HostedRunnerDrainInput {
                    reason: Some("budget_exhausted".to_string()),
                    requested_by: Some("platform".to_string()),
                    export_paths: Some(vec![".".to_string()]),
                },
                requested_at,
                completed_at,
            )
            .unwrap();
        assert_eq!(
            result.manifest.runtime.flush_status,
            RuntimeFlushStatus::Completed
        );
        assert_eq!(
            result.manifest.runtime.session_id.as_deref(),
            Some("maestro-session-1")
        );
        assert_eq!(
            result.manifest.runtime.protocol_version.as_deref(),
            Some(HEADLESS_PROTOCOL_VERSION)
        );
        assert_eq!(result.manifest.runtime.cursor, Some(2));

        let blocked = runtime.handle_request_with_headers(
            "POST",
            "/api/headless/sessions/maestro-session-1/messages",
            Some(r#"{"type":"prompt","content":"after drain"}"#),
            &headers,
        );
        assert_eq!(blocked.status, 503);
        assert_eq!(blocked.body["code"], "runtime_not_ready");

        let events = runtime.handle_request(
            "GET",
            "/api/headless/sessions/maestro-session-1/events?cursor=1&subscriptionId=hsub_1",
            None,
        );
        assert_eq!(events.status, 200);
        assert_eq!(events.body[0]["type"], "message");
        assert_eq!(events.body[0]["cursor"], 2);
        assert_eq!(events.body[0]["message"]["type"], "status");
        assert!(events.body[0]["message"]["message"]
            .as_str()
            .unwrap()
            .contains("budget_exhausted"));
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
    fn request_handler_tracks_headless_controller_viewer_leases() {
        let (_temp_dir, runtime) = runtime();

        let controller = runtime.handle_request(
            "POST",
            "/api/headless/connections",
            Some(
                &json!({
                    "protocolVersion": HEADLESS_PROTOCOL_VERSION,
                    "clientInfo": {"name": "maestro-controller", "version": "test"},
                    "role": "controller",
                    "capabilities": {
                        "serverRequests": ["approval", "tool_retry"],
                        "utilityOperations": ["command_exec"]
                    },
                    "optOutNotifications": ["heartbeat"]
                })
                .to_string(),
            ),
        );
        assert_eq!(controller.status, 200);
        assert_eq!(controller.body["session_id"], "maestro-session-1");
        assert_eq!(controller.body["connection_id"], "hconn_1");
        assert_eq!(controller.body["role"], "controller");
        assert_eq!(controller.body["controller_lease_granted"], true);
        assert_eq!(controller.body["controller_connection_id"], "hconn_1");

        let viewer = runtime.handle_request(
            "POST",
            "/api/headless/connections",
            Some(
                &json!({
                    "role": "viewer",
                    "capabilities": {
                        "serverRequests": ["approval"],
                        "utilityOperations": ["file_read", "file_search"]
                    }
                })
                .to_string(),
            ),
        );
        assert_eq!(viewer.status, 200);
        assert_eq!(viewer.body["connection_id"], "hconn_2");
        assert_eq!(viewer.body["role"], "viewer");
        assert_eq!(viewer.body["controller_lease_granted"], false);
        assert_eq!(viewer.body["controller_connection_id"], "hconn_1");

        let rejected_viewer = runtime.handle_request(
            "POST",
            "/api/headless/connections",
            Some(
                &json!({
                    "role": "viewer",
                    "capabilities": {
                        "utilityOperations": ["command_exec"]
                    }
                })
                .to_string(),
            ),
        );
        assert_eq!(rejected_viewer.status, 400);
        assert_eq!(rejected_viewer.body["code"], "bad_request");

        let conflict = runtime.handle_request(
            "POST",
            "/api/headless/connections",
            Some(r#"{"role":"controller"}"#),
        );
        assert_eq!(conflict.status, 409);
        assert_eq!(conflict.body["code"], "controller_lease_held");

        let takeover = runtime.handle_request(
            "POST",
            "/api/headless/connections",
            Some(r#"{"role":"controller","takeControl":true}"#),
        );
        assert_eq!(takeover.status, 200);
        assert_eq!(takeover.body["connection_id"], "hconn_3");
        assert_eq!(takeover.body["controller_lease_granted"], true);
        assert_eq!(takeover.body["controller_connection_id"], "hconn_3");

        let subscribe = runtime.handle_request(
            "POST",
            "/api/headless/sessions/maestro-session-1/subscribe",
            Some(r#"{"connectionId":"hconn_3","role":"controller"}"#),
        );
        assert_eq!(subscribe.status, 200);
        assert_eq!(subscribe.body["subscription_id"], "hsub_1");
        assert_eq!(subscribe.body["snapshot"]["cursor"], 0);

        let state = runtime.handle_request(
            "GET",
            "/api/headless/sessions/maestro-session-1/state",
            None,
        );
        assert_eq!(state.status, 200);
        assert_eq!(state.body["session_id"], "maestro-session-1");
        assert_eq!(state.body["state"]["connection_count"], 3);
        assert_eq!(state.body["state"]["controller_connection_id"], "hconn_3");
        assert_eq!(state.body["state"]["controller_subscription_id"], "hsub_1");

        let mut headers = HashMap::new();
        headers.insert(
            "x-maestro-headless-connection-id".to_string(),
            "hconn_3".to_string(),
        );
        headers.insert(
            "x-maestro-headless-subscriber-id".to_string(),
            "hsub_1".to_string(),
        );
        let message = runtime.handle_request_with_headers(
            "POST",
            "/api/headless/sessions/maestro-session-1/messages",
            Some(r#"{"type":"hello"}"#),
            &headers,
        );
        assert_eq!(message.status, 200);
        assert_eq!(message.body["success"], true);
        assert_eq!(message.body["execution"], "transport_only");
        assert_eq!(message.body["cursor"], 1);

        let events = runtime.handle_request(
            "GET",
            "/api/headless/sessions/maestro-session-1/events?cursor=0&subscriptionId=hsub_1",
            None,
        );
        assert_eq!(events.status, 200);
        assert_eq!(events.body[0]["type"], "message");
        assert_eq!(events.body[0]["cursor"], 1);
        assert_eq!(events.body[0]["message"]["type"], "hello_ok");
        assert_eq!(events.body[0]["message"]["connection_id"], "hconn_3");

        let mut viewer_headers = HashMap::new();
        viewer_headers.insert(
            "x-maestro-headless-connection-id".to_string(),
            "hconn_2".to_string(),
        );
        let viewer_message = runtime.handle_request_with_headers(
            "POST",
            "/api/headless/sessions/maestro-session-1/messages",
            Some(r#"{"type":"hello"}"#),
            &viewer_headers,
        );
        assert_eq!(viewer_message.status, 409);
        assert_eq!(viewer_message.body["code"], "controller_lease_held");
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
    async fn http_listener_serves_headless_lease_routes() {
        let (_temp_dir, runtime) = runtime();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let shutdown = CancellationToken::new();
        let server = tokio::spawn(serve_hosted_runner_http(
            listener,
            runtime,
            shutdown.clone(),
        ));

        let client = reqwest::Client::new();
        let connection = client
            .post(format!("http://{address}/api/headless/connections"))
            .json(&json!({
                "protocolVersion": HEADLESS_PROTOCOL_VERSION,
                "role": "controller",
                "capabilities": {
                    "serverRequests": ["approval", "tool_retry"],
                    "utilityOperations": ["command_exec"]
                }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(connection.status(), reqwest::StatusCode::OK);
        let connection = connection.json::<Value>().await.unwrap();
        assert_eq!(connection["connection_id"], "hconn_1");
        assert_eq!(connection["controller_lease_granted"], true);

        let subscribe = client
            .post(format!(
                "http://{address}/api/headless/sessions/maestro-session-1/subscribe"
            ))
            .json(&json!({
                "connectionId": "hconn_1",
                "role": "controller"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(subscribe.status(), reqwest::StatusCode::OK);
        let subscribe = subscribe.json::<Value>().await.unwrap();
        assert_eq!(subscribe["subscription_id"], "hsub_1");
        assert_eq!(subscribe["controller_connection_id"], "hconn_1");
        assert_eq!(subscribe["snapshot"]["state"]["subscriber_count"], 1);

        let heartbeat = client
            .post(format!(
                "http://{address}/api/headless/sessions/maestro-session-1/heartbeat"
            ))
            .json(&json!({
                "connectionId": "hconn_1",
                "subscriptionId": "hsub_1"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(heartbeat.status(), reqwest::StatusCode::OK);
        let heartbeat = heartbeat.json::<Value>().await.unwrap();
        assert_eq!(heartbeat["controller_lease_granted"], true);

        let state = client
            .get(format!(
                "http://{address}/api/headless/sessions/maestro-session-1/state"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(state.status(), reqwest::StatusCode::OK);
        let state = state.json::<Value>().await.unwrap();
        assert_eq!(state["state"]["controller_subscription_id"], "hsub_1");

        let message = client
            .post(format!(
                "http://{address}/api/headless/sessions/maestro-session-1/messages"
            ))
            .header("x-maestro-headless-connection-id", "hconn_1")
            .header("x-maestro-headless-subscriber-id", "hsub_1")
            .json(&json!({"type": "hello"}))
            .send()
            .await
            .unwrap();
        assert_eq!(message.status(), reqwest::StatusCode::OK);
        let message = message.json::<Value>().await.unwrap();
        assert_eq!(message["success"], true);
        assert_eq!(message["execution"], "transport_only");
        assert_eq!(message["cursor"], 1);

        let events = client
            .get(format!(
                "http://{address}/api/headless/sessions/maestro-session-1/events?cursor=0&subscriptionId=hsub_1"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(events.status(), reqwest::StatusCode::OK);
        assert!(events
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/event-stream"));
        let events = events.text().await.unwrap();
        assert!(events.contains("data:"));
        assert!(events.contains(r#""type":"message""#));
        assert!(events.contains(r#""type":"hello_ok""#));

        shutdown.cancel();
        server.await.unwrap().unwrap();
    }
}
