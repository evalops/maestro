//! Platform event-bus publishing for Ambient Agent runtime lifecycle events.

use anyhow::Context;
use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::env;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::OnceCell;
use tokio::time::timeout;
use tracing::warn;
use uuid::Uuid;

const SESSION_EVENT_SCHEMA: &str = "buf.build/evalops/proto/maestro.v1.MaestroSession";
const SESSION_EVENT_TYPE: &str = "type.googleapis.com/maestro.v1.MaestroSession";
const DEFAULT_SOURCE: &str = "maestro.ambient-agent";
const DEFAULT_AGENT_ID: &str = "ambient_agent_daemon";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmbientSessionState {
    Started,
    Suspended,
    Resumed,
    Closed,
}

impl AmbientSessionState {
    fn event_type(self) -> &'static str {
        match self {
            Self::Started => "maestro.sessions.session.started",
            Self::Suspended => "maestro.sessions.session.suspended",
            Self::Resumed => "maestro.sessions.session.resumed",
            Self::Closed => "maestro.sessions.session.closed",
        }
    }

    fn proto_state(self) -> &'static str {
        match self {
            Self::Started => "MAESTRO_SESSION_STATE_STARTED",
            Self::Suspended => "MAESTRO_SESSION_STATE_SUSPENDED",
            Self::Resumed => "MAESTRO_SESSION_STATE_RESUMED",
            Self::Closed => "MAESTRO_SESSION_STATE_CLOSED",
        }
    }

    fn timestamp_field(self) -> &'static str {
        match self {
            Self::Started => "started_at",
            Self::Suspended => "suspended_at",
            Self::Resumed => "resumed_at",
            Self::Closed => "closed_at",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmbientCloseReason {
    Completed,
    UserStopped,
    Error,
}

impl AmbientCloseReason {
    fn proto_reason(self) -> &'static str {
        match self {
            Self::Completed => "MAESTRO_CLOSE_REASON_COMPLETED",
            Self::UserStopped => "MAESTRO_CLOSE_REASON_USER_STOPPED",
            Self::Error => "MAESTRO_CLOSE_REASON_ERROR",
        }
    }
}

#[derive(Debug, Clone)]
pub struct AmbientSessionEvent {
    pub session_id: String,
    pub state: AmbientSessionState,
    pub workspace_root: String,
    pub close_reason: Option<AmbientCloseReason>,
    pub close_message: Option<String>,
    pub metadata: BTreeMap<String, Value>,
}

impl AmbientSessionEvent {
    pub fn new(
        session_id: impl Into<String>,
        state: AmbientSessionState,
        workspace_root: impl AsRef<Path>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            state,
            workspace_root: workspace_root.as_ref().to_string_lossy().to_string(),
            close_reason: None,
            close_message: None,
            metadata: BTreeMap::new(),
        }
    }

    pub fn close_reason(mut self, reason: AmbientCloseReason) -> Self {
        self.close_reason = Some(reason);
        self
    }

    pub fn close_message(mut self, message: impl Into<String>) -> Self {
        self.close_message = Some(message.into());
        self
    }

    pub fn metadata(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.metadata.insert(key.into(), value.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEventBusConfig {
    pub enabled: bool,
    pub reason: String,
    pub nats_url: Option<String>,
    pub nats_token: Option<String>,
    pub nats_user: Option<String>,
    pub nats_password: Option<String>,
    pub source: String,
    pub tenant_id: Option<String>,
    pub workspace_id: String,
    pub agent_run_id: Option<String>,
    pub agent_id: Option<String>,
    pub actor_id: Option<String>,
    pub principal_id: Option<String>,
    pub trace_id: Option<String>,
    pub request_id: Option<String>,
    pub remote_runner_session_id: Option<String>,
    pub objective_id: Option<String>,
    pub conversation_id: Option<String>,
    pub runtime_mode: String,
    pub surface: String,
    pub attributes: BTreeMap<String, String>,
}

impl PlatformEventBusConfig {
    pub fn from_env() -> Self {
        Self::from_iter(env::vars())
    }

    fn from_iter<I>(vars: I) -> Self
    where
        I: IntoIterator<Item = (String, String)>,
    {
        let vars: BTreeMap<String, String> = vars
            .into_iter()
            .filter(|(_, value)| !value.trim().is_empty())
            .map(|(key, value)| (key, value.trim().to_string()))
            .collect();
        let flag = read_bool(read_env(&vars, &["MAESTRO_EVENT_BUS", "MAESTRO_AUDIT_BUS"]));
        let nats_url = read_env(
            &vars,
            &["MAESTRO_EVENT_BUS_URL", "EVALOPS_NATS_URL", "NATS_URL"],
        )
        .cloned();
        let managed_routing = read_env(&vars, &["MAESTRO_EVALOPS_ACCESS_TOKEN"]).is_some()
            && read_env(
                &vars,
                &[
                    "MAESTRO_EVALOPS_ORG_ID",
                    "EVALOPS_ORGANIZATION_ID",
                    "MAESTRO_ENTERPRISE_ORG_ID",
                ],
            )
            .is_some();

        let enabled = if flag == Some(false) {
            false
        } else {
            flag.unwrap_or(nats_url.is_some() || managed_routing)
        };
        let reason = if flag == Some(false) {
            "flag disabled"
        } else if nats_url.is_some() {
            "nats"
        } else if managed_routing {
            "managed evalops routing"
        } else if flag == Some(true) {
            "flag enabled"
        } else {
            "disabled"
        }
        .to_string();

        let tenant_id = read_env(
            &vars,
            &[
                "MAESTRO_EVALOPS_ORG_ID",
                "EVALOPS_ORGANIZATION_ID",
                "MAESTRO_ENTERPRISE_ORG_ID",
            ],
        )
        .cloned();

        Self {
            enabled,
            reason,
            nats_url,
            nats_token: read_env(&vars, &["MAESTRO_EVENT_BUS_TOKEN", "NATS_TOKEN"]).cloned(),
            nats_user: read_env(&vars, &["MAESTRO_EVENT_BUS_USER", "NATS_USER"]).cloned(),
            nats_password: read_env(&vars, &["MAESTRO_EVENT_BUS_PASSWORD", "NATS_PASSWORD"])
                .cloned(),
            source: read_env(&vars, &["MAESTRO_EVENT_BUS_SOURCE"])
                .cloned()
                .unwrap_or_else(|| DEFAULT_SOURCE.to_string()),
            tenant_id,
            workspace_id: read_env(
                &vars,
                &[
                    "MAESTRO_EVALOPS_WORKSPACE_ID",
                    "EVALOPS_WORKSPACE_ID",
                    "PWD",
                ],
            )
            .cloned()
            .unwrap_or_else(|| {
                env::current_dir()
                    .unwrap_or_else(|_| ".".into())
                    .to_string_lossy()
                    .to_string()
            }),
            agent_run_id: read_env(&vars, &["MAESTRO_AGENT_RUN_ID"]).cloned(),
            agent_id: read_env(&vars, &["MAESTRO_AGENT_ID"]).cloned(),
            actor_id: read_env(&vars, &["MAESTRO_ACTOR_ID"]).cloned(),
            principal_id: read_env(&vars, &["MAESTRO_PRINCIPAL_ID"]).cloned(),
            trace_id: read_env(&vars, &["TRACE_ID", "OTEL_TRACE_ID"]).cloned(),
            request_id: read_env(&vars, &["MAESTRO_REQUEST_ID"]).cloned(),
            remote_runner_session_id: read_env(&vars, &["MAESTRO_REMOTE_RUNNER_SESSION_ID"])
                .cloned(),
            objective_id: read_env(&vars, &["MAESTRO_OBJECTIVE_ID"]).cloned(),
            conversation_id: read_env(&vars, &["MAESTRO_CONVERSATION_ID"]).cloned(),
            runtime_mode: normalize_runtime_mode(read_env(&vars, &["MAESTRO_RUNTIME_MODE"])),
            surface: normalize_surface(read_env(
                &vars,
                &["MAESTRO_SURFACE", "MAESTRO_EVENT_SURFACE"],
            )),
            attributes: read_prefixed(&vars, "MAESTRO_EVENT_BUS_ATTR_"),
        }
    }

    pub fn for_test() -> Self {
        Self {
            enabled: true,
            reason: "test".to_string(),
            nats_url: Some("nats://test.invalid:4222".to_string()),
            nats_token: None,
            nats_user: None,
            nats_password: None,
            source: DEFAULT_SOURCE.to_string(),
            tenant_id: Some("org_test".to_string()),
            workspace_id: "workspace_test".to_string(),
            agent_run_id: None,
            agent_id: None,
            actor_id: None,
            principal_id: None,
            trace_id: None,
            request_id: None,
            remote_runner_session_id: None,
            objective_id: None,
            conversation_id: None,
            runtime_mode: "MAESTRO_RUNTIME_MODE_HEADLESS".to_string(),
            surface: "MAESTRO_SURFACE_TUI".to_string(),
            attributes: BTreeMap::new(),
        }
    }
}

#[async_trait]
pub trait PlatformEventBusTransport: Send + Sync {
    async fn publish(&self, subject: &str, payload: String) -> anyhow::Result<()>;
}

#[derive(Clone)]
pub struct PlatformEventBus {
    config: PlatformEventBusConfig,
    transport: Arc<dyn PlatformEventBusTransport>,
}

impl PlatformEventBus {
    pub fn from_env() -> Self {
        Self::new(PlatformEventBusConfig::from_env())
    }

    pub fn new(config: PlatformEventBusConfig) -> Self {
        Self {
            transport: Arc::new(NatsJetStreamTransport {
                config: config.clone(),
                client: OnceCell::new(),
            }),
            config,
        }
    }

    pub fn with_transport(
        config: PlatformEventBusConfig,
        transport: Arc<dyn PlatformEventBusTransport>,
    ) -> Self {
        Self { config, transport }
    }

    pub async fn publish_session_event(&self, event: AmbientSessionEvent) {
        if !self.config.enabled {
            return;
        }
        if self.config.nats_url.is_none() && self.config.reason != "test" {
            return;
        }

        let subject = event.state.event_type();
        let payload = build_session_cloud_event(&self.config, &event);
        let encoded = match serde_json::to_string(&payload) {
            Ok(value) => value,
            Err(error) => {
                warn!("Failed to encode Ambient session event: {}", error);
                return;
            }
        };

        match timeout(
            Duration::from_secs(3),
            self.transport.publish(subject, encoded),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => warn!("Failed to publish Ambient session event: {}", error),
            Err(_) => warn!("Timed out publishing Ambient session event {}", subject),
        }
    }
}

struct NatsJetStreamTransport {
    config: PlatformEventBusConfig,
    // Match the TypeScript publisher: connect lazily, then reuse the client.
    client: OnceCell<async_nats::Client>,
}

#[async_trait]
impl PlatformEventBusTransport for NatsJetStreamTransport {
    async fn publish(&self, subject: &str, payload: String) -> anyhow::Result<()> {
        let client = self.client().await?;
        let jetstream = async_nats::jetstream::new(client);
        let ack = jetstream
            .publish(subject.to_string(), payload.into())
            .await
            .with_context(|| format!("publish {}", subject))?;
        ack.await
            .with_context(|| format!("acknowledge {}", subject))?;
        Ok(())
    }
}

impl NatsJetStreamTransport {
    async fn client(&self) -> anyhow::Result<async_nats::Client> {
        let client = self
            .client
            .get_or_try_init(|| async { self.connect().await })
            .await?;
        Ok(client.clone())
    }

    async fn connect(&self) -> anyhow::Result<async_nats::Client> {
        let Some(nats_url) = &self.config.nats_url else {
            anyhow::bail!("missing NATS URL");
        };

        let mut options = async_nats::ConnectOptions::new();
        if let Some(token) = &self.config.nats_token {
            options = options.token(token.to_string());
        }
        if let (Some(user), Some(password)) = (&self.config.nats_user, &self.config.nats_password) {
            options = options.user_and_password(user.to_string(), password.to_string());
        }

        let client = options
            .connect(nats_url)
            .await
            .with_context(|| format!("connect to NATS at {}", nats_url))?;
        Ok(client)
    }
}

fn build_session_cloud_event(
    config: &PlatformEventBusConfig,
    event: &AmbientSessionEvent,
) -> Value {
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let event_type = event.state.event_type();
    let mut correlation = Map::new();
    optional_insert(
        &mut correlation,
        "organization_id",
        config.tenant_id.clone(),
    );
    correlation.insert("workspace_id".to_string(), json!(config.workspace_id));
    correlation.insert("session_id".to_string(), json!(event.session_id));
    optional_insert(
        &mut correlation,
        "agent_run_id",
        config.agent_run_id.clone(),
    );
    correlation.insert(
        "agent_id".to_string(),
        json!(config.agent_id.as_deref().unwrap_or(DEFAULT_AGENT_ID)),
    );
    optional_insert(&mut correlation, "actor_id", config.actor_id.clone());
    optional_insert(
        &mut correlation,
        "principal_id",
        config.principal_id.clone(),
    );
    optional_insert(&mut correlation, "trace_id", config.trace_id.clone());
    correlation.insert(
        "request_id".to_string(),
        json!(config
            .request_id
            .clone()
            .unwrap_or_else(|| format!("ambient-daemon:{}", event.session_id))),
    );
    optional_insert(
        &mut correlation,
        "remote_runner_session_id",
        config.remote_runner_session_id.clone(),
    );
    optional_insert(
        &mut correlation,
        "objective_id",
        config.objective_id.clone(),
    );
    optional_insert(
        &mut correlation,
        "conversation_id",
        config.conversation_id.clone(),
    );
    if !config.attributes.is_empty() {
        correlation.insert("attributes".to_string(), json!(config.attributes));
    }

    let mut data = Map::new();
    data.insert("@type".to_string(), json!(SESSION_EVENT_TYPE));
    data.insert("correlation".to_string(), Value::Object(correlation));
    data.insert("state".to_string(), json!(event.state.proto_state()));
    data.insert("surface".to_string(), json!(config.surface));
    data.insert("runtime_mode".to_string(), json!(config.runtime_mode));
    data.insert("workspace_root".to_string(), json!(event.workspace_root));
    data.insert(
        "runtime_version".to_string(),
        json!(env!("CARGO_PKG_VERSION")),
    );
    data.insert(event.state.timestamp_field().to_string(), json!(now));
    if let Some(reason) = event.close_reason {
        data.insert("close_reason".to_string(), json!(reason.proto_reason()));
    }
    optional_insert(&mut data, "close_message", event.close_message.clone());
    if !event.metadata.is_empty() {
        data.insert("metadata".to_string(), json!(event.metadata));
    }

    let mut root = Map::new();
    root.insert("spec_version".to_string(), json!("1.0"));
    root.insert("id".to_string(), json!(Uuid::new_v4().to_string()));
    root.insert("type".to_string(), json!(event_type));
    root.insert("source".to_string(), json!(config.source));
    root.insert("subject".to_string(), json!(event_type));
    root.insert("time".to_string(), json!(now));
    root.insert(
        "data_content_type".to_string(),
        json!("application/protobuf"),
    );
    optional_insert(&mut root, "tenant_id", config.tenant_id.clone());
    root.insert("data".to_string(), Value::Object(data));
    root.insert(
        "extensions".to_string(),
        json!({ "dataschema": SESSION_EVENT_SCHEMA }),
    );
    Value::Object(root)
}

fn optional_insert(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.to_string(), json!(value));
    }
}

fn read_env<'a>(vars: &'a BTreeMap<String, String>, names: &[&str]) -> Option<&'a String> {
    names.iter().find_map(|name| vars.get(*name))
}

fn read_bool(value: Option<&String>) -> Option<bool> {
    match value?.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn read_prefixed(vars: &BTreeMap<String, String>, prefix: &str) -> BTreeMap<String, String> {
    vars.iter()
        .filter_map(|(key, value)| {
            key.strip_prefix(prefix)
                .map(|suffix| (suffix.to_ascii_lowercase(), value.clone()))
        })
        .collect()
}

fn normalize_surface(value: Option<&String>) -> String {
    match value.map(|value| value.to_ascii_lowercase()) {
        Some(value) if value == "cli" => "MAESTRO_SURFACE_CLI",
        Some(value) if value == "tui" => "MAESTRO_SURFACE_TUI",
        Some(value) if value == "web" => "MAESTRO_SURFACE_WEB",
        Some(value) if value == "ide" || value == "vscode" || value == "jetbrains" => {
            "MAESTRO_SURFACE_IDE"
        }
        Some(value) if value == "github" || value == "github-agent" => {
            "MAESTRO_SURFACE_GITHUB_AGENT"
        }
        Some(value) if value == "desktop" => "MAESTRO_SURFACE_DESKTOP",
        Some(value) if value == "remote" || value == "remote-runner" => {
            "MAESTRO_SURFACE_REMOTE_RUNNER"
        }
        _ => "MAESTRO_SURFACE_TUI",
    }
    .to_string()
}

fn normalize_runtime_mode(value: Option<&String>) -> String {
    match value.map(|value| value.to_ascii_lowercase()) {
        Some(value) if value == "headless" => "MAESTRO_RUNTIME_MODE_HEADLESS",
        Some(value) if value == "hosted" => "MAESTRO_RUNTIME_MODE_HOSTED",
        Some(value) if value == "remote" || value == "remote-attached" => {
            "MAESTRO_RUNTIME_MODE_REMOTE_ATTACHED"
        }
        Some(value) if value == "local" => "MAESTRO_RUNTIME_MODE_LOCAL",
        _ => "MAESTRO_RUNTIME_MODE_LOCAL",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingTransport {
        published: Mutex<Vec<(String, String)>>,
    }

    #[async_trait]
    impl PlatformEventBusTransport for RecordingTransport {
        async fn publish(&self, subject: &str, payload: String) -> anyhow::Result<()> {
            self.published
                .lock()
                .unwrap()
                .push((subject.to_string(), payload));
            Ok(())
        }
    }

    #[tokio::test]
    async fn publishes_ambient_session_lifecycle_cloudevent() {
        let transport = Arc::new(RecordingTransport::default());
        let publisher =
            PlatformEventBus::with_transport(PlatformEventBusConfig::for_test(), transport.clone());

        publisher
            .publish_session_event(
                AmbientSessionEvent::new(
                    "ambient-session-1",
                    AmbientSessionState::Started,
                    "/tmp/ambient-agent",
                )
                .metadata("status", "running"),
            )
            .await;

        let published = transport.published.lock().unwrap();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].0, "maestro.sessions.session.started");
        let event: Value = serde_json::from_str(&published[0].1).unwrap();
        assert_eq!(event["type"], "maestro.sessions.session.started");
        assert_eq!(event["source"], DEFAULT_SOURCE);
        assert_eq!(event["tenant_id"], "org_test");
        assert_eq!(event["extensions"]["dataschema"], SESSION_EVENT_SCHEMA);
        assert_eq!(event["data"]["@type"], SESSION_EVENT_TYPE);
        assert_eq!(event["data"]["state"], "MAESTRO_SESSION_STATE_STARTED");
        assert_eq!(event["data"]["surface"], "MAESTRO_SURFACE_TUI");
        assert_eq!(
            event["data"]["runtime_mode"],
            "MAESTRO_RUNTIME_MODE_HEADLESS"
        );
        assert_eq!(
            event["data"]["correlation"]["session_id"],
            "ambient-session-1"
        );
        assert_eq!(event["data"]["correlation"]["agent_id"], DEFAULT_AGENT_ID);
        assert_eq!(event["data"]["metadata"]["status"], "running");
    }

    #[test]
    fn resolves_audit_bus_scope_independently_from_training_telemetry() {
        let config = PlatformEventBusConfig::from_iter([
            ("MAESTRO_TELEMETRY".to_string(), "0".to_string()),
            (
                "MAESTRO_EVENT_BUS_URL".to_string(),
                "nats://bus.example:4222".to_string(),
            ),
            ("MAESTRO_EVALOPS_ORG_ID".to_string(), "org_123".to_string()),
            (
                "MAESTRO_EVALOPS_WORKSPACE_ID".to_string(),
                "workspace_123".to_string(),
            ),
            ("MAESTRO_AGENT_ID".to_string(), "ambient-custom".to_string()),
            ("MAESTRO_ACTOR_ID".to_string(), "actor_123".to_string()),
            ("TRACE_ID".to_string(), "trace_123".to_string()),
            ("MAESTRO_REQUEST_ID".to_string(), "request_123".to_string()),
        ]);

        assert!(config.enabled);
        assert_eq!(config.reason, "nats");
        assert_eq!(config.tenant_id.as_deref(), Some("org_123"));
        assert_eq!(config.workspace_id, "workspace_123");
        assert_eq!(config.agent_id.as_deref(), Some("ambient-custom"));
        assert_eq!(config.actor_id.as_deref(), Some("actor_123"));
        assert_eq!(config.trace_id.as_deref(), Some("trace_123"));
        assert_eq!(config.request_id.as_deref(), Some("request_123"));
    }

    #[test]
    fn normalizes_surface_like_shared_typescript_publisher() {
        assert_eq!(normalize_surface(None), "MAESTRO_SURFACE_TUI");
        assert_eq!(
            normalize_surface(Some(&"tui".to_string())),
            "MAESTRO_SURFACE_TUI"
        );
        assert_eq!(
            normalize_surface(Some(&"github-agent".to_string())),
            "MAESTRO_SURFACE_GITHUB_AGENT"
        );
    }

    #[test]
    fn normalizes_runtime_mode_like_shared_typescript_publisher() {
        assert_eq!(normalize_runtime_mode(None), "MAESTRO_RUNTIME_MODE_LOCAL");
        assert_eq!(
            normalize_runtime_mode(Some(&"headless".to_string())),
            "MAESTRO_RUNTIME_MODE_HEADLESS"
        );
        assert_eq!(
            normalize_runtime_mode(Some(&"remote-attached".to_string())),
            "MAESTRO_RUNTIME_MODE_REMOTE_ATTACHED"
        );
    }
}
