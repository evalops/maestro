use base64::{
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use maestro_tui::agent::{FromAgent, NativeAgent, NativeAgentConfig, TokenUsage, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::env;
use std::io::{Cursor, Read};
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{self, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc, watch, Mutex};

mod auth;
mod codex_compat;
mod codex_subagent_dispatch;
mod http;
mod model_catalog;
mod runtime_assets;

use auth::*;
use codex_subagent_dispatch::CODEX_SUBAGENT_DISPATCH_LANES;
#[cfg(test)]
use http::parse_request_head;
pub(crate) use http::MAX_JSON_BODY_BYTES;
use http::{
    header_end, json_response, origin_allowed, percent_decode_component, query_flag,
    read_request_body, read_request_body_with_limit, read_request_head, requested_cors_origin,
    response, response_cors_credentials_header, response_cors_origin, response_with_extra_headers,
    response_with_extra_headers_and_length, response_with_no_store, text_response,
    with_response_cors_origin, RequestHead,
};
#[cfg(test)]
use http::{response_with_cache_and_length, response_with_no_store_and_length};
use model_catalog::{available_models, default_model, resolve_model, ModelInfo};
#[cfg(test)]
use model_catalog::{
    builtin_models, default_model_from_registry, emergency_default_model, merge_configured_models,
    merge_llm_gateway_model_catalog, ModelRegistry,
};
use runtime_assets::*;

const MAX_EXTRACT_JSON_BODY_BYTES: usize = 72 * 1024 * 1024;
const DEFAULT_EXTRACT_MAX_CHARS: usize = 200_000;
const MAX_EXTRACT_INPUT_BYTES: usize = 50 * 1024 * 1024;
const MAX_PROJECT_ONBOARDING_IMPRESSIONS: u8 = 4;
const A2A_PROTOCOL_VERSION: &str = "1.0";
const A2A_DEFAULT_TURN_TIMEOUT_MS: u64 = 180_000;
const A2A_DEFAULT_RESPONSE_END_SETTLE_MS: u64 = 250;
const A2A_TERMINAL_TASK_STORE_LIMIT: usize = 128;
const A2A_DEFAULT_LIST_PAGE_SIZE: usize = 50;
const A2A_MAX_LIST_PAGE_SIZE: usize = 100;
const A2A_DEFAULT_SUBSCRIBE_TIMEOUT_MS: u64 = 60_000;
const A2A_DEFAULT_SUBSCRIBE_HEARTBEAT_MS: u64 = 15_000;
const A2A_TASK_EVENT_REPLAY_LIMIT: usize = 256;
const A2A_PUSH_NOTIFICATION_CONFIG_LIMIT: usize = 16;
const A2A_DEFAULT_PUSH_TIMEOUT_MS: u64 = 10_000;
const A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY: &str = "pushNotificationConfigs";
const A2A_LEDGER_LOCK_RETRY_MS: u64 = 25;
const A2A_LEDGER_LOCK_STALE_MS: u64 = 30_000;
const A2A_LEDGER_LOCK_TIMEOUT_MS: u64 = A2A_LEDGER_LOCK_STALE_MS + A2A_LEDGER_LOCK_RETRY_MS;
const A2A_LEDGER_LOCK_OWNER_FILE: &str = "owner";
const A2A_LEDGER_LOCK_HEARTBEAT_FILE: &str = "heartbeat";
const EVALOPS_A2A_EXTENSION_URI: &str = "https://evalops.com/a2a/extensions/operating-plane/v1";
const A2A_CONTROL_PLANE_LEDGER_PEER: &str = "maestro-control-plane";
const A2A_CONTROL_PLANE_LEDGER_DISPLAY_NAME: &str = "Maestro Control Plane";
const PLATFORM_A2A_PUSH_PATH: &str = "/api/platform/a2a/push";
const CODEX_SUBAGENT_WORK_GRAPH_SCHEMA: &str = "evalops.maestro.codex.subagent-workgraph.v1";
static CODEX_BRIDGE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static CODEX_HEADLESS_RUN_COUNTER: AtomicU64 = AtomicU64::new(0);
static ATTACHMENT_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
static A2A_ID_FALLBACK_COUNTER: AtomicU64 = AtomicU64::new(0);
type PendingToolResponseSender = mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>;
type A2ACancelSender = watch::Sender<bool>;
type A2ACancelReceiver = watch::Receiver<bool>;

#[derive(Debug, PartialEq, Eq)]
enum CliAction {
    Serve,
    Help,
    Version,
}

fn parse_cli_action<I, S>(args: I) -> Result<CliAction, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    if args.is_empty() {
        return Ok(CliAction::Serve);
    }
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "-h" | "--help"))
    {
        return Ok(CliAction::Help);
    }
    if args.len() == 1 && matches!(args[0].as_str(), "-V" | "--version") {
        return Ok(CliAction::Version);
    }
    Err(format!("unexpected argument: {}", args.join(" ")))
}

fn print_cli_help() {
    println!(
        "Maestro Rust control plane\n\n\
Usage:\n  maestro-control-plane [--help] [--version]\n\n\
Environment:\n  MAESTRO_CONTROL_HOST  bind host (default: 0.0.0.0)\n  PORT                  bind port (default: 8080)\n  MAESTRO_HOME          state directory for sessions, usage, and preferences\n  MAESTRO_WEB_API_KEY   API key accepted via Bearer or x-maestro-api-key\n  MAESTRO_WEB_REQUIRE_KEY=0 disables API-key auth for local development\n"
    );
}

fn print_cli_version() {
    println!("maestro-control-plane {}", env!("CARGO_PKG_VERSION"));
}

#[derive(Debug, Clone)]
struct Config {
    listen_host: String,
    listen_port: u16,
    api_key: Option<String>,
    require_key: bool,
    csrf_token: Option<String>,
    require_csrf: bool,
    cwd: PathBuf,
    session_store_path: PathBuf,
    command_prefs_path: PathBuf,
    usage_file_path: PathBuf,
    a2a_tasks_file_path: PathBuf,
    static_root: PathBuf,
    static_cache_max_age: u64,
    llm_gateway_models_url: Option<String>,
    llm_gateway_token: Option<String>,
    llm_gateway_org_id: Option<String>,
    llm_gateway_timeout_ms: u64,
}

impl Config {
    fn from_env() -> Self {
        let listen_port = env_u16("PORT", 8080);
        let require_key = env::var("MAESTRO_WEB_REQUIRE_KEY")
            .map(|value| value != "0")
            .unwrap_or_else(|_| env::var("NODE_ENV").map(|v| v != "test").unwrap_or(true));
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let csrf_token = trimmed_env("MAESTRO_WEB_CSRF_TOKEN");
        let require_csrf = csrf_token.is_some()
            || (prod_profile() && env::var("MAESTRO_WEB_REQUIRE_CSRF").as_deref() != Ok("0"));
        let llm_gateway_models_url = llm_gateway_models_url();
        let openrouter_models = llm_gateway_models_url
            .as_deref()
            .is_some_and(is_openrouter_models_url);

        Self {
            listen_host: env::var("MAESTRO_CONTROL_HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            listen_port,
            api_key: env::var("MAESTRO_WEB_API_KEY")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            require_key,
            csrf_token,
            require_csrf,
            cwd: cwd.clone(),
            session_store_path: env::var("MAESTRO_SESSIONS_FILE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| default_session_store_path(&cwd)),
            command_prefs_path: command_prefs_path(),
            usage_file_path: usage_file_path(),
            a2a_tasks_file_path: a2a_tasks_file_path(),
            static_root: env::var("MAESTRO_WEB_STATIC_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("packages/web/dist")),
            static_cache_max_age: env::var("MAESTRO_STATIC_MAX_AGE")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(86_400),
            llm_gateway_models_url,
            llm_gateway_token: if openrouter_models {
                trimmed_env("MAESTRO_OPENROUTER_API_KEY")
                    .or_else(|| trimmed_env("OPENROUTER_API_KEY"))
            } else {
                trimmed_env("MAESTRO_LLM_GATEWAY_TOKEN")
            },
            llm_gateway_org_id: if openrouter_models {
                None
            } else {
                trimmed_env("MAESTRO_LLM_GATEWAY_ORG_ID")
            },
            llm_gateway_timeout_ms: env::var("MAESTRO_LLM_GATEWAY_TIMEOUT_MS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(2_500),
        }
    }

    fn listen_addr(&self) -> String {
        format!("{}:{}", self.listen_host, self.listen_port)
    }
}

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    started_at: Instant,
    selected_model: Arc<Mutex<ModelInfo>>,
    telemetry_override: Arc<Mutex<Option<bool>>>,
    training_override: Arc<Mutex<Option<bool>>>,
    background_settings: Arc<Mutex<BackgroundSettings>>,
    framework_preference: Arc<Mutex<Option<String>>>,
    command_prefs: Arc<Mutex<CommandPrefs>>,
    sessions: Arc<Mutex<SessionStore>>,
    session_store_persist_enabled: bool,
    session_persist_lock: Arc<Mutex<()>>,
    usage_persist_lock: Arc<Mutex<()>>,
    shared_sessions: Arc<Mutex<HashMap<String, SharedSessionGrant>>>,
    approval_modes: Arc<Mutex<HashMap<String, String>>>,
    pending_tool_responses: Arc<Mutex<HashMap<String, PendingToolResponseSender>>>,
    a2a_tasks: Arc<Mutex<HashMap<String, Value>>>,
    a2a_task_persist_lock: Arc<Mutex<()>>,
    a2a_task_events: broadcast::Sender<A2ATaskUpdateEvent>,
    a2a_task_event_history: Arc<Mutex<HashMap<String, A2ATaskEventHistory>>>,
    a2a_cancel_senders: Arc<Mutex<HashMap<String, A2ACancelSender>>>,
}

#[derive(Clone, Debug)]
struct A2ATaskUpdateEvent {
    task_id: String,
    sequence: u64,
    task: Value,
}

#[derive(Debug, Default)]
struct A2ATaskEventHistory {
    next_sequence: u64,
    events: Vec<A2ATaskUpdateEvent>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundSettings {
    notifications_enabled: bool,
    status_details_enabled: bool,
}

#[derive(Debug, Deserialize)]
struct BackgroundUpdateRequest {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct FrameworkUpdateRequest {
    framework: Option<Option<String>>,
    scope: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CommandPrefs {
    favorites: Vec<String>,
    recents: Vec<String>,
}

#[derive(Serialize)]
struct StatusSnapshot {
    cwd: String,
    git: Option<GitSnapshot>,
    context: ContextSnapshot,
    onboarding: OnboardingSnapshot,
    server: ServerSnapshot,
    database: DatabaseSnapshot,
    #[serde(rename = "backgroundTasks")]
    background_tasks: Option<serde_json::Value>,
    hooks: HooksSnapshot,
    #[serde(rename = "lastUpdated")]
    last_updated: u64,
    #[serde(rename = "lastLatencyMs")]
    last_latency_ms: u128,
}

#[derive(Serialize)]
struct GitSnapshot {
    branch: String,
    status: GitStatus,
}

#[derive(Serialize)]
struct GitStatus {
    modified: usize,
    added: usize,
    deleted: usize,
    untracked: usize,
    total: usize,
}

#[derive(Serialize)]
struct ContextSnapshot {
    #[serde(rename = "agentMd")]
    agent_md: bool,
    #[serde(rename = "claudeMd")]
    claude_md: bool,
}

#[derive(Serialize)]
struct OnboardingSnapshot {
    #[serde(rename = "shouldShow")]
    should_show: bool,
    completed: bool,
    #[serde(rename = "seenCount")]
    seen_count: u8,
    steps: Vec<OnboardingStep>,
}

#[derive(Serialize)]
struct OnboardingStep {
    key: &'static str,
    text: &'static str,
    #[serde(rename = "isComplete")]
    is_complete: bool,
    #[serde(rename = "isEnabled")]
    is_enabled: bool,
}

#[derive(Serialize)]
struct ServerSnapshot {
    uptime: f64,
    version: String,
    #[serde(rename = "staticCacheMaxAgeSeconds")]
    static_cache_max_age_seconds: u64,
    runtime: &'static str,
}

#[derive(Serialize)]
struct DatabaseSnapshot {
    configured: bool,
    connected: bool,
}

#[derive(Serialize)]
struct HooksSnapshot {
    #[serde(rename = "asyncInFlight")]
    async_in_flight: u8,
    concurrency: HookConcurrencySnapshot,
}

#[derive(Serialize)]
struct HookConcurrencySnapshot {
    max: u8,
    active: u8,
    queued: u8,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match parse_cli_action(env::args().skip(1)) {
        Ok(CliAction::Serve) => {}
        Ok(CliAction::Help) => {
            print_cli_help();
            return Ok(());
        }
        Ok(CliAction::Version) => {
            print_cli_version();
            return Ok(());
        }
        Err(error) => {
            eprintln!("{error}\nRun `maestro-control-plane --help` for usage.");
            process::exit(2);
        }
    }

    let config = Arc::new(Config::from_env());
    let listener = TcpListener::bind(config.listen_addr()).await?;
    eprintln!(
        "maestro rust server listening on http://{}",
        config.listen_addr()
    );
    let (sessions, session_store_persist_enabled) =
        load_session_store(&config.session_store_path).await;
    let shared_sessions = sessions.shared_sessions.clone();
    let command_prefs = load_command_prefs(&config.command_prefs_path).await;
    let a2a_tasks = load_a2a_tasks(&config.a2a_tasks_file_path).await;
    let (a2a_task_events, _) = broadcast::channel(256);

    let state = AppState {
        config: config.clone(),
        started_at: Instant::now(),
        selected_model: Arc::new(Mutex::new(default_model(&config).await)),
        telemetry_override: Arc::new(Mutex::new(None)),
        training_override: Arc::new(Mutex::new(None)),
        background_settings: Arc::new(Mutex::new(BackgroundSettings::default())),
        framework_preference: Arc::new(Mutex::new(None)),
        command_prefs: Arc::new(Mutex::new(command_prefs)),
        sessions: Arc::new(Mutex::new(sessions)),
        session_store_persist_enabled,
        session_persist_lock: Arc::new(Mutex::new(())),
        usage_persist_lock: Arc::new(Mutex::new(())),
        shared_sessions: Arc::new(Mutex::new(shared_sessions)),
        approval_modes: Arc::new(Mutex::new(HashMap::new())),
        pending_tool_responses: Arc::new(Mutex::new(HashMap::new())),
        a2a_tasks: Arc::new(Mutex::new(a2a_tasks)),
        a2a_task_persist_lock: Arc::new(Mutex::new(())),
        a2a_task_events,
        a2a_task_event_history: Arc::new(Mutex::new(HashMap::new())),
        a2a_cancel_senders: Arc::new(Mutex::new(HashMap::new())),
    };

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(connection) => connection,
            Err(error) => {
                eprintln!("control-plane accept failed: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, state).await {
                eprintln!("control-plane request failed: {error}");
            }
        });
    }
}

async fn handle_connection(mut stream: TcpStream, state: AppState) -> Result<(), String> {
    let mut initial = Vec::with_capacity(4096);
    let head = read_request_head(&mut stream, &mut initial).await?;
    let response_origin = requested_cors_origin(&head);

    with_response_cors_origin(response_origin, async move {
        if is_chat_websocket_endpoint(&head) {
            return handle_chat_websocket_endpoint(stream, initial, head, state).await;
        }

        if is_chat_endpoint(&head) {
            return handle_chat_endpoint(stream, initial, head, state).await;
        }

        if is_a2a_streaming_endpoint(&head) {
            return handle_a2a_streaming_endpoint(stream, initial, head, state).await;
        }

        if is_a2a_endpoint(&head) {
            let response = handle_a2a_endpoint(&mut stream, &mut initial, head, &state).await;
            stream
                .write_all(&response)
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }

        if is_platform_a2a_push_endpoint(&head) {
            let response =
                handle_platform_a2a_push_endpoint(&mut stream, &mut initial, head, &state).await;
            stream
                .write_all(&response)
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }

        if is_local_endpoint(&head) {
            let response = handle_local_endpoint(&mut stream, &mut initial, head, &state).await;
            stream
                .write_all(&response)
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }

        if is_runtime_config_request(&head) {
            let response = runtime_config_response(&head, &state.config);
            stream
                .write_all(&response)
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }

        if is_static_asset_request(&head) {
            let response = static_response(&head, &state.config).await;
            stream
                .write_all(&response)
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }

        let response = json_response(
            501,
            &serde_json::json!({
                "error": "route has not been migrated to the Rust server yet",
                "path": head.path,
                "runtime": "rust-control-plane"
            }),
        );
        stream
            .write_all(&response)
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        Ok(())
    })
    .await
}

fn is_chat_endpoint(head: &RequestHead) -> bool {
    head.method == "POST" && head.path == "/api/chat"
}

fn is_chat_websocket_endpoint(head: &RequestHead) -> bool {
    head.method == "GET" && head.path == "/api/chat/ws"
}

fn is_platform_a2a_push_endpoint(head: &RequestHead) -> bool {
    head.path == PLATFORM_A2A_PUSH_PATH
}

fn is_local_endpoint(head: &RequestHead) -> bool {
    if head.method == "OPTIONS" && head.path.starts_with("/api/") {
        return true;
    }
    matches!(
        (head.method.as_str(), head.path.as_str()),
        (
            "GET",
            "/healthz"
                | "/readyz"
                | "/api/status"
                | "/api/models"
                | "/api/model"
                | "/api/files"
                | "/api/commands"
                | "/api/command-prefs"
                | "/api/config"
                | "/api/usage"
                | "/api/metrics"
                | "/api/run"
                | "/api/background"
                | "/api/undo"
                | "/api/changes"
                | "/api/framework"
                | "/api/tools"
                | "/api/review"
                | "/api/context"
                | "/api/stats"
                | "/api/approvals"
                | "/api/telemetry"
                | "/api/training"
        ) | (
            "POST",
            "/api/status"
                | "/api/model"
                | "/api/command-prefs"
                | "/api/config"
                | "/api/telemetry"
                | "/api/training"
                | "/api/framework"
                | "/api/background"
                | "/api/undo"
                | "/api/run"
                | "/api/approvals"
                | "/api/attachments/extract"
        )
    ) || is_session_endpoint(head)
        || is_pending_request_resume_endpoint(head)
}

fn is_session_endpoint(head: &RequestHead) -> bool {
    match head.method.as_str() {
        "GET" => {
            head.path == "/api/sessions"
                || shared_session_path_from_path(&head.path).is_some()
                || session_path_from_path(&head.path).is_some()
        }
        "POST" => {
            head.path == "/api/sessions"
                || session_path_from_path(&head.path)
                    .and_then(|path| path.tail)
                    .map(|tail| {
                        matches!(tail, "share" | "export")
                            || session_attachment_extract_id(tail).is_some()
                    })
                    .unwrap_or(false)
        }
        "PATCH" | "DELETE" => session_path_from_path(&head.path).is_some(),
        _ => false,
    }
}

fn is_pending_request_resume_endpoint(head: &RequestHead) -> bool {
    head.method == "POST" && pending_request_id_from_resume_path(&head.path).is_some()
}

struct SessionPath<'a> {
    id: &'a str,
    tail: Option<&'a str>,
}

struct SharedSessionPath<'a> {
    token: &'a str,
    tail: Option<&'a str>,
}

fn session_path_from_path(path: &str) -> Option<SessionPath<'_>> {
    if path.starts_with("/api/sessions/shared/") {
        return None;
    }
    let remainder = path.strip_prefix("/api/sessions/")?;
    let (id, tail) = remainder
        .split_once('/')
        .map(|(id, tail)| (id, Some(tail)))
        .unwrap_or((remainder, None));
    if id.is_empty() {
        return None;
    }
    Some(SessionPath { id, tail })
}

fn shared_session_path_from_path(path: &str) -> Option<SharedSessionPath<'_>> {
    let remainder = path.strip_prefix("/api/sessions/shared/")?;
    let (token, tail) = remainder
        .split_once('/')
        .map(|(token, tail)| (token, Some(tail)))
        .unwrap_or((remainder, None));
    if token.is_empty() {
        return None;
    }
    Some(SharedSessionPath { token, tail })
}

fn pending_request_id_from_resume_path(path: &str) -> Option<String> {
    let encoded_request_id = path
        .strip_prefix("/api/pending-requests/")?
        .strip_suffix("/resume")?;
    let request_id = percent_decode_component(encoded_request_id);
    if request_id.is_empty() || request_id.contains('/') {
        return None;
    }
    Some(request_id)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct A2APartBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    media_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct A2AMessageBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(default)]
    parts: Vec<A2APartBody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    extensions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reference_task_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct A2ASendMessageRequest {
    message: A2AMessageBody,
    #[serde(default)]
    configuration: Option<Value>,
    #[serde(default)]
    metadata: Option<Value>,
}

#[derive(Debug, Default)]
struct A2ATurnOutput {
    assistant_text: String,
    thinking_text: String,
    usage: Option<TokenUsage>,
    tools: Vec<Value>,
}

enum A2ATurnResult {
    Completed(A2ATurnOutput),
    Canceled,
}

#[derive(Debug)]
struct A2ASendTarget {
    task_id: String,
    context_id: String,
    history: Vec<Value>,
    previous_task: Option<Value>,
    metadata: Value,
}

fn is_a2a_endpoint(head: &RequestHead) -> bool {
    if head.method == "OPTIONS" {
        return head.path == "/.well-known/agent-card.json"
            || head.path == "/message:send"
            || head.path == "/message:stream"
            || head.path == "/extendedAgentCard"
            || head.path == "/tasks"
            || head.path.starts_with("/tasks/");
    }
    matches!(
        (head.method.as_str(), head.path.as_str()),
        ("GET", "/.well-known/agent-card.json")
            | ("GET", "/extendedAgentCard")
            | ("POST", "/message:send")
            | ("GET", "/tasks")
    ) || (head.method == "GET" && a2a_task_id_from_get_path(&head.path).is_some())
        || (head.method == "POST" && a2a_task_id_from_cancel_path(&head.path).is_some())
        || ((head.method == "GET" || head.method == "POST" || head.method == "DELETE")
            && a2a_push_notification_config_path(&head.path).is_some())
}

fn is_a2a_streaming_endpoint(head: &RequestHead) -> bool {
    (head.method == "POST" && head.path == "/message:stream")
        || ((head.method == "GET" || head.method == "POST")
            && a2a_task_id_from_subscribe_path(&head.path).is_some())
}

fn a2a_task_id_from_get_path(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/tasks/")?;
    (!id.is_empty() && !id.contains('/') && !id.contains(':')).then_some(id)
}

fn a2a_push_notification_config_path(path: &str) -> Option<(String, Option<String>)> {
    let rest = path.strip_prefix("/tasks/")?;
    let (task_id, suffix) = rest.split_once("/pushNotificationConfigs")?;
    if task_id.trim().is_empty() || task_id.contains('/') || task_id.contains(':') {
        return None;
    }
    if suffix.is_empty() {
        return Some((percent_decode_component(task_id), None));
    }
    let config_id = suffix.strip_prefix('/')?;
    if config_id.trim().is_empty() || config_id.contains('/') || config_id.contains(':') {
        return None;
    }
    Some((
        percent_decode_component(task_id),
        Some(percent_decode_component(config_id)),
    ))
}

fn validate_a2a_protocol_version(head: &RequestHead) -> Result<(), Vec<u8>> {
    let Some(version) = a2a_requested_protocol_version(head) else {
        return Ok(());
    };
    let version = version.trim();
    if version == A2A_PROTOCOL_VERSION {
        Ok(())
    } else {
        let message =
            format!("Unsupported A2A protocol version {version}; expected {A2A_PROTOCOL_VERSION}");
        Err(a2a_error_response(400, "UNSUPPORTED_VERSION", &message))
    }
}

fn a2a_requested_protocol_version(head: &RequestHead) -> Option<&str> {
    head.headers
        .get("a2a-version")
        .and_then(|value| {
            value
                .split(',')
                .map(str::trim)
                .find(|part| !part.is_empty())
        })
        .or_else(|| head.query.get("a2a-version").map(String::as_str))
        .or_else(|| head.query.get("A2A-Version").map(String::as_str))
        .or_else(|| head.query.get("a2aVersion").map(String::as_str))
}

fn validate_a2a_requested_extensions(
    head: &RequestHead,
    message_extensions: Option<&[String]>,
) -> Result<Vec<String>, Vec<u8>> {
    let requested = requested_a2a_extensions(head, message_extensions);
    let unsupported = requested
        .iter()
        .find(|extension| !a2a_supported_extension(extension));
    if let Some(extension) = unsupported {
        return Err(a2a_error_response(
            400,
            "EXTENSION_NOT_SUPPORTED",
            &format!("A2A extension is not supported by this Maestro agent: {extension}"),
        ));
    }
    Ok(requested)
}

fn requested_a2a_extensions(
    head: &RequestHead,
    message_extensions: Option<&[String]>,
) -> Vec<String> {
    let mut requested = Vec::new();
    if let Some(header) = head.headers.get("a2a-extensions") {
        for extension in header.split(',') {
            push_unique_a2a_extension(&mut requested, extension);
        }
    }
    if let Some(query) = head.query.get("a2a-extensions") {
        for extension in query.split(',') {
            push_unique_a2a_extension(&mut requested, extension);
        }
    }
    if let Some(query) = head.query.get("A2A-Extensions") {
        for extension in query.split(',') {
            push_unique_a2a_extension(&mut requested, extension);
        }
    }
    if let Some(extensions) = message_extensions {
        for extension in extensions {
            push_unique_a2a_extension(&mut requested, extension);
        }
    }
    requested
}

fn push_unique_a2a_extension(requested: &mut Vec<String>, extension: &str) {
    let extension = extension.trim();
    if extension.is_empty() || requested.iter().any(|existing| existing == extension) {
        return;
    }
    requested.push(extension.to_string());
}

fn a2a_supported_extension(extension: &str) -> bool {
    extension == EVALOPS_A2A_EXTENSION_URI
}

async fn handle_a2a_endpoint(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: RequestHead,
    state: &AppState,
) -> Vec<u8> {
    if head.method == "OPTIONS" {
        return response(204, "text/plain; charset=utf-8", &[]);
    }

    if let Err(response) = validate_a2a_protocol_version(&head) {
        return response;
    }

    if let Err(response) = validate_csrf(&head, &state.config) {
        return response;
    }

    if head.method == "GET" && head.path == "/.well-known/agent-card.json" {
        return json_response(200, &a2a_agent_card(&head, &state.config));
    }

    let Some(auth) = auth_context(&head, &state.config) else {
        return json_response(401, &serde_json::json!({ "error": "Unauthorized" }));
    };

    if head.method == "GET" && head.path == "/extendedAgentCard" {
        return json_response(200, &a2a_extended_agent_card(&head, &state.config));
    }

    if head.method == "GET" && head.path == "/tasks" {
        return match a2a_list_tasks_response(&head, state, &auth).await {
            Ok(value) => json_response(200, &value),
            Err(response) => response,
        };
    }

    if let Some((task_id, config_id)) = a2a_push_notification_config_path(&head.path) {
        return match (head.method.as_str(), config_id.as_deref()) {
            ("GET", None) => handle_a2a_push_notification_config_list(state, &task_id, &auth).await,
            ("GET", Some(config_id)) => {
                handle_a2a_push_notification_config_get(state, &task_id, config_id, &auth).await
            }
            ("POST", None) => {
                handle_a2a_push_notification_config_create(
                    stream, initial, &head, state, &task_id, &auth,
                )
                .await
            }
            ("DELETE", Some(config_id)) => {
                handle_a2a_push_notification_config_delete(state, &task_id, config_id, &auth).await
            }
            _ => a2a_error_response(404, "NOT_FOUND", "A2A endpoint not found"),
        };
    }

    if head.method == "GET" {
        if let Some(task_id) = a2a_task_id_from_get_path(&head.path) {
            let tasks = state.a2a_tasks.lock().await;
            return tasks.get(task_id).map_or_else(
                || a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found"),
                |task| {
                    if a2a_task_visible_to_auth(task, &auth) {
                        json_response(200, &a2a_task_for_query(task, true, None))
                    } else {
                        a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found")
                    }
                },
            );
        }
    }

    if head.method == "POST" {
        if let Some(task_id) = a2a_task_id_from_cancel_path(&head.path) {
            return match cancel_a2a_task(state, task_id, &auth).await {
                Ok(task) => json_response(200, &a2a_public_task(&task)),
                Err(response) => response,
            };
        }
    }

    if head.method == "POST" && head.path == "/message:send" {
        return handle_a2a_message_send(stream, initial, &head, state, &auth).await;
    }

    a2a_error_response(404, "NOT_FOUND", "A2A endpoint not found")
}

async fn handle_a2a_streaming_endpoint(
    mut stream: TcpStream,
    mut initial: Vec<u8>,
    head: RequestHead,
    state: AppState,
) -> Result<(), String> {
    if let Err(response) = validate_a2a_protocol_version(&head) {
        return write_response_and_close(&mut stream, response).await;
    }
    if let Err(response) = validate_csrf(&head, &state.config) {
        return write_response_and_close(&mut stream, response).await;
    }
    let Some(auth) = auth_context(&head, &state.config) else {
        return write_response_and_close(
            &mut stream,
            json_response(401, &serde_json::json!({ "error": "Unauthorized" })),
        )
        .await;
    };

    if head.method == "POST" && head.path == "/message:stream" {
        return handle_a2a_message_stream(&mut stream, &mut initial, &head, &state, &auth).await;
    }
    if (head.method == "GET" || head.method == "POST")
        && a2a_task_id_from_subscribe_path(&head.path).is_some()
    {
        return handle_a2a_task_subscribe(&mut stream, &head, &state, &auth).await;
    }
    write_response_and_close(
        &mut stream,
        a2a_error_response(404, "NOT_FOUND", "A2A streaming endpoint not found"),
    )
    .await
}

async fn write_response_and_close(stream: &mut TcpStream, response: Vec<u8>) -> Result<(), String> {
    stream
        .write_all(&response)
        .await
        .map_err(|error| error.to_string())?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn handle_a2a_message_stream(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
    auth: &AuthContext,
) -> Result<(), String> {
    let body = match read_request_body(stream, initial, head).await {
        Ok(body) => body,
        Err(error) => {
            return write_response_and_close(
                stream,
                a2a_error_response(400, "INVALID_REQUEST", &error),
            )
            .await;
        }
    };
    let request: A2ASendMessageRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => {
            return write_response_and_close(
                stream,
                a2a_error_response(
                    400,
                    "INVALID_REQUEST",
                    &format!("invalid A2A message request: {error}"),
                ),
            )
            .await;
        }
    };
    let requested_extensions =
        match validate_a2a_requested_extensions(head, request.message.extensions.as_deref()) {
            Ok(extensions) => extensions,
            Err(response) => return write_response_and_close(stream, response).await,
        };
    let Some(prompt) = a2a_message_text(&request.message) else {
        return write_response_and_close(
            stream,
            a2a_error_response(
                400,
                "INVALID_REQUEST",
                "A2A message must contain at least one text part",
            ),
        )
        .await;
    };
    if let Err(error) = a2a_return_immediately(&request) {
        return write_response_and_close(stream, a2a_error_response(400, "INVALID_REQUEST", error))
            .await;
    }

    let metadata = a2a_task_metadata(head, &request, auth, &requested_extensions);
    let target = match claim_a2a_send_task(state, &request, head, auth, metadata).await {
        Ok(target) => target,
        Err(response) => return write_response_and_close(stream, response).await,
    };
    let task_id = target.task_id;
    let context_id = target.context_id;
    let history = target.history;
    let mut previous_task = target.previous_task;
    let metadata = target.metadata;
    let (cancel_tx, cancel_rx) = watch::channel(false);
    if let Err(response) = register_a2a_cancel_sender(state, &task_id, cancel_tx).await {
        rollback_a2a_send_claim(state, &task_id, previous_task.take()).await;
        return write_response_and_close(stream, response).await;
    }

    if let Err(error) = stream.write_all(sse_headers().as_bytes()).await {
        state.a2a_cancel_senders.lock().await.remove(&task_id);
        rollback_a2a_send_claim(state, &task_id, previous_task.take()).await;
        return Err(error.to_string());
    }
    if let Some(task) = state.a2a_tasks.lock().await.get(&task_id).cloned() {
        if let Err(error) = send_a2a_stream_response(
            stream,
            &serde_json::json!({ "task": a2a_public_task(&task) }),
        )
        .await
        {
            state.a2a_cancel_senders.lock().await.remove(&task_id);
            rollback_a2a_send_claim(state, &task_id, previous_task.take()).await;
            return Err(error);
        }
    }
    let task = complete_a2a_task(
        state, prompt, task_id, context_id, history, metadata, cancel_rx,
    )
    .await;
    send_a2a_stream_response(
        stream,
        &serde_json::json!({ "statusUpdate": a2a_status_update_event(&task) }),
    )
    .await?;
    for artifact in task
        .get("artifacts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        send_a2a_stream_response(
            stream,
            &serde_json::json!({
                "artifactUpdate": a2a_artifact_update_event(&task, artifact)
            }),
        )
        .await?;
    }
    send_a2a_stream_response(
        stream,
        &serde_json::json!({ "task": a2a_public_task(&task) }),
    )
    .await?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn handle_a2a_task_subscribe(
    stream: &mut TcpStream,
    head: &RequestHead,
    state: &AppState,
    auth: &AuthContext,
) -> Result<(), String> {
    let task_id = a2a_task_id_from_subscribe_path(&head.path)
        .expect("subscribe path should have been recognized");
    let mut receiver = state.a2a_task_events.subscribe();
    let current = {
        let tasks = state.a2a_tasks.lock().await;
        let Some(task) = tasks.get(task_id) else {
            return write_response_and_close(
                stream,
                a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found"),
            )
            .await;
        };
        if !a2a_task_visible_to_auth(task, auth) {
            return write_response_and_close(
                stream,
                a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found"),
            )
            .await;
        }
        task.clone()
    };

    if a2a_task_is_terminal(&current) {
        return write_response_and_close(
            stream,
            a2a_error_response(
                400,
                "UNSUPPORTED_OPERATION",
                "A2A terminal tasks cannot be subscribed to",
            ),
        )
        .await;
    }
    stream
        .write_all(sse_headers().as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    send_a2a_stream_response(stream, &serde_json::json!({ "task": current.clone() })).await?;
    send_a2a_stream_response(
        stream,
        &serde_json::json!({ "statusUpdate": a2a_status_update_event(&current) }),
    )
    .await?;
    let mut next_replay_sequence = a2a_task_event_next_sequence(state, task_id).await;

    let subscribe_timeout = Duration::from_millis(
        env_u64(
            "MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS",
            A2A_DEFAULT_SUBSCRIBE_TIMEOUT_MS,
        )
        .max(1),
    );
    let heartbeat_interval = Duration::from_millis(
        env_u64(
            "MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS",
            A2A_DEFAULT_SUBSCRIBE_HEARTBEAT_MS,
        )
        .max(1),
    );
    let deadline = Instant::now() + subscribe_timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let wait_timeout = remaining.min(heartbeat_interval);
        let event = match tokio::time::timeout(wait_timeout, receiver.recv()).await {
            Ok(Ok(event)) => {
                if event.task_id == task_id {
                    next_replay_sequence = event.sequence.saturating_add(1);
                    Some(event.task)
                } else {
                    None
                }
            }
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                let replay =
                    a2a_task_events_since(state, task_id, next_replay_sequence, auth).await;
                if replay.is_empty() {
                    next_replay_sequence = a2a_task_event_next_sequence(state, task_id).await;
                    current_a2a_subscribe_task(state, task_id, auth).await
                } else {
                    for event in replay {
                        next_replay_sequence = event.sequence.saturating_add(1);
                        if send_a2a_subscribe_task_update(stream, &event.task, auth).await? {
                            let _ = stream.shutdown().await;
                            return Ok(());
                        }
                    }
                    continue;
                }
            }
            Ok(Err(broadcast::error::RecvError::Closed)) => break,
            Err(_) => {
                if Instant::now() >= deadline {
                    break;
                }
                stream
                    .write_all(b": keep-alive\n\n")
                    .await
                    .map_err(|error| error.to_string())?;
                continue;
            }
        };
        let Some(event) = event else {
            continue;
        };
        if event.get("id").and_then(Value::as_str) != Some(task_id) {
            continue;
        }
        if send_a2a_subscribe_task_update(stream, &event, auth).await? {
            break;
        }
    }
    let _ = stream.shutdown().await;
    Ok(())
}

async fn current_a2a_subscribe_task(
    state: &AppState,
    task_id: &str,
    auth: &AuthContext,
) -> Option<Value> {
    let tasks = state.a2a_tasks.lock().await;
    let task = tasks.get(task_id)?;
    a2a_task_visible_to_auth(task, auth).then(|| task.clone())
}

async fn a2a_task_event_next_sequence(state: &AppState, task_id: &str) -> u64 {
    state
        .a2a_task_event_history
        .lock()
        .await
        .get(task_id)
        .map(|history| history.next_sequence)
        .unwrap_or(0)
}

async fn a2a_task_events_since(
    state: &AppState,
    task_id: &str,
    sequence: u64,
    auth: &AuthContext,
) -> Vec<A2ATaskUpdateEvent> {
    state
        .a2a_task_event_history
        .lock()
        .await
        .get(task_id)
        .map(|history| {
            history
                .events
                .iter()
                .filter(|event| {
                    event.sequence >= sequence && a2a_task_visible_to_auth(&event.task, auth)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

async fn send_a2a_subscribe_task_update(
    stream: &mut TcpStream,
    task: &Value,
    auth: &AuthContext,
) -> Result<bool, String> {
    if !a2a_task_visible_to_auth(task, auth) {
        return Ok(false);
    }
    send_a2a_stream_response(
        stream,
        &serde_json::json!({ "statusUpdate": a2a_status_update_event(task) }),
    )
    .await?;
    if a2a_task_is_terminal(task) {
        for artifact in task
            .get("artifacts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            send_a2a_stream_response(
                stream,
                &serde_json::json!({
                    "artifactUpdate": a2a_artifact_update_event(task, artifact)
                }),
            )
            .await?;
        }
        send_a2a_stream_response(
            stream,
            &serde_json::json!({ "task": a2a_public_task(task) }),
        )
        .await?;
        return Ok(true);
    }
    Ok(false)
}

async fn send_a2a_stream_response(stream: &mut TcpStream, value: &Value) -> Result<(), String> {
    let Some(event_name) = a2a_stream_event_name(value) else {
        return send_sse(stream, value).await;
    };
    let body = serde_json::to_string(value).map_err(|error| error.to_string())?;
    stream
        .write_all(format!("event: {event_name}\ndata: {body}\n\n").as_bytes())
        .await
        .map_err(|error| error.to_string())
}

fn a2a_stream_event_name(value: &Value) -> Option<&'static str> {
    if value.get("task").is_some() {
        Some("task")
    } else if value.get("statusUpdate").is_some() {
        Some("statusUpdate")
    } else if value.get("artifactUpdate").is_some() {
        Some("artifactUpdate")
    } else {
        None
    }
}

fn a2a_status_update_event(task: &Value) -> Value {
    let task = a2a_public_task(task);
    serde_json::json!({
        "taskId": task.get("id").cloned().unwrap_or(Value::Null),
        "contextId": task.get("contextId").cloned().unwrap_or(Value::Null),
        "status": task.get("status").cloned().unwrap_or(Value::Null),
        "metadata": task.get("metadata").cloned().unwrap_or_else(|| serde_json::json!({}))
    })
}

fn a2a_artifact_update_event(task: &Value, artifact: &Value) -> Value {
    let task = a2a_public_task(task);
    serde_json::json!({
        "taskId": task.get("id").cloned().unwrap_or(Value::Null),
        "contextId": task.get("contextId").cloned().unwrap_or(Value::Null),
        "artifact": artifact,
        "append": false,
        "lastChunk": true,
        "metadata": task.get("metadata").cloned().unwrap_or_else(|| serde_json::json!({}))
    })
}

fn a2a_public_task(task: &Value) -> Value {
    let mut task = task.clone();
    a2a_redact_push_notification_metadata(&mut task);
    task
}

fn a2a_redact_push_notification_metadata(task: &mut Value) {
    let Some(metadata) = task.get_mut("metadata").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(configs) = metadata
        .get_mut(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for config in configs {
        a2a_redact_push_notification_secret_fields(config);
    }
}

fn a2a_redacted_push_notification_config(config: &Value) -> Value {
    let mut config = config.clone();
    a2a_redact_push_notification_secret_fields(&mut config);
    config
}

fn a2a_redact_push_notification_secret_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if a2a_push_notification_secret_key(key) {
                    *value = Value::String("<redacted>".to_string());
                } else {
                    a2a_redact_push_notification_secret_fields(value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                a2a_redact_push_notification_secret_fields(value);
            }
        }
        _ => {}
    }
}

fn a2a_push_notification_secret_key(key: &str) -> bool {
    let normalized = key.replace(['_', '-', '.', ' '], "").to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "token"
            | "authtoken"
            | "bearertoken"
            | "authorization"
            | "authorizationheader"
            | "credential"
            | "credentials"
            | "secret"
            | "password"
    )
}

async fn handle_platform_a2a_push_endpoint(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: RequestHead,
    state: &AppState,
) -> Vec<u8> {
    if head.method == "OPTIONS" {
        return response_with_extra_headers(
            204,
            "text/plain; charset=utf-8",
            &[],
            "Allow: POST, OPTIONS\r\n",
        );
    }
    if head.method != "POST" {
        return response_with_extra_headers(
            405,
            "application/json",
            br#"{"error":{"code":"METHOD_NOT_ALLOWED","message":"A2A push callbacks require POST"}}"#,
            "Allow: POST, OPTIONS\r\n",
        );
    }
    if let Err(response) = validate_platform_a2a_push_callback_auth(&head) {
        return response;
    }
    let body = match read_request_body(stream, initial, &head).await {
        Ok(body) => body,
        Err(error) => return a2a_error_response(400, "INVALID_REQUEST", &error),
    };
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(error) => {
            return a2a_error_response(
                400,
                "INVALID_REQUEST",
                &format!("invalid A2A push payload: {error}"),
            );
        }
    };
    match record_platform_a2a_push_payload(state, payload).await {
        Ok(accepted) => json_response(202, &accepted),
        Err(message) => a2a_error_response(400, "INVALID_REQUEST", &message),
    }
}

fn validate_platform_a2a_push_callback_auth(head: &RequestHead) -> Result<(), Vec<u8>> {
    let Some(expected) = platform_a2a_push_callback_token() else {
        return Err(json_response(
            503,
            &serde_json::json!({
                "error": {
                    "code": "CALLBACK_TOKEN_NOT_CONFIGURED",
                    "message": "A2A push callback token is not configured"
                }
            }),
        ));
    };
    let provided = platform_a2a_push_request_token(head);
    if provided.as_deref() == Some(expected.as_str()) {
        Ok(())
    } else {
        Err(json_response(
            401,
            &serde_json::json!({
                "error": {
                    "code": "UNAUTHORIZED",
                    "message": "A2A push callback token is invalid"
                }
            }),
        ))
    }
}

fn platform_a2a_push_callback_token() -> Option<String> {
    trimmed_env("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN")
        .or_else(|| trimmed_env("MAESTRO_A2A_CALLBACK_TOKEN"))
}

fn platform_a2a_push_request_token(head: &RequestHead) -> Option<String> {
    head.headers
        .get("x-a2a-notification-token")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            head.headers
                .get("authorization")
                .and_then(|value| value.strip_prefix("Bearer "))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

async fn record_platform_a2a_push_payload(
    state: &AppState,
    payload: Value,
) -> Result<Value, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "A2A push payload must be a JSON object".to_string())?;
    if let Some(task) = object.get("task") {
        let task_id = task_id_from_task(task)?;
        let task = task.clone();
        {
            let mut tasks = state.a2a_tasks.lock().await;
            tasks.insert(task_id.clone(), task.clone());
        }
        publish_a2a_task_update(state, &task).await;
        persist_a2a_tasks(state).await;
        return Ok(serde_json::json!({
            "accepted": true,
            "kind": "task",
            "taskId": task_id
        }));
    }
    if let Some(status_update) = object.get("statusUpdate") {
        let task = apply_platform_a2a_status_update(state, status_update).await?;
        publish_a2a_task_update(state, &task).await;
        persist_a2a_tasks(state).await;
        return Ok(serde_json::json!({
            "accepted": true,
            "kind": "statusUpdate",
            "taskId": task.get("id").and_then(Value::as_str).unwrap_or_default()
        }));
    }
    if let Some(artifact_update) = object.get("artifactUpdate") {
        let task = apply_platform_a2a_artifact_update(state, artifact_update).await?;
        publish_a2a_task_update(state, &task).await;
        persist_a2a_tasks(state).await;
        return Ok(serde_json::json!({
            "accepted": true,
            "kind": "artifactUpdate",
            "taskId": task.get("id").and_then(Value::as_str).unwrap_or_default()
        }));
    }
    Err("A2A push payload must include statusUpdate, artifactUpdate, or task".to_string())
}

async fn apply_platform_a2a_status_update(
    state: &AppState,
    status_update: &Value,
) -> Result<Value, String> {
    let object = status_update
        .as_object()
        .ok_or_else(|| "A2A statusUpdate must be an object".to_string())?;
    let task_id = required_string_field(object, "taskId", "A2A statusUpdate taskId is required")?;
    let status = object
        .get("status")
        .filter(|status| status.is_object())
        .cloned()
        .ok_or_else(|| "A2A statusUpdate status is required".to_string())?;
    let mut tasks = state.a2a_tasks.lock().await;
    let context_id = optional_string_field(object, "contextId")
        .or_else(|| tasks.get(&task_id).and_then(task_context_id))
        .unwrap_or_else(|| task_id.clone());
    let task = tasks
        .entry(task_id.clone())
        .or_insert_with(|| empty_platform_a2a_task(&task_id, &context_id));
    task["id"] = Value::String(task_id);
    task["contextId"] = Value::String(context_id);
    task["status"] = status;
    if let Some(metadata) = object.get("metadata") {
        upsert_task_metadata_field(task, "lastPlatformStatusUpdate", metadata.clone());
    }
    Ok(task.clone())
}

async fn apply_platform_a2a_artifact_update(
    state: &AppState,
    artifact_update: &Value,
) -> Result<Value, String> {
    let object = artifact_update
        .as_object()
        .ok_or_else(|| "A2A artifactUpdate must be an object".to_string())?;
    let task_id = required_string_field(object, "taskId", "A2A artifactUpdate taskId is required")?;
    let artifact = object
        .get("artifact")
        .filter(|artifact| artifact.is_object())
        .cloned()
        .ok_or_else(|| "A2A artifactUpdate artifact is required".to_string())?;
    let mut tasks = state.a2a_tasks.lock().await;
    let context_id = optional_string_field(object, "contextId")
        .or_else(|| tasks.get(&task_id).and_then(task_context_id))
        .unwrap_or_else(|| task_id.clone());
    let task = tasks
        .entry(task_id.clone())
        .or_insert_with(|| empty_platform_a2a_task(&task_id, &context_id));
    task["id"] = Value::String(task_id);
    task["contextId"] = Value::String(context_id);
    append_task_artifact(task, artifact);
    if let Some(metadata) = object.get("metadata") {
        upsert_task_metadata_field(task, "lastPlatformArtifactUpdate", metadata.clone());
    }
    Ok(task.clone())
}

fn task_id_from_task(task: &Value) -> Result<String, String> {
    task.get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "A2A task payload id is required".to_string())
}

fn task_context_id(task: &Value) -> Option<String> {
    task.get("contextId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn empty_platform_a2a_task(task_id: &str, context_id: &str) -> Value {
    serde_json::json!({
        "id": task_id,
        "contextId": context_id,
        "status": {
            "state": "TASK_STATE_WORKING",
            "message": a2a_agent_message(context_id, "Platform AgentRuntime push update received."),
            "timestamp": now_rfc3339()
        },
        "history": [],
        "artifacts": [],
        "metadata": {
            "runtime": "platform-agent-runtime",
            "surface": "platform-a2a-push"
        }
    })
}

fn optional_string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn required_string_field(
    object: &Map<String, Value>,
    key: &str,
    message: &str,
) -> Result<String, String> {
    optional_string_field(object, key).ok_or_else(|| message.to_string())
}

fn upsert_task_metadata_field(task: &mut Value, key: &str, value: Value) {
    if !task.get("metadata").is_some_and(Value::is_object) {
        task["metadata"] = serde_json::json!({});
    }
    if let Some(metadata) = task.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.insert(key.to_string(), value);
    }
}

fn append_task_artifact(task: &mut Value, artifact: Value) {
    if !task.get("artifacts").is_some_and(Value::is_array) {
        task["artifacts"] = Value::Array(Vec::new());
    }
    let artifact_id = artifact
        .get("artifactId")
        .or_else(|| artifact.get("artifact_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(artifacts) = task.get_mut("artifacts").and_then(Value::as_array_mut) else {
        return;
    };
    if let Some(artifact_id) = artifact_id {
        if let Some(existing) = artifacts.iter_mut().find(|existing| {
            existing
                .get("artifactId")
                .or_else(|| existing.get("artifact_id"))
                .and_then(Value::as_str)
                == Some(artifact_id.as_str())
        }) {
            *existing = artifact;
            return;
        }
    }
    artifacts.push(artifact);
}

async fn cancel_a2a_task(
    state: &AppState,
    task_id: &str,
    auth: &AuthContext,
) -> Result<Value, Vec<u8>> {
    let mut tasks = state.a2a_tasks.lock().await;
    let Some(task) = tasks.get_mut(task_id) else {
        return Err(a2a_error_response(
            404,
            "TASK_NOT_FOUND",
            "A2A task not found",
        ));
    };
    if !a2a_task_visible_to_auth(task, auth) {
        return Err(a2a_error_response(
            404,
            "TASK_NOT_FOUND",
            "A2A task not found",
        ));
    }
    if a2a_task_is_terminal(task) {
        return Err(a2a_error_response(
            400,
            "TASK_NOT_CANCELABLE",
            "A2A task cannot be canceled from its current state",
        ));
    }
    let context_id = task
        .get("contextId")
        .and_then(Value::as_str)
        .unwrap_or("a2a")
        .to_string();
    task["status"] = serde_json::json!({
        "state": "TASK_STATE_CANCELED",
        "message": a2a_agent_message(&context_id, "Task canceled"),
        "timestamp": now_rfc3339()
    });
    task["artifacts"] = Value::Array(Vec::new());
    let task = task.clone();
    prune_a2a_terminal_tasks(&mut tasks);
    drop(tasks);

    if let Some(sender) = state.a2a_cancel_senders.lock().await.remove(task_id) {
        let _ = sender.send(true);
    }
    publish_a2a_task_update(state, &task).await;
    persist_a2a_tasks(state).await;

    Ok(task)
}

fn a2a_task_status_state(task: &Value) -> Option<&str> {
    task.get("status")
        .and_then(|status| status.get("state"))
        .and_then(Value::as_str)
}

fn a2a_task_status_timestamp(task: &Value) -> Option<&str> {
    task.get("status")
        .and_then(|status| status.get("timestamp"))
        .and_then(Value::as_str)
}

fn a2a_task_is_terminal(task: &Value) -> bool {
    matches!(
        a2a_task_status_state(task),
        Some(
            "TASK_STATE_COMPLETED"
                | "TASK_STATE_FAILED"
                | "TASK_STATE_CANCELED"
                | "TASK_STATE_REJECTED"
        )
    )
}

fn a2a_task_accepts_message(task: &Value) -> bool {
    a2a_task_status_state(task) == Some("TASK_STATE_INPUT_REQUIRED")
}

fn a2a_task_owner_subject(task: &Value) -> Option<&str> {
    task.get("metadata")
        .and_then(|metadata| metadata.get("ownerSubject"))
        .and_then(Value::as_str)
}

fn a2a_task_visible_to_auth(task: &Value, auth: &AuthContext) -> bool {
    if auth.unrestricted {
        return true;
    }
    auth.subject
        .as_deref()
        .is_some_and(|subject| a2a_task_owner_subject(task) == Some(subject))
}

async fn load_a2a_tasks(path: &Path) -> HashMap<String, Value> {
    let Some(parsed) = read_a2a_task_ledger_value(path).await else {
        return HashMap::new();
    };
    a2a_task_ledger_entries(&parsed)
        .into_iter()
        .filter_map(|entry| a2a_task_from_ledger_entry(&entry))
        .filter_map(|task| {
            let task_id = task.get("id").and_then(Value::as_str)?.trim().to_string();
            (!task_id.is_empty()).then_some((task_id, task))
        })
        .collect()
}

async fn read_a2a_task_ledger_value(path: &Path) -> Option<Value> {
    let raw = match tokio::fs::read_to_string(path).await {
        Ok(raw) => raw,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("failed to read A2A task ledger {}: {error}", path.display());
            }
            return None;
        }
    };
    match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!(
                "failed to parse A2A task ledger {}: {error}",
                path.display()
            );
            None
        }
    }
}

fn a2a_task_ledger_entries(ledger: &Value) -> Vec<Value> {
    ledger
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn a2a_task_from_ledger_entry(entry: &Value) -> Option<Value> {
    let peer = entry.get("peer").and_then(Value::as_str);
    if peer.is_some_and(|peer| peer != A2A_CONTROL_PLANE_LEDGER_PEER) {
        return None;
    }
    if let Some(task) = entry.get("a2aTask").and_then(Value::as_object) {
        let task = Value::Object(task.clone());
        if task.get("id").and_then(Value::as_str).is_some() {
            return Some(task);
        }
    }
    if entry.get("id").and_then(Value::as_str).is_some()
        && entry.get("status").and_then(Value::as_object).is_some()
    {
        return Some(entry.clone());
    }
    if peer != Some(A2A_CONTROL_PLANE_LEDGER_PEER) {
        return None;
    }
    let task_id = entry.get("taskId").and_then(Value::as_str)?;
    let context_id = entry
        .get("contextId")
        .and_then(Value::as_str)
        .unwrap_or("maestro-control-plane");
    let state = entry
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("TASK_STATE_UNKNOWN");
    let updated_at = entry
        .get("updatedAt")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(now_rfc3339);
    let status_message_text = entry
        .get("responseText")
        .and_then(Value::as_str)
        .or_else(|| entry.get("text").and_then(Value::as_str))
        .unwrap_or("Restored A2A task from Maestro ledger.");
    let status_message = a2a_agent_message(context_id, status_message_text);
    let history = entry
        .get("transcript")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| a2a_message_from_ledger_transcript(context_id, item))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let metadata = entry
        .get("metadata")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let mut task = a2a_task_value(
        task_id,
        context_id,
        state,
        status_message,
        history,
        Vec::new(),
        metadata,
    );
    task["status"]["timestamp"] = Value::String(updated_at);
    Some(task)
}

fn a2a_message_from_ledger_transcript(context_id: &str, item: &Value) -> Option<Value> {
    let text = item.get("text").and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    let role = match item.get("role").and_then(Value::as_str) {
        Some(role) if role.eq_ignore_ascii_case("agent") => "ROLE_AGENT",
        _ => "ROLE_USER",
    };
    let message_id = item
        .get("messageId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| generate_a2a_id("maestro-message"));
    Some(serde_json::json!({
        "messageId": message_id,
        "contextId": context_id,
        "role": role,
        "parts": [{ "text": text, "mediaType": "text/plain" }]
    }))
}

async fn persist_a2a_tasks(state: &AppState) {
    let _guard = state.a2a_task_persist_lock.lock().await;
    let file_lock = match acquire_a2a_task_ledger_file_lock(&state.config.a2a_tasks_file_path).await
    {
        Ok(file_lock) => file_lock,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    let heartbeat_task =
        spawn_a2a_task_ledger_lock_heartbeat(&file_lock, a2a_task_ledger_lock_heartbeat_interval());
    let result = persist_a2a_tasks_locked(state).await;
    heartbeat_task.abort();
    let _ = heartbeat_task.await;
    release_a2a_task_ledger_file_lock(file_lock).await;
    if let Err(error) = result {
        eprintln!("{error}");
    }
}

async fn persist_a2a_tasks_locked(state: &AppState) -> Result<(), String> {
    let existing_entries = read_a2a_task_ledger_value(&state.config.a2a_tasks_file_path)
        .await
        .map(|ledger| a2a_task_ledger_entries(&ledger))
        .unwrap_or_default();
    let tasks = state.a2a_tasks.lock().await;
    let local_task_ids = tasks.keys().cloned().collect::<Vec<_>>();
    let mut retained_entries = existing_entries
        .iter()
        .filter(|entry| {
            if a2a_ledger_entry_is_raw_a2a_task(entry) {
                return false;
            }
            if a2a_ledger_entry_is_control_plane(entry) {
                let task_id = ledger_entry_task_id(entry);
                if task_id.is_empty() {
                    return true;
                }
                return !local_task_ids.iter().any(|local_id| local_id == task_id);
            }
            true
        })
        .cloned()
        .collect::<Vec<_>>();
    let existing_control_plane_entries = existing_entries
        .into_iter()
        .filter(a2a_ledger_entry_is_control_plane)
        .filter_map(|entry| {
            let task_id = entry.get("taskId").and_then(Value::as_str)?.to_string();
            Some((task_id, entry))
        })
        .collect::<HashMap<_, _>>();
    let mut control_plane_entries = tasks
        .values()
        .cloned()
        .filter_map(|task| {
            let task_id = task.get("id").and_then(Value::as_str)?;
            let existing = existing_control_plane_entries.get(task_id);
            Some(a2a_ledger_entry_from_task(&task, existing))
        })
        .collect::<Vec<_>>();
    drop(tasks);
    retained_entries.append(&mut control_plane_entries);
    retained_entries.sort_by(|left, right| {
        ledger_entry_updated_at(left)
            .cmp(ledger_entry_updated_at(right))
            .then_with(|| ledger_entry_task_id(left).cmp(ledger_entry_task_id(right)))
    });
    let body = serde_json::to_vec_pretty(&serde_json::json!({ "tasks": retained_entries }))
        .unwrap_or_else(|_| br#"{"tasks":[]}"#.to_vec());
    let path = &state.config.a2a_tasks_file_path;
    if let Some(parent) = path.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            return Err(format!(
                "failed to create A2A task ledger directory {}: {error}",
                parent.display()
            ));
        }
    }
    let tmp_path = a2a_task_ledger_temp_path(path);
    if let Err(error) = tokio::fs::write(&tmp_path, body).await {
        return Err(format!(
            "failed to write A2A task ledger {}: {error}",
            tmp_path.display()
        ));
    }
    if let Err(error) = tokio::fs::rename(&tmp_path, path).await {
        let message = format!(
            "failed to replace A2A task ledger {}: {error}",
            path.display()
        );
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(message);
    }
    Ok(())
}

struct A2ATaskLedgerFileLock {
    path: PathBuf,
    token: String,
}

async fn acquire_a2a_task_ledger_file_lock(path: &Path) -> Result<A2ATaskLedgerFileLock, String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            format!(
                "failed to create A2A task ledger directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let lock_path = a2a_task_ledger_lock_path(path);
    let token = format!(
        "{}:{}",
        process::id(),
        ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let deadline = Instant::now() + Duration::from_millis(A2A_LEDGER_LOCK_TIMEOUT_MS);
    loop {
        match tokio::fs::create_dir(&lock_path).await {
            Ok(()) => {
                if let Err(error) = write_a2a_task_ledger_lock_metadata(&lock_path, &token).await {
                    let _ = tokio::fs::remove_dir_all(&lock_path).await;
                    return Err(error);
                }
                return Ok(A2ATaskLedgerFileLock {
                    path: lock_path,
                    token,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if a2a_task_ledger_lock_is_stale(&lock_path).await {
                    let _ = tokio::fs::remove_dir_all(&lock_path).await;
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "timed out waiting for A2A task ledger lock {}",
                        lock_path.display()
                    ));
                }
                tokio::time::sleep(Duration::from_millis(A2A_LEDGER_LOCK_RETRY_MS)).await;
            }
            Err(error) => {
                return Err(format!(
                    "failed to acquire A2A task ledger lock {}: {error}",
                    lock_path.display()
                ));
            }
        }
    }
}

async fn write_a2a_task_ledger_lock_metadata(lock_path: &Path, token: &str) -> Result<(), String> {
    tokio::fs::write(
        lock_path.join(A2A_LEDGER_LOCK_OWNER_FILE),
        format!("{token}\n"),
    )
    .await
    .map_err(|error| {
        format!(
            "failed to write A2A task ledger lock owner {}: {error}",
            lock_path.display()
        )
    })?;
    write_a2a_task_ledger_lock_heartbeat(lock_path).await
}

async fn write_a2a_task_ledger_lock_heartbeat(lock_path: &Path) -> Result<(), String> {
    tokio::fs::write(
        lock_path.join(A2A_LEDGER_LOCK_HEARTBEAT_FILE),
        format!("{}\n", unix_millis_now()),
    )
    .await
    .map_err(|error| {
        format!(
            "failed to write A2A task ledger lock heartbeat {}: {error}",
            lock_path.display()
        )
    })
}

fn a2a_task_ledger_lock_heartbeat_interval() -> Duration {
    Duration::from_millis(
        (A2A_LEDGER_LOCK_STALE_MS / 3)
            .max(A2A_LEDGER_LOCK_RETRY_MS)
            .max(1),
    )
}

fn spawn_a2a_task_ledger_lock_heartbeat(
    file_lock: &A2ATaskLedgerFileLock,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    let lock_path = file_lock.path.clone();
    let token = file_lock.token.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            if !a2a_task_ledger_lock_is_owned(&lock_path, &token).await {
                break;
            }
            let _ = write_a2a_task_ledger_lock_heartbeat(&lock_path).await;
        }
    })
}

async fn release_a2a_task_ledger_file_lock(file_lock: A2ATaskLedgerFileLock) {
    if a2a_task_ledger_lock_is_owned(&file_lock.path, &file_lock.token).await {
        let _ = tokio::fs::remove_dir_all(&file_lock.path).await;
    }
}

async fn a2a_task_ledger_lock_is_owned(lock_path: &Path, token: &str) -> bool {
    tokio::fs::read_to_string(lock_path.join(A2A_LEDGER_LOCK_OWNER_FILE))
        .await
        .map(|owner| owner.trim() == token)
        .unwrap_or(false)
}

async fn a2a_task_ledger_lock_is_stale(lock_path: &Path) -> bool {
    let modified_at = match a2a_task_ledger_lock_modified_at(lock_path).await {
        Some(modified_at) => modified_at,
        None => return true,
    };
    SystemTime::now()
        .duration_since(modified_at)
        .map(|age| age > Duration::from_millis(A2A_LEDGER_LOCK_STALE_MS))
        .unwrap_or(false)
}

async fn a2a_task_ledger_lock_modified_at(lock_path: &Path) -> Option<SystemTime> {
    for path in [
        lock_path.join(A2A_LEDGER_LOCK_HEARTBEAT_FILE),
        lock_path.join(A2A_LEDGER_LOCK_OWNER_FILE),
        lock_path.to_path_buf(),
    ] {
        match tokio::fs::metadata(&path).await {
            Ok(metadata) => return metadata.modified().ok(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        }
    }
    None
}

fn a2a_task_ledger_lock_path(path: &Path) -> PathBuf {
    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".lock");
    PathBuf::from(lock_path)
}

fn a2a_task_ledger_temp_path(path: &Path) -> PathBuf {
    let mut tmp_path = path.as_os_str().to_os_string();
    tmp_path.push(format!(
        ".{}.{}.tmp",
        process::id(),
        ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    PathBuf::from(tmp_path)
}

fn unix_millis_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

async fn publish_a2a_task_update(state: &AppState, task: &Value) {
    let Some(task_id) = task
        .get("id")
        .and_then(Value::as_str)
        .filter(|task_id| !task_id.is_empty())
    else {
        return;
    };
    let event = {
        let mut histories = state.a2a_task_event_history.lock().await;
        let history = histories.entry(task_id.to_string()).or_default();
        let event = A2ATaskUpdateEvent {
            task_id: task_id.to_string(),
            sequence: history.next_sequence,
            task: task.clone(),
        };
        history.next_sequence = history.next_sequence.saturating_add(1);
        history.events.push(event.clone());
        let overflow = history
            .events
            .len()
            .saturating_sub(A2A_TASK_EVENT_REPLAY_LIMIT);
        if overflow > 0 {
            history.events.drain(..overflow);
        }
        event
    };
    let _ = state.a2a_task_events.send(event);
    dispatch_a2a_push_notifications(task);
}

fn dispatch_a2a_push_notifications(task: &Value) {
    if truthy_env("MAESTRO_A2A_PUSH_DISABLE_DELIVERY") {
        return;
    }
    let configs = a2a_task_push_notification_configs(task);
    if configs.is_empty() {
        return;
    }
    let payloads = a2a_push_notification_payloads(task);
    for config in configs {
        let payloads = payloads.clone();
        std::mem::drop(tokio::task::spawn_blocking(move || {
            for payload in payloads {
                send_a2a_push_notification(&payload, &config);
            }
        }));
    }
}

fn a2a_task_without_push_notification_configs(task: &Value) -> Value {
    let mut task = task.clone();
    if let Some(metadata) = task.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.remove(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY);
    }
    task
}

fn a2a_push_notification_payloads(task: &Value) -> Vec<Value> {
    let task = a2a_task_without_push_notification_configs(task);
    let mut payloads = vec![serde_json::json!({ "statusUpdate": a2a_status_update_event(&task) })];
    if a2a_task_is_terminal(&task) {
        for artifact in task
            .get("artifacts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            payloads.push(serde_json::json!({
                "artifactUpdate": a2a_artifact_update_event(&task, artifact)
            }));
        }
        payloads.push(serde_json::json!({ "task": task }));
    }
    payloads
}

fn send_a2a_push_notification(payload: &Value, config: &Value) {
    let Some(url) = config.get("url").and_then(Value::as_str) else {
        return;
    };
    if validate_a2a_push_notification_url(url, true).is_err() {
        return;
    }
    let timeout = Duration::from_millis(env_u64(
        "MAESTRO_A2A_PUSH_TIMEOUT_MS",
        A2A_DEFAULT_PUSH_TIMEOUT_MS,
    ));
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return;
    };
    let Ok(body) = serde_json::to_vec(payload) else {
        return;
    };
    let mut request = client
        .post(url)
        .header("Content-Type", "application/a2a+json")
        .body(body);
    if let Some(token) = config.get("token").and_then(Value::as_str) {
        request = request.header("X-A2A-Notification-Token", token);
    }
    if let Some(authentication) = config.get("authentication").and_then(Value::as_object) {
        if let Some(header_value) = a2a_push_authorization_header(authentication) {
            request = request.header("Authorization", header_value);
        }
    }
    let _ = request.send();
}

fn a2a_push_authorization_header(authentication: &Map<String, Value>) -> Option<String> {
    let scheme = authentication
        .get("scheme")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            authentication
                .get("schemes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find_map(Value::as_str)
                .map(str::trim)
        })
        .filter(|value| !value.is_empty())?;
    let credentials = authentication
        .get("credentials")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(format!("{scheme} {credentials}"))
}

fn a2a_ledger_entry_is_control_plane(entry: &Value) -> bool {
    entry.get("peer").and_then(Value::as_str) == Some(A2A_CONTROL_PLANE_LEDGER_PEER)
        || (entry.get("peer").is_none()
            && entry.get("id").and_then(Value::as_str).is_some()
            && entry.get("status").and_then(Value::as_object).is_some())
}

fn a2a_ledger_entry_is_raw_a2a_task(entry: &Value) -> bool {
    entry.get("peer").is_none()
        && entry.get("taskId").is_none()
        && entry.get("id").and_then(Value::as_str).is_some()
        && entry.get("status").and_then(Value::as_object).is_some()
}

fn a2a_ledger_entry_from_task(task: &Value, existing: Option<&Value>) -> Value {
    let task_id = task
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown-task");
    let context_id = task.get("contextId").and_then(Value::as_str);
    let state = a2a_task_status_state(task).unwrap_or("TASK_STATE_UNKNOWN");
    let updated_at = a2a_task_status_timestamp(task)
        .map(str::to_string)
        .unwrap_or_else(now_rfc3339);
    let transcript = a2a_task_transcript(task, state, &updated_at);
    let text = transcript
        .iter()
        .find(|entry| entry.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|entry| entry.get("text").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| {
            existing
                .and_then(|entry| entry.get("text").and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("A2A task {task_id}"));
    let response_text = a2a_task_response_text(task);
    let created_at = existing
        .and_then(|entry| entry.get("createdAt").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| {
            transcript
                .first()
                .and_then(|entry| entry.get("at").and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| updated_at.clone());
    let metadata = a2a_clean_ledger_metadata(task.get("metadata"));
    let mut entry = serde_json::json!({
        "id": existing
            .and_then(|entry| entry.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| format!("maestro-control-plane-{task_id}")),
        "kind": "message",
        "peer": A2A_CONTROL_PLANE_LEDGER_PEER,
        "peerDisplayName": A2A_CONTROL_PLANE_LEDGER_DISPLAY_NAME,
        "taskId": task_id,
        "text": text,
        "state": state,
        "transcript": transcript,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "metadata": metadata,
        "a2aTask": task
    });
    if let Some(context_id) = context_id {
        entry["contextId"] = Value::String(context_id.to_string());
    }
    if let Some(message_id) = a2a_task_first_user_message_id(task) {
        entry["messageId"] = Value::String(message_id);
    }
    if let Some(response_text) = response_text {
        entry["responseText"] = Value::String(response_text);
    }
    if a2a_task_is_terminal(task) {
        entry["completedAt"] = entry["updatedAt"].clone();
    }
    entry
}

fn a2a_task_transcript(task: &Value, state: &str, updated_at: &str) -> Vec<Value> {
    task.get("history")
        .and_then(Value::as_array)
        .map(|history| {
            history
                .iter()
                .filter_map(|message| a2a_transcript_entry_from_message(message, state, updated_at))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn a2a_transcript_entry_from_message(
    message: &Value,
    state: &str,
    updated_at: &str,
) -> Option<Value> {
    let text = a2a_message_value_text(message)?;
    let role = match message.get("role").and_then(Value::as_str) {
        Some(role)
            if role.eq_ignore_ascii_case("ROLE_AGENT") || role.eq_ignore_ascii_case("agent") =>
        {
            "agent"
        }
        _ => "user",
    };
    let mut entry = serde_json::json!({
        "at": updated_at,
        "role": role,
        "text": text
    });
    if role == "agent" {
        entry["state"] = Value::String(state.to_string());
    }
    if let Some(message_id) = message.get("messageId").and_then(Value::as_str) {
        entry["messageId"] = Value::String(message_id.to_string());
    }
    Some(entry)
}

fn a2a_task_response_text(task: &Value) -> Option<String> {
    task.get("status")
        .and_then(|status| status.get("message"))
        .and_then(a2a_message_value_text)
        .or_else(|| {
            task.get("artifacts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .flat_map(|artifact| {
                    artifact
                        .get("parts")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .map(str::trim)
                .find(|text| !text.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            task.get("history")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .rev()
                .find(|message| {
                    message
                        .get("role")
                        .and_then(Value::as_str)
                        .is_some_and(|role| {
                            role.eq_ignore_ascii_case("ROLE_AGENT")
                                || role.eq_ignore_ascii_case("agent")
                        })
                })
                .and_then(a2a_message_value_text)
        })
}

fn a2a_message_value_text(message: &Value) -> Option<String> {
    let text = message
        .get("parts")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.is_empty()).then_some(text)
}

fn a2a_task_first_user_message_id(task: &Value) -> Option<String> {
    task.get("history")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|message| {
            message
                .get("role")
                .and_then(Value::as_str)
                .is_none_or(|role| {
                    role.eq_ignore_ascii_case("ROLE_USER") || role.eq_ignore_ascii_case("user")
                })
        })
        .and_then(|message| message.get("messageId").and_then(Value::as_str))
        .map(str::to_string)
}

fn a2a_clean_ledger_metadata(metadata: Option<&Value>) -> Value {
    let object = metadata
        .and_then(Value::as_object)
        .map(|metadata| {
            metadata
                .iter()
                .filter_map(|(key, value)| match value {
                    Value::String(_) | Value::Number(_) | Value::Bool(_) => {
                        Some((key.clone(), value.clone()))
                    }
                    _ => None,
                })
                .collect::<Map<_, _>>()
        })
        .unwrap_or_default();
    Value::Object(object)
}

fn ledger_entry_updated_at(entry: &Value) -> &str {
    entry
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn ledger_entry_task_id(entry: &Value) -> &str {
    entry
        .get("taskId")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

async fn a2a_list_tasks_response(
    head: &RequestHead,
    state: &AppState,
    auth: &AuthContext,
) -> Result<Value, Vec<u8>> {
    let page_size = match a2a_usize_query(head, &["pageSize", "page_size", "limit"]) {
        Ok(Some(value)) => value.clamp(1, A2A_MAX_LIST_PAGE_SIZE),
        Ok(None) => A2A_DEFAULT_LIST_PAGE_SIZE,
        Err(message) => return Err(a2a_error_response(400, "INVALID_REQUEST", &message)),
    };
    let page_start = match a2a_task_page_start(head) {
        Ok(value) => value,
        Err(message) => return Err(a2a_error_response(400, "INVALID_REQUEST", &message)),
    };
    let context_id = a2a_string_query(head, &["contextId", "context_id"]);
    let status =
        a2a_string_query(head, &["status", "state"]).map(|value| a2a_normalize_state(&value));
    let status_timestamp_after = a2a_string_query(
        head,
        &[
            "statusTimestampAfter",
            "status_timestamp_after",
            "lastUpdatedAfter",
            "last_updated_after",
        ],
    );
    let include_artifacts = match a2a_bool_query(head, &["includeArtifacts", "include_artifacts"]) {
        Ok(Some(value)) => value,
        Ok(None) => false,
        Err(message) => return Err(a2a_error_response(400, "INVALID_REQUEST", &message)),
    };
    let history_length = match a2a_usize_query(head, &["historyLength", "history_length"]) {
        Ok(value) => value,
        Err(message) => return Err(a2a_error_response(400, "INVALID_REQUEST", &message)),
    };

    let mut tasks = state
        .a2a_tasks
        .lock()
        .await
        .values()
        .filter(|task| a2a_task_visible_to_auth(task, auth))
        .filter(|task| {
            context_id.as_deref().is_none_or(|context_id| {
                task.get("contextId")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value == context_id)
            })
        })
        .filter(|task| {
            status
                .as_deref()
                .is_none_or(|status| a2a_task_status_state(task) == Some(status))
        })
        .filter(|task| {
            status_timestamp_after.as_deref().is_none_or(|after| {
                a2a_task_status_timestamp(task)
                    .is_some_and(|timestamp| a2a_timestamp_at_or_after(timestamp, after))
            })
        })
        .map(|task| a2a_task_for_query(task, include_artifacts, history_length))
        .collect::<Vec<_>>();
    tasks.sort_by(|left, right| {
        compare_a2a_task_status_timestamps_desc(left, right)
            .then_with(|| a2a_task_id_for_sort(left).cmp(a2a_task_id_for_sort(right)))
    });
    let total_size = tasks.len();
    let page_start_index = a2a_task_page_start_index(&tasks, &page_start);
    let page = tasks
        .into_iter()
        .skip(page_start_index)
        .take(page_size)
        .collect::<Vec<_>>();
    let next_offset = page_start_index.saturating_add(page.len());
    let next_page_token = (next_offset < total_size)
        .then(|| page.last().and_then(a2a_task_page_token))
        .flatten();
    Ok(serde_json::json!({
        "tasks": page,
        "nextPageToken": next_page_token.unwrap_or_default(),
        "pageSize": page_size,
        "totalSize": total_size
    }))
}

fn a2a_timestamp_at_or_after(timestamp: &str, after: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(timestamp),
        chrono::DateTime::parse_from_rfc3339(after),
    ) {
        (Ok(timestamp), Ok(after)) => timestamp >= after,
        _ => timestamp >= after,
    }
}

fn compare_a2a_task_status_timestamps_desc(left: &Value, right: &Value) -> std::cmp::Ordering {
    compare_a2a_status_timestamps_desc(
        a2a_task_status_timestamp(left),
        a2a_task_status_timestamp(right),
    )
}

fn compare_a2a_status_timestamps_desc(
    left_timestamp: Option<&str>,
    right_timestamp: Option<&str>,
) -> std::cmp::Ordering {
    match (
        left_timestamp.and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok()),
        right_timestamp.and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok()),
    ) {
        (Some(left), Some(right)) => right.cmp(&left),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => right_timestamp
            .unwrap_or_default()
            .cmp(left_timestamp.unwrap_or_default()),
    }
}

#[derive(Debug)]
enum A2ATaskPageStart {
    Beginning,
    Offset(usize),
    Cursor(A2ATaskPageCursor),
}

#[derive(Debug)]
struct A2ATaskPageCursor {
    status_timestamp: String,
    id: String,
}

fn a2a_task_page_start(head: &RequestHead) -> Result<A2ATaskPageStart, String> {
    if let Some(token) = a2a_string_query(head, &["pageToken", "page_token"]) {
        if let Ok(offset) = token.parse::<usize>() {
            return Ok(A2ATaskPageStart::Offset(offset));
        }
        return parse_a2a_task_page_token(&token).map(A2ATaskPageStart::Cursor);
    }
    match a2a_usize_query(head, &["offset"])? {
        Some(offset) => Ok(A2ATaskPageStart::Offset(offset)),
        None => Ok(A2ATaskPageStart::Beginning),
    }
}

fn parse_a2a_task_page_token(token: &str) -> Result<A2ATaskPageCursor, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(token.as_bytes())
        .map_err(|_| "A2A query parameter pageToken must be a valid task page token".to_string())?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "A2A query parameter pageToken must be a valid task page token".to_string())?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            "A2A query parameter pageToken must be a valid task page token".to_string()
        })?;
    Ok(A2ATaskPageCursor {
        status_timestamp: value
            .get("statusTimestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        id: id.to_string(),
    })
}

fn a2a_task_page_start_index(tasks: &[Value], page_start: &A2ATaskPageStart) -> usize {
    match page_start {
        A2ATaskPageStart::Beginning => 0,
        A2ATaskPageStart::Offset(offset) => *offset,
        A2ATaskPageStart::Cursor(cursor) => tasks
            .iter()
            .position(|task| a2a_task_matches_page_cursor(task, cursor))
            .map(|index| index.saturating_add(1))
            .unwrap_or_else(|| {
                tasks
                    .iter()
                    .position(|task| a2a_task_sorts_after_page_cursor(task, cursor))
                    .unwrap_or(tasks.len())
            }),
    }
}

fn a2a_task_matches_page_cursor(task: &Value, cursor: &A2ATaskPageCursor) -> bool {
    a2a_task_id_for_sort(task) == cursor.id
        && compare_a2a_status_timestamps_desc(
            a2a_task_status_timestamp(task),
            Some(cursor.status_timestamp.as_str()),
        )
        .is_eq()
}

fn a2a_task_sorts_after_page_cursor(task: &Value, cursor: &A2ATaskPageCursor) -> bool {
    match compare_a2a_status_timestamps_desc(
        a2a_task_status_timestamp(task),
        Some(cursor.status_timestamp.as_str()),
    ) {
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => a2a_task_id_for_sort(task) > cursor.id.as_str(),
        std::cmp::Ordering::Greater => true,
    }
}

fn a2a_task_page_token(task: &Value) -> Option<String> {
    let id = a2a_task_id_for_sort(task);
    if id.is_empty() {
        return None;
    }
    let value = serde_json::json!({
        "statusTimestamp": a2a_task_status_timestamp(task).unwrap_or_default(),
        "id": id,
    });
    serde_json::to_vec(&value)
        .ok()
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
}

fn a2a_task_id_for_sort(task: &Value) -> &str {
    task.get("id").and_then(Value::as_str).unwrap_or_default()
}

fn a2a_task_for_query(
    task: &Value,
    include_artifacts: bool,
    history_length: Option<usize>,
) -> Value {
    let mut task = a2a_public_task(task);
    if !include_artifacts {
        if let Some(task) = task.as_object_mut() {
            task.remove("artifacts");
        }
    }
    if let Some(history_length) = history_length {
        if let Some(history) = task.get_mut("history").and_then(Value::as_array_mut) {
            if history_length == 0 {
                history.clear();
            } else if history.len() > history_length {
                let start = history.len() - history_length;
                history.drain(..start);
            }
        }
    }
    task
}

fn a2a_string_query(head: &RequestHead, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        head.query
            .get(*name)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn a2a_usize_query(head: &RequestHead, names: &[&str]) -> Result<Option<usize>, String> {
    let Some(value) = a2a_string_query(head, names) else {
        return Ok(None);
    };
    value
        .parse::<usize>()
        .map(Some)
        .map_err(|_| format!("A2A query parameter {} must be an integer", names[0]))
}

fn a2a_bool_query(head: &RequestHead, names: &[&str]) -> Result<Option<bool>, String> {
    let Some(value) = a2a_string_query(head, names) else {
        return Ok(None);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(Some(true)),
        "0" | "false" | "no" | "off" => Ok(Some(false)),
        _ => Err(format!(
            "A2A query parameter {} must be a boolean",
            names[0]
        )),
    }
}

fn a2a_normalize_state(value: &str) -> String {
    let upper = value.trim().to_ascii_uppercase();
    if upper.starts_with("TASK_STATE_") {
        upper
    } else {
        format!("TASK_STATE_{upper}")
    }
}

async fn claim_a2a_send_task(
    state: &AppState,
    request: &A2ASendMessageRequest,
    head: &RequestHead,
    auth: &AuthContext,
    metadata: Value,
) -> Result<A2ASendTarget, Vec<u8>> {
    let requested_task_id = request
        .message
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|task_id| !task_id.is_empty())
        .map(str::to_string);
    let task_id = requested_task_id
        .clone()
        .unwrap_or_else(|| generate_a2a_id("maestro-task"));
    let explicit_context_id = request
        .message
        .context_id
        .as_deref()
        .map(str::trim)
        .filter(|context_id| !context_id.is_empty())
        .map(str::to_string);
    let push_config = a2a_push_notification_config_from_send_request(request, &task_id).await?;

    let mut tasks = state.a2a_tasks.lock().await;
    let (task_id, context_id, mut history, previous_task, mut task_metadata) =
        if requested_task_id.is_some() {
            let Some(task) = tasks.get(&task_id) else {
                return Err(a2a_error_response(
                    404,
                    "TASK_NOT_FOUND",
                    "A2A task not found",
                ));
            };
            if !a2a_task_visible_to_auth(task, auth) {
                return Err(a2a_error_response(
                    404,
                    "TASK_NOT_FOUND",
                    "A2A task not found",
                ));
            }
            if a2a_task_is_terminal(task) {
                return Err(a2a_error_response(
                    400,
                    "UNSUPPORTED_OPERATION",
                    "A2A terminal tasks cannot accept more messages",
                ));
            }
            if !a2a_task_accepts_message(task) {
                return Err(a2a_error_response(
                    409,
                    "UNSUPPORTED_OPERATION",
                    "A2A task is not ready to accept another message",
                ));
            }

            let task_context_id = task
                .get("contextId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|context_id| !context_id.is_empty())
                .map(str::to_string);
            if let (Some(message_context_id), Some(task_context_id)) =
                (explicit_context_id.as_deref(), task_context_id.as_deref())
            {
                if message_context_id != task_context_id {
                    return Err(a2a_error_response(
                        400,
                        "INVALID_REQUEST",
                        "A2A message contextId must match the referenced task",
                    ));
                }
            }
            let context_id = explicit_context_id
                .or(task_context_id)
                .unwrap_or_else(|| a2a_context_id(request, head));
            let history = task
                .get("history")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            (
                task_id,
                context_id,
                history,
                Some(task.clone()),
                a2a_merge_task_metadata(task, metadata),
            )
        } else {
            (
                task_id,
                explicit_context_id.unwrap_or_else(|| a2a_context_id(request, head)),
                Vec::new(),
                None,
                metadata,
            )
        };
    if let Some(config) = push_config {
        task_metadata = a2a_metadata_with_push_notification_config(task_metadata, config)
            .map_err(|message| a2a_error_response(400, "INVALID_REQUEST", &message))?;
    }
    history.push(a2a_user_message_value(&request.message, &context_id));
    let working_message = a2a_agent_message(&context_id, "Maestro is working on the A2A task.");
    let task = a2a_task_value(
        &task_id,
        &context_id,
        "TASK_STATE_WORKING",
        working_message,
        history.clone(),
        Vec::new(),
        task_metadata.clone(),
    );
    tasks.insert(task_id.clone(), task.clone());
    prune_a2a_terminal_tasks(&mut tasks);
    drop(tasks);
    publish_a2a_task_update(state, &task).await;
    persist_a2a_tasks(state).await;
    Ok(A2ASendTarget {
        task_id,
        context_id,
        history,
        previous_task,
        metadata: task_metadata,
    })
}

fn a2a_merge_task_metadata(existing_task: &Value, metadata: Value) -> Value {
    let mut merged = existing_task
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Value::Object(metadata) = metadata {
        for (key, value) in metadata {
            merged.insert(key, value);
        }
    }
    Value::Object(merged)
}

async fn a2a_push_notification_config_from_send_request(
    request: &A2ASendMessageRequest,
    task_id: &str,
) -> Result<Option<Value>, Vec<u8>> {
    let Some(configuration) = request.configuration.as_ref().and_then(Value::as_object) else {
        return Ok(None);
    };
    let config = configuration
        .get("taskPushNotificationConfig")
        .or_else(|| configuration.get("task_push_notification_config"))
        .or_else(|| configuration.get("pushNotificationConfig"));
    let Some(config) = config else {
        return Ok(None);
    };
    normalize_a2a_push_notification_config_blocking(task_id, config.clone(), false)
        .await
        .map(Some)
        .map_err(|message| a2a_error_response(400, "INVALID_REQUEST", &message))
}

async fn normalize_a2a_push_notification_config_blocking(
    task_id: &str,
    config: Value,
    require_task_match: bool,
) -> Result<Value, String> {
    let task_id = task_id.to_string();
    // URL validation resolves DNS to reject private callback targets, so keep it
    // off Tokio worker threads on request paths.
    tokio::task::spawn_blocking(move || {
        normalize_a2a_push_notification_config(&task_id, config, require_task_match)
    })
    .await
    .map_err(|error| format!("A2A push notification config validation failed: {error}"))?
}

fn a2a_metadata_key_is_reserved(key: &str) -> bool {
    key == A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY
}

fn a2a_metadata_with_push_notification_config(
    metadata: Value,
    config: Value,
) -> Result<Value, String> {
    let task = serde_json::json!({
        "metadata": metadata
    });
    let updated = a2a_task_with_push_notification_config(&task, config)?;
    Ok(updated
        .get("metadata")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({})))
}

fn a2a_task_push_notification_configs(task: &Value) -> Vec<Value> {
    let Some(task_id) = task.get("id").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(configs) = task
        .get("metadata")
        .and_then(|metadata| metadata.get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    if configs.len() > A2A_PUSH_NOTIFICATION_CONFIG_LIMIT {
        return Vec::new();
    }
    configs
        .iter()
        .filter_map(|config| {
            normalize_a2a_push_notification_config_without_dns(task_id, config.clone(), true).ok()
        })
        .collect()
}

fn normalize_a2a_push_notification_config(
    task_id: &str,
    config: Value,
    require_task_match: bool,
) -> Result<Value, String> {
    normalize_a2a_push_notification_config_inner(
        task_id,
        config,
        require_task_match,
        true,
        A2APushConfigIdPolicy::Generate,
    )
}

fn normalize_a2a_push_notification_config_without_dns(
    task_id: &str,
    config: Value,
    require_task_match: bool,
) -> Result<Value, String> {
    normalize_a2a_push_notification_config_inner(
        task_id,
        config,
        require_task_match,
        false,
        A2APushConfigIdPolicy::LegacyTaskFallback,
    )
}

enum A2APushConfigIdPolicy {
    Generate,
    LegacyTaskFallback,
}

fn normalize_a2a_push_notification_config_inner(
    task_id: &str,
    config: Value,
    require_task_match: bool,
    resolve_dns: bool,
    id_policy: A2APushConfigIdPolicy,
) -> Result<Value, String> {
    let mut object = config
        .as_object()
        .cloned()
        .ok_or_else(|| "A2A push notification config must be an object".to_string())?;
    let url = object
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "A2A push notification config url is required".to_string())?;
    validate_a2a_push_notification_url(url, resolve_dns)?;
    object.insert("url".to_string(), Value::String(url.to_string()));

    let configured_task_id = object
        .get("taskId")
        .or_else(|| object.get("task_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if require_task_match && configured_task_id.is_some_and(|value| value != task_id) {
        return Err("A2A push notification config taskId must match the request path".to_string());
    }
    object.remove("task_id");
    object.insert("taskId".to_string(), Value::String(task_id.to_string()));

    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| match id_policy {
            A2APushConfigIdPolicy::Generate => generate_a2a_id("pushcfg"),
            A2APushConfigIdPolicy::LegacyTaskFallback => task_id.to_string(),
        });
    if id.contains('/') || id.contains(':') {
        return Err("A2A push notification config id must not contain '/' or ':'".to_string());
    }
    object.insert("id".to_string(), Value::String(id));

    if let Some(token) = object.get("token").and_then(Value::as_str).map(str::trim) {
        object.insert("token".to_string(), Value::String(token.to_string()));
    }
    Ok(Value::Object(object))
}

fn validate_a2a_push_notification_url(url: &str, resolve_dns: bool) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| format!("A2A push notification config url is invalid: {error}"))?;
    match parsed.scheme() {
        "https" => {}
        "http" if truthy_env("MAESTRO_A2A_PUSH_ALLOW_INSECURE") => {}
        _ => {
            return Err(
                "A2A push notification config url must use HTTPS unless MAESTRO_A2A_PUSH_ALLOW_INSECURE=1"
                    .to_string(),
            );
        }
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "A2A push notification config url must include a host".to_string())?;
    let port = parsed.port_or_known_default().unwrap_or(443);
    if !truthy_env("MAESTRO_A2A_PUSH_ALLOW_PRIVATE")
        && (a2a_push_host_is_private(host)
            || (resolve_dns && a2a_push_host_resolves_private(host, port)))
    {
        return Err(
            "A2A push notification config url host is private; set MAESTRO_A2A_PUSH_ALLOW_PRIVATE=1 for local development"
                .to_string(),
        );
    }
    Ok(())
}

fn a2a_push_host_is_private(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "localhost.localdomain") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(a2a_push_ip_is_private)
}

fn a2a_push_host_resolves_private(host: &str, port: u16) -> bool {
    if host.parse::<IpAddr>().is_ok() {
        return false;
    }
    (host, port).to_socket_addrs().is_ok_and(|addresses| {
        addresses
            .map(|address| address.ip())
            .any(a2a_push_ip_is_private)
    })
}

fn a2a_push_ip_is_private(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(addr) => {
            addr.is_loopback()
                || addr.is_private()
                || addr.is_link_local()
                || addr.is_unspecified()
                || addr.octets()[0] == 169 && addr.octets()[1] == 254
        }
        IpAddr::V6(addr) => {
            if let Some(mapped) = addr.to_ipv4_mapped() {
                return a2a_push_ip_is_private(IpAddr::V4(mapped));
            }
            addr.is_loopback()
                || addr.is_unspecified()
                || addr.segments()[0] & 0xfe00 == 0xfc00
                || addr.segments()[0] & 0xffc0 == 0xfe80
        }
    }
}

fn a2a_task_with_push_notification_config(task: &Value, config: Value) -> Result<Value, String> {
    let mut task_object = task
        .as_object()
        .cloned()
        .ok_or_else(|| "A2A task must be an object".to_string())?;
    let mut metadata = task_object
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut configs = metadata
        .get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let config_id = config
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "A2A push notification config id is required".to_string())?;
    if let Some(index) = configs
        .iter()
        .position(|existing| existing.get("id").and_then(Value::as_str) == Some(config_id))
    {
        configs[index] = config;
    } else {
        if configs.len() >= A2A_PUSH_NOTIFICATION_CONFIG_LIMIT {
            return Err(format!(
                "A2A task may have at most {A2A_PUSH_NOTIFICATION_CONFIG_LIMIT} push notification configs"
            ));
        }
        configs.push(config);
    }
    metadata.insert(
        A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY.to_string(),
        Value::Array(configs),
    );
    task_object.insert("metadata".to_string(), Value::Object(metadata));
    Ok(Value::Object(task_object))
}

fn a2a_task_without_push_notification_config(task: &Value, config_id: &str) -> Option<Value> {
    let mut task_object = task.as_object()?.clone();
    let mut metadata = task_object
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut configs = metadata
        .get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let original_len = configs.len();
    configs.retain(|config| config.get("id").and_then(Value::as_str) != Some(config_id));
    if configs.len() == original_len {
        return None;
    }
    if configs.is_empty() {
        metadata.remove(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY);
    } else {
        metadata.insert(
            A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY.to_string(),
            Value::Array(configs),
        );
    }
    task_object.insert("metadata".to_string(), Value::Object(metadata));
    Some(Value::Object(task_object))
}

async fn rollback_a2a_send_claim(state: &AppState, task_id: &str, previous_task: Option<Value>) {
    let mut tasks = state.a2a_tasks.lock().await;
    let Some(task) = tasks.get(task_id) else {
        return;
    };
    if a2a_task_status_state(task) != Some("TASK_STATE_WORKING") {
        return;
    }
    if let Some(previous_task) = previous_task {
        tasks.insert(task_id.to_string(), previous_task.clone());
        drop(tasks);
        publish_a2a_task_update(state, &previous_task).await;
    } else {
        tasks.remove(task_id);
        drop(tasks);
    }
    persist_a2a_tasks(state).await;
}

async fn a2a_canceled_task(state: &AppState, task_id: &str) -> Option<Value> {
    state.a2a_tasks.lock().await.get(task_id).and_then(|task| {
        (a2a_task_status_state(task) == Some("TASK_STATE_CANCELED")).then(|| task.clone())
    })
}

async fn store_a2a_task_unless_canceled(state: &AppState, task_id: &str, task: Value) -> Value {
    let mut tasks = state.a2a_tasks.lock().await;
    if let Some(existing) = tasks.get(task_id) {
        if a2a_task_status_state(existing) == Some("TASK_STATE_CANCELED") {
            return existing.clone();
        }
    }
    tasks.insert(task_id.to_string(), task.clone());
    prune_a2a_terminal_tasks(&mut tasks);
    drop(tasks);
    publish_a2a_task_update(state, &task).await;
    persist_a2a_tasks(state).await;
    task
}

fn prune_a2a_terminal_tasks(tasks: &mut HashMap<String, Value>) {
    let mut terminal_tasks = tasks
        .iter()
        .filter(|(_, task)| a2a_task_is_terminal(task))
        .map(|(task_id, task)| {
            (
                task_id.clone(),
                a2a_task_status_timestamp(task)
                    .unwrap_or_default()
                    .to_string(),
            )
        })
        .collect::<Vec<_>>();
    if terminal_tasks.len() <= A2A_TERMINAL_TASK_STORE_LIMIT {
        return;
    }
    terminal_tasks.sort_by(|(left_id, left_timestamp), (right_id, right_timestamp)| {
        left_timestamp
            .cmp(right_timestamp)
            .then_with(|| left_id.cmp(right_id))
    });
    let overflow = terminal_tasks.len() - A2A_TERMINAL_TASK_STORE_LIMIT;
    for (task_id, _) in terminal_tasks.into_iter().take(overflow) {
        tasks.remove(&task_id);
    }
}

async fn register_a2a_cancel_sender(
    state: &AppState,
    task_id: &str,
    cancel_tx: A2ACancelSender,
) -> Result<(), Vec<u8>> {
    let mut senders = state.a2a_cancel_senders.lock().await;
    if senders.contains_key(task_id) {
        return Err(a2a_error_response(
            409,
            "UNSUPPORTED_OPERATION",
            "A2A task is already running",
        ));
    }
    senders.insert(task_id.to_string(), cancel_tx);
    Ok(())
}

async fn handle_a2a_push_notification_config_list(
    state: &AppState,
    task_id: &str,
    auth: &AuthContext,
) -> Vec<u8> {
    let tasks = state.a2a_tasks.lock().await;
    let Some(task) = tasks.get(task_id) else {
        return a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found");
    };
    if !a2a_task_visible_to_auth(task, auth) {
        return a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found");
    }
    json_response(
        200,
        &serde_json::json!({
            "configs": a2a_task_push_notification_configs(task)
                .iter()
                .map(a2a_redacted_push_notification_config)
                .collect::<Vec<_>>()
        }),
    )
}

async fn handle_a2a_push_notification_config_get(
    state: &AppState,
    task_id: &str,
    config_id: &str,
    auth: &AuthContext,
) -> Vec<u8> {
    let tasks = state.a2a_tasks.lock().await;
    let Some(task) = tasks.get(task_id) else {
        return a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found");
    };
    if !a2a_task_visible_to_auth(task, auth) {
        return a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found");
    }
    a2a_task_push_notification_configs(task)
        .into_iter()
        .find(|config| config.get("id").and_then(Value::as_str) == Some(config_id))
        .map_or_else(
            || {
                a2a_error_response(
                    404,
                    "PUSH_NOTIFICATION_CONFIG_NOT_FOUND",
                    "A2A push notification config not found",
                )
            },
            |config| json_response(200, &a2a_redacted_push_notification_config(&config)),
        )
}

async fn handle_a2a_push_notification_config_create(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
    task_id: &str,
    auth: &AuthContext,
) -> Vec<u8> {
    let body = match read_request_body(stream, initial, head).await {
        Ok(body) => body,
        Err(error) => return a2a_error_response(400, "INVALID_REQUEST", &error),
    };
    let raw_config: Value = match serde_json::from_slice(&body) {
        Ok(config) => config,
        Err(error) => {
            return a2a_error_response(
                400,
                "INVALID_REQUEST",
                &format!("invalid A2A push notification config: {error}"),
            );
        }
    };
    let config =
        match normalize_a2a_push_notification_config_blocking(task_id, raw_config, true).await {
            Ok(config) => config,
            Err(message) => return a2a_error_response(400, "INVALID_REQUEST", &message),
        };
    let mut tasks = state.a2a_tasks.lock().await;
    let Some(existing_task) = tasks.get(task_id) else {
        return a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found");
    };
    if !a2a_task_visible_to_auth(existing_task, auth) {
        return a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found");
    }
    let task = match a2a_task_with_push_notification_config(existing_task, config.clone()) {
        Ok(task) => task,
        Err(message) => return a2a_error_response(400, "INVALID_REQUEST", &message),
    };
    tasks.insert(task_id.to_string(), task.clone());
    drop(tasks);
    publish_a2a_task_update(state, &task).await;
    persist_a2a_tasks(state).await;
    json_response(200, &a2a_redacted_push_notification_config(&config))
}

async fn handle_a2a_push_notification_config_delete(
    state: &AppState,
    task_id: &str,
    config_id: &str,
    auth: &AuthContext,
) -> Vec<u8> {
    let mut tasks = state.a2a_tasks.lock().await;
    let Some(existing_task) = tasks.get(task_id) else {
        return a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found");
    };
    if !a2a_task_visible_to_auth(existing_task, auth) {
        return a2a_error_response(404, "TASK_NOT_FOUND", "A2A task not found");
    }
    let Some(task) = a2a_task_without_push_notification_config(existing_task, config_id) else {
        return json_response(200, &serde_json::json!({}));
    };
    tasks.insert(task_id.to_string(), task.clone());
    drop(tasks);
    publish_a2a_task_update(state, &task).await;
    persist_a2a_tasks(state).await;
    json_response(200, &serde_json::json!({}))
}

async fn handle_a2a_message_send(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
    auth: &AuthContext,
) -> Vec<u8> {
    let body = match read_request_body(stream, initial, head).await {
        Ok(body) => body,
        Err(error) => return a2a_error_response(400, "INVALID_REQUEST", &error),
    };
    let request: A2ASendMessageRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => {
            return a2a_error_response(
                400,
                "INVALID_REQUEST",
                &format!("invalid A2A message request: {error}"),
            );
        }
    };
    let requested_extensions =
        match validate_a2a_requested_extensions(head, request.message.extensions.as_deref()) {
            Ok(extensions) => extensions,
            Err(response) => return response,
        };

    let Some(prompt) = a2a_message_text(&request.message) else {
        return a2a_error_response(
            400,
            "INVALID_REQUEST",
            "A2A message must contain at least one text part",
        );
    };
    let return_immediately = match a2a_return_immediately(&request) {
        Ok(value) => value,
        Err(error) => return a2a_error_response(400, "INVALID_REQUEST", error),
    };

    let metadata = a2a_task_metadata(head, &request, auth, &requested_extensions);
    let target = match claim_a2a_send_task(state, &request, head, auth, metadata).await {
        Ok(target) => target,
        Err(response) => return response,
    };
    let task_id = target.task_id;
    let context_id = target.context_id;
    let history = target.history;
    let previous_task = target.previous_task;
    let metadata = target.metadata;

    let (cancel_tx, cancel_rx) = watch::channel(false);
    if let Err(response) = register_a2a_cancel_sender(state, &task_id, cancel_tx).await {
        rollback_a2a_send_claim(state, &task_id, previous_task).await;
        return response;
    }
    if let Some(task) = a2a_canceled_task(state, &task_id).await {
        state.a2a_cancel_senders.lock().await.remove(&task_id);
        return json_response(200, &serde_json::json!({ "task": a2a_public_task(&task) }));
    }
    if return_immediately {
        let accepted_message = a2a_agent_message(&context_id, "Maestro accepted the A2A task.");
        let mut accepted_history = history.clone();
        accepted_history.push(accepted_message.clone());
        let task = a2a_task_value(
            &task_id,
            &context_id,
            "TASK_STATE_WORKING",
            accepted_message.clone(),
            accepted_history.clone(),
            Vec::new(),
            metadata.clone(),
        );
        let task = store_a2a_task_unless_canceled(state, &task_id, task).await;
        let state = state.clone();
        tokio::spawn(async move {
            let _ = complete_a2a_task(
                &state,
                prompt,
                task_id,
                context_id,
                accepted_history,
                metadata,
                cancel_rx,
            )
            .await;
        });
        return json_response(200, &serde_json::json!({ "task": a2a_public_task(&task) }));
    }

    let task = complete_a2a_task(
        state, prompt, task_id, context_id, history, metadata, cancel_rx,
    )
    .await;
    json_response(200, &serde_json::json!({ "task": a2a_public_task(&task) }))
}

async fn complete_a2a_task(
    state: &AppState,
    prompt: String,
    task_id: String,
    context_id: String,
    mut history: Vec<Value>,
    mut metadata: Value,
    cancel_rx: A2ACancelReceiver,
) -> Value {
    let turn = match run_a2a_native_turn(state, prompt, cancel_rx).await {
        Ok(A2ATurnResult::Completed(turn)) => turn,
        Ok(A2ATurnResult::Canceled) => {
            let message = a2a_agent_message(&context_id, "Task canceled");
            history.push(message.clone());
            let task = a2a_task_value(
                &task_id,
                &context_id,
                "TASK_STATE_CANCELED",
                message,
                history,
                Vec::new(),
                metadata,
            );
            let task = store_a2a_task_unless_canceled(state, &task_id, task).await;
            state.a2a_cancel_senders.lock().await.remove(&task_id);
            return task;
        }
        Err(error) => {
            let message = a2a_agent_message(&context_id, &error);
            history.push(message.clone());
            let task = a2a_task_value(
                &task_id,
                &context_id,
                "TASK_STATE_FAILED",
                message.clone(),
                history,
                Vec::new(),
                metadata,
            );
            let task = store_a2a_task_unless_canceled(state, &task_id, task).await;
            state.a2a_cancel_senders.lock().await.remove(&task_id);
            return task;
        }
    };

    let assistant_text = if turn.assistant_text.trim().is_empty() {
        "Maestro completed the A2A task without a text response.".to_string()
    } else {
        turn.assistant_text
    };
    let agent_message = a2a_agent_message(&context_id, &assistant_text);
    if !turn.thinking_text.trim().is_empty() {
        metadata["thinking"] = Value::String(turn.thinking_text);
    }
    if !turn.tools.is_empty() {
        metadata["tools"] = Value::Array(turn.tools);
    }
    if let Some(usage) = turn.usage {
        metadata["usage"] = serde_json::json!({
            "input": usage.input_tokens,
            "output": usage.output_tokens,
            "cacheRead": usage.cache_read_tokens,
            "cacheWrite": usage.cache_write_tokens,
            "cost": usage.cost.unwrap_or(0.0)
        });
    }
    let task = a2a_task_value(
        &task_id,
        &context_id,
        "TASK_STATE_COMPLETED",
        agent_message.clone(),
        {
            history.push(agent_message);
            history
        },
        vec![serde_json::json!({
            "artifactId": format!("{task_id}-assistant-response"),
            "name": "assistant-response",
            "parts": [{ "text": assistant_text, "mediaType": "text/plain" }]
        })],
        metadata,
    );
    let task = store_a2a_task_unless_canceled(state, &task_id, task).await;
    state.a2a_cancel_senders.lock().await.remove(&task_id);
    task
}

fn a2a_agent_card(head: &RequestHead, config: &Config) -> Value {
    let base_url = a2a_public_base_url(head, config);
    let mut card = serde_json::json!({
        "protocolVersion": A2A_PROTOCOL_VERSION,
        "name": trimmed_env("MAESTRO_A2A_AGENT_NAME")
            .unwrap_or_else(|| "Maestro Desktop Agent".to_string()),
        "description": trimmed_env("MAESTRO_A2A_AGENT_DESCRIPTION")
            .unwrap_or_else(|| "Local Maestro Rust/TS TUI agent endpoint for A2A task delegation.".to_string()),
        "url": base_url,
        "preferredTransport": "HTTP+JSON",
        "supportedInterfaces": [{
            "url": base_url,
            "protocolBinding": "HTTP+JSON",
            "protocolVersion": A2A_PROTOCOL_VERSION
        }],
        "provider": {
            "organization": "EvalOps",
            "url": "https://evalops.com"
        },
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": {
            "streaming": true,
            "pushNotifications": true,
            "extendedAgentCard": true,
            "extensions": [a2a_operating_plane_extension(false)]
        },
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain", "application/json"],
        "skills": a2a_agent_skills()
    });
    if let Some(security) = a2a_agent_card_security(config) {
        if let Value::Object(card) = &mut card {
            card.insert("securitySchemes".to_string(), security.0);
            card.insert("securityRequirements".to_string(), security.1);
        }
    }
    card
}

fn a2a_extended_agent_card(head: &RequestHead, config: &Config) -> Value {
    let mut card = a2a_agent_card(head, config);
    if let Value::Object(card_object) = &mut card {
        card_object.insert(
            "documentationUrl".to_string(),
            Value::String(
                "https://github.com/evalops/maestro/tree/main/docs/protocols".to_string(),
            ),
        );
        card_object.insert(
            "metadata".to_string(),
            serde_json::json!({
                "runtime": "maestro-rust-control-plane",
                "taskStore": "durable-file",
                "taskStorePath": config.a2a_tasks_file_path.to_string_lossy(),
                "streamingEndpoints": ["/message:stream", "/tasks/{id}:subscribe"],
                "pushNotificationEndpoints": [
                    "/tasks/{taskId}/pushNotificationConfigs",
                    "/tasks/{taskId}/pushNotificationConfigs/{id}"
                ],
                "taskList": {
                    "filters": ["contextId", "status", "statusTimestampAfter"],
                    "pagination": { "defaultPageSize": A2A_DEFAULT_LIST_PAGE_SIZE, "maxPageSize": A2A_MAX_LIST_PAGE_SIZE },
                    "historyLength": true,
                    "includeArtifacts": true
                },
                "operatingPlane": {
                    "extensionUri": EVALOPS_A2A_EXTENSION_URI,
                    "correlationFields": [
                        "workspaceId",
                        "sessionId",
                        "agentId",
                        "a2aSkillId",
                        "actorId",
                        "traceparent",
                        "tracestate"
                    ],
                    "subagentRequestMetadataPath": "evalops.subagentRequest",
                    "retentionFields": ["data_classification", "retention_class", "safe_summary"]
                }
            }),
        );
        card_object.insert(
            "capabilities".to_string(),
            serde_json::json!({
                "streaming": true,
                "pushNotifications": true,
                "extendedAgentCard": true,
                "extensions": [a2a_operating_plane_extension(true)]
            }),
        );
    }
    card
}

fn a2a_operating_plane_extension(extended: bool) -> Value {
    serde_json::json!({
        "uri": EVALOPS_A2A_EXTENSION_URI,
        "description": "Carries EvalOps/Maestro workspace, session, trace, retention, and approval correlation metadata without changing core A2A task semantics.",
        "required": false,
        "params": {
            "version": "1",
            "metadataFields": [
                "workspaceId",
                "sessionId",
                "agentId",
                "a2aSkillId",
                "actorId",
                "traceparent",
                "tracestate",
                "evalops.subagentRequest",
                "data_classification",
                "retention_class",
                "safe_summary"
            ],
            "extendedAgentCard": extended
        }
    })
}

fn a2a_agent_card_security(config: &Config) -> Option<(Value, Value)> {
    if !config.require_key {
        return None;
    }
    Some((
        serde_json::json!({
            "maestroApiKey": {
                "type": "apiKey",
                "in": "header",
                "name": "x-maestro-api-key",
                "description": "Maestro control-plane API key."
            },
            "bearer": {
                "type": "http",
                "scheme": "bearer",
                "description": "Bearer token accepted by Maestro shared-secret auth."
            }
        }),
        serde_json::json!([
            { "maestroApiKey": [] },
            { "bearer": [] }
        ]),
    ))
}

fn a2a_agent_skills() -> Value {
    let mut skill = serde_json::json!({
        "id": "maestro-tui-turn",
        "name": "Maestro TUI turn",
        "description": "Run a prompt through the local Maestro native TUI agent runner.",
        "tags": ["maestro", "tui", "codex", "a2a", "fleet"],
        "examples": [
            "Review the current workspace and summarize the next highest leverage action."
        ],
        "inputModes": ["text/plain"],
        "outputModes": ["text/plain", "application/json"]
    });
    if let Some(model) = trimmed_env("MAESTRO_A2A_MODEL") {
        skill["metadata"] = serde_json::json!({ "defaultModel": model });
    }
    let mut skills = Vec::with_capacity(1 + CODEX_SUBAGENT_DISPATCH_LANES.len());
    skills.push(skill);
    skills.extend(CODEX_SUBAGENT_DISPATCH_LANES.iter().map(|lane| {
        a2a_subagent_skill(
            lane.skill_id,
            lane.display_name,
            lane.description,
            lane.tags,
            lane.lane_id,
        )
    }));
    Value::Array(skills)
}

fn a2a_subagent_skill(
    id: &str,
    name: &str,
    description: &str,
    tags: &[&str],
    lane_id: &str,
) -> Value {
    let (
        required_context_grants,
        required_artifact_kinds,
        optional_artifact_kinds,
        allowed_task_classes,
    ) = match lane_id {
        "code-writer" => (
            vec!["repo:read", "repo:write-scoped", "tool:execute-tests"],
            vec!["patch.summary"],
            vec!["test.report", "review.summary"],
            vec!["code.implementation", "code.refactor"],
        ),
        "code-review" => (
            vec!["repo:read", "pull-request:read", "evidence:read"],
            vec!["review.summary"],
            vec!["risk.finding", "test.plan"],
            vec!["code.review", "risk.analysis"],
        ),
        "test-runner" => (
            vec!["repo:read", "tool:execute-tests", "evidence:write"],
            vec!["test.report"],
            vec!["failure.triage", "coverage.summary"],
            vec!["test.execution", "ci.triage"],
        ),
        "repo-explorer" => (
            vec!["repo:read", "evidence:write"],
            vec!["repo.map"],
            vec!["evidence.index"],
            vec!["repo.inspect", "context.gathering"],
        ),
        "release-shepherd" => (
            vec![
                "repo:read",
                "pull-request:write",
                "deploy:read",
                "evidence:write",
            ],
            vec!["release.evidence"],
            vec!["ci.summary", "deploy.status"],
            vec!["release.follow-through", "deployment.smoke"],
        ),
        _ => (
            vec!["repo:read"],
            vec!["subagent.summary"],
            vec!["evidence.index"],
            vec!["agent.delegation"],
        ),
    };
    serde_json::json!({
        "id": id,
        "name": name,
        "description": description,
        "tags": tags,
        "inputModes": ["text/plain", "application/json"],
        "outputModes": ["text/plain", "application/json"],
        "requiredContextGrants": required_context_grants,
        "approvalPolicyRef": format!("maestro.subagent.{lane_id}.target-policy"),
        "maxAutonomy": "bounded",
        "requiredArtifactKinds": required_artifact_kinds,
        "optionalArtifactKinds": optional_artifact_kinds,
        "allowedTaskClasses": allowed_task_classes,
        "deniedTaskClasses": [
            "credential.materialization",
            "secret.exfiltration",
            "unbounded.repository.write"
        ],
        "attributes": {
            "evalopsSkillKind": "maestro-subagent",
            "subagentLaneId": lane_id,
            "requestMetadataPath": "evalops.subagentRequest",
            "operatingPlaneExtension": EVALOPS_A2A_EXTENSION_URI
        },
        "metadata": {
            "evalopsSkillKind": "maestro-subagent",
            "subagentLaneId": lane_id,
            "operatingPlaneExtension": EVALOPS_A2A_EXTENSION_URI,
            "requestMetadataPath": "evalops.subagentRequest",
            "approvalPolicy": "target-maestro-policy",
            "contextGrantPolicy": "bounded-policy-grants",
            "resultPolicy": "summary-and-artifacts",
            "workGraph": "target AgentRun child-agent work items"
        }
    })
}

fn a2a_public_base_url(_head: &RequestHead, config: &Config) -> String {
    if let Some(url) =
        trimmed_env("MAESTRO_A2A_PUBLIC_URL").or_else(|| trimmed_env("MAESTRO_CONTROL_PUBLIC_URL"))
    {
        return url.trim_end_matches('/').to_string();
    }
    let host = if let Some(host) = trimmed_env("MAESTRO_A2A_PUBLIC_HOST")
        .or_else(|| trimmed_env("MAESTRO_CONTROL_PUBLIC_HOST"))
    {
        host
    } else if config.listen_host == "0.0.0.0" || config.listen_host == "::" {
        trimmed_env("HOSTNAME")
            .or_else(|| trimmed_env("COMPUTERNAME"))
            .unwrap_or_else(|| "127.0.0.1".to_string())
    } else {
        config.listen_host.clone()
    };
    format!(
        "http://{}",
        a2a_public_host_authority(&host, config.listen_port)
    )
}

fn a2a_public_host_authority(host: &str, port: u16) -> String {
    if let Some(rest) = host.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let literal = &rest[..end];
            let suffix = &rest[end + 1..];
            let authority = format!("[{}]{suffix}", a2a_uri_host(literal));
            if suffix.starts_with(':') {
                authority
            } else {
                format!("{authority}:{port}")
            }
        } else {
            format!("[{}]:{port}", a2a_uri_host(rest))
        }
    } else if host.matches(':').count() > 1 {
        format!("[{}]:{port}", a2a_uri_host(host))
    } else if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:{port}")
    }
}

fn a2a_uri_host(host: &str) -> String {
    let mut normalized = String::with_capacity(host.len());
    let mut chars = host.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '%' {
            let mut lookahead = chars.clone();
            let already_encoded = lookahead
                .next()
                .is_some_and(|next| next.is_ascii_hexdigit())
                && lookahead
                    .next()
                    .is_some_and(|next| next.is_ascii_hexdigit());
            if already_encoded {
                normalized.push(ch);
            } else {
                normalized.push_str("%25");
            }
        } else {
            normalized.push(ch);
        }
    }
    normalized
}

fn a2a_message_text(message: &A2AMessageBody) -> Option<String> {
    let text = message
        .parts
        .iter()
        .filter_map(|part| part.text.as_deref())
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.is_empty()).then_some(text)
}

fn a2a_context_id(request: &A2ASendMessageRequest, head: &RequestHead) -> String {
    let normalized = |value: Option<&str>| {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    normalized(request.message.context_id.as_deref())
        .or_else(|| {
            normalized(
                request
                    .message
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("sessionId").and_then(Value::as_str)),
            )
        })
        .or_else(|| normalized(head.headers.get("x-evalops-session-id").map(String::as_str)))
        .or_else(|| normalized(head.headers.get("x-maestro-session-id").map(String::as_str)))
        .unwrap_or_else(|| generate_a2a_id("maestro-context"))
}

fn a2a_user_message_value(message: &A2AMessageBody, context_id: &str) -> Value {
    let mut value = serde_json::to_value(message).unwrap_or_else(|_| serde_json::json!({}));
    if let Value::Object(object) = &mut value {
        object
            .entry("messageId")
            .or_insert_with(|| Value::String(generate_a2a_id("maestro-message")));
        object.insert(
            "contextId".to_string(),
            Value::String(context_id.to_string()),
        );
        object
            .entry("role")
            .or_insert_with(|| Value::String("ROLE_USER".to_string()));
    }
    value
}

fn a2a_agent_message(context_id: &str, text: &str) -> Value {
    serde_json::json!({
        "messageId": generate_a2a_id("maestro-message"),
        "contextId": context_id,
        "role": "ROLE_AGENT",
        "parts": [{ "text": text, "mediaType": "text/plain" }],
        "metadata": {
            "runtime": "maestro-rust-control-plane",
            "surface": "rust-tui"
        }
    })
}

fn a2a_task_value(
    task_id: &str,
    context_id: &str,
    state: &str,
    status_message: Value,
    history: Vec<Value>,
    artifacts: Vec<Value>,
    metadata: Value,
) -> Value {
    serde_json::json!({
        "id": task_id,
        "contextId": context_id,
        "status": {
            "state": state,
            "message": status_message,
            "timestamp": now_rfc3339()
        },
        "history": history,
        "artifacts": artifacts,
        "metadata": metadata
    })
}

fn a2a_task_metadata(
    head: &RequestHead,
    request: &A2ASendMessageRequest,
    auth: &AuthContext,
    requested_extensions: &[String],
) -> Value {
    let mut metadata = Map::new();
    metadata.insert(
        "runtime".to_string(),
        Value::String("maestro-rust-control-plane".to_string()),
    );
    metadata.insert("surface".to_string(), Value::String("rust-tui".to_string()));
    metadata.insert(
        "a2aProtocolVersion".to_string(),
        Value::String(A2A_PROTOCOL_VERSION.to_string()),
    );
    if let Some(subject) = auth.subject.as_deref() {
        metadata.insert(
            "ownerSubject".to_string(),
            Value::String(subject.to_string()),
        );
    }
    for (field, header) in [
        ("workspaceId", "x-evalops-workspace-id"),
        ("agentId", "x-evalops-agent-id"),
        ("sessionId", "x-evalops-session-id"),
        ("actorId", "x-evalops-actor-id"),
        ("traceparent", "traceparent"),
        ("tracestate", "tracestate"),
    ] {
        if let Some(value) = head.headers.get(header).map(String::as_str) {
            if !value.trim().is_empty() {
                metadata.insert(field.to_string(), Value::String(value.trim().to_string()));
            }
        }
    }
    if let Some(Value::Object(request_metadata)) = request.metadata.as_ref() {
        for (key, value) in request_metadata {
            if a2a_metadata_key_is_reserved(key) {
                continue;
            }
            metadata.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    if let Some(configuration) = request
        .configuration
        .as_ref()
        .and_then(a2a_configuration_metadata)
    {
        metadata
            .entry("configuration".to_string())
            .or_insert(configuration);
    }
    if let Some(Value::Object(message_metadata)) = request.message.metadata.as_ref() {
        for (key, value) in message_metadata {
            if a2a_metadata_key_is_reserved(key) {
                continue;
            }
            metadata.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    if !requested_extensions.is_empty() {
        metadata.insert(
            "a2aExtensions".to_string(),
            Value::Array(
                requested_extensions
                    .iter()
                    .map(|extension| Value::String(extension.clone()))
                    .collect(),
            ),
        );
    }
    Value::Object(metadata)
}

fn a2a_configuration_metadata(configuration: &Value) -> Option<Value> {
    let mut object = configuration.as_object()?.clone();
    object.remove("taskPushNotificationConfig");
    object.remove("task_push_notification_config");
    object.remove("pushNotificationConfig");
    (!object.is_empty()).then_some(Value::Object(object))
}

fn a2a_return_immediately(request: &A2ASendMessageRequest) -> Result<bool, &'static str> {
    let Some(configuration) = request.configuration.as_ref() else {
        return Ok(false);
    };
    let Some(configuration) = configuration.as_object() else {
        return Err("A2A configuration must be an object");
    };
    let Some(return_immediately) = configuration.get("returnImmediately") else {
        return Ok(false);
    };
    return_immediately
        .as_bool()
        .ok_or("A2A configuration returnImmediately must be a boolean")
}

async fn run_a2a_native_turn(
    state: &AppState,
    prompt: String,
    mut cancel_rx: A2ACancelReceiver,
) -> Result<A2ATurnResult, String> {
    if *cancel_rx.borrow() {
        return Ok(A2ATurnResult::Canceled);
    }

    if let Some(response) = trimmed_env("MAESTRO_A2A_FAKE_RESPONSE") {
        if a2a_wait_for_fake_response_delay(&mut cancel_rx).await {
            return Ok(A2ATurnResult::Canceled);
        }
        return Ok(A2ATurnResult::Completed(A2ATurnOutput {
            assistant_text: response,
            ..Default::default()
        }));
    }

    let model = if let Some(model) = trimmed_env("MAESTRO_A2A_MODEL") {
        model
    } else {
        let selected = state.selected_model.lock().await;
        format!("{}/{}", selected.provider, selected.id)
    };
    let config = NativeAgentConfig {
        model,
        cwd: state.config.cwd.to_string_lossy().to_string(),
        system_prompt: Some(
            trimmed_env("MAESTRO_A2A_SYSTEM_PROMPT").unwrap_or_else(|| {
                "You are the local Maestro Desktop A2A agent. Complete delegated work from peer agents clearly and concisely.".to_string()
            }),
        ),
        thinking_enabled: truthy_env("MAESTRO_A2A_THINKING"),
        thinking_budget: env::var("MAESTRO_A2A_THINKING_BUDGET")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(10_000),
        ..NativeAgentConfig::default()
    };
    let (agent, mut events) = NativeAgent::new(config).map_err(|error| error.to_string())?;
    agent
        .prompt(prompt, Vec::new())
        .await
        .map_err(|error| error.to_string())?;

    let timeout = Duration::from_millis(env_u64(
        "MAESTRO_A2A_TURN_TIMEOUT_MS",
        A2A_DEFAULT_TURN_TIMEOUT_MS,
    ));
    let approval_mode = trimmed_env("MAESTRO_A2A_TOOL_APPROVAL")
        .unwrap_or_else(|| "fail".to_string())
        .to_ascii_lowercase();
    let auto_approve_tools = matches!(approval_mode.as_str(), "auto" | "approve" | "approved");
    let mut output = A2ATurnOutput::default();
    let mut last_error: Option<String> = None;
    let mut response_ended = false;
    let response_end_settle = Duration::from_millis(env_u64(
        "MAESTRO_A2A_RESPONSE_END_SETTLE_MS",
        A2A_DEFAULT_RESPONSE_END_SETTLE_MS,
    ));
    let mut response_end_deadline: Option<tokio::time::Instant> = None;
    let turn_timeout = tokio::time::sleep(timeout);
    tokio::pin!(turn_timeout);

    loop {
        let response_end_wait = async {
            if let Some(deadline) = response_end_deadline {
                tokio::time::sleep_until(deadline).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        let event = tokio::select! {
            _ = &mut turn_timeout => {
                agent.cancel();
                return Err("A2A native TUI turn timed out".to_string());
            }
            _ = response_end_wait => {
                break;
            }
            changed = cancel_rx.changed() => {
                if changed.is_ok() && *cancel_rx.borrow() {
                    agent.cancel();
                    return Ok(A2ATurnResult::Canceled);
                }
                continue;
            }
            event = events.recv() => match event {
                Some(event) => event,
                None => break,
            },
        };
        match event {
            FromAgent::ResponseStart { .. } => {
                response_end_deadline = None;
            }
            FromAgent::ResponseChunk {
                content,
                is_thinking,
                ..
            } => {
                response_end_deadline = None;
                if is_thinking {
                    output.thinking_text.push_str(&content);
                } else {
                    output.assistant_text.push_str(&content);
                }
            }
            FromAgent::ResponseEnd { usage, .. } => {
                output.usage = usage;
                response_ended = true;
                response_end_deadline = Some(tokio::time::Instant::now() + response_end_settle);
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
            } => {
                response_end_deadline = None;
                record_tool_call_metadata(&mut output.tools, &call_id, &tool, args);
                if requires_approval {
                    let _ = agent.tool_response_sender().send((
                        call_id.clone(),
                        auto_approve_tools,
                        None,
                    ));
                    if !auto_approve_tools {
                        finish_tool_metadata(&mut output.tools, &call_id, false);
                    }
                }
            }
            FromAgent::ToolEnd {
                call_id, success, ..
            } => {
                response_end_deadline = None;
                finish_tool_metadata(&mut output.tools, &call_id, success);
            }
            FromAgent::HookBlocked {
                call_id,
                tool,
                reason,
            } => {
                response_end_deadline = None;
                if !output
                    .tools
                    .iter()
                    .any(|entry| entry.get("id").and_then(Value::as_str) == Some(&call_id))
                {
                    record_tool_call_metadata(&mut output.tools, &call_id, &tool, Value::Null);
                }
                finish_tool_metadata(&mut output.tools, &call_id, false);
                last_error = Some(reason);
            }
            FromAgent::Error { message, fatal } => {
                last_error = Some(message);
                if fatal {
                    break;
                }
            }
            _ => {}
        }
    }

    if response_ended {
        Ok(A2ATurnResult::Completed(output))
    } else {
        Err(last_error
            .unwrap_or_else(|| "A2A native TUI turn ended before response_end".to_string()))
    }
}

async fn a2a_wait_for_fake_response_delay(cancel_rx: &mut A2ACancelReceiver) -> bool {
    let delay_ms = env_u64("MAESTRO_A2A_FAKE_RESPONSE_DELAY_MS", 0);
    if delay_ms == 0 {
        return *cancel_rx.borrow();
    }

    let delay = tokio::time::sleep(Duration::from_millis(delay_ms));
    tokio::pin!(delay);
    tokio::select! {
        _ = &mut delay => *cancel_rx.borrow(),
        changed = cancel_rx.changed() => changed.is_ok() && *cancel_rx.borrow(),
    }
}

fn generate_a2a_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::fill(&mut bytes).is_ok() {
        return format!("{prefix}-{}", URL_SAFE_NO_PAD.encode(bytes));
    }
    let counter = A2A_ID_FALLBACK_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{}-{counter}", now_millis(), process::id())
}

fn a2a_error_response(status: u16, code: &str, message: &str) -> Vec<u8> {
    json_response(
        status,
        &serde_json::json!({ "error": { "code": code, "message": message } }),
    )
}

async fn handle_local_endpoint(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: RequestHead,
    state: &AppState,
) -> Vec<u8> {
    if let Err(response) = validate_csrf(&head, &state.config) {
        return response;
    }
    if head.method == "GET" && shared_session_path_from_path(&head.path).is_some() {
        return handle_session_endpoint(stream, initial, &head, state).await;
    }
    if is_session_endpoint(&head) {
        if let Err(response) = authorize(&head, &state.config) {
            return response;
        }
        return handle_session_endpoint(stream, initial, &head, state).await;
    }
    if is_pending_request_resume_endpoint(&head) {
        if let Err(response) = authorize(&head, &state.config) {
            return response;
        }
        return handle_pending_request_resume_endpoint(stream, initial, &head, state).await;
    }

    match (head.method.as_str(), head.path.as_str()) {
        ("GET", "/healthz") => text_response(200, "ok\n"),
        ("GET", "/readyz") => json_response(200, &serde_json::json!({ "status": "ready" })),
        ("GET", "/api/models") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(
                200,
                &serde_json::json!({ "models": available_models(&state.config).await.models }),
            )
        }
        ("GET", "/api/model") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let model = state.selected_model.lock().await.clone();
            json_response(200, &model)
        }
        ("POST", "/api/model") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let body = match read_request_body(stream, initial, &head).await {
                Ok(body) => body,
                Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
            };
            let payload: Value = match serde_json::from_slice(&body) {
                Ok(payload) => payload,
                Err(error) => {
                    return json_response(
                        400,
                        &serde_json::json!({ "error": format!("invalid model request: {error}") }),
                    );
                }
            };
            let Some(model_id) = payload.get("model").and_then(Value::as_str).map(str::trim) else {
                return json_response(400, &serde_json::json!({ "error": "model is required" }));
            };
            let registry = available_models(&state.config).await;
            let Some(model) = resolve_model(model_id, &registry) else {
                return json_response(
                    404,
                    &serde_json::json!({ "error": format!("Unknown model: {model_id}") }),
                );
            };
            *state.selected_model.lock().await = model.clone();
            json_response(200, &model)
        }
        ("POST", "/api/status") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            if head.query.get("action").map(String::as_str) == Some("mark-onboarding-seen") {
                mark_project_onboarding_seen(&state.config.cwd).await;
            }
            json_response(200, &serde_json::json!({ "success": true }))
        }
        ("GET", "/api/status") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let snapshot = build_status_snapshot(state).await;
            json_response(200, &snapshot)
        }
        ("GET", "/api/files") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &serde_json::json!({ "files": workspace_files(&state.config.cwd).await }))
        }
        ("GET", "/api/commands") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(
                200,
                &serde_json::json!({ "commands": command_catalog(&state.config.cwd).await }),
            )
        }
        ("GET", "/api/command-prefs") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &state.command_prefs.lock().await.clone())
        }
        ("POST", "/api/command-prefs") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let body = match read_request_body(stream, initial, &head).await {
                Ok(body) => body,
                Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
            };
            let prefs: CommandPrefs = match serde_json::from_slice(&body) {
                Ok(prefs) => prefs,
                Err(error) => {
                    return json_response(
                        400,
                        &serde_json::json!({ "error": format!("invalid command prefs: {error}") }),
                    );
                }
            };
            *state.command_prefs.lock().await = prefs.clone();
            persist_command_prefs(&state.config.command_prefs_path, &prefs).await;
            json_response(200, &serde_json::json!({ "ok": true }))
        }
        ("GET", "/api/config") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let config_path = model_config_path();
            let config = read_json_value(&config_path)
                .await
                .unwrap_or_else(|| serde_json::json!({ "providers": [] }));
            json_response(
                200,
                &serde_json::json!({ "config": config, "configPath": config_path }),
            )
        }
        ("POST", "/api/config") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let body = match read_request_body(stream, initial, &head).await {
                Ok(body) => body,
                Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
            };
            let payload: Value = match serde_json::from_slice(&body) {
                Ok(payload) => payload,
                Err(error) => {
                    return json_response(
                        400,
                        &serde_json::json!({ "error": format!("invalid config request: {error}") }),
                    );
                }
            };
            let Some(config) = payload.get("config") else {
                return json_response(400, &serde_json::json!({ "error": "config is required" }));
            };
            if !config.is_object() {
                return json_response(
                    400,
                    &serde_json::json!({ "error": "Config must be a JSON object" }),
                );
            }
            if contains_forbidden_json_key(config) {
                return json_response(
                    400,
                    &serde_json::json!({ "error": "Config contains forbidden keys" }),
                );
            }
            let config_path = PathBuf::from(model_config_path());
            if let Some(parent) = config_path.parent() {
                if let Err(error) = tokio::fs::create_dir_all(parent).await {
                    return json_response(
                        500,
                        &serde_json::json!({ "error": format!("failed to create config directory: {error}") }),
                    );
                }
            }
            let serialized = match serde_json::to_vec(config) {
                Ok(serialized) => serialized,
                Err(error) => {
                    return json_response(
                        500,
                        &serde_json::json!({ "error": format!("failed to serialize config: {error}") }),
                    );
                }
            };
            if serialized.len() > 256 * 1024 {
                return json_response(413, &serde_json::json!({ "error": "Config exceeds maximum allowed size" }));
            }
            if let Err(error) = tokio::fs::write(&config_path, serialized).await {
                return json_response(
                    500,
                    &serde_json::json!({ "error": format!("failed to write config: {error}") }),
                );
            }
            json_response(200, &serde_json::json!({ "success": true }))
        }
        ("GET", "/api/usage") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &usage_snapshot(&state.config.usage_file_path).await)
        }
        ("GET", "/api/metrics") => text_response(200, "# HELP maestro_rust_control_plane_up Rust control plane up\n# TYPE maestro_rust_control_plane_up gauge\nmaestro_rust_control_plane_up 1\n"),
        ("GET", "/api/run") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            if head.query.get("action").map(String::as_str) == Some("scripts") {
                return json_response(200, &serde_json::json!({ "scripts": package_scripts(&state.config.cwd).await }));
            }
            json_response(400, &serde_json::json!({ "error": "Invalid action" }))
        }
        ("POST", "/api/run") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let body = match read_request_body(stream, initial, &head).await {
                Ok(body) => body,
                Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
            };
            let request: RunScriptRequest = match serde_json::from_slice(&body) {
                Ok(request) => request,
                Err(error) => {
                    return json_response(
                        400,
                        &serde_json::json!({ "error": format!("invalid run request: {error}") }),
                    );
                }
            };
            run_script_response(&state.config.cwd, request).await
        }
        ("POST", "/api/attachments/extract") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            handle_attachment_extract(stream, initial, &head).await
        }
        ("GET", "/api/approvals") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            approval_mode_response(&head, state).await
        }
        ("POST", "/api/approvals") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            set_approval_mode_response(stream, initial, &head, state).await
        }
        ("GET", "/api/background") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let settings = state.background_settings.lock().await.clone();
            json_response(200, &background_response(&head, &settings))
        }
        ("POST", "/api/background") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            update_background_response(stream, initial, &head, state).await
        }
        ("GET", "/api/undo") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &undo_response(&head))
        }
        ("POST", "/api/undo") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(
                200,
                &serde_json::json!({
                    "success": false,
                    "message": "Undo checkpoints are not available in the Rust control plane yet",
                    "changedFiles": []
                }),
            )
        }
        ("GET", "/api/changes") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &changes_snapshot(&state.config.cwd).await)
        }
        ("GET", "/api/framework") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let framework = state.framework_preference.lock().await.clone();
            json_response(200, &framework_response(&head, framework.as_deref()))
        }
        ("POST", "/api/framework") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            update_framework_response(stream, initial, &head, state).await
        }
        ("GET", "/api/tools") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &serde_json::json!({ "tools": [] }))
        }
        ("GET", "/api/review") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &serde_json::json!({ "items": [], "summary": null }))
        }
        ("GET", "/api/context") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &serde_json::json!({ "runtime": "rust-control-plane", "cwd": state.config.cwd }))
        }
        ("GET", "/api/stats") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &serde_json::json!({ "runtime": "rust-control-plane", "uptime": state.started_at.elapsed().as_secs_f64() }))
        }
        ("GET", "/api/telemetry") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &telemetry_status(*state.telemetry_override.lock().await))
        }
        ("POST", "/api/telemetry") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let action = match read_required_action(stream, initial, &head, &["on", "off", "reset"]).await {
                Ok(action) => action,
                Err(response) => return response,
            };
            let override_value = match action.as_str() {
                "on" => Some(true),
                "off" => Some(false),
                "reset" => None,
                _ => unreachable!("action was validated"),
            };
            *state.telemetry_override.lock().await = override_value;
            json_response(
                200,
                &serde_json::json!({
                    "success": true,
                    "status": telemetry_status(override_value),
                    "message": "Telemetry preference updated"
                }),
            )
        }
        ("GET", "/api/training") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &training_status(*state.training_override.lock().await))
        }
        ("POST", "/api/training") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            let action = match read_required_action(stream, initial, &head, &["on", "off", "reset"]).await {
                Ok(action) => action,
                Err(response) => return response,
            };
            let override_value = match action.as_str() {
                "on" => Some(false),
                "off" => Some(true),
                "reset" => None,
                _ => unreachable!("action was validated"),
            };
            *state.training_override.lock().await = override_value;
            json_response(
                200,
                &serde_json::json!({
                    "success": true,
                    "status": training_status(override_value),
                    "message": "Training preference updated"
                }),
            )
        }
        ("OPTIONS", path) if path.starts_with("/api/") => {
            response(204, "text/plain; charset=utf-8", &[])
        }
        _ => json_response(404, &serde_json::json!({ "error": "Not found" })),
    }
}

#[derive(Debug, Deserialize, Default)]
struct SessionCreateRequest {
    title: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SessionUpdateRequest {
    title: Option<String>,
    favorite: Option<bool>,
    tags: Option<Vec<String>>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct SessionStore {
    #[serde(default)]
    sessions: HashMap<String, SessionRecord>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    shared_sessions: HashMap<String, SharedSessionGrant>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    title: String,
    created_at: String,
    updated_at: String,
    message_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    favorite: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    #[serde(default)]
    messages: Vec<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedSessionGrant {
    session_id: String,
    expires_at: u64,
    max_accesses: Option<u64>,
    access_count: u64,
}

struct ShareOptions {
    expires_in_hours: u64,
    max_accesses: Option<u64>,
    allow_sensitive_content: bool,
}

struct ExportOptions {
    format: String,
    allow_sensitive_content: bool,
}

async fn handle_session_endpoint(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
) -> Vec<u8> {
    if head.method == "GET" {
        if let Some(shared_path) = shared_session_path_from_path(&head.path) {
            return handle_shared_session_get(state, shared_path).await;
        }
    }
    let Some(auth) = auth_context(head, &state.config) else {
        return json_response(401, &serde_json::json!({ "error": "Unauthorized" }));
    };
    match head.method.as_str() {
        "GET" if head.path == "/api/sessions" => json_response(
            200,
            &serde_json::json!({ "sessions": session_summaries(state, &auth).await }),
        ),
        "POST" if head.path == "/api/sessions" => {
            let body = match read_request_body(stream, initial, head).await {
                Ok(body) => body,
                Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
            };
            let request = if body.is_empty() {
                SessionCreateRequest::default()
            } else {
                match serde_json::from_slice::<SessionCreateRequest>(&body) {
                    Ok(request) => request,
                    Err(error) => {
                        return json_response(
                            400,
                            &serde_json::json!({ "error": format!("invalid session request: {error}") }),
                        );
                    }
                }
            };
            let session = create_session_record(request.title, auth.subject.clone());
            let value = session_full_value(&session);
            {
                state
                    .sessions
                    .lock()
                    .await
                    .sessions
                    .insert(session.id.clone(), session);
            }
            persist_session_store(state).await;
            json_response(200, &value)
        }
        "POST" => {
            let Some(session_path) = session_path_from_path(&head.path) else {
                return json_response(404, &serde_json::json!({ "error": "Not found" }));
            };
            match session_path.tail {
                Some("share") => {
                    handle_session_share_post(stream, initial, head, state, session_path, &auth)
                        .await
                }
                Some("export") => {
                    handle_session_export_post(stream, initial, head, state, session_path, &auth)
                        .await
                }
                Some(tail) => {
                    if let Some(attachment_id) = session_attachment_extract_id(tail) {
                        handle_session_attachment_extract(
                            head,
                            state,
                            session_path.id,
                            attachment_id,
                            &auth,
                        )
                        .await
                    } else {
                        json_response(404, &serde_json::json!({ "error": "Not found" }))
                    }
                }
                _ => json_response(404, &serde_json::json!({ "error": "Not found" })),
            }
        }
        "GET" => {
            let Some(session_path) = session_path_from_path(&head.path) else {
                return json_response(404, &serde_json::json!({ "error": "Not found" }));
            };
            handle_session_get(head, state, session_path, &auth).await
        }
        "PATCH" => {
            let Some(session_path) = session_path_from_path(&head.path) else {
                return json_response(404, &serde_json::json!({ "error": "Not found" }));
            };
            if session_path.tail.is_some() {
                return json_response(404, &serde_json::json!({ "error": "Not found" }));
            };
            let body = match read_request_body(stream, initial, head).await {
                Ok(body) => body,
                Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
            };
            let request = if body.is_empty() {
                SessionUpdateRequest::default()
            } else {
                match serde_json::from_slice::<SessionUpdateRequest>(&body) {
                    Ok(request) => request,
                    Err(error) => {
                        return json_response(
                            400,
                            &serde_json::json!({ "error": format!("invalid session update: {error}") }),
                        );
                    }
                }
            };
            let mut sessions = state.sessions.lock().await;
            let Some(session) = sessions.sessions.get_mut(session_path.id) else {
                return json_response(404, &serde_json::json!({ "error": "Session not found" }));
            };
            if !session_visible_to_auth(session, &auth) {
                return json_response(404, &serde_json::json!({ "error": "Session not found" }));
            }
            if let Some(title) = request.title.and_then(|title| normalize_title(Some(title))) {
                session.title = title;
            }
            if let Some(favorite) = request.favorite {
                session.favorite = Some(favorite);
            }
            if let Some(tags) = request.tags {
                session.tags = tags;
            }
            session.updated_at = now_rfc3339();
            let value = session_summary_value(session);
            drop(sessions);
            persist_session_store(state).await;
            json_response(200, &value)
        }
        "DELETE" => {
            let Some(session_path) = session_path_from_path(&head.path) else {
                return json_response(404, &serde_json::json!({ "error": "Not found" }));
            };
            if session_path.tail.is_some() {
                return json_response(404, &serde_json::json!({ "error": "Not found" }));
            };
            let mut sessions = state.sessions.lock().await;
            let Some(session) = sessions.sessions.get(session_path.id) else {
                return json_response(404, &serde_json::json!({ "error": "Session not found" }));
            };
            if !session_visible_to_auth(session, &auth) {
                return json_response(404, &serde_json::json!({ "error": "Session not found" }));
            }
            sessions.sessions.remove(session_path.id);
            drop(sessions);
            persist_session_store(state).await;
            response_with_extra_headers_and_length(204, "application/json", &[], "", 0)
        }
        _ => json_response(405, &serde_json::json!({ "error": "Method not allowed" })),
    }
}

async fn handle_pending_request_resume_endpoint(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
) -> Vec<u8> {
    let Some(request_id) = pending_request_id_from_resume_path(&head.path) else {
        return json_response(404, &serde_json::json!({ "error": "Not found" }));
    };
    let body = match read_request_body(stream, initial, head).await {
        Ok(body) => body,
        Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
    };
    let payload = if body.is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(payload) if payload.is_object() => payload,
            Ok(_) => {
                return json_response(
                    400,
                    &serde_json::json!({ "error": "pending request resume payload must be an object" }),
                );
            }
            Err(error) => {
                return json_response(
                    400,
                    &serde_json::json!({ "error": format!("invalid pending request resume request: {error}") }),
                );
            }
        }
    };
    let Some(sender) = state
        .pending_tool_responses
        .lock()
        .await
        .remove(&request_id)
    else {
        return json_response(
            404,
            &serde_json::json!({ "error": format!("No active pending request: {request_id}") }),
        );
    };
    let (approved, result) = pending_tool_response_from_payload(&payload);
    if sender.send((request_id.clone(), approved, result)).is_err() {
        return json_response(
            409,
            &serde_json::json!({ "error": "Pending request is no longer active" }),
        );
    }
    json_response(200, &pending_request_resume_value(&request_id, &payload))
}

async fn load_session_store(path: &Path) -> (SessionStore, bool) {
    match tokio::fs::read(path).await {
        Ok(bytes) => match decode_session_store(&bytes) {
            Ok(store) => (store, true),
            Err(error) => {
                eprintln!(
                    "failed to parse session store at {}: {error}; leaving the file untouched",
                    path.display()
                );
                (SessionStore::default(), false)
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (SessionStore::default(), true)
        }
        Err(_) => (SessionStore::default(), true),
    }
}

fn decode_session_store(bytes: &[u8]) -> Result<SessionStore, String> {
    let value = serde_json::from_slice::<Value>(bytes).map_err(|error| error.to_string())?;
    if value.get("sessions").is_some() {
        return serde_json::from_value::<SessionStore>(value).map_err(|error| error.to_string());
    }
    if value.is_object() {
        let sessions = serde_json::from_value::<HashMap<String, SessionRecord>>(value)
            .map_err(|error| error.to_string())?;
        return Ok(SessionStore {
            sessions,
            shared_sessions: HashMap::new(),
        });
    }
    if value.is_array() {
        let sessions = serde_json::from_value::<Vec<SessionRecord>>(value)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|session| (session.id.clone(), session))
            .collect();
        return Ok(SessionStore {
            sessions,
            shared_sessions: HashMap::new(),
        });
    }
    Err("session store must be an object or array".to_string())
}

async fn persist_session_store(state: &AppState) {
    if !state.session_store_persist_enabled {
        eprintln!(
            "skipping session store write because {} did not parse on startup",
            state.config.session_store_path.display()
        );
        return;
    }
    let _persist = state.session_persist_lock.lock().await;
    let store = state.sessions.lock().await.clone();
    if let Some(parent) = state.config.session_store_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&store) {
        let _ = tokio::fs::write(&state.config.session_store_path, bytes).await;
    }
}

async fn persist_shared_sessions(state: &AppState) {
    if !state.session_store_persist_enabled {
        return;
    }
    let shared_sessions = state.shared_sessions.lock().await.clone();
    {
        let mut store = state.sessions.lock().await;
        store.shared_sessions = shared_sessions;
    }
    persist_session_store(state).await;
}

fn create_session_record(title: Option<String>, owner: Option<String>) -> SessionRecord {
    let now = now_rfc3339();
    SessionRecord {
        id: new_session_id(),
        owner,
        title: normalize_title(title).unwrap_or_else(|| "New Chat".to_string()),
        created_at: now.clone(),
        updated_at: now,
        message_count: 0,
        favorite: None,
        tags: Vec::new(),
        messages: Vec::new(),
    }
}

fn normalize_title(title: Option<String>) -> Option<String> {
    title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn session_visible_to_auth(session: &SessionRecord, auth: &AuthContext) -> bool {
    auth.unrestricted
        || auth
            .subject
            .as_deref()
            .is_some_and(|subject| session.owner.as_deref() == Some(subject))
}

async fn session_summaries(state: &AppState, auth: &AuthContext) -> Vec<Value> {
    let mut sessions: Vec<SessionRecord> = state
        .sessions
        .lock()
        .await
        .sessions
        .values()
        .filter(|session| session_visible_to_auth(session, auth))
        .cloned()
        .collect();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions
        .iter()
        .map(session_summary_value)
        .collect::<Vec<_>>()
}

async fn handle_session_get(
    head: &RequestHead,
    state: &AppState,
    session_path: SessionPath<'_>,
    auth: &AuthContext,
) -> Vec<u8> {
    let Some(session) = state
        .sessions
        .lock()
        .await
        .sessions
        .get(session_path.id)
        .cloned()
    else {
        return json_response(404, &serde_json::json!({ "error": "Session not found" }));
    };
    if !session_visible_to_auth(&session, auth) {
        return json_response(404, &serde_json::json!({ "error": "Session not found" }));
    }

    match session_path.tail {
        None => json_response(200, &session_full_value(&session)),
        Some("timeline") => json_response(200, &session_timeline_value(&session)),
        Some("share") => json_response(
            200,
            &serde_json::json!({ "sessionId": session.id, "enabled": false, "shareUrl": Value::Null }),
        ),
        Some("export") => json_response(200, &session_full_value(&session)),
        Some("artifacts") => json_response(200, &session_artifacts_value(&session)),
        Some("artifact-access") => session_artifact_access_response(head, &session),
        Some("attachments") => json_response(200, &session_attachments_value(&session)),
        Some("artifacts.zip") => serve_session_artifacts_zip(&session),
        Some(tail) if tail.starts_with("artifacts/") => {
            serve_session_artifact(head, &session, tail)
        }
        Some(tail) if tail.starts_with("attachments/") => serve_session_attachment(&session, tail),
        _ => json_response(404, &serde_json::json!({ "error": "Not found" })),
    }
}

fn session_timeline_value(session: &SessionRecord) -> Value {
    serde_json::json!({
        "sessionId": session.id,
        "source": "local",
        "generatedAt": now_rfc3339(),
        "platformBacked": false,
        "pendingRequestCount": 0,
        "items": session.messages.iter().enumerate().map(|(index, message)| {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("assistant");
            let event_type = if role == "user" { "message.user" } else { "message.assistant" };
            serde_json::json!({
                "id": format!("{}-{index}", session.id),
                "sessionId": session.id,
                "timestamp": message.get("timestamp").and_then(Value::as_str).unwrap_or(&session.updated_at),
                "type": event_type,
                "title": if role == "user" { "User message" } else { "Assistant message" },
                "visibility": "user",
                "source": "local",
                "status": "completed",
                "role": role,
                "summary": timeline_message_summary(message),
                "metadata": { "message": public_session_message(message) }
            })
        }).collect::<Vec<_>>()
    })
}

fn timeline_message_summary(message: &Value) -> String {
    message
        .get("content")
        .map(|content| {
            content
                .as_str()
                .map(ToString::to_string)
                .unwrap_or_else(|| content.to_string())
        })
        .unwrap_or_default()
        .chars()
        .take(240)
        .collect()
}

async fn handle_shared_session_get(
    state: &AppState,
    shared_path: SharedSessionPath<'_>,
) -> Vec<u8> {
    let now = now_millis();
    let (session_id, should_persist_shared_sessions) = {
        let mut shares = state.shared_sessions.lock().await;
        let Some(grant) = shares.get_mut(shared_path.token) else {
            return json_response(
                404,
                &serde_json::json!({ "error": "Shared session not found" }),
            );
        };
        if grant.expires_at <= now {
            shares.remove(shared_path.token);
            drop(shares);
            persist_shared_sessions(state).await;
            return json_response(
                404,
                &serde_json::json!({ "error": "Shared session not found" }),
            );
        }
        if shared_path.tail.is_none() {
            if grant
                .max_accesses
                .map(|max| grant.access_count >= max)
                .unwrap_or(false)
            {
                shares.remove(shared_path.token);
                drop(shares);
                persist_shared_sessions(state).await;
                return json_response(
                    404,
                    &serde_json::json!({ "error": "Shared session not found" }),
                );
            }
            grant.access_count = grant.access_count.saturating_add(1);
            (grant.session_id.clone(), true)
        } else {
            (grant.session_id.clone(), false)
        }
    };
    if should_persist_shared_sessions {
        persist_shared_sessions(state).await;
    }
    let Some(session) = state
        .sessions
        .lock()
        .await
        .sessions
        .get(&session_id)
        .cloned()
    else {
        return json_response(
            404,
            &serde_json::json!({ "error": "Shared session not found" }),
        );
    };

    match shared_path.tail {
        None => json_response(200, &session_full_value(&session)),
        Some(tail) if tail.starts_with("attachments/") => serve_session_attachment(&session, tail),
        _ => json_response(404, &serde_json::json!({ "error": "Not found" })),
    }
}

async fn handle_session_share_post(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
    session_path: SessionPath<'_>,
    auth: &AuthContext,
) -> Vec<u8> {
    let Some(session) = state
        .sessions
        .lock()
        .await
        .sessions
        .get(session_path.id)
        .cloned()
    else {
        return json_response(404, &serde_json::json!({ "error": "Session not found" }));
    };
    if !session_visible_to_auth(&session, auth) {
        return json_response(404, &serde_json::json!({ "error": "Session not found" }));
    }
    let options = match read_share_options(stream, initial, head).await {
        Ok(options) => options,
        Err(response) => return response,
    };
    if !options.allow_sensitive_content && session_contains_sensitive_content(&session) {
        return json_response(
            409,
            &serde_json::json!({
                "error": "Sensitive content detected. Confirm that you want to publish this session.",
                "code": "sensitive_content_detected"
            }),
        );
    }
    let token = match generate_share_token() {
        Ok(token) => token,
        Err(error) => return json_response(500, &serde_json::json!({ "error": error })),
    };
    let expires_at = chrono::Utc::now() + chrono::Duration::hours(options.expires_in_hours as i64);
    state.shared_sessions.lock().await.insert(
        token.clone(),
        SharedSessionGrant {
            session_id: session.id,
            expires_at: expires_at.timestamp_millis().max(0) as u64,
            max_accesses: options.max_accesses,
            access_count: 0,
        },
    );
    persist_shared_sessions(state).await;
    json_response(
        200,
        &serde_json::json!({
            "shareToken": token,
            "shareUrl": format!("/api/sessions/shared/{token}"),
            "webShareUrl": format!("/share/{token}"),
            "expiresAt": expires_at.to_rfc3339(),
            "maxAccesses": options.max_accesses
        }),
    )
}

async fn read_share_options(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
) -> Result<ShareOptions, Vec<u8>> {
    let body = read_request_body(stream, initial, head)
        .await
        .map_err(|error| json_response(400, &serde_json::json!({ "error": error })))?;
    let value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(&body).map_err(|error| {
            json_response(
                400,
                &serde_json::json!({ "error": format!("invalid share request: {error}") }),
            )
        })?
    };
    Ok(share_options_from_value(&value))
}

fn share_options_from_value(value: &Value) -> ShareOptions {
    let expires_in_hours = value
        .get("expiresInHours")
        .and_then(Value::as_u64)
        .unwrap_or(24)
        .clamp(1, 168);
    let max_accesses = match value.get("maxAccesses") {
        Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().unwrap_or(100).max(1)),
        None => Some(100),
    };
    ShareOptions {
        expires_in_hours,
        max_accesses,
        allow_sensitive_content: value
            .get("allowSensitiveContent")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn export_options_from_body(body: &[u8]) -> Result<ExportOptions, String> {
    if body.is_empty() {
        return Ok(ExportOptions {
            format: "json".to_string(),
            allow_sensitive_content: false,
        });
    }
    let value = serde_json::from_slice::<Value>(body)
        .map_err(|error| format!("invalid export request: {error}"))?;
    Ok(export_options_from_value(&value))
}

fn export_options_from_value(value: &Value) -> ExportOptions {
    ExportOptions {
        format: value
            .get("format")
            .and_then(Value::as_str)
            .filter(|format| matches!(*format, "json" | "markdown" | "text"))
            .unwrap_or("json")
            .to_string(),
        allow_sensitive_content: value
            .get("allowSensitiveContent")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn session_contains_sensitive_content(session: &SessionRecord) -> bool {
    let haystack = serde_json::to_string(&session.messages)
        .unwrap_or_default()
        .to_ascii_lowercase();
    [
        "api_key",
        "apikey",
        "access token",
        "auth token",
        "bearer ",
        "password",
        "private key",
        "secret",
    ]
    .iter()
    .any(|needle| haystack.contains(needle))
}

fn generate_share_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Unable to generate share token: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

async fn handle_session_export_post(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
    session_path: SessionPath<'_>,
    auth: &AuthContext,
) -> Vec<u8> {
    let body = match read_request_body(stream, initial, head).await {
        Ok(body) => body,
        Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
    };
    let options = match export_options_from_body(&body) {
        Ok(options) => options,
        Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
    };
    let Some(session) = state
        .sessions
        .lock()
        .await
        .sessions
        .get(session_path.id)
        .cloned()
    else {
        return json_response(404, &serde_json::json!({ "error": "Session not found" }));
    };
    if !session_visible_to_auth(&session, auth) {
        return json_response(404, &serde_json::json!({ "error": "Session not found" }));
    }
    if !options.allow_sensitive_content && session_contains_sensitive_content(&session) {
        return json_response(
            409,
            &serde_json::json!({
                "error": "Sensitive content detected. Confirm that you want to export this session.",
                "code": "sensitive_content_detected"
            }),
        );
    }
    match options.format.as_str() {
        "markdown" => text_response(200, &session_export_text(&session, true)),
        "text" => text_response(200, &session_export_text(&session, false)),
        _ => json_response(200, &session_full_value(&session)),
    }
}

fn session_export_text(session: &SessionRecord, markdown: bool) -> String {
    let mut lines = Vec::new();
    if markdown {
        lines.push(format!("# {}", session.title));
    } else {
        lines.push(session.title.clone());
    }
    for message in &session.messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("message");
        let text = message_text(message);
        if markdown {
            lines.push(format!("\n## {role}\n{text}"));
        } else {
            lines.push(format!("\n{role}:\n{text}"));
        }
    }
    lines.join("\n")
}

fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| Some(block.to_string()))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(value) => value.to_string(),
        None => String::new(),
    }
}

fn session_attachments_value(session: &SessionRecord) -> Value {
    let mut attachments = session_attachments(session);
    for attachment in &mut attachments {
        sanitize_attachment_for_read(attachment);
    }
    serde_json::json!({ "sessionId": session.id, "attachments": attachments })
}

fn session_attachments(session: &SessionRecord) -> Vec<Value> {
    let mut attachments = Vec::new();
    for message in &session.messages {
        if let Some(values) = message.get("attachments").and_then(Value::as_array) {
            attachments.extend(values.iter().cloned());
        }
    }
    attachments
}

fn session_attachment_extract_id(tail: &str) -> Option<String> {
    let rest = tail.strip_prefix("attachments/")?;
    let (attachment_id, suffix) = rest.split_once('/')?;
    if suffix != "extract" {
        return None;
    }
    let attachment_id = percent_decode_component(attachment_id);
    if attachment_id.is_empty() {
        None
    } else {
        Some(attachment_id)
    }
}

async fn handle_attachment_extract(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
) -> Vec<u8> {
    let body = match read_request_body_with_limit(
        stream,
        initial,
        head,
        MAX_EXTRACT_JSON_BODY_BYTES,
    )
    .await
    {
        Ok(body) => body,
        Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
    };
    let request: ExtractAttachmentRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                400,
                &serde_json::json!({ "error": format!("invalid attachment extract request: {error}") }),
            );
        }
    };
    match tokio::task::spawn_blocking(move || extract_attachment_request(request)).await {
        Ok(Ok(output)) => attachment_extract_json_response(output.file_name.clone(), output),
        Ok(Err(error)) => json_response(400, &serde_json::json!({ "error": error })),
        Err(error) => json_response(
            500,
            &serde_json::json!({ "error": format!("Attachment extraction failed: {error}") }),
        ),
    }
}

async fn handle_session_attachment_extract(
    head: &RequestHead,
    state: &AppState,
    session_id: &str,
    attachment_id: String,
    auth: &AuthContext,
) -> Vec<u8> {
    let should_force = head
        .query
        .get("force")
        .map(|force| matches!(force.as_str(), "1" | "true"))
        .unwrap_or(false);
    let (file_name, mime_type, content_base64) = {
        let mut sessions = state.sessions.lock().await;
        let Some(session) = sessions.sessions.get_mut(session_id) else {
            return json_response(404, &serde_json::json!({ "error": "Session not found" }));
        };
        if !session_visible_to_auth(session, auth) {
            return json_response(404, &serde_json::json!({ "error": "Session not found" }));
        }
        let Some(attachment) = find_session_attachment_mut(session, &attachment_id) else {
            return json_response(404, &serde_json::json!({ "error": "Attachment not found" }));
        };

        let file_name = attachment_string_field(attachment, &["fileName", "file_name"])
            .unwrap_or_else(|| "attachment".to_string());
        let mime_type = attachment_string_field(attachment, &["mimeType", "mime_type"]);
        if let Some(extracted_text) =
            attachment_string_field(attachment, &["extractedText", "extracted_text"])
        {
            if !should_force {
                return json_response(
                    200,
                    &serde_json::json!({
                        "fileName": file_name,
                        "format": "unknown",
                        "size": attachment.get("size").and_then(Value::as_u64).unwrap_or(0),
                        "truncated": false,
                        "extractedText": extracted_text,
                        "cached": true
                    }),
                );
            }
        }
        let Some(content_base64) =
            attachment_string_field(attachment, &["contentBase64", "content_base64", "content"])
        else {
            return json_response(
                404,
                &serde_json::json!({ "error": "Attachment content not available" }),
            );
        };
        (file_name, mime_type, content_base64)
    };
    let output = match tokio::task::spawn_blocking({
        let file_name = file_name.clone();
        move || {
            extract_attachment_request(ExtractAttachmentRequest {
                file_name,
                mime_type,
                content_base64,
                max_chars: None,
            })
        }
    })
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return json_response(400, &serde_json::json!({ "error": error }));
        }
        Err(error) => {
            return json_response(
                500,
                &serde_json::json!({ "error": format!("Attachment extraction failed: {error}") }),
            );
        }
    };
    let should_persist = {
        let mut sessions = state.sessions.lock().await;
        let Some(session) = sessions.sessions.get_mut(session_id) else {
            return attachment_extract_json_response(file_name, output);
        };
        if !session_visible_to_auth(session, auth) {
            return json_response(404, &serde_json::json!({ "error": "Session not found" }));
        }
        let Some(attachment) = find_session_attachment_mut(session, &attachment_id) else {
            return attachment_extract_json_response(file_name, output);
        };
        if let Some(object) = attachment.as_object_mut() {
            object.insert(
                "extractedText".to_string(),
                Value::String(output.extracted_text.clone()),
            );
            true
        } else {
            false
        }
    };
    if should_persist {
        persist_session_store(state).await;
    }
    attachment_extract_json_response(file_name, output)
}

fn find_session_attachment_mut<'a>(
    session: &'a mut SessionRecord,
    attachment_id: &str,
) -> Option<&'a mut Value> {
    for message in &mut session.messages {
        let Some(attachments) = message.get_mut("attachments").and_then(Value::as_array_mut) else {
            continue;
        };
        if let Some(attachment) = attachments.iter_mut().find(|attachment| {
            attachment
                .get("id")
                .and_then(Value::as_str)
                .map(|id| id == attachment_id)
                .unwrap_or(false)
        }) {
            return Some(attachment);
        }
    }
    None
}

fn attachment_string_field(attachment: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| attachment.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn attachment_extract_json_response(file_name: String, output: ExtractDocumentOutput) -> Vec<u8> {
    json_response(
        200,
        &serde_json::json!({
            "fileName": file_name,
            "format": output.format,
            "size": output.size_bytes,
            "truncated": output.truncated,
            "extractedText": output.extracted_text
        }),
    )
}

fn extract_attachment_request(
    request: ExtractAttachmentRequest,
) -> Result<ExtractDocumentOutput, String> {
    let file_name = request.file_name.trim().to_string();
    if file_name.is_empty() {
        return Err("fileName is required".to_string());
    }
    let normalized = normalize_base64(&request.content_base64);
    let encoded = strip_data_url_prefix(&normalized);
    if encoded.is_empty() {
        return Err("contentBase64 is required".to_string());
    }
    if !is_valid_base64(encoded) {
        return Err("Invalid base64 content".to_string());
    }
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid base64 content".to_string())?;
    extract_document_text(
        bytes,
        file_name,
        request.mime_type.filter(|value| !value.trim().is_empty()),
        request.max_chars,
    )
}

fn normalize_base64(input: &str) -> String {
    input.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn is_valid_base64(input: &str) -> bool {
    if input.is_empty() || input.len() % 4 == 1 {
        return false;
    }
    input
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '='))
}

fn extract_document_text(
    bytes: Vec<u8>,
    file_name: String,
    mime_type: Option<String>,
    max_chars: Option<usize>,
) -> Result<ExtractDocumentOutput, String> {
    if bytes.len() > MAX_EXTRACT_INPUT_BYTES {
        return Err(format!(
            "Document is too large ({:.1}MB). Maximum supported size is 50MB.",
            bytes.len() as f64 / 1024.0 / 1024.0
        ));
    }
    let format = detect_document_format(&file_name, mime_type.as_deref());
    let size_bytes = bytes.len();
    let extracted_text = match format.as_str() {
        "text" => {
            String::from_utf8(bytes).map_err(|_| "Document is not valid UTF-8 text".to_string())?
        }
        "pdf" => pdf_extract::extract_text_from_mem(&bytes)
            .map_err(|error| format!("Failed to extract PDF text: {error}"))?,
        "docx" => extract_zip_text(&bytes, |name| name == "word/document.xml")?,
        "pptx" => extract_zip_text(&bytes, |name| {
            name.starts_with("ppt/slides/") && name.ends_with(".xml")
        })?,
        "xlsx" => extract_zip_text(&bytes, |name| {
            name == "xl/sharedStrings.xml"
                || (name.starts_with("xl/worksheets/") && name.ends_with(".xml"))
        })?,
        _ => String::new(),
    };
    if extracted_text.is_empty() && format == "unknown" {
        return Err("Unsupported document format".to_string());
    }
    let max_chars = max_chars.unwrap_or(DEFAULT_EXTRACT_MAX_CHARS).max(1);
    let (extracted_text, truncated) = clamp_chars(&extracted_text, max_chars);
    Ok(ExtractDocumentOutput {
        file_name,
        format,
        size_bytes,
        truncated,
        extracted_text,
    })
}

fn detect_document_format(file_name: &str, mime_type: Option<&str>) -> String {
    let lower_name = file_name.to_ascii_lowercase();
    let mime_type = mime_type.unwrap_or("").to_ascii_lowercase();
    if mime_type.starts_with("text/") {
        return "text".to_string();
    }
    if mime_type == "application/pdf" || lower_name.ends_with(".pdf") {
        return "pdf".to_string();
    }
    if mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        || lower_name.ends_with(".docx")
    {
        return "docx".to_string();
    }
    if mime_type == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        || lower_name.ends_with(".pptx")
    {
        return "pptx".to_string();
    }
    if mime_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        || lower_name.ends_with(".xlsx")
    {
        return "xlsx".to_string();
    }
    for extension in [
        ".txt",
        ".md",
        ".markdown",
        ".json",
        ".yaml",
        ".yml",
        ".csv",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".html",
        ".css",
        ".xml",
    ] {
        if lower_name.ends_with(extension) {
            return "text".to_string();
        }
    }
    "unknown".to_string()
}

fn extract_zip_text<F>(bytes: &[u8], accept: F) -> Result<String, String>
where
    F: Fn(&str) -> bool,
{
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Failed to read document archive: {error}"))?;
    let mut output = String::new();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read document entry: {error}"))?;
        let name = file.name().to_string();
        if !accept(&name) {
            continue;
        }
        let mut xml = String::new();
        file.read_to_string(&mut xml)
            .map_err(|error| format!("Failed to read document XML: {error}"))?;
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&xml_text_content(&xml));
    }
    Ok(output)
}

fn xml_text_content(xml: &str) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    for ch in xml.chars() {
        match ch {
            '<' => {
                in_tag = true;
                text.push(' ');
            }
            '>' => in_tag = false,
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }
    decode_xml_entities(&collapse_whitespace(&text))
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_xml_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn clamp_chars(text: &str, max_chars: usize) -> (String, bool) {
    for (count, (index, _)) in text.char_indices().enumerate() {
        if count == max_chars {
            return (text[..index].to_string(), true);
        }
    }
    (text.to_string(), false)
}

fn serve_session_attachment(session: &SessionRecord, tail: &str) -> Vec<u8> {
    let Some(attachment_id) = tail
        .strip_prefix("attachments/")
        .and_then(|rest| rest.split('/').next())
        .map(percent_decode_component)
        .filter(|value| !value.is_empty())
    else {
        return json_response(404, &serde_json::json!({ "error": "Attachment not found" }));
    };
    let Some(attachment) = session_attachments(session).into_iter().find(|attachment| {
        attachment
            .get("id")
            .and_then(Value::as_str)
            .map(|id| id == attachment_id)
            .unwrap_or(false)
    }) else {
        return json_response(404, &serde_json::json!({ "error": "Attachment not found" }));
    };
    let Some(content) = attachment.get("content").and_then(Value::as_str) else {
        return json_response(
            404,
            &serde_json::json!({ "error": "Attachment content not available" }),
        );
    };
    let encoded = content
        .split_once(',')
        .map(|(_, value)| value)
        .unwrap_or(content);
    let Ok(bytes) = BASE64_STANDARD.decode(encoded) else {
        return json_response(
            400,
            &serde_json::json!({ "error": "Attachment content is not valid base64" }),
        );
    };
    let mime = attachment
        .get("mimeType")
        .or_else(|| attachment.get("mime_type"))
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    response_with_no_store(200, mime, &bytes)
}

fn session_artifacts_value(session: &SessionRecord) -> Value {
    let artifacts = reconstruct_session_artifacts(session)
        .into_iter()
        .map(|(filename, content)| {
            serde_json::json!({
                "filename": filename,
                "content": content
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "sessionId": session.id, "artifacts": artifacts })
}

fn session_artifact_access_response(head: &RequestHead, session: &SessionRecord) -> Vec<u8> {
    let Some(actions) = artifact_access_actions(head.query.get("actions")) else {
        return json_response(
            400,
            &serde_json::json!({ "error": "actions must include view, file, events, or zip" }),
        );
    };
    let filename = head
        .query
        .get("filename")
        .map(|value| percent_decode_component(value))
        .filter(|value| !value.trim().is_empty());
    let ttl_ms = env::var("MAESTRO_ARTIFACT_ACCESS_TTL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(5 * 60 * 1000);
    let expires_at = now_millis().saturating_add(ttl_ms);
    let expires_at_iso =
        (chrono::Utc::now() + chrono::Duration::milliseconds(ttl_ms as i64)).to_rfc3339();
    let token_payload = format!(
        "{}:{}:{}:{}",
        session.id,
        filename.as_deref().unwrap_or(""),
        actions.join(","),
        expires_at
    );
    json_response(
        200,
        &serde_json::json!({
            "sessionId": session.id,
            "scope": Value::Null,
            "filename": filename,
            "actions": actions,
            "expiresAt": expires_at,
            "expiresAtIso": expires_at_iso,
            "token": BASE64_STANDARD.encode(token_payload)
        }),
    )
}

fn artifact_access_actions(raw_actions: Option<&String>) -> Option<Vec<String>> {
    let decoded = raw_actions.map(|value| percent_decode_component(value))?;
    let mut actions = Vec::new();
    for action in decoded.split(',').map(str::trim) {
        if matches!(action, "view" | "file" | "events" | "zip")
            && !actions.iter().any(|existing| existing == action)
        {
            actions.push(action.to_string());
        }
    }
    if actions.is_empty() {
        None
    } else {
        Some(actions)
    }
}

fn serve_session_artifact(head: &RequestHead, session: &SessionRecord, tail: &str) -> Vec<u8> {
    let Some(rest) = tail.strip_prefix("artifacts/") else {
        return json_response(404, &serde_json::json!({ "error": "Artifact not found" }));
    };
    let is_view = rest.ends_with("/view");
    let filename = percent_decode_component(rest.strip_suffix("/view").unwrap_or(rest));
    let artifacts = reconstruct_session_artifacts(session);
    let Some(content) = artifacts.get(&filename) else {
        return json_response(404, &serde_json::json!({ "error": "Artifact not found" }));
    };
    let mime = mime_for_path(Path::new(&filename));
    if is_view && mime.starts_with("text/html") {
        return sandboxed_artifact_viewer(&filename, content);
    }
    if query_flag(head, "download") || query_flag(head, "standalone") {
        return response_with_extra_headers(
            200,
            mime,
            content.as_bytes(),
            &format!(
                "Content-Disposition: {}\r\nCache-Control: no-store, no-cache, must-revalidate\r\n",
                attachment_content_disposition(&filename)
            ),
        );
    }
    response_with_no_store(200, mime, content.as_bytes())
}

fn sandboxed_artifact_viewer(filename: &str, content: &str) -> Vec<u8> {
    let title = html_escape(filename);
    let srcdoc = html_escape(content);
    let body = format!(
        r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
html,body,iframe{{margin:0;width:100%;height:100%;border:0;background:white;}}
</style>
</head>
<body>
<iframe title="{title}" sandbox="allow-scripts allow-forms allow-popups allow-downloads" srcdoc="{srcdoc}"></iframe>
</body>
</html>"#
    );
    response_with_extra_headers(
        200,
        "text/html; charset=utf-8",
        body.as_bytes(),
        "Cache-Control: no-store, no-cache, must-revalidate\r\nContent-Security-Policy: default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'\r\n",
    )
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn serve_session_artifacts_zip(session: &SessionRecord) -> Vec<u8> {
    let mut artifacts = reconstruct_session_artifacts(session)
        .into_iter()
        .collect::<Vec<_>>();
    artifacts.sort_by(|left, right| left.0.cmp(&right.0));
    let zip = match build_store_zip(
        artifacts
            .iter()
            .map(|(name, content)| (name.as_str(), content.as_bytes())),
    ) {
        Ok(zip) => zip,
        Err(error) => return json_response(500, &serde_json::json!({ "error": error })),
    };
    response_with_extra_headers(
        200,
        "application/zip",
        &zip,
        &format!(
            "Content-Disposition: {}\r\nCache-Control: no-store, no-cache, must-revalidate\r\n",
            attachment_content_disposition(&format!("artifacts-{}.zip", session.id))
        ),
    )
}

fn build_store_zip<'a, I>(entries: I) -> Result<Vec<u8>, String>
where
    I: IntoIterator<Item = (&'a str, &'a [u8])>,
{
    let entries = entries.into_iter().collect::<Vec<_>>();
    if entries.len() > u16::MAX as usize {
        return Err("Too many artifacts to archive".to_string());
    }

    let mut output = Vec::new();
    let mut central_directory = Vec::new();
    for (name, content) in &entries {
        let name_bytes = name.as_bytes();
        if name_bytes.len() > u16::MAX as usize || content.len() > u32::MAX as usize {
            return Err("Artifact archive entry is too large".to_string());
        }
        let local_header_offset = output.len();
        if local_header_offset > u32::MAX as usize {
            return Err("Artifact archive is too large".to_string());
        }
        let crc = crc32(content);
        push_u32_le(&mut output, 0x0403_4b50);
        push_u16_le(&mut output, 20);
        push_u16_le(&mut output, 0);
        push_u16_le(&mut output, 0);
        push_u16_le(&mut output, 0);
        push_u16_le(&mut output, 0);
        push_u32_le(&mut output, crc);
        push_u32_le(&mut output, content.len() as u32);
        push_u32_le(&mut output, content.len() as u32);
        push_u16_le(&mut output, name_bytes.len() as u16);
        push_u16_le(&mut output, 0);
        output.extend_from_slice(name_bytes);
        output.extend_from_slice(content);

        push_u32_le(&mut central_directory, 0x0201_4b50);
        push_u16_le(&mut central_directory, 20);
        push_u16_le(&mut central_directory, 20);
        push_u16_le(&mut central_directory, 0);
        push_u16_le(&mut central_directory, 0);
        push_u16_le(&mut central_directory, 0);
        push_u16_le(&mut central_directory, 0);
        push_u32_le(&mut central_directory, crc);
        push_u32_le(&mut central_directory, content.len() as u32);
        push_u32_le(&mut central_directory, content.len() as u32);
        push_u16_le(&mut central_directory, name_bytes.len() as u16);
        push_u16_le(&mut central_directory, 0);
        push_u16_le(&mut central_directory, 0);
        push_u16_le(&mut central_directory, 0);
        push_u16_le(&mut central_directory, 0);
        push_u32_le(&mut central_directory, 0);
        push_u32_le(&mut central_directory, local_header_offset as u32);
        central_directory.extend_from_slice(name_bytes);
    }

    let central_directory_offset = output.len();
    let central_directory_size = central_directory.len();
    if central_directory_offset > u32::MAX as usize || central_directory_size > u32::MAX as usize {
        return Err("Artifact archive is too large".to_string());
    }
    output.extend_from_slice(&central_directory);
    push_u32_le(&mut output, 0x0605_4b50);
    push_u16_le(&mut output, 0);
    push_u16_le(&mut output, 0);
    push_u16_le(&mut output, entries.len() as u16);
    push_u16_le(&mut output, entries.len() as u16);
    push_u32_le(&mut output, central_directory_size as u32);
    push_u32_le(&mut output, central_directory_offset as u32);
    push_u16_le(&mut output, 0);
    Ok(output)
}

fn push_u16_le(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u32_le(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn attachment_content_disposition(filename: &str) -> String {
    let safe_filename = filename
        .chars()
        .map(|ch| match ch {
            '"' | '\\' | '\r' | '\n' => '_',
            _ => ch,
        })
        .collect::<String>();
    format!("attachment; filename=\"{safe_filename}\"")
}

fn reconstruct_session_artifacts(session: &SessionRecord) -> HashMap<String, String> {
    let mut artifacts = HashMap::new();
    for message in &session.messages {
        let Some(tools) = message.get("tools").and_then(Value::as_array) else {
            continue;
        };
        for tool in tools {
            if tool.get("name").and_then(Value::as_str) != Some("artifacts") {
                continue;
            }
            if tool.get("status").and_then(Value::as_str) != Some("completed") {
                continue;
            }
            if tool
                .get("result")
                .and_then(|result| result.get("isError"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let Some(args) = tool.get("args") else {
                continue;
            };
            let command = args.get("command").and_then(Value::as_str).unwrap_or("");
            let Some(filename) = args.get("filename").and_then(Value::as_str) else {
                continue;
            };
            match command {
                "create" | "rewrite" => {
                    artifacts.insert(
                        filename.to_string(),
                        args.get("content")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    );
                }
                "update" => {
                    if let (Some(current), Some(old), Some(new)) = (
                        artifacts.get_mut(filename),
                        args.get("old_str").and_then(Value::as_str),
                        args.get("new_str").and_then(Value::as_str),
                    ) {
                        *current = current.replacen(old, new, 1);
                    }
                }
                "delete" => {
                    artifacts.remove(filename);
                }
                _ => {}
            }
        }
    }
    artifacts
}

fn session_summary_value(session: &SessionRecord) -> Value {
    let mut value = serde_json::json!({
        "id": session.id,
        "title": session.title,
        "createdAt": session.created_at,
        "updatedAt": session.updated_at,
        "messageCount": session.message_count
    });
    if let Some(favorite) = session.favorite {
        value["favorite"] = Value::Bool(favorite);
    }
    if !session.tags.is_empty() {
        value["tags"] = serde_json::json!(session.tags);
    }
    value
}

fn session_full_value(session: &SessionRecord) -> Value {
    let mut value = session_summary_value(session);
    value["messages"] = Value::Array(
        session
            .messages
            .iter()
            .map(public_session_message)
            .collect(),
    );
    value
}

fn public_session_message(message: &Value) -> Value {
    let mut message = message.clone();
    if let Some(object) = message.as_object_mut() {
        if let Some(attachments) = object.get_mut("attachments").and_then(Value::as_array_mut) {
            for attachment in attachments {
                sanitize_attachment_for_read(attachment);
            }
        }
    }
    message
}

fn sanitize_attachment_for_read(attachment: &mut Value) {
    let Some(object) = attachment.as_object_mut() else {
        return;
    };
    let had_inline_content = object.remove("content").is_some()
        || object.remove("contentBase64").is_some()
        || object.remove("content_base64").is_some();
    if had_inline_content && !object.contains_key("contentOmitted") {
        object.insert("contentOmitted".to_string(), Value::Bool(true));
    }
}

fn new_session_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let counter = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("rust-session-{now}-{counter}")
}

fn pending_request_resume_value(request_id: &str, payload: &Value) -> Value {
    let kind = payload
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if payload.get("decision").is_some() {
                "approval"
            } else if payload.get("action").is_some() {
                "tool_retry"
            } else {
                "client_tool"
            }
        });
    let resolution = match kind {
        "approval" => payload
            .get("decision")
            .and_then(Value::as_str)
            .unwrap_or("approved"),
        "tool_retry" => match payload.get("action").and_then(Value::as_str) {
            Some("retry") => "retried",
            Some("skip") => "skipped",
            Some("abort") => "aborted",
            _ => "completed",
        },
        "user_input" => "answered",
        _ if payload
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false) =>
        {
            "failed"
        }
        _ => "completed",
    };
    let mut request = serde_json::json!({
        "id": request_id,
        "kind": kind,
        "resolution": resolution,
        "source": "local"
    });
    if let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) {
        request["sessionId"] = Value::String(session_id.to_string());
    }
    serde_json::json!({ "success": true, "request": request })
}

fn pending_tool_response_from_payload(payload: &Value) -> (bool, Option<ToolResult>) {
    if payload
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "approval")
        || payload.get("decision").is_some()
    {
        let decision = payload
            .get("decision")
            .and_then(Value::as_str)
            .unwrap_or("approved");
        return (!matches!(decision, "denied" | "rejected" | "abort"), None);
    }

    let output = payload
        .get("content")
        .map(|content| {
            content
                .as_str()
                .map(ToString::to_string)
                .unwrap_or_else(|| content.to_string())
        })
        .unwrap_or_default();
    if payload
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        (true, Some(ToolResult::failure(output)))
    } else {
        (true, Some(ToolResult::success(output)))
    }
}

async fn workspace_files(cwd: &Path) -> Vec<String> {
    if let Ok(output) = Command::new("rg")
        .arg("--files")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .await
    {
        if output.status.success() {
            let files = lines_from_output(&output.stdout);
            if !files.is_empty() {
                return files.into_iter().take(2000).collect();
            }
        }
    }

    if let Ok(output) = Command::new("git")
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .await
    {
        if output.status.success() {
            return lines_from_output(&output.stdout)
                .into_iter()
                .take(2000)
                .collect();
        }
    }

    if let Ok(output) = Command::new("find")
        .args([
            ".",
            "(",
            "-path",
            "./.git",
            "-o",
            "-path",
            "./node_modules",
            "-o",
            "-path",
            "./dist",
            "-o",
            "-path",
            "./target",
            ")",
            "-prune",
            "-o",
            "-type",
            "f",
            "-print",
        ])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .await
    {
        if output.status.success() {
            return lines_from_output(&output.stdout)
                .into_iter()
                .map(|file| file.trim_start_matches("./").to_string())
                .take(2000)
                .collect();
        }
    }

    Vec::new()
}

fn lines_from_output(output: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

async fn command_catalog(cwd: &Path) -> Vec<Value> {
    let mut commands = Vec::new();
    for dir in [
        maestro_home().join("commands"),
        cwd.join(".maestro/commands"),
    ] {
        let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = tokio::fs::read_to_string(&path).await else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if value.get("name").and_then(Value::as_str).is_none()
                || value.get("prompt").and_then(Value::as_str).is_none()
            {
                continue;
            }
            commands.push(serde_json::json!({
                "name": value.get("name").cloned().unwrap_or(Value::Null),
                "description": value.get("description").cloned(),
                "prompt": value.get("prompt").cloned().unwrap_or(Value::Null),
                "args": value.get("args").cloned().unwrap_or_else(|| serde_json::json!([]))
            }));
        }
    }
    commands
}

fn maestro_home() -> PathBuf {
    env::var("MAESTRO_HOME")
        .map(PathBuf::from)
        .or_else(|_| env::var("HOME").map(|home| PathBuf::from(home).join(".maestro")))
        .unwrap_or_else(|_| PathBuf::from(".maestro"))
}

fn agent_dir() -> PathBuf {
    env::var("MAESTRO_AGENT_DIR")
        .or_else(|_| env::var("PLAYWRIGHT_AGENT_DIR"))
        .or_else(|_| env::var("CODING_AGENT_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| maestro_home().join("agent"))
}

fn model_config_path() -> String {
    env::var("MAESTRO_MODELS_FILE").unwrap_or_else(|_| {
        maestro_home()
            .join("models.json")
            .to_string_lossy()
            .to_string()
    })
}

fn command_prefs_path() -> PathBuf {
    env::var("MAESTRO_COMMAND_PREFS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| agent_dir().join("command-prefs.json"))
}

fn default_session_store_path(cwd: &Path) -> PathBuf {
    if let Ok(state_dir) = env::var("MAESTRO_STATE_DIR") {
        return PathBuf::from(state_dir).join("sessions.json");
    }
    if cwd == Path::new("/app") {
        return env::temp_dir().join("maestro/sessions.json");
    }
    PathBuf::from(".maestro/sessions.json")
}

fn usage_file_path() -> PathBuf {
    env::var("MAESTRO_USAGE_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| maestro_home().join("usage.json"))
}

fn a2a_tasks_file_path() -> PathBuf {
    env::var("MAESTRO_A2A_TASKS_FILE")
        .or_else(|_| env::var("CODEX_A2A_TASKS_FILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| maestro_home().join("a2a/tasks.json"))
}

async fn read_json_value(path: &str) -> Option<Value> {
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str(&raw).ok()
}

fn contains_forbidden_json_key(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| {
            matches!(key.as_str(), "__proto__" | "constructor" | "prototype")
                || contains_forbidden_json_key(value)
        }),
        Value::Array(values) => values.iter().any(contains_forbidden_json_key),
        _ => false,
    }
}

async fn load_command_prefs(path: &Path) -> CommandPrefs {
    let Ok(raw) = tokio::fs::read_to_string(path).await else {
        return CommandPrefs::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

async fn persist_command_prefs(path: &Path, prefs: &CommandPrefs) {
    if let Some(parent) = path.parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return;
        }
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(prefs) {
        let _ = tokio::fs::write(path, bytes).await;
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageEntry {
    #[serde(default)]
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    tokens_input: u64,
    #[serde(default)]
    tokens_output: u64,
    #[serde(default)]
    tokens_cache_read: u64,
    #[serde(default)]
    tokens_cache_write: u64,
    #[serde(default)]
    cost: f64,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageTokenTotals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageBucket {
    cost: f64,
    requests: u64,
    tokens: u64,
    tokens_detailed: UsageTokenTotals,
    calls: u64,
    cached_tokens: u64,
}

async fn load_usage_entries(path: &Path) -> Vec<UsageEntry> {
    let Ok(raw) = tokio::fs::read_to_string(path).await else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

async fn usage_snapshot(path: &Path) -> Value {
    let entries = load_usage_entries(path).await;
    let mut total_cost = 0.0;
    let mut totals = UsageTokenTotals::default();
    let mut by_provider: HashMap<String, UsageBucket> = HashMap::new();
    let mut by_model: HashMap<String, UsageBucket> = HashMap::new();

    for entry in &entries {
        let tokens = entry.tokens_input
            + entry.tokens_output
            + entry.tokens_cache_read
            + entry.tokens_cache_write;
        total_cost += entry.cost;
        totals.input += entry.tokens_input;
        totals.output += entry.tokens_output;
        totals.cache_read += entry.tokens_cache_read;
        totals.cache_write += entry.tokens_cache_write;
        totals.total += tokens;

        let provider = if entry.provider.is_empty() {
            "unknown"
        } else {
            &entry.provider
        };
        let provider_bucket = by_provider.entry(provider.to_string()).or_default();
        add_usage_to_bucket(provider_bucket, entry.cost, tokens, entry);

        let model = if entry.model.is_empty() {
            "unknown"
        } else {
            &entry.model
        };
        let model_bucket = by_model.entry(format!("{provider}/{model}")).or_default();
        add_usage_to_bucket(model_bucket, entry.cost, tokens, entry);
    }

    serde_json::json!({
        "summary": {
            "totalCost": total_cost,
            "totalRequests": entries.len(),
            "totalTokens": totals.total,
            "tokensDetailed": totals,
            "totalTokensDetailed": totals,
            "totalTokensBreakdown": totals,
            "totalCachedTokens": totals.cache_read + totals.cache_write,
            "byProvider": by_provider,
            "byModel": by_model
        },
        "hasData": !entries.is_empty()
    })
}

fn add_usage_to_bucket(bucket: &mut UsageBucket, cost: f64, tokens: u64, entry: &UsageEntry) {
    bucket.cost += cost;
    bucket.requests += 1;
    bucket.tokens += tokens;
    bucket.calls += 1;
    bucket.cached_tokens += entry.tokens_cache_read + entry.tokens_cache_write;
    bucket.tokens_detailed.input += entry.tokens_input;
    bucket.tokens_detailed.output += entry.tokens_output;
    bucket.tokens_detailed.cache_read += entry.tokens_cache_read;
    bucket.tokens_detailed.cache_write += entry.tokens_cache_write;
    bucket.tokens_detailed.total += tokens;
}

async fn package_scripts(cwd: &Path) -> Vec<String> {
    let mut scripts: Vec<String> = package_script_map(cwd).await.into_keys().collect();
    scripts.sort();
    scripts
}

async fn package_script_map(cwd: &Path) -> HashMap<String, String> {
    let package_json = cwd.join("package.json");
    let Some(value) = read_json_value(&package_json.to_string_lossy()).await else {
        return HashMap::new();
    };
    value
        .get("scripts")
        .and_then(Value::as_object)
        .map(|scripts| {
            scripts
                .iter()
                .filter_map(|(name, command)| {
                    command
                        .as_str()
                        .map(|command| (name.to_string(), command.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunScriptRequest {
    script: String,
    args: Option<String>,
}

async fn run_script_response(cwd: &Path, request: RunScriptRequest) -> Vec<u8> {
    let script = request.script.trim();
    if script.is_empty() {
        return json_response(
            400,
            &serde_json::json!({ "error": "Script name is required" }),
        );
    }
    if !is_valid_script_name(script) {
        return json_response(
            400,
            &serde_json::json!({ "error": "Invalid script name format" }),
        );
    }

    let available_scripts = package_script_map(cwd).await;
    if !available_scripts.contains_key(script) {
        let mut available: Vec<String> = available_scripts.keys().cloned().collect();
        available.sort();
        return json_response(
            400,
            &serde_json::json!({
                "error": format!("Script \"{script}\" not found in package.json"),
                "available": available,
            }),
        );
    }

    let args = request.args.unwrap_or_default();
    if contains_shell_metachars(&args) {
        return json_response(
            400,
            &serde_json::json!({
                "error": "Arguments contain invalid characters. Shell metacharacters are not allowed."
            }),
        );
    }

    let Some(runner) = script_runner_command().await else {
        return json_response(
            503,
            &serde_json::json!({
                "error": "No JavaScript package runner is available for /api/run. Install bun or npm, or set MAESTRO_SCRIPT_RUNNER."
            }),
        );
    };

    let args = args.trim();
    let mut command = Command::new(&runner);
    command.arg("run").arg(script);
    if !args.is_empty() {
        command.arg("--");
        command.args(args.split_whitespace());
    }

    match command.current_dir(cwd).stdin(Stdio::null()).output().await {
        Ok(output) => json_response(
            200,
            &serde_json::json!({
                "success": output.status.success(),
                "exitCode": output.status.code().unwrap_or(1),
                "stdout": String::from_utf8_lossy(&output.stdout),
                "stderr": String::from_utf8_lossy(&output.stderr),
                "command": script_run_display(&runner, script, args),
            }),
        ),
        Err(error) => json_response(
            500,
            &serde_json::json!({ "error": format!("failed to run script: {error}") }),
        ),
    }
}

async fn approval_mode_response(head: &RequestHead, state: &AppState) -> Vec<u8> {
    let session_id = approval_session_id(head);
    let mode = state
        .approval_modes
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .unwrap_or_else(default_approval_mode);
    json_response(
        200,
        &serde_json::json!({
            "mode": mode,
            "availableModes": ["auto", "prompt", "fail"]
        }),
    )
}

async fn set_approval_mode_response(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
) -> Vec<u8> {
    let body = match read_request_body(stream, initial, head).await {
        Ok(body) => body,
        Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
    };
    let payload = if body.is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(value) if value.is_object() => value,
            Ok(_) => {
                return json_response(
                    400,
                    &serde_json::json!({ "error": "approval payload must be an object" }),
                );
            }
            Err(error) => {
                return json_response(
                    400,
                    &serde_json::json!({ "error": format!("invalid approval request: {error}") }),
                );
            }
        }
    };
    let Some(mode) = payload
        .get("mode")
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "auto" | "prompt" | "fail"))
    else {
        return json_response(
            400,
            &serde_json::json!({ "error": "mode must be auto, prompt, or fail" }),
        );
    };
    let session_id = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| approval_session_id(head));
    state
        .approval_modes
        .lock()
        .await
        .insert(session_id, mode.to_string());
    json_response(
        200,
        &serde_json::json!({
            "success": true,
            "mode": mode,
            "message": format!("Approval mode set to {mode}")
        }),
    )
}

fn approval_session_id(head: &RequestHead) -> String {
    head.query
        .get("sessionId")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| "default".to_string())
}

fn default_approval_mode() -> String {
    env::var("MAESTRO_APPROVAL_MODE")
        .ok()
        .filter(|mode| matches!(mode.as_str(), "auto" | "prompt" | "fail"))
        .unwrap_or_else(|| "prompt".to_string())
}

async fn approval_mode_for_session(state: &AppState, session_id: Option<&str>) -> String {
    let key = session_id.unwrap_or("default");
    state
        .approval_modes
        .lock()
        .await
        .get(key)
        .cloned()
        .unwrap_or_else(default_approval_mode)
}

async fn script_runner_command() -> Option<String> {
    if let Ok(runner) = env::var("MAESTRO_SCRIPT_RUNNER") {
        let runner = runner.trim();
        if !runner.is_empty() {
            return Some(runner.to_string());
        }
    }
    for candidate in ["bun", "npm"] {
        if executable_on_path(candidate).await {
            return Some(candidate.to_string());
        }
    }
    None
}

async fn executable_on_path(name: &str) -> bool {
    Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {name} >/dev/null 2>&1"))
        .stdin(Stdio::null())
        .output()
        .await
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn script_run_display(runner: &str, script: &str, args: &str) -> String {
    if args.is_empty() {
        format!("{runner} run {script}")
    } else {
        format!("{runner} run {script} -- {args}")
    }
}

fn is_valid_script_name(script: &str) -> bool {
    script.len() <= 100
        && !script.is_empty()
        && script
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':' | '.' | '-'))
}

fn contains_shell_metachars(value: &str) -> bool {
    value.chars().any(|ch| {
        matches!(
            ch,
            ';' | '&'
                | '|'
                | '`'
                | '$'
                | '('
                | ')'
                | '{'
                | '}'
                | '['
                | ']'
                | '<'
                | '>'
                | '\\'
                | '!'
                | '#'
                | '*'
                | '?'
                | '"'
                | '\''
                | '\n'
                | '\r'
                | '\t'
        )
    })
}

fn background_response(head: &RequestHead, settings: &BackgroundSettings) -> Value {
    match head.query.get("action").map(String::as_str) {
        Some("history") => serde_json::json!({ "history": [], "truncated": false }),
        Some("path") => serde_json::json!({
            "path": maestro_home().join("background-tasks.jsonl").to_string_lossy(),
            "exists": false,
            "overridden": env::var("MAESTRO_BACKGROUND_TASKS_FILE").is_ok()
        }),
        _ => serde_json::json!({
            "settings": settings,
            "snapshot": {
                "running": 0,
                "total": 0,
                "failed": 0,
                "detailsRedacted": true
            }
        }),
    }
}

async fn update_background_response(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
) -> Vec<u8> {
    let action = match head.query.get("action").map(String::as_str) {
        Some("notify") => "notify",
        Some("details") => "details",
        Some(action) => {
            return json_response(
                400,
                &serde_json::json!({ "error": format!("unsupported background action \"{action}\"") }),
            );
        }
        None => {
            return json_response(
                400,
                &serde_json::json!({ "error": "background action is required" }),
            );
        }
    };
    let body = match read_request_body(stream, initial, head).await {
        Ok(body) => body,
        Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
    };
    let request = match serde_json::from_slice::<BackgroundUpdateRequest>(&body) {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                400,
                &serde_json::json!({ "error": format!("invalid background update request: {error}") }),
            );
        }
    };

    let mut settings = state.background_settings.lock().await;
    let message = match action {
        "notify" => {
            settings.notifications_enabled = request.enabled;
            format!(
                "Background task notifications {}.",
                if request.enabled {
                    "enabled"
                } else {
                    "disabled"
                }
            )
        }
        "details" => {
            settings.status_details_enabled = request.enabled;
            format!(
                "Background task details {}.",
                if request.enabled {
                    "enabled"
                } else {
                    "disabled"
                }
            )
        }
        _ => unreachable!("background action was validated"),
    };
    json_response(
        200,
        &serde_json::json!({ "success": true, "message": message }),
    )
}

fn undo_response(head: &RequestHead) -> Value {
    match head.query.get("action").map(String::as_str) {
        Some("history") => serde_json::json!({ "history": [] }),
        _ => serde_json::json!({
            "totalChanges": 0,
            "canUndo": false,
            "checkpoints": []
        }),
    }
}

async fn changes_snapshot(cwd: &Path) -> Value {
    let output = run_git(cwd, &["status", "--porcelain"])
        .await
        .unwrap_or_default();
    let files: Vec<Value> = output
        .lines()
        .filter(|line| line.len() > 3)
        .map(|line| {
            serde_json::json!({
                "path": line[3..].trim(),
                "status": line[..2].trim()
            })
        })
        .collect();
    let total = files.len();
    serde_json::json!({ "files": files, "tools": [], "total": total })
}

struct FrameworkInfo {
    id: &'static str,
    summary: &'static str,
}

const FRAMEWORKS: &[FrameworkInfo] = &[
    FrameworkInfo {
        id: "express",
        summary: "Preferred framework: Express.js on Node 20. Use TypeScript, zod for validation, vitest, and supertest for HTTP tests.",
    },
    FrameworkInfo {
        id: "fastapi",
        summary: "Preferred framework: FastAPI on Python 3.12. Use pydantic v2, uvicorn, pytest, httpx for tests, and typed routers.",
    },
    FrameworkInfo {
        id: "node",
        summary: "Preferred framework: Generic Node.js on TypeScript/Node 20. Use zod for validation, vitest for unit tests, supertest for HTTP, and eslint/biome for linting.",
    },
];

fn framework_response(head: &RequestHead, current: Option<&str>) -> Value {
    match head.query.get("action").map(String::as_str) {
        Some("list") => serde_json::json!({
            "frameworks": FRAMEWORKS
                .iter()
                .map(|info| serde_json::json!({ "id": info.id, "summary": info.summary }))
                .collect::<Vec<_>>()
        }),
        _ => serde_json::json!({
            "framework": current.unwrap_or("none"),
            "source": "rust-control-plane",
            "locked": false,
            "scope": framework_scope(head.query.get("scope").map(String::as_str).unwrap_or("user")).unwrap_or("user")
        }),
    }
}

async fn update_framework_response(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
) -> Vec<u8> {
    let body = match read_request_body(stream, initial, head).await {
        Ok(body) => body,
        Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
    };
    let request = match serde_json::from_slice::<FrameworkUpdateRequest>(&body) {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                400,
                &serde_json::json!({ "error": format!("invalid framework update request: {error}") }),
            );
        }
    };
    let scope = match request.scope.as_deref().map(framework_scope).transpose() {
        Ok(scope) => scope.unwrap_or("user"),
        Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
    };
    let Some(raw_framework) = request.framework else {
        return json_response(
            400,
            &serde_json::json!({ "error": "framework is required" }),
        );
    };
    let normalized = raw_framework.and_then(normalize_framework_id);
    if normalized.is_none() {
        *state.framework_preference.lock().await = None;
        return json_response(
            200,
            &serde_json::json!({
                "success": true,
                "message": format!("Default framework cleared for {scope} scope"),
                "framework": Value::Null,
                "scope": scope
            }),
        );
    }
    let framework = normalized.expect("framework none case returned");
    let Some(info) = framework_info(&framework) else {
        let available = FRAMEWORKS
            .iter()
            .map(|info| info.id)
            .collect::<Vec<_>>()
            .join(", ");
        return json_response(
            400,
            &serde_json::json!({ "error": format!("Unknown framework \"{framework}\". Available options: {available}") }),
        );
    };
    *state.framework_preference.lock().await = Some(info.id.to_string());
    json_response(
        200,
        &serde_json::json!({
            "success": true,
            "framework": info.id,
            "summary": info.summary,
            "scope": scope,
            "message": format!("{} (scope: {scope})", info.summary)
        }),
    )
}

fn framework_scope(scope: &str) -> Result<&'static str, String> {
    match scope {
        "user" => Ok("user"),
        "workspace" => Ok("workspace"),
        other => Err(format!("unsupported framework scope \"{other}\"")),
    }
}

fn normalize_framework_id(value: String) -> Option<String> {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() || matches!(normalized.as_str(), "none" | "off") {
        None
    } else {
        Some(normalized)
    }
}

fn framework_info(id: &str) -> Option<&'static FrameworkInfo> {
    FRAMEWORKS.iter().find(|info| info.id == id)
}

fn telemetry_status(override_value: Option<bool>) -> Value {
    let flag = env::var("MAESTRO_TELEMETRY")
        .or_else(|_| env::var("PLAYWRIGHT_TELEMETRY"))
        .ok();
    let endpoint = env::var("MAESTRO_TELEMETRY_ENDPOINT")
        .or_else(|_| env::var("PLAYWRIGHT_TELEMETRY_ENDPOINT"))
        .ok();
    let file_path = env::var("MAESTRO_TELEMETRY_FILE")
        .or_else(|_| env::var("PLAYWRIGHT_TELEMETRY_FILE"))
        .unwrap_or_else(|_| {
            maestro_home()
                .join("telemetry.jsonl")
                .to_string_lossy()
                .to_string()
        });
    let file_configured =
        env::var("MAESTRO_TELEMETRY_FILE").is_ok() || env::var("PLAYWRIGHT_TELEMETRY_FILE").is_ok();
    let enabled = telemetry_enabled(
        override_value,
        flag.as_deref(),
        endpoint.is_some(),
        file_configured,
    );
    serde_json::json!({
        "enabled": enabled,
        "reason": if override_value.is_some() { "runtime override" } else if enabled { "configured" } else { "disabled" },
        "endpoint": endpoint,
        "filePath": file_path,
        "sampleRate": 1,
        "flagValue": flag,
        "runtimeOverride": override_value.map(|enabled| if enabled { "enabled" } else { "disabled" })
    })
}

fn telemetry_enabled(
    override_value: Option<bool>,
    flag: Option<&str>,
    endpoint_configured: bool,
    file_configured: bool,
) -> bool {
    override_value
        .or_else(|| parse_bool_flag(flag))
        .unwrap_or(endpoint_configured || file_configured)
}

fn training_status(override_value: Option<bool>) -> Value {
    let flag = env::var("MAESTRO_TRAINING_OPT_OUT").ok();
    let opt_out = override_value.or_else(|| parse_bool_flag(flag.as_deref()));
    let preference = match opt_out {
        Some(true) => "opted-out",
        Some(false) => "opted-in",
        None => "provider-default",
    };
    serde_json::json!({
        "preference": preference,
        "optOut": opt_out,
        "reason": if override_value.is_some() { "runtime override" } else if flag.is_some() { "MAESTRO_TRAINING_OPT_OUT" } else { "provider default" },
        "flagValue": flag,
        "runtimeOverride": override_value.map(|opt_out| if opt_out { "opted-out" } else { "opted-in" })
    })
}

fn parse_bool_flag(value: Option<&str>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

async fn read_required_action(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    valid_actions: &[&str],
) -> Result<String, Vec<u8>> {
    let body = read_request_body(stream, initial, head)
        .await
        .map_err(|error| json_response(400, &serde_json::json!({ "error": error })))?;
    parse_action_body(&body, valid_actions)
        .map_err(|error| json_response(400, &serde_json::json!({ "error": error })))
}

fn parse_action_body(body: &[u8], valid_actions: &[&str]) -> Result<String, String> {
    let payload = serde_json::from_slice::<Value>(body)
        .map_err(|error| format!("invalid action request: {error}"))?;
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|action| !action.is_empty())
        .ok_or_else(|| "action is required".to_string())?;
    if !valid_actions.contains(&action) {
        return Err(format!(
            "invalid action \"{action}\". Expected one of: {}",
            valid_actions.join(", ")
        ));
    }
    Ok(action.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    model: Option<String>,
    messages: Vec<ChatMessage>,
    thinking_level: Option<String>,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    role: String,
    content: Value,
    #[serde(default)]
    attachments: Vec<ChatAttachment>,
    #[serde(default, flatten)]
    extra: Map<String, Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatAttachment {
    id: Option<String>,
    #[serde(rename = "type")]
    attachment_type: Option<String>,
    file_name: Option<String>,
    mime_type: Option<String>,
    content: Option<String>,
    content_omitted: Option<bool>,
    extracted_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractAttachmentRequest {
    file_name: String,
    mime_type: Option<String>,
    content_base64: String,
    max_chars: Option<usize>,
}

struct ExtractDocumentOutput {
    file_name: String,
    format: String,
    size_bytes: usize,
    truncated: bool,
    extracted_text: String,
}

struct PreparedAttachments {
    paths: Vec<String>,
    temp_dir: Option<PathBuf>,
}

impl Drop for PreparedAttachments {
    fn drop(&mut self) {
        if let Some(temp_dir) = self.temp_dir.take() {
            let _ = std::fs::remove_dir_all(temp_dir);
        }
    }
}

async fn selected_chat_model(chat: &ChatRequest, state: &AppState) -> String {
    if let Some(model) = chat
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        return model.to_string();
    }
    let selected = state.selected_model.lock().await;
    format!("{}/{}", selected.provider, selected.id)
}

fn codex_app_server_model_id(model: &str) -> Option<String> {
    let trimmed = model.trim();
    let (provider, model_id) = trimmed.split_once('/')?;
    if provider != "openai-codex" {
        return None;
    }
    let model_id = model_id.trim();
    (!model_id.is_empty()).then(|| model_id.to_string())
}

async fn usage_provider_model(
    chat: &ChatRequest,
    state: &AppState,
    agent_model: &str,
) -> (String, String) {
    if chat
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .is_none()
    {
        let selected = state.selected_model.lock().await;
        return (selected.provider.clone(), selected.id.clone());
    }

    if let Some((provider, model)) = agent_model.split_once('/') {
        return (provider.to_string(), model.to_string());
    }

    let registry = available_models(&state.config).await;
    resolve_model(agent_model, &registry)
        .map(|model| (model.provider, model.id))
        .unwrap_or_else(|| ("unknown".to_string(), agent_model.to_string()))
}

async fn record_usage_entry(
    state: &AppState,
    session_id: Option<&str>,
    provider: &str,
    model: &str,
    usage: Option<&TokenUsage>,
) {
    let Some(usage) = usage else {
        return;
    };
    let _persist = state.usage_persist_lock.lock().await;
    let path = &state.config.usage_file_path;
    let mut entries = tokio::fs::read_to_string(path)
        .await
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let mut entry = serde_json::json!({
        "timestamp": now_millis(),
        "provider": provider,
        "model": model,
        "tokensInput": usage.input_tokens,
        "tokensOutput": usage.output_tokens,
        "tokensCacheRead": usage.cache_read_tokens,
        "tokensCacheWrite": usage.cache_write_tokens,
        "cost": usage.cost.unwrap_or(0.0)
    });
    if let Some(session_id) = session_id {
        entry["sessionId"] = Value::String(session_id.to_string());
    }
    entries.push(entry);
    if entries.len() > 10_000 {
        entries.drain(..entries.len() - 10_000);
    }
    if let Some(parent) = path.parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return;
        }
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&entries) {
        let _ = tokio::fs::write(path, bytes).await;
    }
}

fn codex_app_server_cli_path() -> PathBuf {
    env::var("MAESTRO_CODEX_APP_SERVER_CLI")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let start_dir = env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
            codex_app_server_cli_path_from_start_dir(&start_dir)
        })
}

fn codex_app_server_cli_path_from_start_dir(start_dir: &Path) -> PathBuf {
    let mut package_root_candidate = None;
    for dir in start_dir.ancestors() {
        let cli_path = dir.join("dist/cli.js");
        if cli_path.exists() {
            return cli_path;
        }
        if package_root_candidate.is_none() && dir.join("package.json").exists() {
            package_root_candidate = Some(cli_path);
        }
    }
    package_root_candidate.unwrap_or_else(|| start_dir.join("dist/cli.js"))
}

fn codex_app_server_timeout() -> Duration {
    Duration::from_millis(
        env::var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(240_000),
    )
}

fn codex_app_server_shutdown_timeout() -> Duration {
    Duration::from_millis(
        env::var("MAESTRO_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1_000),
    )
}

fn codex_app_server_sandbox_mode() -> Option<String> {
    let bridge_override = env::var("MAESTRO_CODEX_APP_SERVER_SANDBOX").ok();
    let inherited = env::var("MAESTRO_SANDBOX_MODE").ok();
    codex_app_server_sandbox_mode_from_values(bridge_override.as_deref(), inherited.as_deref())
}

fn codex_app_server_sandbox_mode_from_values(
    bridge_override: Option<&str>,
    inherited: Option<&str>,
) -> Option<String> {
    bridge_override
        .or(inherited)
        .map(str::trim)
        .filter(|mode| !mode.is_empty())
        .filter(|mode| !matches!(*mode, "default" | "inherit"))
        .map(str::to_string)
}

fn codex_app_server_approval_mode(session_mode: &str) -> &'static str {
    match session_mode {
        "auto" => "auto",
        "fail" => "fail",
        _ => "prompt",
    }
}

fn truncate_command_output(text: &str) -> String {
    const MAX_ERROR_CHARS: usize = 4_000;
    if text.chars().count() <= MAX_ERROR_CHARS {
        return text.to_string();
    }
    let truncated = text.chars().take(MAX_ERROR_CHARS).collect::<String>();
    format!("{truncated}\n... truncated ...")
}

#[derive(Clone)]
struct CodexBridgeOutput {
    text: String,
    usage: Option<TokenUsage>,
    tool_events: Vec<CodexBridgeToolEvent>,
}

#[derive(Clone)]
struct CodexBridgeToolEvent {
    event_type: &'static str,
    tool_call_id: String,
    tool_name: String,
    display_name: Option<String>,
    summary_label: Option<String>,
    args: Value,
    result: Value,
    is_error: Option<bool>,
}

#[derive(Clone)]
struct CodexBridgeToolContext {
    tool_name: String,
    display_name: Option<String>,
    summary_label: Option<String>,
    args: Value,
}

fn assistant_output_from_jsonl(stdout: &str) -> Result<CodexBridgeOutput, String> {
    let mut current_role: Option<String> = None;
    let mut assistant_text: Option<String> = None;
    let mut assistant_stop_reason: Option<String> = None;
    let mut assistant_usage: Option<TokenUsage> = None;
    let mut tool_events = Vec::new();
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(tool_event) = codex_jsonl_tool_event_from_json(&event) {
            tool_events.push(tool_event);
            continue;
        }
        if event.get("type").and_then(Value::as_str) == Some("turn") {
            if event.get("phase").and_then(Value::as_str) == Some("start") {
                current_role = event
                    .get("role")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            } else if event.get("phase").and_then(Value::as_str) == Some("end")
                && event.get("role").and_then(Value::as_str) == Some("assistant")
            {
                current_role = None;
            }
            continue;
        }
        if current_role.as_deref() != Some("assistant") {
            continue;
        }
        if event.get("type").and_then(Value::as_str) == Some("item")
            && event.get("subtype").and_then(Value::as_str) == Some("message_complete")
        {
            if let Some(stop_reason) = event
                .get("data")
                .and_then(|data| data.get("stopReason"))
                .and_then(Value::as_str)
            {
                assistant_stop_reason = Some(stop_reason.to_string());
            }
            if let Some(usage) = event
                .get("data")
                .and_then(|data| data.get("usage"))
                .and_then(codex_usage_from_json)
            {
                assistant_usage = Some(usage);
            }
            if let Some(text) = event
                .get("data")
                .and_then(|data| data.get("text"))
                .and_then(Value::as_str)
            {
                assistant_text = Some(text.to_string());
            }
        }
    }
    if assistant_stop_reason.as_deref() == Some("error") {
        return Err("Codex app-server bridge returned an error stop reason".to_string());
    }
    let text = assistant_text.ok_or_else(|| {
        "Codex app-server bridge completed without an assistant message".to_string()
    })?;
    if text.trim().is_empty() {
        return Err("Codex app-server bridge returned an empty assistant message".to_string());
    }
    Ok(CodexBridgeOutput {
        text,
        usage: assistant_usage,
        tool_events,
    })
}

#[cfg(test)]
fn assistant_text_from_jsonl(stdout: &str) -> Result<String, String> {
    assistant_output_from_jsonl(stdout).map(|output| output.text)
}

fn codex_jsonl_tool_event_from_json(event: &Value) -> Option<CodexBridgeToolEvent> {
    match event.get("type").and_then(Value::as_str)? {
        "item" => match event.get("subtype").and_then(Value::as_str)? {
            "tool_call" => {
                let data = event.get("data")?;
                let tool_call_id = data
                    .get("toolCallId")
                    .or_else(|| data.get("tool_call_id"))
                    .and_then(Value::as_str)?;
                let tool_name = data
                    .get("toolName")
                    .or_else(|| data.get("tool_name"))
                    .and_then(Value::as_str)?;
                let args = data
                    .get("args")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new()));
                Some(codex_bridge_tool_start_event(tool_call_id, tool_name, args))
            }
            "tool_result" => {
                let data = event.get("data")?;
                let tool_call_id = data
                    .get("toolCallId")
                    .or_else(|| data.get("tool_call_id"))
                    .and_then(Value::as_str)?;
                let tool_name = data
                    .get("toolName")
                    .or_else(|| data.get("tool_name"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let result = data.get("result").cloned().unwrap_or_else(|| {
                    codex_bridge_tool_result(tool_call_id, tool_name, false, None)
                });
                let is_error = data
                    .get("isError")
                    .or_else(|| data.get("is_error"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Some(codex_bridge_tool_end_event(
                    tool_call_id,
                    tool_name,
                    result,
                    is_error,
                ))
            }
            _ => None,
        },
        "item.started" => {
            let item = event.get("item")?;
            codex_collab_tool_event_from_jsonl_item(item, false)
        }
        "item.completed" => {
            let item = event.get("item")?;
            codex_collab_tool_event_from_jsonl_item(item, true)
        }
        _ => None,
    }
}

fn codex_headless_tool_event_from_json(event: &Value) -> Option<CodexBridgeToolEvent> {
    match event.get("type").and_then(Value::as_str)? {
        "tool_call" => {
            let tool_call_id = event.get("call_id").and_then(Value::as_str)?;
            let tool_name =
                canonical_codex_bridge_tool_name(event.get("tool").and_then(Value::as_str)?);
            let args = event
                .get("args")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            Some(codex_bridge_tool_start_event(
                tool_call_id,
                &tool_name,
                args,
            ))
        }
        "tool_end" => {
            let tool_call_id = event.get("call_id").and_then(Value::as_str)?;
            let tool_name = canonical_codex_bridge_tool_name(
                event.get("tool").and_then(Value::as_str).unwrap_or("tool"),
            );
            let success = event
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let details = codex_headless_tool_end_details(event);
            Some(codex_bridge_tool_end_event(
                tool_call_id,
                &tool_name,
                codex_bridge_tool_result(tool_call_id, &tool_name, success, Some(details)),
                !success,
            ))
        }
        _ => None,
    }
}

fn codex_headless_tool_event_from_json_with_context(
    event: &Value,
    contexts: &mut HashMap<String, CodexBridgeToolContext>,
) -> Option<CodexBridgeToolEvent> {
    let event_type = event.get("type").and_then(Value::as_str)?;
    if event_type == "tool_call" {
        let tool_event = codex_headless_tool_event_from_json(event)?;
        contexts.insert(
            tool_event.tool_call_id.clone(),
            CodexBridgeToolContext {
                tool_name: tool_event.tool_name.clone(),
                display_name: tool_event.display_name.clone(),
                summary_label: tool_event.summary_label.clone(),
                args: tool_event.args.clone(),
            },
        );
        return Some(tool_event);
    }
    if event_type != "tool_end" {
        return None;
    }
    let tool_call_id = event.get("call_id").and_then(Value::as_str)?;
    let context = contexts.remove(tool_call_id);
    let mut tool_event = codex_headless_tool_event_from_json(event)?;
    if let Some(context) = context {
        tool_event.tool_name = context.tool_name;
        tool_event.display_name = context.display_name;
        tool_event.summary_label = context.summary_label;
        tool_event.args = context.args;
        let success = !tool_event.is_error.unwrap_or(true);
        let mut details = codex_headless_tool_end_details(event);
        if let Some(object) = details.as_object_mut() {
            object.insert("args".to_string(), tool_event.args.clone());
        }
        tool_event.result = codex_bridge_tool_result(
            &tool_event.tool_call_id,
            &tool_event.tool_name,
            success,
            Some(details),
        );
    }
    Some(tool_event)
}

fn codex_collab_tool_event_from_jsonl_item(
    item: &Value,
    completed: bool,
) -> Option<CodexBridgeToolEvent> {
    if item.get("type").and_then(Value::as_str) != Some("collab_tool_call") {
        return None;
    }
    let tool_call_id = item.get("id").and_then(Value::as_str)?;
    let tool = item.get("tool").and_then(Value::as_str)?;
    let canonical_tool = codex_canonical_collab_tool(tool);
    let tool_name = format!("codex.subagent.{canonical_tool}");
    let args = codex_collab_args_from_jsonl_item(item, &canonical_tool);
    if !completed {
        return Some(codex_bridge_tool_start_event(
            tool_call_id,
            &tool_name,
            args,
        ));
    }
    let is_error = item
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "failed");
    let result = codex_bridge_tool_result(tool_call_id, &tool_name, !is_error, Some(args.clone()));
    Some(codex_bridge_tool_end_event(
        tool_call_id,
        &tool_name,
        result,
        is_error,
    ))
}

fn codex_collab_args_from_jsonl_item(item: &Value, canonical_tool: &str) -> Value {
    let child_run_ids = codex_collab_child_run_ids_from_item(item);
    let codex_work_graph =
        codex_collab_work_graph_from_jsonl_item(item, canonical_tool, &child_run_ids);
    serde_json::json!({
        "codexTool": canonical_tool,
        "status": item.get("status").cloned().unwrap_or(Value::Null),
        "senderThreadId": item.get("sender_thread_id").cloned().unwrap_or(Value::Null),
        "receiverThreadIds": item.get("receiver_thread_ids").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "childRunIds": child_run_ids,
        "codexWorkGraph": codex_work_graph,
        "prompt": item.get("prompt").cloned().unwrap_or(Value::Null),
        "model": item.get("model").cloned().unwrap_or(Value::Null),
        "reasoningEffort": item.get("reasoning_effort").cloned().unwrap_or(Value::Null),
        "agentsStates": item.get("agents_states").cloned().unwrap_or_else(|| Value::Object(Map::new()))
    })
}

fn codex_collab_child_run_ids_from_item(item: &Value) -> Value {
    for key in ["child_run_ids", "childRunIds"] {
        if let Some(ids) = item.get(key).and_then(Value::as_array) {
            let child_run_ids = ids
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(|id| Value::String(id.to_string()))
                .collect::<Vec<_>>();
            if !child_run_ids.is_empty() {
                return Value::Array(child_run_ids);
            }
        }
    }

    let child_run_ids = item
        .get("receiver_thread_ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(|id| Value::String(format!("codex-thread:{id}")))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Value::Array(child_run_ids)
}

fn string_array_from_json_value(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn string_array_from_object_aliases(object: &Map<String, Value>, keys: &[&str]) -> Vec<String> {
    keys.iter()
        .find_map(|key| {
            let values = string_array_from_json_value(object.get(*key));
            (!values.is_empty()).then_some(values)
        })
        .unwrap_or_default()
}

fn copy_string_array_alias(object: &mut Map<String, Value>, canonical_key: &str, aliases: &[&str]) {
    if !string_array_from_json_value(object.get(canonical_key)).is_empty() {
        return;
    }
    let values = string_array_from_object_aliases(object, aliases);
    if values.is_empty() {
        return;
    }
    object.insert(
        canonical_key.to_string(),
        Value::Array(values.into_iter().map(Value::String).collect()),
    );
}

fn copy_value_alias(object: &mut Map<String, Value>, canonical_key: &str, aliases: &[&str]) {
    if object.get(canonical_key).is_some() {
        return;
    }
    if let Some(value) = aliases.iter().find_map(|key| object.get(*key).cloned()) {
        object.insert(canonical_key.to_string(), value);
    }
}

fn normalize_codex_subagent_args_aliases(object: &mut Map<String, Value>) {
    copy_value_alias(object, "threadId", &["thread_id"]);
    copy_value_alias(object, "turnId", &["turn_id"]);
    copy_value_alias(object, "senderThreadId", &["sender_thread_id"]);
    copy_string_array_alias(object, "receiverThreadIds", &["receiver_thread_ids"]);
    copy_string_array_alias(object, "childRunIds", &["child_run_ids"]);
    copy_value_alias(object, "agentsStates", &["agents_states"]);
}

fn codex_collab_work_graph_from_jsonl_item(
    item: &Value,
    canonical_tool: &str,
    child_run_ids: &Value,
) -> Value {
    let receiver_thread_ids = string_array_from_json_value(item.get("receiver_thread_ids"));
    let child_run_ids = string_array_from_json_value(Some(child_run_ids));
    let target_count = receiver_thread_ids.len().max(child_run_ids.len());
    let child_runs = (0..target_count)
        .map(|index| {
            let thread_id = receiver_thread_ids.get(index).cloned();
            let child_run_id = child_run_ids
                .get(index)
                .cloned()
                .or_else(|| thread_id.as_ref().map(|id| format!("codex-thread:{id}")))
                .unwrap_or_else(|| format!("unknown-child-run-{index}"));
            let mut child_run = serde_json::json!({
                "edgeId": codex_collab_edge_id(
                    item.get("id").and_then(Value::as_str),
                    &child_run_id,
                    index,
                    canonical_tool,
                ),
                "targetIndex": index,
                "childRunId": child_run_id,
                "operation": canonical_tool,
            });
            if let (Some(object), Some(thread_id)) = (child_run.as_object_mut(), thread_id.as_ref())
            {
                object.insert("threadId".to_string(), Value::String(thread_id.clone()));
            }
            if let Some(status) = thread_id
                .as_ref()
                .and_then(|id| codex_collab_child_status_from_jsonl_item(item, id))
            {
                if let Some(object) = child_run.as_object_mut() {
                    object.insert("status".to_string(), Value::String(status));
                }
            }
            child_run
        })
        .collect::<Vec<_>>();
    let sender_thread_id = item.get("sender_thread_id").cloned().unwrap_or(Value::Null);
    serde_json::json!({
        "schemaVersion": CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
        "toolCallId": item.get("id").cloned().unwrap_or(Value::Null),
        "tool": canonical_tool,
        "status": item.get("status").cloned().unwrap_or(Value::Null),
        "parent": {
            "threadId": sender_thread_id.clone(),
            "turnId": item.get("turn_id").cloned().unwrap_or(Value::Null),
            "senderThreadId": sender_thread_id,
        },
        "childRuns": child_runs,
    })
}

fn codex_collab_edge_id(
    tool_call_id: Option<&str>,
    child_run_id: &str,
    index: usize,
    canonical_tool: &str,
) -> String {
    format!(
        "{}:{index}:{canonical_tool}:{child_run_id}",
        tool_call_id.unwrap_or("unknown-tool-call")
    )
}

fn codex_collab_child_status_from_jsonl_item(item: &Value, thread_id: &str) -> Option<String> {
    let agent_states = item
        .get("agents_states")
        .or_else(|| item.get("agentsStates"))?
        .as_object()?;
    let agent_state = agent_states.get(thread_id)?.as_object()?;
    json_string_from_object(agent_state, &["status"])
}

fn codex_bridge_tool_args(tool_name: &str, args: Value, tool_call_id: Option<&str>) -> Value {
    if !tool_name.starts_with("codex.subagent.") {
        return args;
    }
    let mut object = match args {
        Value::Object(object) => object,
        other => return other,
    };
    normalize_codex_subagent_args_aliases(&mut object);
    if let Some(tool_call_id) = tool_call_id.filter(|id| !id.is_empty()) {
        let has_tool_call_id = object
            .get("toolCallId")
            .or_else(|| object.get("tool_call_id"))
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty());
        if !has_tool_call_id {
            object.insert(
                "toolCallId".to_string(),
                Value::String(tool_call_id.to_string()),
            );
        }
    }
    let canonical_tool = object
        .get("codexTool")
        .and_then(Value::as_str)
        .or_else(|| tool_name.strip_prefix("codex.subagent."))
        .map(codex_canonical_collab_tool);
    if let Some(canonical_tool) = canonical_tool {
        object.insert("codexTool".to_string(), Value::String(canonical_tool));
    }
    let has_child_run_ids = object
        .get("childRunIds")
        .and_then(Value::as_array)
        .is_some_and(|ids| {
            ids.iter()
                .any(|id| id.as_str().is_some_and(|id| !id.is_empty()))
        });
    if !has_child_run_ids {
        if let Some(ids) = object.get("child_run_ids").and_then(Value::as_array) {
            let child_run_ids = ids
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(|id| Value::String(id.to_string()))
                .collect::<Vec<_>>();
            if !child_run_ids.is_empty() {
                object.insert("childRunIds".to_string(), Value::Array(child_run_ids));
            }
        }
    }
    let has_child_run_ids = object
        .get("childRunIds")
        .and_then(Value::as_array)
        .is_some_and(|ids| {
            ids.iter()
                .any(|id| id.as_str().is_some_and(|id| !id.is_empty()))
        });
    if !has_child_run_ids {
        let child_run_ids = object
            .get("receiverThreadIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(|id| Value::String(format!("codex-thread:{id}")))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        object.insert("childRunIds".to_string(), Value::Array(child_run_ids));
    }
    let has_work_graph = object
        .get("codexWorkGraph")
        .or_else(|| object.get("codex_work_graph"))
        .and_then(Value::as_object)
        .is_some();
    if !has_work_graph {
        object.insert(
            "codexWorkGraph".to_string(),
            codex_collab_work_graph_from_args_object(tool_name, &object),
        );
    }
    Value::Object(object)
}

fn codex_collab_work_graph_from_args_object(tool_name: &str, object: &Map<String, Value>) -> Value {
    let canonical_tool = codex_canonical_collab_tool(
        object
            .get("codexTool")
            .and_then(Value::as_str)
            .or_else(|| tool_name.strip_prefix("codex.subagent."))
            .unwrap_or(tool_name),
    );
    let receiver_thread_ids =
        string_array_from_object_aliases(object, &["receiverThreadIds", "receiver_thread_ids"]);
    let child_run_ids = string_array_from_object_aliases(object, &["childRunIds", "child_run_ids"]);
    let target_count = receiver_thread_ids.len().max(child_run_ids.len());
    let child_runs = (0..target_count)
        .map(|index| {
            let thread_id = receiver_thread_ids.get(index).cloned();
            let child_run_id = child_run_ids
                .get(index)
                .cloned()
                .or_else(|| thread_id.as_ref().map(|id| format!("codex-thread:{id}")))
                .unwrap_or_else(|| format!("unknown-child-run-{index}"));
            let mut child_run = serde_json::json!({
                "edgeId": codex_collab_edge_id(
                    object.get("toolCallId").and_then(Value::as_str),
                    &child_run_id,
                    index,
                    &canonical_tool,
                ),
                "targetIndex": index,
                "childRunId": child_run_id,
                "operation": canonical_tool,
            });
            if let (Some(object), Some(thread_id)) = (child_run.as_object_mut(), thread_id.as_ref())
            {
                object.insert("threadId".to_string(), Value::String(thread_id.clone()));
            }
            if let Some(status) = thread_id
                .as_ref()
                .and_then(|id| codex_collab_child_status_from_args_object(object, id))
            {
                if let Some(object) = child_run.as_object_mut() {
                    object.insert("status".to_string(), Value::String(status));
                }
            }
            child_run
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "schemaVersion": CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
        "toolCallId": object.get("toolCallId").cloned().unwrap_or(Value::Null),
        "tool": canonical_tool,
        "status": object.get("status").cloned().unwrap_or(Value::Null),
        "parent": {
            "threadId": object.get("threadId").or_else(|| object.get("thread_id")).cloned().unwrap_or(Value::Null),
            "turnId": object.get("turnId").or_else(|| object.get("turn_id")).cloned().unwrap_or(Value::Null),
            "senderThreadId": object.get("senderThreadId").or_else(|| object.get("sender_thread_id")).cloned().unwrap_or(Value::Null),
        },
        "childRuns": child_runs,
    })
}

fn codex_collab_child_status_from_args_object(
    object: &Map<String, Value>,
    thread_id: &str,
) -> Option<String> {
    let agent_states = object
        .get("agentsStates")
        .or_else(|| object.get("agents_states"))?
        .as_object()?;
    let agent_state = agent_states.get(thread_id)?.as_object()?;
    json_string_from_object(agent_state, &["status"])
}

fn json_string_from_object(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn codex_canonical_collab_tool(tool: &str) -> String {
    match tool {
        "spawn_agent" | "spawnAgent" => "spawnAgent".to_string(),
        "send_input" | "sendInput" => "sendInput".to_string(),
        "resume_agent" | "resume_subagent" | "resumeAgent" | "resumeSubagent" => {
            "resumeAgent".to_string()
        }
        "wait_agent" | "waitAgent" | "wait" => "wait".to_string(),
        "close_agent" | "closeAgent" => "closeAgent".to_string(),
        other => other.to_string(),
    }
}

fn canonical_codex_bridge_tool_name(tool_name: &str) -> String {
    tool_name
        .strip_prefix("codex.subagent.")
        .map(|tool| format!("codex.subagent.{}", codex_canonical_collab_tool(tool)))
        .unwrap_or_else(|| tool_name.to_string())
}

fn codex_bridge_tool_start_event(
    tool_call_id: &str,
    tool_name: &str,
    args: Value,
) -> CodexBridgeToolEvent {
    let args = codex_bridge_tool_args(tool_name, args, Some(tool_call_id));
    CodexBridgeToolEvent {
        event_type: "tool_execution_start",
        tool_call_id: tool_call_id.to_string(),
        tool_name: tool_name.to_string(),
        display_name: codex_bridge_tool_display_name(tool_name),
        summary_label: codex_bridge_tool_summary_label(tool_name, &args),
        args,
        result: Value::Null,
        is_error: None,
    }
}

fn codex_bridge_tool_end_event(
    tool_call_id: &str,
    tool_name: &str,
    result: Value,
    is_error: bool,
) -> CodexBridgeToolEvent {
    CodexBridgeToolEvent {
        event_type: "tool_execution_end",
        tool_call_id: tool_call_id.to_string(),
        tool_name: tool_name.to_string(),
        display_name: codex_bridge_tool_display_name(tool_name),
        summary_label: codex_bridge_tool_summary_label(tool_name, &Value::Null),
        args: Value::Object(Map::new()),
        result,
        is_error: Some(is_error),
    }
}

fn codex_bridge_tool_result(
    tool_call_id: &str,
    tool_name: &str,
    success: bool,
    details: Option<Value>,
) -> Value {
    let text = if success {
        format!("{tool_name} completed")
    } else {
        format!("{tool_name} failed")
    };
    let mut result = serde_json::json!({
        "role": "toolResult",
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "content": [{ "type": "text", "text": text }],
        "isError": !success,
        "timestamp": now_rfc3339()
    });
    if let Some(details) = details {
        result["details"] = details;
    }
    result
}

fn codex_headless_tool_end_details(event: &Value) -> Value {
    let mut details = event
        .get("details")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(error_code) = event.get("error_code").and_then(Value::as_str) {
        details.insert(
            "errorCode".to_string(),
            Value::String(error_code.to_string()),
        );
    }
    if let Some(approval_request_id) = event.get("approval_request_id").and_then(Value::as_str) {
        details.insert(
            "approvalRequestId".to_string(),
            Value::String(approval_request_id.to_string()),
        );
    }
    if let Some(governed_outcome) = event.get("governed_outcome").and_then(Value::as_str) {
        details.insert(
            "governedOutcome".to_string(),
            Value::String(governed_outcome.to_string()),
        );
    }
    Value::Object(details)
}

fn codex_bridge_tool_display_name(tool_name: &str) -> Option<String> {
    tool_name
        .strip_prefix("codex.subagent.")
        .map(|tool| format!("Codex subagent: {}", codex_collab_human_tool(tool)))
}

fn codex_bridge_tool_summary_label(tool_name: &str, args: &Value) -> Option<String> {
    let tool = tool_name.strip_prefix("codex.subagent.")?;
    let count = args
        .get("receiverThreadIds")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let target = match count {
        0 => return Some(codex_collab_human_tool(tool).to_string()),
        1 => "1 agent".to_string(),
        n => format!("{n} agents"),
    };
    Some(format!("{} {target}", codex_collab_human_tool(tool)))
}

fn codex_collab_human_tool(tool: &str) -> &'static str {
    match tool {
        "spawnAgent" => "spawn agent",
        "sendInput" => "send input",
        "resumeAgent" => "resume agent",
        "closeAgent" => "close agent",
        "wait" => "wait",
        _ => "subagent",
    }
}

fn codex_usage_from_json(usage: &Value) -> Option<TokenUsage> {
    let input_tokens = value_u64_field(usage, &["input", "tokensInput"]);
    let output_tokens = value_u64_field(usage, &["output", "tokensOutput"]);
    let cache_read_tokens = value_u64_field(usage, &["cacheRead", "tokensCacheRead"]);
    let cache_write_tokens = value_u64_field(usage, &["cacheWrite", "tokensCacheWrite"]);
    let cost = usage
        .get("cost")
        .and_then(|cost| {
            cost.get("total")
                .and_then(Value::as_f64)
                .or_else(|| cost.as_f64())
        })
        .or_else(|| usage.get("costTotal").and_then(Value::as_f64));

    if input_tokens == 0
        && output_tokens == 0
        && cache_read_tokens == 0
        && cache_write_tokens == 0
        && cost.is_none()
    {
        return None;
    }

    Some(TokenUsage {
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost,
    })
}

fn value_u64_field(value: &Value, names: &[&str]) -> u64 {
    names
        .iter()
        .find_map(|name| {
            value
                .get(*name)
                .and_then(Value::as_u64)
                .or_else(|| value.get(*name).and_then(Value::as_f64).map(|n| n as u64))
        })
        .unwrap_or(0)
}

struct CodexBridgePrompt {
    argument: String,
    temp_dir: PathBuf,
}

fn codex_bridge_prompt_body(prompt: &str, attachment_paths: &[String]) -> String {
    let mut body = format!("# Maestro Rust Codex bridge request\n\n{prompt}\n");
    if !attachment_paths.is_empty() {
        body.push_str("\n## Attachment files\n\n");
        body.push_str(
            "The user uploaded the following files. Inspect these paths with tools as needed before answering:\n",
        );
        for path in attachment_paths {
            body.push_str(&format!("- {path}\n"));
        }
    }
    body
}

fn unique_temp_name(prefix: &str, counter: &AtomicU64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let counter = counter.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{now}-{counter}", process::id())
}

fn sandbox_visible_temp_dir(cwd: &Path, prefix: &str, counter: &AtomicU64) -> PathBuf {
    let name = unique_temp_name(prefix, counter);
    if codex_app_server_sandbox_mode().as_deref() == Some("docker") {
        cwd.join(format!(".{name}"))
    } else {
        env::temp_dir().join(name)
    }
}

fn codex_bridge_temp_dir(cwd: &Path) -> PathBuf {
    sandbox_visible_temp_dir(cwd, "maestro-codex-bridge", &CODEX_BRIDGE_TEMP_COUNTER)
}

async fn run_codex_bridge_command(mut command: Command) -> Result<std::process::Output, String> {
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to run Codex app-server bridge: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture Codex app-server bridge stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture Codex app-server bridge stderr".to_string())?;
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });

    let status = match tokio::time::timeout(codex_app_server_timeout(), child.wait()).await {
        Ok(status) => status
            .map_err(|error| format!("failed to wait for Codex app-server bridge: {error}"))?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err("Codex app-server request timed out".to_string());
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|error| format!("failed to join Codex app-server stdout reader: {error}"))?
        .map_err(|error| format!("failed to read Codex app-server stdout: {error}"))?;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("failed to join Codex app-server stderr reader: {error}"))?
        .map_err(|error| format!("failed to read Codex app-server stderr: {error}"))?;

    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

async fn prepare_codex_bridge_prompt(
    cwd: &Path,
    prompt: &str,
    attachment_paths: &[String],
) -> Result<CodexBridgePrompt, String> {
    let temp_dir = codex_bridge_temp_dir(cwd);
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|error| format!("failed to create Codex bridge prompt directory: {error}"))?;
    let prompt_path = temp_dir.join("prompt.md");
    tokio::fs::write(
        &prompt_path,
        codex_bridge_prompt_body(prompt, attachment_paths),
    )
    .await
    .map_err(|error| format!("failed to write Codex bridge prompt: {error}"))?;
    Ok(CodexBridgePrompt {
        argument: format!(
            "Use the read tool to read {}. Follow the instructions in that file. If it lists attachment files, inspect them as needed. Reply only with the final answer.",
            prompt_path.display()
        ),
        temp_dir,
    })
}

async fn run_codex_app_server_cli(
    cwd: &Path,
    model: &str,
    approval_mode: &str,
    prompt: &str,
    attachment_paths: &[String],
) -> Result<CodexBridgeOutput, String> {
    let cli_path = codex_app_server_cli_path();
    if !cli_path.exists() {
        return Err(format!(
            "Codex app-server bridge requires {}. Run `npm run build:all` first or set MAESTRO_CODEX_APP_SERVER_CLI.",
            cli_path.display()
        ));
    }

    let node_bin = env::var("MAESTRO_NODE_BIN").unwrap_or_else(|_| "node".to_string());
    let bridge_prompt = prepare_codex_bridge_prompt(cwd, prompt, attachment_paths).await?;
    let sandbox_mode = codex_app_server_sandbox_mode();
    let mut command = Command::new(node_bin);
    command
        .arg(cli_path)
        .arg("--provider")
        .arg("openai-codex")
        .arg("--model")
        .arg(model)
        .arg("--mode")
        .arg("json")
        .arg("--no-session")
        .arg("--approval-mode")
        .arg(approval_mode);
    if let Some(sandbox_mode) = sandbox_mode {
        command.arg("--sandbox").arg(sandbox_mode);
    }
    command
        .arg(&bridge_prompt.argument)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("NO_COLOR", "1")
        .env("MAESTRO_TELEMETRY_DISABLED", "1")
        .env(
            "MAESTRO_USAGE_FILE",
            bridge_prompt.temp_dir.join("usage.json"),
        );

    let output_result = run_codex_bridge_command(command).await;
    let _ = tokio::fs::remove_dir_all(&bridge_prompt.temp_dir).await;
    let output = output_result?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        return assistant_output_from_jsonl(&stdout);
    }

    let mut message = format!(
        "Codex app-server bridge failed with exit code {}",
        output.status.code().unwrap_or(1)
    );
    if !stderr.is_empty() {
        message.push_str(&format!(": {}", truncate_command_output(&stderr)));
    } else if !stdout.is_empty() {
        message.push_str(&format!(": {}", truncate_command_output(&stdout)));
    }
    Err(message)
}

#[derive(Clone, Copy)]
enum CodexBridgeTransport {
    Sse,
    WebSocket,
}

async fn send_codex_bridge_event(
    stream: &mut TcpStream,
    transport: CodexBridgeTransport,
    value: &Value,
) -> Result<(), String> {
    match transport {
        CodexBridgeTransport::Sse => send_sse(stream, value).await,
        CodexBridgeTransport::WebSocket => send_ws_json(stream, value).await,
    }
}

async fn send_codex_bridge_tool_event(
    stream: &mut TcpStream,
    transport: CodexBridgeTransport,
    event: &CodexBridgeToolEvent,
) -> Result<(), String> {
    let mut object = Map::new();
    object.insert(
        "type".to_string(),
        Value::String(event.event_type.to_string()),
    );
    object.insert(
        "toolCallId".to_string(),
        Value::String(event.tool_call_id.clone()),
    );
    object.insert(
        "toolName".to_string(),
        Value::String(event.tool_name.clone()),
    );
    if let Some(display_name) = &event.display_name {
        object.insert(
            "displayName".to_string(),
            Value::String(display_name.clone()),
        );
    }
    if let Some(summary_label) = &event.summary_label {
        object.insert(
            "summaryLabel".to_string(),
            Value::String(summary_label.clone()),
        );
    }
    match event.event_type {
        "tool_execution_start" => {
            object.insert("args".to_string(), event.args.clone());
        }
        "tool_execution_end" => {
            object.insert("result".to_string(), event.result.clone());
            object.insert(
                "isError".to_string(),
                Value::Bool(event.is_error.unwrap_or(false)),
            );
        }
        _ => return Ok(()),
    }
    send_codex_bridge_event(stream, transport, &Value::Object(object)).await
}

fn codex_headless_usage_from_json(event: &Value) -> Option<TokenUsage> {
    let usage = event.get("usage")?;
    let input_tokens = value_u64_field(usage, &["input_tokens", "inputTokens", "input"]);
    let output_tokens = value_u64_field(usage, &["output_tokens", "outputTokens", "output"]);
    let cache_read_tokens = value_u64_field(
        usage,
        &["cache_read_tokens", "cacheReadTokens", "cacheRead"],
    );
    let cache_write_tokens = value_u64_field(
        usage,
        &["cache_write_tokens", "cacheWriteTokens", "cacheWrite"],
    );
    let cost = usage
        .get("total_cost_usd")
        .and_then(Value::as_f64)
        .or_else(|| usage.get("totalCostUsd").and_then(Value::as_f64))
        .or_else(|| usage.get("costTotal").and_then(Value::as_f64));
    if input_tokens == 0
        && output_tokens == 0
        && cache_read_tokens == 0
        && cache_write_tokens == 0
        && cost.is_none()
    {
        return None;
    }
    Some(TokenUsage {
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost,
    })
}

async fn write_codex_headless_message(
    stdin: &mut tokio::process::ChildStdin,
    value: &Value,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|error| format!("failed to serialize Codex headless message: {error}"))?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| format!("failed to write Codex headless message: {error}"))
}

fn codex_headless_approval_response(
    request_id: &str,
    approved: bool,
    result: Option<&ToolResult>,
) -> Value {
    let mut result_value = if let Some(result) = result {
        serde_json::json!({
            "success": result.success,
            "output": result.output,
            "error": result.error
        })
    } else if approved {
        serde_json::json!({
            "success": true,
            "output": "Approved"
        })
    } else {
        serde_json::json!({
            "success": false,
            "output": "",
            "error": "Denied by user"
        })
    };
    if result_value.get("error").is_some_and(Value::is_null) {
        result_value
            .as_object_mut()
            .map(|object| object.remove("error"));
    }
    serde_json::json!({
        "type": "server_request_response",
        "request_id": request_id,
        "request_type": "approval",
        "approved": approved,
        "result": result_value
    })
}

fn codex_headless_run_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let counter = CODEX_HEADLESS_RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("run-{}-{now}-{counter}", process::id())
}

fn codex_headless_pending_request_id(
    session_id: Option<&str>,
    run_id: &str,
    request_id: &str,
) -> String {
    format!(
        "codex:{}:{}:{}",
        session_id.unwrap_or("default"),
        run_id,
        request_id
    )
}

#[allow(clippy::too_many_arguments)]
async fn handle_codex_headless_approval_request(
    stream: &mut TcpStream,
    transport: CodexBridgeTransport,
    state: &AppState,
    session_id: Option<&str>,
    run_id: &str,
    request: &Value,
    pending_approval_ids: &Arc<Mutex<Vec<String>>>,
    stdin: &mut tokio::process::ChildStdin,
) -> Result<(), String> {
    if request.get("request_type").and_then(Value::as_str) != Some("approval") {
        return Ok(());
    }
    let child_request_id = request
        .get("request_id")
        .and_then(Value::as_str)
        .or_else(|| request.get("call_id").and_then(Value::as_str))
        .ok_or_else(|| "Codex headless approval request missing request_id".to_string())?
        .to_string();
    let external_request_id =
        codex_headless_pending_request_id(session_id, run_id, child_request_id.as_str());
    let tool_name = request
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let args = request
        .get("args")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));
    let reason = request
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("Tool execution requires approval")
        .to_string();
    let (sender, mut receiver) = mpsc::unbounded_channel();
    state
        .pending_tool_responses
        .lock()
        .await
        .insert(external_request_id.clone(), sender);
    pending_approval_ids
        .lock()
        .await
        .push(external_request_id.clone());

    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({
            "type": "action_approval_required",
            "request": {
                "id": external_request_id,
                "toolName": tool_name,
                "args": args,
                "reason": reason
            }
        }),
    )
    .await?;

    let Some((_call_id, approved, result)) = receiver.recv().await else {
        return Err("Codex headless approval request closed before decision".to_string());
    };
    write_codex_headless_message(
        stdin,
        &codex_headless_approval_response(&child_request_id, approved, result.as_ref()),
    )
    .await
}

async fn cleanup_codex_headless_approvals(
    state: &AppState,
    pending_approval_ids: &Arc<Mutex<Vec<String>>>,
) {
    let ids = pending_approval_ids.lock().await.clone();
    if ids.is_empty() {
        return;
    }
    let mut pending = state.pending_tool_responses.lock().await;
    for id in ids {
        pending.remove(&id);
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_codex_app_server_headless_cli(
    stream: &mut TcpStream,
    transport: CodexBridgeTransport,
    state: &AppState,
    session_id: Option<&str>,
    cwd: &Path,
    model: &str,
    prompt: &str,
    attachment_paths: &[String],
) -> Result<CodexBridgeOutput, String> {
    let cli_path = codex_app_server_cli_path();
    if !cli_path.exists() {
        return Err(format!(
            "Codex app-server bridge requires {}. Run `npm run build:all` first or set MAESTRO_CODEX_APP_SERVER_CLI.",
            cli_path.display()
        ));
    }

    let node_bin = env::var("MAESTRO_NODE_BIN").unwrap_or_else(|_| "node".to_string());
    let bridge_prompt = prepare_codex_bridge_prompt(cwd, prompt, attachment_paths).await?;
    let sandbox_mode = codex_app_server_sandbox_mode();
    let mut command = Command::new(node_bin);
    command
        .arg(cli_path)
        .arg("--provider")
        .arg("openai-codex")
        .arg("--model")
        .arg(model)
        .arg("--headless")
        .arg("--no-session")
        .arg("--approval-mode")
        .arg("prompt");
    if let Some(sandbox_mode) = sandbox_mode {
        command.arg("--sandbox").arg(sandbox_mode);
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("NO_COLOR", "1")
        .env("MAESTRO_TELEMETRY_DISABLED", "1")
        .env(
            "MAESTRO_USAGE_FILE",
            bridge_prompt.temp_dir.join("usage.json"),
        );

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to run Codex headless bridge: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to capture Codex headless stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture Codex headless stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture Codex headless stderr".to_string())?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let pending_approval_ids = Arc::new(Mutex::new(Vec::new()));
    let approval_run_id = codex_headless_run_id();
    let request_timeout = codex_app_server_timeout();
    let shutdown_timeout = codex_app_server_shutdown_timeout();
    let mut lines = BufReader::new(stdout).lines();

    let request_result = async {
        write_codex_headless_message(
            &mut stdin,
            &serde_json::json!({
                "type": "hello",
                "protocol_version": "2026-04-02",
                "client_info": {
                    "name": "maestro-rust-control-plane"
                },
                "capabilities": {
                    "server_requests": ["approval"]
                },
                "role": "controller"
            }),
        )
        .await?;
        write_codex_headless_message(
            &mut stdin,
            &serde_json::json!({
                "type": "init",
                "approval_mode": "prompt"
            }),
        )
        .await?;
        write_codex_headless_message(
            &mut stdin,
            &serde_json::json!({
                "type": "prompt",
                "content": bridge_prompt.argument
            }),
        )
        .await?;

        let mut assistant_text = String::new();
        let mut tool_events = Vec::new();
        let mut tool_contexts: HashMap<String, CodexBridgeToolContext> = HashMap::new();
        loop {
            let line = match tokio::time::timeout(request_timeout, lines.next_line()).await {
                Ok(Ok(Some(line))) => line,
                Ok(Ok(None)) => break,
                Ok(Err(error)) => {
                    return Err(format!("failed to read Codex headless output: {error}"));
                }
                Err(_) => return Err("Codex app-server request timed out".to_string()),
            };
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match event.get("type").and_then(Value::as_str) {
                Some("response_chunk")
                    if !event
                        .get("is_thinking")
                        .and_then(Value::as_bool)
                        .unwrap_or(false) =>
                {
                    if let Some(content) = event.get("content").and_then(Value::as_str) {
                        assistant_text.push_str(content);
                    }
                }
                Some("response_end") => {
                    let assistant_usage = codex_headless_usage_from_json(&event);
                    let _ = write_codex_headless_message(
                        &mut stdin,
                        &serde_json::json!({ "type": "shutdown" }),
                    )
                    .await;
                    if assistant_text.trim().is_empty() {
                        return Err(
                            "Codex headless bridge returned an empty assistant message".to_string()
                        );
                    }
                    return Ok(CodexBridgeOutput {
                        text: assistant_text,
                        usage: assistant_usage,
                        tool_events,
                    });
                }
                Some("tool_call") | Some("tool_end") => {
                    if let Some(tool_event) =
                        codex_headless_tool_event_from_json_with_context(&event, &mut tool_contexts)
                    {
                        tool_events.push(tool_event);
                    }
                }
                Some("server_request") => {
                    handle_codex_headless_approval_request(
                        stream,
                        transport,
                        state,
                        session_id,
                        &approval_run_id,
                        &event,
                        &pending_approval_ids,
                        &mut stdin,
                    )
                    .await?;
                }
                Some("error") => {
                    let message = event
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex headless bridge error");
                    if event.get("fatal").and_then(Value::as_bool).unwrap_or(false) {
                        return Err(message.to_string());
                    }
                }
                _ => {}
            }
        }
        Err("Codex headless bridge exited without an assistant response".to_string())
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&bridge_prompt.temp_dir).await;
    cleanup_codex_headless_approvals(state, &pending_approval_ids).await;
    let output = request_result;
    if output.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
        let _ = stderr_task.await;
        return output;
    }
    match tokio::time::timeout(shutdown_timeout, child.wait()).await {
        Ok(Ok(_status)) => {}
        Ok(Err(error)) => {
            return Err(format!("failed to wait for Codex headless bridge: {error}"));
        }
        Err(_) => {
            let _ = child.kill().await;
        }
    }
    let _stderr = stderr_task
        .await
        .map_err(|error| format!("failed to join Codex headless stderr reader: {error}"))?
        .map_err(|error| format!("failed to read Codex headless stderr: {error}"))?;
    output
}

async fn handle_codex_app_server_chat(
    stream: &mut TcpStream,
    state: &AppState,
    session_id: Option<&str>,
    model: &str,
    prompt: &str,
    attachment_paths: &[String],
) -> Result<(), String> {
    handle_codex_app_server_chat_transport(
        stream,
        state,
        session_id,
        model,
        prompt,
        attachment_paths,
        CodexBridgeTransport::Sse,
    )
    .await
}

async fn handle_codex_app_server_chat_transport(
    stream: &mut TcpStream,
    state: &AppState,
    session_id: Option<&str>,
    model: &str,
    prompt: &str,
    attachment_paths: &[String],
    transport: CodexBridgeTransport,
) -> Result<(), String> {
    let session_approval_mode = approval_mode_for_session(state, session_id).await;
    let approval_mode = codex_app_server_approval_mode(&session_approval_mode);
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({ "type": "agent_start" }),
    )
    .await?;
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({ "type": "turn_start" }),
    )
    .await?;
    let message = composer_assistant_message("", "", None);
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({ "type": "message_start", "message": message }),
    )
    .await?;

    let assistant_output_result = if approval_mode == "prompt" {
        run_codex_app_server_headless_cli(
            stream,
            transport,
            state,
            session_id,
            &state.config.cwd,
            model,
            prompt,
            attachment_paths,
        )
        .await
    } else {
        run_codex_app_server_cli(
            &state.config.cwd,
            model,
            approval_mode,
            prompt,
            attachment_paths,
        )
        .await
    };
    let assistant_output = match assistant_output_result {
        Ok(output) => output,
        Err(error) => {
            send_codex_bridge_event(
                stream,
                transport,
                &serde_json::json!({ "type": "error", "message": error }),
            )
            .await?;
            send_codex_bridge_event(stream, transport, &serde_json::json!({ "type": "done" }))
                .await?;
            return Ok(());
        }
    };
    for tool_event in &assistant_output.tool_events {
        send_codex_bridge_tool_event(stream, transport, tool_event).await?;
    }

    let message =
        composer_assistant_message(&assistant_output.text, "", assistant_output.usage.clone());
    if !assistant_output.text.is_empty() {
        send_codex_bridge_event(
            stream,
            transport,
            &serde_json::json!({
                "type": "message_update",
                "message": message,
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": assistant_output.text
                }
            }),
        )
        .await?;
    }
    record_chat_assistant_message(state, session_id, message.clone()).await;
    record_usage_entry(
        state,
        session_id,
        "openai-codex",
        model,
        assistant_output.usage.as_ref(),
    )
    .await;
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({ "type": "message_end", "message": message }),
    )
    .await?;
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({
            "type": "turn_end",
            "message": message,
            "toolResults": []
        }),
    )
    .await?;
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({
            "type": "agent_end",
            "messages": [message],
            "stopReason": "stop"
        }),
    )
    .await?;
    send_codex_bridge_event(stream, transport, &serde_json::json!({ "type": "done" })).await?;
    Ok(())
}

async fn handle_codex_app_server_chat_ws(
    stream: &mut TcpStream,
    state: &AppState,
    session_id: Option<&str>,
    model: &str,
    prompt: &str,
    attachment_paths: &[String],
) -> Result<(), String> {
    handle_codex_app_server_chat_transport(
        stream,
        state,
        session_id,
        model,
        prompt,
        attachment_paths,
        CodexBridgeTransport::WebSocket,
    )
    .await
}

async fn record_chat_user_message(
    state: &AppState,
    chat: &ChatRequest,
    auth: &AuthContext,
) -> Result<(), String> {
    let Some(session_id) = chat.session_id.as_deref() else {
        return Ok(());
    };
    let Some(latest) = chat.messages.last() else {
        return Ok(());
    };
    let mut message = chat_message_prompt_value(latest);
    if let Value::Object(object) = &mut message {
        object.insert("timestamp".to_string(), Value::String(now_rfc3339()));
    }
    if !latest.attachments.is_empty() {
        message["attachments"] = serde_json::json!(latest.attachments);
    }
    append_session_message(
        state,
        session_id,
        message,
        Some(&latest.content),
        auth.subject.clone(),
        Some(auth),
    )
    .await
}

async fn record_chat_assistant_message(state: &AppState, session_id: Option<&str>, message: Value) {
    let Some(session_id) = session_id else {
        return;
    };
    let _ = append_session_message(state, session_id, message, None, None, None).await;
}

async fn append_session_message(
    state: &AppState,
    session_id: &str,
    message: Value,
    title_source: Option<&Value>,
    owner: Option<String>,
    auth: Option<&AuthContext>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = if sessions.sessions.contains_key(session_id) {
        let session = sessions
            .sessions
            .get_mut(session_id)
            .expect("session existence checked");
        if auth.is_some_and(|auth| !session_visible_to_auth(session, auth)) {
            return Err("Session not found".to_string());
        }
        session
    } else {
        sessions
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(|| {
                let mut session =
                    create_session_record(title_source.and_then(title_from_content), owner);
                session.id = session_id.to_string();
                session
            })
    };
    if session.message_count == 0 {
        if let Some(title) = title_source.and_then(title_from_content) {
            session.title = title;
        }
    }
    session.messages.push(message);
    session.message_count = session.messages.len() as u64;
    session.updated_at = now_rfc3339();
    drop(sessions);
    persist_session_store(state).await;
    Ok(())
}

fn title_from_content(content: &Value) -> Option<String> {
    let text = composer_text_content(content);
    let title = text
        .split_whitespace()
        .take(12)
        .collect::<Vec<_>>()
        .join(" ");
    normalize_title(Some(title)).map(|title| title.chars().take(80).collect())
}

async fn handle_chat_endpoint(
    mut stream: TcpStream,
    mut initial: Vec<u8>,
    head: RequestHead,
    state: AppState,
) -> Result<(), String> {
    let Some(auth) = auth_context(&head, &state.config) else {
        let response = json_response(401, &serde_json::json!({ "error": "Unauthorized" }));
        stream
            .write_all(&response)
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    };
    if let Err(response) = validate_csrf(&head, &state.config) {
        stream
            .write_all(&response)
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    let body = match read_request_body(&mut stream, &mut initial, &head).await {
        Ok(body) => body,
        Err(error) => {
            stream
                .write_all(&json_response(400, &serde_json::json!({ "error": error })))
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };
    let chat = match serde_json::from_slice::<ChatRequest>(&body) {
        Ok(request) => request,
        Err(error) => {
            stream
                .write_all(&json_response(
                    400,
                    &serde_json::json!({ "error": format!("invalid chat request: {error}") }),
                ))
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };

    let Some(latest) = chat.messages.last() else {
        stream
            .write_all(&json_response(
                400,
                &serde_json::json!({ "error": "No messages supplied" }),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    };
    if latest.role != "user" {
        stream
            .write_all(&json_response(
                400,
                &serde_json::json!({ "error": "Last message must be a user message" }),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    if !chat_message_has_input(latest) {
        stream
            .write_all(&json_response(
                400,
                &serde_json::json!({ "error": "User message cannot be empty" }),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }
    let prompt = build_prompt_from_chat(&chat);

    let session_id = chat.session_id.clone();
    let prepared_attachments = match prepare_chat_attachments(&chat, &state.config.cwd).await {
        Ok(attachments) => attachments,
        Err(error) => {
            stream
                .write_all(&json_response(400, &serde_json::json!({ "error": error })))
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };
    if let Err(error) = record_chat_user_message(&state, &chat, &auth).await {
        cleanup_prepared_attachments(prepared_attachments).await;
        stream
            .write_all(&json_response(404, &serde_json::json!({ "error": error })))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    stream
        .write_all(sse_headers().as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    let model = selected_chat_model(&chat, &state).await;
    if let Some(codex_model) = codex_app_server_model_id(&model) {
        if let Some(session_id) = session_id.as_deref() {
            send_sse(
                &mut stream,
                &serde_json::json!({
                    "type": "status",
                    "status": "session",
                    "details": { "sessionId": session_id, "runtime": "rust-codex-app-server" }
                }),
            )
            .await?;
        }
        handle_codex_app_server_chat(
            &mut stream,
            &state,
            session_id.as_deref(),
            &codex_model,
            &prompt,
            &prepared_attachments.paths,
        )
        .await?;
        let _ = stream.shutdown().await;
        cleanup_prepared_attachments(prepared_attachments).await;
        return Ok(());
    }
    let (usage_provider, usage_model) = usage_provider_model(&chat, &state, &model).await;
    let thinking_enabled = chat
        .thinking_level
        .as_deref()
        .map(|level| !matches!(level, "off" | "none" | "disabled"))
        .unwrap_or(false);
    let config = NativeAgentConfig {
        model,
        cwd: state.config.cwd.to_string_lossy().to_string(),
        thinking_enabled,
        thinking_budget: env::var("MAESTRO_THINKING_BUDGET")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(10_000),
        ..NativeAgentConfig::default()
    };

    let (agent, mut events) = match NativeAgent::new(config) {
        Ok(agent) => agent,
        Err(error) => {
            send_sse(
                &mut stream,
                &serde_json::json!({ "type": "error", "message": error.to_string() }),
            )
            .await?;
            send_sse(&mut stream, &serde_json::json!({ "type": "done" })).await?;
            let _ = stream.shutdown().await;
            cleanup_prepared_attachments(prepared_attachments).await;
            return Ok(());
        }
    };

    if let Some(session_id) = session_id.as_deref() {
        send_sse(
            &mut stream,
            &serde_json::json!({
                "type": "status",
                "status": "session",
                "details": { "sessionId": session_id, "runtime": "rust" }
            }),
        )
        .await?;
    }
    send_sse(&mut stream, &serde_json::json!({ "type": "agent_start" })).await?;
    send_sse(&mut stream, &serde_json::json!({ "type": "turn_start" })).await?;

    let prompt_result = agent
        .prompt(prompt, prepared_attachments.paths.clone())
        .await;
    if let Err(error) = prompt_result {
        send_sse(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": error.to_string() }),
        )
        .await?;
        send_sse(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        let _ = stream.shutdown().await;
        cleanup_prepared_attachments(prepared_attachments).await;
        return Ok(());
    }

    let mut assistant_text = String::new();
    let mut thinking_text = String::new();
    let mut response_started = false;
    let mut thinking_started = false;
    let mut terminal_sent = false;
    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut assistant_tools: Vec<Value> = Vec::new();

    while let Some(event) = events.recv().await {
        match event {
            FromAgent::Ready { .. }
            | FromAgent::ModelChanged { .. }
            | FromAgent::ModelChangeFailed { .. }
            | FromAgent::SessionInfo { .. } => {}
            FromAgent::ResponseStart { .. } => {
                response_started = true;
                let message = composer_assistant_message(&assistant_text, &thinking_text, None);
                send_sse(
                    &mut stream,
                    &serde_json::json!({ "type": "message_start", "message": message }),
                )
                .await?;
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "message_update",
                        "message": message,
                        "assistantMessageEvent": {
                            "type": "start",
                            "partial": message
                        }
                    }),
                )
                .await?;
            }
            FromAgent::ResponseChunk {
                content,
                is_thinking,
                ..
            } => {
                if !response_started {
                    response_started = true;
                    let message = composer_assistant_message(&assistant_text, &thinking_text, None);
                    send_sse(
                        &mut stream,
                        &serde_json::json!({ "type": "message_start", "message": message }),
                    )
                    .await?;
                }
                if is_thinking {
                    if !thinking_started {
                        thinking_started = true;
                        let message =
                            composer_assistant_message(&assistant_text, &thinking_text, None);
                        send_sse(
                            &mut stream,
                            &serde_json::json!({
                                "type": "message_update",
                                "message": message,
                                "assistantMessageEvent": {
                                    "type": "thinking_start",
                                    "contentIndex": 0,
                                    "partial": message
                                }
                            }),
                        )
                        .await?;
                    }
                    thinking_text.push_str(&content);
                    send_sse(
                        &mut stream,
                        &serde_json::json!({
                            "type": "message_update",
                            "message": composer_assistant_message(&assistant_text, &thinking_text, None),
                            "assistantMessageEvent": {
                                "type": "thinking_delta",
                                "contentIndex": 0,
                                "delta": content
                            }
                        }),
                    )
                    .await?;
                } else {
                    assistant_text.push_str(&content);
                    send_sse(
                        &mut stream,
                        &serde_json::json!({
                            "type": "message_update",
                            "message": composer_assistant_message(&assistant_text, &thinking_text, None),
                            "assistantMessageEvent": {
                                "type": "text_delta",
                                "contentIndex": 0,
                                "delta": content
                            }
                        }),
                    )
                    .await?;
                }
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
            } => {
                tool_names.insert(call_id.clone(), tool.clone());
                record_tool_call_metadata(&mut assistant_tools, &call_id, &tool, args.clone());
                if requires_approval {
                    match approval_mode_for_session(&state, session_id.as_deref())
                        .await
                        .as_str()
                    {
                        "auto" => {
                            let _ =
                                agent
                                    .tool_response_sender()
                                    .send((call_id.clone(), true, None));
                            send_sse(
                                &mut stream,
                                &serde_json::json!({
                                    "type": "tool_execution_start",
                                    "toolCallId": call_id,
                                }),
                            )
                            .await?;
                        }
                        "fail" => {
                            let _ =
                                agent
                                    .tool_response_sender()
                                    .send((call_id.clone(), false, None));
                            finish_tool_metadata(&mut assistant_tools, &call_id, false);
                            send_sse(&mut stream, &approval_blocked_tool_event(&call_id, &tool))
                                .await?;
                        }
                        _ => {
                            state
                                .pending_tool_responses
                                .lock()
                                .await
                                .insert(call_id.clone(), agent.tool_response_sender());
                            send_sse(
                                &mut stream,
                                &serde_json::json!({
                                    "type": "action_approval_required",
                                    "request": {
                                        "id": call_id,
                                        "toolName": tool,
                                        "args": args,
                                        "reason": "Tool execution requires approval"
                                    }
                                }),
                            )
                            .await?;
                        }
                    }
                } else {
                    send_sse(
                        &mut stream,
                        &serde_json::json!({
                            "type": "tool_execution_start",
                            "toolCallId": call_id,
                            "toolName": tool,
                            "args": args
                        }),
                    )
                    .await?;
                }
            }
            FromAgent::ToolStart { call_id } => {
                update_tool_metadata_status(&mut assistant_tools, &call_id, "running");
                let tool = tool_names
                    .get(&call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".to_string());
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_start",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "args": {}
                    }),
                )
                .await?;
            }
            FromAgent::ToolOutput { call_id, content } => {
                let tool = tool_names
                    .get(&call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".to_string());
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_update",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "args": {},
                        "partialResult": content
                    }),
                )
                .await?;
            }
            FromAgent::ToolEnd { call_id, success } => {
                state.pending_tool_responses.lock().await.remove(&call_id);
                finish_tool_metadata(&mut assistant_tools, &call_id, success);
                let tool = tool_names
                    .remove(&call_id)
                    .unwrap_or_else(|| "tool".to_string());
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_end",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "result": { "success": success },
                        "isError": !success
                    }),
                )
                .await?;
            }
            FromAgent::BatchStart { total } => {
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "status",
                        "status": "tool_batch_start",
                        "details": { "total": total }
                    }),
                )
                .await?;
            }
            FromAgent::BatchEnd {
                total,
                successes,
                failures,
            } => {
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_batch_summary",
                        "summary": format!("{successes}/{total} tools succeeded"),
                        "summaryLabels": [],
                        "toolCallIds": [],
                        "toolNames": [],
                        "callsSucceeded": successes,
                        "callsFailed": failures
                    }),
                )
                .await?;
            }
            FromAgent::Error { message, .. } => {
                send_sse(
                    &mut stream,
                    &serde_json::json!({ "type": "error", "message": message }),
                )
                .await?;
            }
            FromAgent::Status { message } => {
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "status",
                        "status": message,
                        "details": {}
                    }),
                )
                .await?;
            }
            FromAgent::Compaction {
                summary,
                first_kept_entry_index,
                tokens_before,
                auto,
                custom_instructions,
                timestamp,
            } => {
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "compaction",
                        "summary": summary,
                        "firstKeptEntryIndex": first_kept_entry_index,
                        "tokensBefore": tokens_before,
                        "auto": auto,
                        "customInstructions": custom_instructions,
                        "timestamp": timestamp
                    }),
                )
                .await?;
            }
            FromAgent::HookBlocked {
                call_id,
                tool,
                reason,
            } => {
                state.pending_tool_responses.lock().await.remove(&call_id);
                finish_tool_metadata(&mut assistant_tools, &call_id, false);
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_end",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "result": reason,
                        "isError": true
                    }),
                )
                .await?;
            }
            FromAgent::ResponseEnd { usage, .. } => {
                record_usage_entry(
                    &state,
                    session_id.as_deref(),
                    &usage_provider,
                    &usage_model,
                    usage.as_ref(),
                )
                .await;
                let message = composer_assistant_message_with_tools(
                    &assistant_text,
                    &thinking_text,
                    usage,
                    &assistant_tools,
                );
                record_chat_assistant_message(&state, session_id.as_deref(), message.clone()).await;
                send_sse(
                    &mut stream,
                    &serde_json::json!({ "type": "message_end", "message": message }),
                )
                .await?;
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "turn_end",
                        "message": message,
                        "toolResults": []
                    }),
                )
                .await?;
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "agent_end",
                        "messages": [message],
                        "stopReason": "stop"
                    }),
                )
                .await?;
                send_sse(&mut stream, &serde_json::json!({ "type": "done" })).await?;
                terminal_sent = true;
                break;
            }
        }
    }

    if !terminal_sent {
        send_sse(
            &mut stream,
            &serde_json::json!({
                "type": "error",
                "message": "Agent stream closed before response completed"
            }),
        )
        .await?;
        send_sse(&mut stream, &serde_json::json!({ "type": "done" })).await?;
    }

    let _ = stream.shutdown().await;
    cleanup_prepared_attachments(prepared_attachments).await;
    Ok(())
}

async fn handle_chat_websocket_endpoint(
    mut stream: TcpStream,
    mut initial: Vec<u8>,
    head: RequestHead,
    state: AppState,
) -> Result<(), String> {
    let Some(auth) = auth_context(&head, &state.config) else {
        let response = json_response(401, &serde_json::json!({ "error": "Unauthorized" }));
        stream
            .write_all(&response)
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    };

    if !origin_allowed(&head) {
        stream
            .write_all(&json_response(
                403,
                &serde_json::json!({ "error": "WebSocket origin is not allowed" }),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    let Some(key) = head.headers.get("sec-websocket-key") else {
        stream
            .write_all(&json_response(
                400,
                &serde_json::json!({ "error": "Missing Sec-WebSocket-Key" }),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    };
    let accept_key = websocket_accept_key(key);
    let handshake = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept_key}\r\n\
         \r\n"
    );
    stream
        .write_all(handshake.as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    let body_start = header_end(&initial)? + 4;
    let mut websocket_buffer = initial.split_off(body_start);
    let request_body = match read_websocket_text_message(&mut stream, &mut websocket_buffer).await {
        Ok(body) => body,
        Err(error) => {
            send_ws_json(
                &mut stream,
                &serde_json::json!({ "type": "error", "message": error }),
            )
            .await?;
            send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
            send_ws_close(&mut stream).await?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };
    let chat = match serde_json::from_slice::<ChatRequest>(&request_body) {
        Ok(request) => request,
        Err(error) => {
            send_ws_json(
                &mut stream,
                &serde_json::json!({ "type": "error", "message": format!("invalid chat request: {error}") }),
            )
            .await?;
            send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
            send_ws_close(&mut stream).await?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };

    let Some(latest) = chat.messages.last() else {
        send_ws_json(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": "No messages supplied" }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        return Ok(());
    };
    if latest.role != "user" {
        send_ws_json(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": "Last message must be a user message" }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    if !chat_message_has_input(latest) {
        send_ws_json(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": "User message cannot be empty" }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        return Ok(());
    }
    let prompt = build_prompt_from_chat(&chat);

    let session_id = chat.session_id.clone();
    let prepared_attachments = match prepare_chat_attachments(&chat, &state.config.cwd).await {
        Ok(attachments) => attachments,
        Err(error) => {
            send_ws_json(
                &mut stream,
                &serde_json::json!({ "type": "error", "message": error }),
            )
            .await?;
            send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
            send_ws_close(&mut stream).await?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };
    if let Err(error) = record_chat_user_message(&state, &chat, &auth).await {
        cleanup_prepared_attachments(prepared_attachments).await;
        send_ws_json(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": error }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    let model = selected_chat_model(&chat, &state).await;
    if let Some(codex_model) = codex_app_server_model_id(&model) {
        if let Some(session_id) = session_id.as_deref() {
            send_ws_json(
                &mut stream,
                &serde_json::json!({
                    "type": "status",
                    "status": "session",
                    "details": { "sessionId": session_id, "runtime": "rust-codex-app-server" }
                }),
            )
            .await?;
        }
        handle_codex_app_server_chat_ws(
            &mut stream,
            &state,
            session_id.as_deref(),
            &codex_model,
            &prompt,
            &prepared_attachments.paths,
        )
        .await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        cleanup_prepared_attachments(prepared_attachments).await;
        return Ok(());
    }
    let (usage_provider, usage_model) = usage_provider_model(&chat, &state, &model).await;
    let thinking_enabled = chat
        .thinking_level
        .as_deref()
        .map(|level| !matches!(level, "off" | "none" | "disabled"))
        .unwrap_or(false);
    let config = NativeAgentConfig {
        model,
        cwd: state.config.cwd.to_string_lossy().to_string(),
        thinking_enabled,
        thinking_budget: env::var("MAESTRO_THINKING_BUDGET")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(10_000),
        ..NativeAgentConfig::default()
    };

    let (agent, mut events) = match NativeAgent::new(config) {
        Ok(agent) => agent,
        Err(error) => {
            send_ws_json(
                &mut stream,
                &serde_json::json!({ "type": "error", "message": error.to_string() }),
            )
            .await?;
            send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
            send_ws_close(&mut stream).await?;
            let _ = stream.shutdown().await;
            cleanup_prepared_attachments(prepared_attachments).await;
            return Ok(());
        }
    };

    send_ws_json(&mut stream, &serde_json::json!({ "type": "agent_start" })).await?;
    send_ws_json(&mut stream, &serde_json::json!({ "type": "turn_start" })).await?;

    if let Err(error) = agent
        .prompt(prompt, prepared_attachments.paths.clone())
        .await
    {
        send_ws_json(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": error.to_string() }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        cleanup_prepared_attachments(prepared_attachments).await;
        return Ok(());
    }

    let mut assistant_text = String::new();
    let mut thinking_text = String::new();
    let mut response_started = false;
    let mut thinking_started = false;
    let mut terminal_sent = false;
    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut assistant_tools: Vec<Value> = Vec::new();

    while let Some(event) = events.recv().await {
        match event {
            FromAgent::Ready { .. }
            | FromAgent::ModelChanged { .. }
            | FromAgent::ModelChangeFailed { .. }
            | FromAgent::SessionInfo { .. } => {}
            FromAgent::ResponseStart { .. } => {
                response_started = true;
                let message = composer_assistant_message(&assistant_text, &thinking_text, None);
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "message_update",
                        "message": message,
                        "assistantMessageEvent": { "type": "start", "partial": message }
                    }),
                )
                .await?;
            }
            FromAgent::ResponseChunk {
                content,
                is_thinking,
                ..
            } => {
                if !response_started {
                    response_started = true;
                }
                if is_thinking {
                    if !thinking_started {
                        thinking_started = true;
                        let message =
                            composer_assistant_message(&assistant_text, &thinking_text, None);
                        send_ws_json(
                            &mut stream,
                            &serde_json::json!({
                                "type": "message_update",
                                "message": message,
                                "assistantMessageEvent": {
                                    "type": "thinking_start",
                                    "contentIndex": 0,
                                    "partial": message
                                }
                            }),
                        )
                        .await?;
                    }
                    thinking_text.push_str(&content);
                    send_ws_json(
                        &mut stream,
                        &serde_json::json!({
                            "type": "message_update",
                            "message": composer_assistant_message(&assistant_text, &thinking_text, None),
                            "assistantMessageEvent": {
                                "type": "thinking_delta",
                                "contentIndex": 0,
                                "delta": content
                            }
                        }),
                    )
                    .await?;
                } else {
                    assistant_text.push_str(&content);
                    send_ws_json(
                        &mut stream,
                        &serde_json::json!({
                            "type": "message_update",
                            "message": composer_assistant_message(&assistant_text, &thinking_text, None),
                            "assistantMessageEvent": {
                                "type": "text_delta",
                                "contentIndex": 0,
                                "delta": content
                            }
                        }),
                    )
                    .await?;
                }
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
            } => {
                tool_names.insert(call_id.clone(), tool.clone());
                record_tool_call_metadata(&mut assistant_tools, &call_id, &tool, args.clone());
                if requires_approval {
                    match approval_mode_for_session(&state, session_id.as_deref())
                        .await
                        .as_str()
                    {
                        "auto" => {
                            let _ =
                                agent
                                    .tool_response_sender()
                                    .send((call_id.clone(), true, None));
                            send_ws_json(
                                &mut stream,
                                &serde_json::json!({
                                    "type": "tool_execution_start",
                                    "toolCallId": call_id,
                                }),
                            )
                            .await?;
                        }
                        "fail" => {
                            let _ =
                                agent
                                    .tool_response_sender()
                                    .send((call_id.clone(), false, None));
                            finish_tool_metadata(&mut assistant_tools, &call_id, false);
                            send_ws_json(
                                &mut stream,
                                &approval_blocked_tool_event(&call_id, &tool),
                            )
                            .await?;
                        }
                        _ => {
                            state
                                .pending_tool_responses
                                .lock()
                                .await
                                .insert(call_id.clone(), agent.tool_response_sender());
                            send_ws_json(
                                &mut stream,
                                &serde_json::json!({
                                    "type": "action_approval_required",
                                    "request": {
                                        "id": call_id,
                                        "toolName": tool,
                                        "args": args,
                                        "reason": "Tool execution requires approval"
                                    }
                                }),
                            )
                            .await?;
                        }
                    }
                } else {
                    send_ws_json(
                        &mut stream,
                        &serde_json::json!({
                            "type": "tool_execution_start",
                            "toolCallId": call_id,
                            "toolName": tool,
                            "args": args
                        }),
                    )
                    .await?;
                }
            }
            FromAgent::ToolStart { call_id } => {
                update_tool_metadata_status(&mut assistant_tools, &call_id, "running");
                let tool = tool_names
                    .get(&call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".to_string());
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_start",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "args": {}
                    }),
                )
                .await?;
            }
            FromAgent::ToolOutput { call_id, content } => {
                let tool = tool_names
                    .get(&call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".to_string());
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_update",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "args": {},
                        "partialResult": content
                    }),
                )
                .await?;
            }
            FromAgent::ToolEnd { call_id, success } => {
                state.pending_tool_responses.lock().await.remove(&call_id);
                finish_tool_metadata(&mut assistant_tools, &call_id, success);
                let tool = tool_names
                    .remove(&call_id)
                    .unwrap_or_else(|| "tool".to_string());
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_end",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "result": { "success": success },
                        "isError": !success
                    }),
                )
                .await?;
            }
            FromAgent::BatchStart { total } => {
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "status",
                        "status": "tool_batch_start",
                        "details": { "total": total }
                    }),
                )
                .await?;
            }
            FromAgent::BatchEnd {
                total,
                successes,
                failures,
            } => {
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_batch_summary",
                        "summary": format!("{successes}/{total} tools succeeded"),
                        "summaryLabels": [],
                        "toolCallIds": [],
                        "toolNames": [],
                        "callsSucceeded": successes,
                        "callsFailed": failures
                    }),
                )
                .await?;
            }
            FromAgent::Error { message, .. } => {
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({ "type": "error", "message": message }),
                )
                .await?;
            }
            FromAgent::Status { message } => {
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "status",
                        "status": message,
                        "details": {}
                    }),
                )
                .await?;
            }
            FromAgent::Compaction {
                summary,
                first_kept_entry_index,
                tokens_before,
                auto,
                custom_instructions,
                timestamp,
            } => {
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "compaction",
                        "summary": summary,
                        "firstKeptEntryIndex": first_kept_entry_index,
                        "tokensBefore": tokens_before,
                        "auto": auto,
                        "customInstructions": custom_instructions,
                        "timestamp": timestamp
                    }),
                )
                .await?;
            }
            FromAgent::HookBlocked {
                call_id,
                tool,
                reason,
            } => {
                state.pending_tool_responses.lock().await.remove(&call_id);
                finish_tool_metadata(&mut assistant_tools, &call_id, false);
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_end",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "result": reason,
                        "isError": true
                    }),
                )
                .await?;
            }
            FromAgent::ResponseEnd { usage, .. } => {
                record_usage_entry(
                    &state,
                    session_id.as_deref(),
                    &usage_provider,
                    &usage_model,
                    usage.as_ref(),
                )
                .await;
                let message = composer_assistant_message_with_tools(
                    &assistant_text,
                    &thinking_text,
                    usage,
                    &assistant_tools,
                );
                record_chat_assistant_message(&state, session_id.as_deref(), message.clone()).await;
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({ "type": "message_end", "message": message }),
                )
                .await?;
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "agent_end",
                        "messages": [message],
                        "stopReason": "stop"
                    }),
                )
                .await?;
                send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
                terminal_sent = true;
                break;
            }
        }
    }

    if !terminal_sent {
        send_ws_json(
            &mut stream,
            &serde_json::json!({
                "type": "error",
                "message": "Agent stream closed before response completed"
            }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
    }

    send_ws_close(&mut stream).await?;
    let _ = stream.shutdown().await;
    cleanup_prepared_attachments(prepared_attachments).await;
    Ok(())
}

async fn prepare_chat_attachments(
    chat: &ChatRequest,
    cwd: &Path,
) -> Result<PreparedAttachments, String> {
    let Some(latest) = chat.messages.last() else {
        return Ok(PreparedAttachments {
            paths: Vec::new(),
            temp_dir: None,
        });
    };
    let mut temp_dir: Option<PathBuf> = None;
    let mut paths = Vec::new();

    for (index, attachment) in latest.attachments.iter().enumerate() {
        let Some(content) = attachment
            .content
            .as_deref()
            .map(str::trim)
            .filter(|content| !content.is_empty())
        else {
            continue;
        };
        let encoded = strip_data_url_prefix(content);
        let bytes = BASE64_STANDARD.decode(encoded).map_err(|error| {
            format!(
                "attachment {} content is not valid base64: {error}",
                attachment.file_name.as_deref().unwrap_or("attachment")
            )
        })?;

        if temp_dir.is_none() {
            let dir = chat_attachment_temp_dir(cwd);
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|error| format!("failed to create attachment temp directory: {error}"))?;
            temp_dir = Some(dir);
        }
        let file_name =
            sanitize_attachment_file_name(attachment.file_name.as_deref().unwrap_or("attachment"));
        let path = temp_dir
            .as_ref()
            .expect("attachment temp dir should be initialized")
            .join(format!("{index}-{file_name}"));
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|error| format!("failed to write attachment {file_name}: {error}"))?;
        paths.push(path.to_string_lossy().to_string());
    }

    Ok(PreparedAttachments { paths, temp_dir })
}

fn strip_data_url_prefix(content: &str) -> &str {
    content
        .split_once(',')
        .filter(|(prefix, _)| prefix.starts_with("data:"))
        .map(|(_, data)| data.trim())
        .unwrap_or(content)
}

fn chat_attachment_temp_dir(cwd: &Path) -> PathBuf {
    sandbox_visible_temp_dir(cwd, "maestro-chat", &ATTACHMENT_TEMP_COUNTER)
}

fn sanitize_attachment_file_name(name: &str) -> String {
    let leaf = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("attachment")
        .trim();
    let sanitized: String = leaf
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches('_');
    if sanitized.is_empty() {
        "attachment".to_string()
    } else {
        sanitized.chars().take(120).collect()
    }
}

async fn cleanup_prepared_attachments(mut attachments: PreparedAttachments) {
    if let Some(temp_dir) = attachments.temp_dir.take() {
        let _ = tokio::fs::remove_dir_all(temp_dir).await;
    }
}

fn build_prompt_from_chat(chat: &ChatRequest) -> String {
    let mut parts = Vec::new();
    if chat.messages.len() > 1 {
        let history: Vec<Value> = chat.messages[..chat.messages.len() - 1]
            .iter()
            .map(chat_message_prompt_value)
            .collect();
        let rendered =
            serde_json::to_string_pretty(&history).expect("chat history should serialize");
        parts.push(format!(
            "Conversation so far (structured JSON, preserving content blocks and tool metadata):\n{rendered}"
        ));
        parts.push("Current user message:".to_string());
    }

    if let Some(latest) = chat.messages.last() {
        let rendered = serde_json::to_string_pretty(&chat_message_prompt_value(latest))
            .expect("chat message should serialize");
        parts.push(rendered);
        let attachment_notes: Vec<String> =
            latest.attachments.iter().map(attachment_note).collect();
        if !attachment_notes.is_empty() {
            parts.push(attachment_notes.join("\n\n"));
        }
    }

    parts.join("\n\n")
}

fn chat_message_prompt_value(message: &ChatMessage) -> Value {
    let mut object = Map::new();
    object.insert("role".to_string(), Value::String(message.role.clone()));
    object.insert("content".to_string(), message.content.clone());
    if !message.attachments.is_empty() {
        object.insert(
            "attachments".to_string(),
            serde_json::json!(message.attachments),
        );
    }
    for (key, value) in &message.extra {
        object.insert(key.clone(), value.clone());
    }
    Value::Object(object)
}

fn chat_message_has_input(message: &ChatMessage) -> bool {
    !composer_text_content(&message.content).trim().is_empty() || !message.attachments.is_empty()
}

fn attachment_note(attachment: &ChatAttachment) -> String {
    let name = attachment.file_name.as_deref().unwrap_or("attachment");
    if let Some(text) = attachment
        .extracted_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return format!("Attachment {name}:\n{text}");
    }

    let mime = attachment
        .mime_type
        .as_deref()
        .filter(|mime| !mime.trim().is_empty())
        .unwrap_or("unknown type");
    let kind = attachment
        .attachment_type
        .as_deref()
        .filter(|kind| !kind.trim().is_empty())
        .unwrap_or("file");
    let id = attachment
        .id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .map(|id| format!(" id={id}"))
        .unwrap_or_default();
    if attachment
        .content
        .as_deref()
        .is_some_and(|content| !content.trim().is_empty())
    {
        format!("Attachment {name}{id} ({kind}, {mime}) is attached for model input.")
    } else if attachment.content_omitted.unwrap_or(false) {
        format!(
            "Attachment {name}{id} ({kind}, {mime}) was referenced, but its content was omitted."
        )
    } else {
        format!("Attachment {name}{id} ({kind}, {mime}) was referenced.")
    }
}

fn composer_text_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .map(|block| {
                if let Some(object) = block.as_object() {
                    if object.get("type").and_then(Value::as_str) == Some("text") {
                        return object
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                    }
                }
                block.to_string()
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn composer_assistant_message(content: &str, thinking: &str, usage: Option<TokenUsage>) -> Value {
    composer_assistant_message_with_tools(content, thinking, usage, &[])
}

fn composer_assistant_message_with_tools(
    content: &str,
    thinking: &str,
    usage: Option<TokenUsage>,
    tools: &[Value],
) -> Value {
    let mut message = serde_json::json!({
        "role": "assistant",
        "content": content,
        "timestamp": now_rfc3339()
    });
    if !thinking.is_empty() {
        message["thinking"] = Value::String(thinking.to_string());
    }
    if let Some(usage) = usage {
        message["usage"] = serde_json::json!({
            "input": usage.input_tokens,
            "output": usage.output_tokens,
            "cacheRead": usage.cache_read_tokens,
            "cacheWrite": usage.cache_write_tokens,
            "cost": {
                "input": 0.0,
                "output": 0.0,
                "cacheRead": 0.0,
                "cacheWrite": 0.0,
                "total": usage.cost.unwrap_or(0.0)
            }
        });
    }
    if !tools.is_empty() {
        message["tools"] = Value::Array(tools.to_vec());
    }
    message
}

fn record_tool_call_metadata(tools: &mut Vec<Value>, call_id: &str, name: &str, args: Value) {
    tools.push(serde_json::json!({
        "id": call_id,
        "name": name,
        "args": args,
        "status": "pending"
    }));
}

fn update_tool_metadata_status(tools: &mut [Value], call_id: &str, status: &str) {
    if let Some(tool) = tools
        .iter_mut()
        .find(|tool| tool.get("id").and_then(Value::as_str) == Some(call_id))
    {
        tool["status"] = Value::String(status.to_string());
    }
}

fn finish_tool_metadata(tools: &mut [Value], call_id: &str, success: bool) {
    if let Some(tool) = tools
        .iter_mut()
        .find(|tool| tool.get("id").and_then(Value::as_str) == Some(call_id))
    {
        tool["status"] = Value::String(if success { "completed" } else { "error" }.to_string());
        tool["result"] = serde_json::json!({
            "success": success,
            "isError": !success
        });
    }
}

fn approval_blocked_tool_event(call_id: &str, tool_name: &str) -> Value {
    serde_json::json!({
        "type": "tool_execution_end",
        "toolCallId": call_id,
        "toolName": tool_name,
        "result": {
            "content": [
                {
                    "type": "text",
                    "text": "Tool execution blocked by approval mode"
                }
            ],
            "isError": true,
            "timestamp": now_rfc3339()
        },
        "isError": true
    })
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn send_sse(stream: &mut TcpStream, value: &Value) -> Result<(), String> {
    let body = serde_json::to_string(value).map_err(|error| error.to_string())?;
    stream
        .write_all(format!("data: {body}\n\n").as_bytes())
        .await
        .map_err(|error| error.to_string())
}

fn websocket_accept_key(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    BASE64_STANDARD.encode(hasher.finalize())
}

async fn send_ws_json(stream: &mut TcpStream, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    write_ws_text_frame(stream, &body).await
}

async fn write_ws_text_frame(stream: &mut TcpStream, payload: &[u8]) -> Result<(), String> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x81);
    if payload.len() < 126 {
        frame.push(payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        frame.push(126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    stream
        .write_all(&frame)
        .await
        .map_err(|error| error.to_string())
}

async fn send_ws_close(stream: &mut TcpStream) -> Result<(), String> {
    stream
        .write_all(&[0x88, 0x00])
        .await
        .map_err(|error| error.to_string())
}

async fn read_websocket_text_message(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
) -> Result<Vec<u8>, String> {
    loop {
        if let Some(message) = try_parse_websocket_text_message(buffer)? {
            return Ok(message);
        }

        let mut chunk = [0u8; 4096];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("WebSocket closed before chat request".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_JSON_BODY_BYTES + 14 {
            return Err("WebSocket chat request exceeds maximum allowed size".to_string());
        }
    }
}

fn try_parse_websocket_text_message(buffer: &mut Vec<u8>) -> Result<Option<Vec<u8>>, String> {
    let mut cursor = 0usize;
    let mut started = false;
    let mut message = Vec::new();

    loop {
        let Some(frame) = parse_websocket_frame(buffer, cursor)? else {
            return Ok(None);
        };

        match frame.opcode {
            0x0 => {
                if !started {
                    return Err("unexpected WebSocket continuation frame".to_string());
                }
            }
            0x1 | 0x2 => {
                if started {
                    return Err(
                        "new WebSocket data frame started before continuation finished".to_string(),
                    );
                }
                started = true;
            }
            0x8 => return Err("WebSocket closed before chat request".to_string()),
            opcode => return Err(format!("unsupported WebSocket opcode: {opcode}")),
        }

        message.extend_from_slice(&frame.payload);
        if message.len() > MAX_JSON_BODY_BYTES {
            return Err("WebSocket chat request exceeds maximum allowed size".to_string());
        }
        cursor = frame.next;

        if frame.fin {
            buffer.drain(..cursor);
            return Ok(Some(message));
        }
    }
}

struct ParsedWebSocketFrame {
    fin: bool,
    opcode: u8,
    payload: Vec<u8>,
    next: usize,
}

fn parse_websocket_frame(
    buffer: &[u8],
    start: usize,
) -> Result<Option<ParsedWebSocketFrame>, String> {
    if buffer.len() < start + 2 {
        return Ok(None);
    }

    let fin = buffer[start] & 0x80 != 0;
    let opcode = buffer[start] & 0x0f;
    let masked = buffer[start + 1] & 0x80 != 0;
    if !masked {
        return Err("client WebSocket frames must be masked".to_string());
    }

    let mut offset = start + 2;
    let mut len = (buffer[start + 1] & 0x7f) as usize;
    if len == 126 {
        if buffer.len() < offset + 2 {
            return Ok(None);
        }
        len = u16::from_be_bytes([buffer[offset], buffer[offset + 1]]) as usize;
        offset += 2;
    } else if len == 127 {
        if buffer.len() < offset + 8 {
            return Ok(None);
        }
        let raw_len = u64::from_be_bytes([
            buffer[offset],
            buffer[offset + 1],
            buffer[offset + 2],
            buffer[offset + 3],
            buffer[offset + 4],
            buffer[offset + 5],
            buffer[offset + 6],
            buffer[offset + 7],
        ]);
        len = usize::try_from(raw_len)
            .map_err(|_| "WebSocket frame length is too large".to_string())?;
        offset += 8;
    }

    if len > MAX_JSON_BODY_BYTES {
        return Err("WebSocket chat request exceeds maximum allowed size".to_string());
    }
    if buffer.len() < offset + 4 + len {
        return Ok(None);
    }

    let mask = [
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ];
    offset += 4;
    let mut payload = buffer[offset..offset + len].to_vec();
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
    Ok(Some(ParsedWebSocketFrame {
        fin,
        opcode,
        payload,
        next: offset + len,
    }))
}

fn sse_headers() -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
        response_cors_origin(),
        response_cors_credentials_header()
    )
}

async fn build_status_snapshot(state: &AppState) -> StatusSnapshot {
    let started = Instant::now();
    let cwd = state.config.cwd.clone();
    let git = git_snapshot(&cwd).await;
    let agent_md_path = cwd.join("AGENT.md");
    let agents_md_path = cwd.join("AGENTS.md");
    let claude_md_path = cwd.join("CLAUDE.md");
    let context = ContextSnapshot {
        agent_md: async_path_exists(agent_md_path).await || async_path_exists(agents_md_path).await,
        claude_md: async_path_exists(claude_md_path).await,
    };
    let onboarding = onboarding_snapshot(&cwd).await;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    StatusSnapshot {
        cwd: cwd.to_string_lossy().to_string(),
        git,
        context,
        onboarding,
        server: ServerSnapshot {
            uptime: state.started_at.elapsed().as_secs_f64(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            static_cache_max_age_seconds: state.config.static_cache_max_age,
            runtime: "rust-control-plane",
        },
        database: DatabaseSnapshot {
            configured: env::var("DATABASE_URL")
                .or_else(|_| env::var("MAESTRO_DATABASE_URL"))
                .ok()
                .is_some(),
            connected: false,
        },
        background_tasks: None,
        hooks: HooksSnapshot {
            async_in_flight: 0,
            concurrency: HookConcurrencySnapshot {
                max: 0,
                active: 0,
                queued: 0,
            },
        },
        last_updated: now,
        last_latency_ms: started.elapsed().as_millis(),
    }
}

async fn git_snapshot(cwd: &Path) -> Option<GitSnapshot> {
    let branch = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()?;
    let status_output = run_git(cwd, &["status", "--porcelain"]).await.ok()?;
    let status = parse_git_status(&status_output);
    Some(GitSnapshot { branch, status })
}

fn parse_git_status(status_output: &str) -> GitStatus {
    let lines: Vec<&str> = status_output
        .lines()
        .filter(|line| !line.is_empty())
        .collect();
    let tracked_codes = lines.iter().filter_map(|line| {
        if line.starts_with("??") {
            return None;
        }
        Some(line.chars().take(2).collect::<Vec<char>>())
    });

    let mut modified = 0;
    let mut added = 0;
    let mut deleted = 0;
    for codes in tracked_codes {
        if codes.iter().any(|code| matches!(code, 'M' | 'T' | 'U')) {
            modified += 1;
        }
        if codes.iter().any(|code| matches!(code, 'A' | 'R' | 'C')) {
            added += 1;
        }
        if codes.contains(&'D') {
            deleted += 1;
        }
    }

    GitStatus {
        modified,
        added,
        deleted,
        untracked: lines.iter().filter(|line| line.starts_with("??")).count(),
        total: lines.len(),
    }
}

async fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn onboarding_snapshot(cwd: &Path) -> OnboardingSnapshot {
    let workspace_empty = workspace_is_empty_for_onboarding(cwd).await;
    let has_instructions = async_path_exists(cwd.join("AGENT.md")).await
        || async_path_exists(cwd.join("AGENTS.md")).await
        || async_path_exists(cwd.join("CLAUDE.md")).await;
    let stored = read_project_onboarding_entry(cwd).await;
    let stored_seen_count = stored
        .as_ref()
        .and_then(|entry| entry.get("seenCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u8::MAX as u64) as u8;
    let stored_completed = stored
        .as_ref()
        .and_then(|entry| entry.get("completed"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let snapshot = compute_onboarding_snapshot(
        workspace_empty,
        has_instructions,
        stored_seen_count,
        stored_completed,
    );
    if snapshot.completed && !stored_completed {
        persist_project_onboarding_entry(cwd, snapshot.seen_count, true).await;
    }
    snapshot
}

fn compute_onboarding_snapshot(
    workspace_empty: bool,
    has_instructions: bool,
    seen_count: u8,
    stored_completed: bool,
) -> OnboardingSnapshot {
    let steps = vec![
        OnboardingStep {
            key: "workspace",
            text: "Ask Maestro to create a new app or clone a repository.",
            is_complete: !workspace_empty,
            is_enabled: workspace_empty,
        },
        OnboardingStep {
            key: "instructions",
            text: "Run /init to scaffold AGENTS.md instructions for this project.",
            is_complete: has_instructions,
            is_enabled: !workspace_empty,
        },
    ];
    let completed = steps
        .iter()
        .filter(|step| step.is_enabled)
        .all(|step| step.is_complete);
    let completed = stored_completed || completed;
    OnboardingSnapshot {
        should_show: !completed
            && seen_count < MAX_PROJECT_ONBOARDING_IMPRESSIONS
            && steps
                .iter()
                .any(|step| step.is_enabled && !step.is_complete),
        completed,
        seen_count,
        steps,
    }
}

async fn mark_project_onboarding_seen(cwd: &Path) {
    let snapshot = onboarding_snapshot(cwd).await;
    if !snapshot.should_show {
        return;
    }
    persist_project_onboarding_entry(
        cwd,
        snapshot
            .seen_count
            .saturating_add(1)
            .min(MAX_PROJECT_ONBOARDING_IMPRESSIONS),
        snapshot.completed,
    )
    .await;
}

async fn read_project_onboarding_entry(cwd: &Path) -> Option<Value> {
    let path = project_onboarding_path();
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    let store = serde_json::from_str::<Value>(&raw).ok()?;
    if store.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    store
        .get("projects")
        .and_then(Value::as_object)
        .and_then(|projects| projects.get(&project_onboarding_key(cwd)).cloned())
}

async fn persist_project_onboarding_entry(cwd: &Path, seen_count: u8, completed: bool) {
    let path = project_onboarding_path();
    let mut store = tokio::fs::read_to_string(&path)
        .await
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.get("version").and_then(Value::as_u64) == Some(1))
        .unwrap_or_else(|| serde_json::json!({ "version": 1, "projects": {} }));
    if !store.get("projects").map(Value::is_object).unwrap_or(false) {
        store["projects"] = serde_json::json!({});
    }
    if let Some(projects) = store.get_mut("projects").and_then(Value::as_object_mut) {
        projects.insert(
            project_onboarding_key(cwd),
            serde_json::json!({
                "seenCount": seen_count,
                "completed": completed,
                "updatedAt": now_rfc3339()
            }),
        );
    }
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Ok(serialized) = serde_json::to_vec_pretty(&store) {
        let _ = tokio::fs::write(path, serialized).await;
    }
}

fn project_onboarding_path() -> PathBuf {
    env::var("MAESTRO_PROJECT_ONBOARDING_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| maestro_home().join("project-onboarding.json"))
}

fn project_onboarding_key(cwd: &Path) -> String {
    cwd.canonicalize()
        .unwrap_or_else(|_| {
            if cwd.is_absolute() {
                cwd.to_path_buf()
            } else {
                env::current_dir()
                    .map(|current| current.join(cwd))
                    .unwrap_or_else(|_| cwd.to_path_buf())
            }
        })
        .to_string_lossy()
        .to_string()
}

async fn workspace_is_empty_for_onboarding(cwd: &Path) -> bool {
    let Ok(mut entries) = tokio::fs::read_dir(cwd).await else {
        return false;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !matches!(
            name.as_ref(),
            ".DS_Store"
                | ".git"
                | ".gitignore"
                | ".maestro"
                | "Thumbs.db"
                | "AGENT.md"
                | "AGENTS.md"
                | "CLAUDE.md"
        ) {
            return false;
        }
    }
    true
}

async fn async_path_exists(path: PathBuf) -> bool {
    tokio::fs::metadata(path).await.is_ok()
}

fn env_u16(name: &str, default: u16) -> u16 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

fn trimmed_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn truthy_env(name: &str) -> bool {
    trimmed_env(name)
        .map(|value| {
            let normalized = value.to_ascii_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "off" | "no")
        })
        .unwrap_or(false)
}

fn llm_gateway_models_url() -> Option<String> {
    if let Some(url) = trimmed_env("MAESTRO_LLM_GATEWAY_MODELS_URL") {
        return Some(url);
    }
    if let Some(base) = trimmed_env("MAESTRO_LLM_GATEWAY_URL") {
        return Some(format!("{}/v1/models", base.trim_end_matches('/')));
    }
    if let Some(url) = trimmed_env("MAESTRO_OPENROUTER_MODELS_URL") {
        return Some(url);
    }
    if truthy_env("MAESTRO_ENABLE_OPENROUTER_MODELS")
        || trimmed_env("MAESTRO_OPENROUTER_API_KEY").is_some()
        || trimmed_env("OPENROUTER_API_KEY").is_some()
    {
        return Some("https://openrouter.ai/api/v1/models".to_string());
    }
    None
}

fn is_openrouter_models_url(url: &str) -> bool {
    url.contains("openrouter.ai/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    static ENV_LOCK: Mutex<()> = Mutex::const_new(());

    #[test]
    fn cli_args_default_to_serving() {
        assert_eq!(
            parse_cli_action(Vec::<String>::new()).unwrap(),
            CliAction::Serve
        );
    }

    #[test]
    fn cli_args_handle_help_and_version_without_serving() {
        assert_eq!(parse_cli_action(["--help"]).unwrap(), CliAction::Help);
        assert_eq!(parse_cli_action(["-h"]).unwrap(), CliAction::Help);
        assert_eq!(parse_cli_action(["--version"]).unwrap(), CliAction::Version);
        assert_eq!(parse_cli_action(["-V"]).unwrap(), CliAction::Version);
    }

    #[test]
    fn cli_args_reject_unknown_values() {
        let error = parse_cli_action(["--wat"]).unwrap_err();
        assert!(error.contains("--wat"));
    }

    #[test]
    fn codex_app_server_model_ids_require_openai_codex_prefix() {
        assert_eq!(
            codex_app_server_model_id("openai-codex/gpt-5.5").as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(
            codex_app_server_model_id(" openai-codex/gpt-5.1-codex-max ").as_deref(),
            Some("gpt-5.1-codex-max")
        );
        assert!(codex_app_server_model_id("openai/gpt-5.5").is_none());
        assert!(codex_app_server_model_id("openai-codex/").is_none());
    }

    #[test]
    fn codex_app_server_sandbox_mode_inherits_without_forcing_read_only() {
        assert_eq!(codex_app_server_sandbox_mode_from_values(None, None), None);
        assert_eq!(
            codex_app_server_sandbox_mode_from_values(None, Some("workspace-write")).as_deref(),
            Some("workspace-write")
        );
        assert_eq!(
            codex_app_server_sandbox_mode_from_values(
                Some("danger-full-access"),
                Some("read-only")
            )
            .as_deref(),
            Some("danger-full-access")
        );
        assert_eq!(
            codex_app_server_sandbox_mode_from_values(Some("inherit"), Some("workspace-write")),
            None
        );
    }

    #[test]
    fn assistant_text_from_jsonl_reads_assistant_completion_only() {
        let jsonl = r#"noise line
{"type":"turn","phase":"start","role":"user","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"user text"}}
{"type":"turn","phase":"end","role":"user","turnId":"turn-1"}
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-2"}
{"type":"item","subtype":"message_delta","turnId":"turn-2","data":{"text":"partial"}}
{"type":"item","subtype":"message_complete","turnId":"turn-2","data":{"text":"assistant text"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-2"}
        "#;
        assert_eq!(
            assistant_text_from_jsonl(jsonl).as_deref(),
            Ok("assistant text")
        );
    }

    #[test]
    fn assistant_text_from_jsonl_requires_assistant_completion() {
        let jsonl = r#"
{"type":"thread","phase":"start","threadId":"thread-1"}
{"type":"turn","phase":"start","role":"user","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"user text"}}
{"type":"turn","phase":"end","role":"user","turnId":"turn-1"}
"#;
        assert!(assistant_text_from_jsonl(jsonl)
            .unwrap_err()
            .contains("without an assistant message"));
    }

    #[test]
    fn assistant_text_from_jsonl_rejects_error_stop_reason() {
        let jsonl = r#"
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"","stopReason":"error"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
        assert!(assistant_text_from_jsonl(jsonl)
            .unwrap_err()
            .contains("error stop reason"));
    }

    #[test]
    fn assistant_text_from_jsonl_rejects_empty_assistant_text() {
        let jsonl = r#"
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"","stopReason":"stop"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
        assert!(assistant_text_from_jsonl(jsonl)
            .unwrap_err()
            .contains("empty assistant message"));
    }

    #[test]
    fn assistant_output_from_jsonl_reads_usage() {
        let jsonl = r#"
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"assistant text","stopReason":"stop","usage":{"input":123,"output":45,"cacheRead":7,"cacheWrite":3,"cost":{"input":0.1,"output":0.2,"cacheRead":0.01,"cacheWrite":0.02,"total":0.33}}}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
        let output = assistant_output_from_jsonl(jsonl).expect("assistant output");
        let usage = output.usage.expect("usage");

        assert_eq!(output.text, "assistant text");
        assert_eq!(usage.input_tokens, 123);
        assert_eq!(usage.output_tokens, 45);
        assert_eq!(usage.cache_read_tokens, 7);
        assert_eq!(usage.cache_write_tokens, 3);
        assert_eq!(usage.cost, Some(0.33));
    }

    #[test]
    fn assistant_output_from_jsonl_records_codex_collab_tool_items() {
        let jsonl = r#"
{"type":"item.started","item":{"id":"collab-call-1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"prompt":"Inspect routing","agents_states":{},"status":"in_progress"}}
{"type":"item.completed","item":{"id":"collab-call-1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"prompt":"Inspect routing","agents_states":{"thread-child":{"status":"completed","message":"Done"}},"status":"completed"}}
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"assistant text","stopReason":"stop"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
        let output = assistant_output_from_jsonl(jsonl).expect("assistant output");

        assert_eq!(output.text, "assistant text");
        assert_eq!(output.tool_events.len(), 2);
        assert_eq!(output.tool_events[0].event_type, "tool_execution_start");
        assert_eq!(output.tool_events[0].tool_call_id, "collab-call-1");
        assert_eq!(output.tool_events[0].tool_name, "codex.subagent.spawnAgent");
        assert_eq!(
            output.tool_events[0].args["receiverThreadIds"],
            serde_json::json!(["thread-child"])
        );
        assert_eq!(
            output.tool_events[0].args["childRunIds"],
            serde_json::json!(["codex-thread:thread-child"])
        );
        assert_eq!(
            output.tool_events[0].args["codexWorkGraph"]["schemaVersion"],
            CODEX_SUBAGENT_WORK_GRAPH_SCHEMA
        );
        assert_eq!(
            output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["childRunId"],
            "codex-thread:thread-child"
        );
        assert_eq!(
            output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["edgeId"],
            "collab-call-1:0:spawnAgent:codex-thread:thread-child"
        );
        assert_eq!(
            output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["targetIndex"],
            serde_json::json!(0)
        );
        assert!(output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["status"].is_null());
        assert_eq!(output.tool_events[1].event_type, "tool_execution_end");
        assert_eq!(output.tool_events[1].is_error, Some(false));
        assert_eq!(
            output.tool_events[1].result["details"]["codexWorkGraph"]["status"],
            "completed"
        );
        assert_eq!(
            output.tool_events[1].result["details"]["codexWorkGraph"]["childRuns"][0]["status"],
            "completed"
        );
        assert_eq!(
            output.tool_events[1].result["details"]["agentsStates"]["thread-child"]["status"],
            "completed"
        );
    }

    #[test]
    fn assistant_output_from_jsonl_normalizes_codex_collab_tool_aliases() {
        let jsonl = r#"
{"type":"item.started","item":{"id":"collab-call-wait","type":"collab_tool_call","tool":"wait_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"child_run_ids":["agent-run-child-1"],"agents_states":{},"status":"in_progress"}}
{"type":"item.completed","item":{"id":"collab-call-wait","type":"collab_tool_call","tool":"wait_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"child_run_ids":["agent-run-child-1"],"agents_states":{},"status":"completed"}}
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"assistant text","stopReason":"stop"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
        let output = assistant_output_from_jsonl(jsonl).expect("assistant output");

        assert_eq!(output.tool_events.len(), 2);
        assert_eq!(output.tool_events[0].tool_name, "codex.subagent.wait");
        assert_eq!(
            output.tool_events[0].display_name.as_deref(),
            Some("Codex subagent: wait")
        );
        assert_eq!(
            output.tool_events[0].args["codexTool"],
            serde_json::json!("wait")
        );
        assert_eq!(
            output.tool_events[0].args["codexWorkGraph"]["tool"],
            serde_json::json!("wait")
        );
        assert_eq!(
            output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["operation"],
            serde_json::json!("wait")
        );
        assert_eq!(output.tool_events[1].tool_name, "codex.subagent.wait");
        assert_eq!(
            output.tool_events[1].result["details"]["codexTool"],
            serde_json::json!("wait")
        );
    }

    #[test]
    fn assistant_output_from_jsonl_preserves_explicit_codex_child_run_ids() {
        let jsonl = r#"
{"type":"item.started","item":{"id":"collab-call-1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"child_run_ids":["agent-run-child-1"],"prompt":"Inspect routing","agents_states":{},"status":"in_progress"}}
{"type":"item.completed","item":{"id":"collab-call-1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"thread-main","receiver_thread_ids":["thread-child"],"child_run_ids":["agent-run-child-1"],"prompt":"Inspect routing","agents_states":{},"status":"completed"}}
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"assistant text","stopReason":"stop"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
        let output = assistant_output_from_jsonl(jsonl).expect("assistant output");

        assert_eq!(
            output.tool_events[0].args["childRunIds"],
            serde_json::json!(["agent-run-child-1"])
        );
        assert_eq!(
            output.tool_events[1].result["details"]["childRunIds"],
            serde_json::json!(["agent-run-child-1"])
        );
        assert_eq!(
            output.tool_events[1].result["details"]["codexWorkGraph"]["childRuns"][0]["childRunId"],
            "agent-run-child-1"
        );
    }

    #[test]
    fn assistant_output_from_jsonl_records_maestro_headless_tool_events() {
        let jsonl = r#"
{"type":"item","subtype":"tool_call","data":{"toolCallId":"collab-call-2","toolName":"codex.subagent.wait","args":{"codexTool":"wait","receiverThreadIds":["thread-child"]}}}
{"type":"item","subtype":"tool_result","data":{"toolCallId":"collab-call-2","toolName":"codex.subagent.wait","result":{"role":"toolResult","toolCallId":"collab-call-2","toolName":"codex.subagent.wait","content":[{"type":"text","text":"wait completed"}],"isError":false,"timestamp":1},"isError":false}}
{"type":"turn","phase":"start","role":"assistant","turnId":"turn-1"}
{"type":"item","subtype":"message_complete","turnId":"turn-1","data":{"text":"assistant text","stopReason":"stop"}}
{"type":"turn","phase":"end","role":"assistant","turnId":"turn-1"}
"#;
        let output = assistant_output_from_jsonl(jsonl).expect("assistant output");

        assert_eq!(output.tool_events.len(), 2);
        assert_eq!(output.tool_events[0].tool_name, "codex.subagent.wait");
        assert_eq!(
            output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["childRunId"],
            "codex-thread:thread-child"
        );
        assert_eq!(
            output.tool_events[0].args["codexWorkGraph"]["toolCallId"],
            "collab-call-2"
        );
        assert_eq!(
            output.tool_events[0].args["codexWorkGraph"]["childRuns"][0]["edgeId"],
            "collab-call-2:0:wait:codex-thread:thread-child"
        );
        assert_eq!(output.tool_events[1].is_error, Some(false));
        assert_eq!(
            output.tool_events[1].result["content"][0]["text"],
            "wait completed"
        );
    }

    #[test]
    fn codex_headless_usage_omits_empty_usage() {
        let event = serde_json::json!({
            "type": "response_end",
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0
            }
        });

        assert!(codex_headless_usage_from_json(&event).is_none());
    }

    #[test]
    fn codex_headless_tool_events_preserve_subagent_lifecycle() {
        let start = codex_headless_tool_event_from_json(&serde_json::json!({
            "type": "tool_call",
            "call_id": "collab-call-3",
            "tool": "codex.subagent.sendInput",
            "args": {
                "codexTool": "sendInput",
                "receiverThreadIds": ["thread-child"],
                "prompt": "Please continue"
            }
        }))
        .expect("start event");
        let end = codex_headless_tool_event_from_json(&serde_json::json!({
            "type": "tool_end",
            "call_id": "collab-call-3",
            "tool": "codex.subagent.sendInput",
            "success": false,
            "error_code": "subagent_not_found",
            "details": {
                "receiverThreadIds": ["thread-child"],
                "childRunIds": ["agent-run-child-1"],
                "agentsStates": {
                    "thread-child": { "status": "failed" }
                }
            }
        }))
        .expect("end event");

        assert_eq!(start.event_type, "tool_execution_start");
        assert_eq!(start.tool_name, "codex.subagent.sendInput");
        assert_eq!(start.args["prompt"], "Please continue");
        assert_eq!(start.args["toolCallId"], "collab-call-3");
        assert_eq!(start.args["codexWorkGraph"]["toolCallId"], "collab-call-3");
        assert_eq!(
            start.args["codexWorkGraph"]["childRuns"][0]["edgeId"],
            "collab-call-3:0:sendInput:codex-thread:thread-child"
        );
        assert_eq!(end.event_type, "tool_execution_end");
        assert_eq!(end.tool_call_id, "collab-call-3");
        assert_eq!(end.is_error, Some(true));
        assert_eq!(end.result["details"]["errorCode"], "subagent_not_found");
        assert_eq!(
            end.result["details"]["receiverThreadIds"],
            serde_json::json!(["thread-child"])
        );
        assert_eq!(
            end.result["details"]["childRunIds"],
            serde_json::json!(["agent-run-child-1"])
        );
        assert_eq!(
            end.result["details"]["agentsStates"]["thread-child"]["status"],
            "failed"
        );
        assert_eq!(
            end.result["content"][0]["text"],
            "codex.subagent.sendInput failed"
        );
    }

    #[test]
    fn codex_headless_tool_events_normalize_snake_case_subagent_targets() {
        let start = codex_headless_tool_event_from_json(&serde_json::json!({
            "type": "tool_call",
            "call_id": "collab-call-snake",
            "tool": "codex.subagent.send_input",
            "args": {
                "codex_tool": "send_input",
                "sender_thread_id": "thread-parent",
                "receiver_thread_ids": ["thread-child"],
                "child_run_ids": ["agent-run-child-1"],
                "agents_states": {
                    "thread-child": { "status": "acknowledged" }
                }
            }
        }))
        .expect("start event");

        assert_eq!(start.tool_name, "codex.subagent.sendInput");
        assert_eq!(start.args["codexTool"], serde_json::json!("sendInput"));
        assert_eq!(
            start.args["receiverThreadIds"],
            serde_json::json!(["thread-child"])
        );
        assert_eq!(
            start.args["childRunIds"],
            serde_json::json!(["agent-run-child-1"])
        );
        assert_eq!(start.args["senderThreadId"], "thread-parent");
        assert_eq!(
            start.args["codexWorkGraph"]["parent"]["senderThreadId"],
            "thread-parent"
        );
        assert_eq!(
            start.args["codexWorkGraph"]["childRuns"][0]["threadId"],
            "thread-child"
        );
        assert_eq!(
            start.args["codexWorkGraph"]["childRuns"][0]["childRunId"],
            "agent-run-child-1"
        );
        assert_eq!(
            start.args["codexWorkGraph"]["childRuns"][0]["status"],
            "acknowledged"
        );
        assert_eq!(
            start.args["codexWorkGraph"]["childRuns"][0]["edgeId"],
            "collab-call-snake:0:sendInput:agent-run-child-1"
        );
    }

    #[test]
    fn codex_headless_tool_events_build_work_graph_from_child_run_ids_only() {
        let start = codex_headless_tool_event_from_json(&serde_json::json!({
            "type": "tool_call",
            "call_id": "collab-call-child-only",
            "tool": "codex.subagent.wait",
            "args": {
                "child_run_ids": ["agent-run-child-only"]
            }
        }))
        .expect("start event");

        assert_eq!(
            start.args["codexWorkGraph"]["childRuns"][0]["childRunId"],
            "agent-run-child-only"
        );
        assert!(start.args["codexWorkGraph"]["childRuns"][0]["threadId"].is_null());
    }

    #[test]
    fn codex_headless_tool_events_normalize_subagent_aliases() {
        let start = codex_headless_tool_event_from_json(&serde_json::json!({
            "type": "tool_call",
            "call_id": "collab-call-5",
            "tool": "codex.subagent.resume_subagent",
            "args": {
                "codexTool": "resume_subagent",
                "receiverThreadIds": ["thread-child"],
                "childRunIds": ["agent-run-child-1"]
            }
        }))
        .expect("start event");
        let end = codex_headless_tool_event_from_json(&serde_json::json!({
            "type": "tool_end",
            "call_id": "collab-call-5",
            "tool": "codex.subagent.resume_subagent",
            "success": true
        }))
        .expect("end event");

        assert_eq!(start.tool_name, "codex.subagent.resumeAgent");
        assert_eq!(start.args["codexTool"], serde_json::json!("resumeAgent"));
        assert_eq!(
            start.args["codexWorkGraph"]["tool"],
            serde_json::json!("resumeAgent")
        );
        assert_eq!(
            start.args["codexWorkGraph"]["childRuns"][0]["operation"],
            serde_json::json!("resumeAgent")
        );
        assert_eq!(end.tool_name, "codex.subagent.resumeAgent");
        assert_eq!(
            end.result["content"][0]["text"],
            "codex.subagent.resumeAgent completed"
        );
    }

    #[test]
    fn codex_headless_subagent_lifecycle_matches_workgraph_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../docs/protocols/codex-subagent-workgraph-v1.json"
        ))
        .expect("work graph fixture should parse");
        assert_eq!(
            fixture["schemaVersion"],
            serde_json::json!(CODEX_SUBAGENT_WORK_GRAPH_SCHEMA)
        );
        assert_eq!(fixture["toolPrefix"], "codex.subagent.");
        assert_eq!(fixture["threadChildRunPrefix"], "codex-thread:");

        let operations = fixture["operations"]
            .as_array()
            .expect("fixture operations should be an array");
        let mut seen_tools = Vec::new();
        for operation in operations {
            let tool = operation["tool"].as_str().expect("tool");
            let operation_name = operation["operation"].as_str().expect("operation");
            let aliases = operation["aliases"].as_array().expect("aliases");
            assert_eq!(codex_canonical_collab_tool(tool), tool);
            assert_eq!(codex_canonical_collab_tool(operation_name), tool);
            seen_tools.push(tool.to_string());

            for alias in aliases {
                let alias = alias.as_str().expect("alias");
                assert_eq!(codex_canonical_collab_tool(alias), tool);
                let start = codex_headless_tool_event_from_json(&serde_json::json!({
                    "type": "tool_call",
                    "call_id": format!("collab-{operation_name}"),
                    "tool": format!("codex.subagent.{alias}"),
                    "args": {
                        "codexTool": alias,
                        "senderThreadId": "thread-parent",
                        "receiverThreadIds": ["thread-child"],
                        "childRunIds": ["agent-run-child-1"]
                    }
                }))
                .expect("start event");

                assert_eq!(start.tool_name, format!("codex.subagent.{tool}"));
                assert_eq!(start.args["codexTool"], serde_json::json!(tool));
                assert_eq!(start.args["senderThreadId"], "thread-parent");
                assert_eq!(
                    start.args["codexWorkGraph"]["schemaVersion"],
                    serde_json::json!(CODEX_SUBAGENT_WORK_GRAPH_SCHEMA)
                );
                assert_eq!(
                    start.args["codexWorkGraph"]["tool"],
                    serde_json::json!(tool)
                );
                assert_eq!(
                    start.args["codexWorkGraph"]["childRuns"][0]["operation"],
                    serde_json::json!(tool)
                );
                assert_eq!(
                    start.args["codexWorkGraph"]["childRuns"][0]["childRunId"],
                    "agent-run-child-1"
                );
            }
        }

        assert_eq!(
            seen_tools,
            vec![
                "spawnAgent",
                "sendInput",
                "resumeAgent",
                "wait",
                "closeAgent"
            ]
        );
    }

    #[test]
    fn codex_headless_tool_end_uses_start_context_when_end_omits_tool_name() {
        let mut contexts = HashMap::new();
        let _ = codex_headless_tool_event_from_json_with_context(
            &serde_json::json!({
                "type": "tool_call",
                "call_id": "collab-call-4",
                "tool": "codex.subagent.spawnAgent",
                "args": {
                    "codexTool": "spawnAgent",
                    "receiverThreadIds": []
                }
            }),
            &mut contexts,
        )
        .expect("start event");
        let end = codex_headless_tool_event_from_json_with_context(
            &serde_json::json!({
                "type": "tool_end",
                "call_id": "collab-call-4",
                "success": true,
                "details": {
                    "receiverThreadIds": ["thread-child-complete"],
                    "childRunIds": ["agent-run-child-complete"]
                }
            }),
            &mut contexts,
        )
        .expect("end event");

        assert_eq!(end.tool_name, "codex.subagent.spawnAgent");
        assert_eq!(end.summary_label.as_deref(), Some("spawn agent"));
        assert_eq!(
            end.result["content"][0]["text"],
            "codex.subagent.spawnAgent completed"
        );
        assert_eq!(end.result["details"]["args"]["codexTool"], "spawnAgent");
        assert_eq!(
            end.result["details"]["receiverThreadIds"],
            serde_json::json!(["thread-child-complete"])
        );
        assert_eq!(
            end.result["details"]["childRunIds"],
            serde_json::json!(["agent-run-child-complete"])
        );
    }

    #[test]
    fn codex_bridge_prompt_body_lists_attachment_paths() {
        let body = codex_bridge_prompt_body(
            "Summarize the upload",
            &[
                "/tmp/maestro-chat/a/report.pdf".to_string(),
                "/tmp/maestro-chat/a/screenshot.png".to_string(),
            ],
        );
        assert!(body.contains("Summarize the upload"));
        assert!(body.contains("/tmp/maestro-chat/a/report.pdf"));
        assert!(body.contains("/tmp/maestro-chat/a/screenshot.png"));
    }

    #[test]
    fn codex_bridge_temp_dirs_are_unique_per_request() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous_bridge = env::var_os("MAESTRO_CODEX_APP_SERVER_SANDBOX");
        let previous_sandbox = env::var_os("MAESTRO_SANDBOX_MODE");
        env::remove_var("MAESTRO_CODEX_APP_SERVER_SANDBOX");
        env::remove_var("MAESTRO_SANDBOX_MODE");
        let cwd = TestDir::new("codex-bridge-temp-cwd");
        let first = codex_bridge_temp_dir(cwd.path());
        let second = codex_bridge_temp_dir(cwd.path());
        if let Some(previous) = previous_bridge {
            env::set_var("MAESTRO_CODEX_APP_SERVER_SANDBOX", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_SANDBOX");
        }
        if let Some(previous) = previous_sandbox {
            env::set_var("MAESTRO_SANDBOX_MODE", previous);
        } else {
            env::remove_var("MAESTRO_SANDBOX_MODE");
        }

        assert_ne!(first, second);
        assert!(first
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("maestro-codex-bridge-")));
    }

    #[test]
    fn codex_bridge_temp_dir_uses_workspace_for_docker_sandbox() {
        let _guard = ENV_LOCK.blocking_lock();
        let cwd = TestDir::new("codex-bridge-docker-cwd");
        let previous_bridge = env::var_os("MAESTRO_CODEX_APP_SERVER_SANDBOX");
        let previous_sandbox = env::var_os("MAESTRO_SANDBOX_MODE");
        env::set_var("MAESTRO_CODEX_APP_SERVER_SANDBOX", "docker");
        env::remove_var("MAESTRO_SANDBOX_MODE");

        let temp_dir = codex_bridge_temp_dir(cwd.path());

        if let Some(previous) = previous_bridge {
            env::set_var("MAESTRO_CODEX_APP_SERVER_SANDBOX", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_SANDBOX");
        }
        if let Some(previous) = previous_sandbox {
            env::set_var("MAESTRO_SANDBOX_MODE", previous);
        } else {
            env::remove_var("MAESTRO_SANDBOX_MODE");
        }

        assert!(temp_dir.starts_with(cwd.path()));
        assert!(temp_dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".maestro-codex-bridge-")));
    }

    #[test]
    fn codex_headless_pending_request_ids_include_run_id() {
        let first = codex_headless_pending_request_id(Some("session-1"), "run-a", "approval-1");
        let second = codex_headless_pending_request_id(Some("session-1"), "run-b", "approval-1");

        assert_eq!(first, "codex:session-1:run-a:approval-1");
        assert_eq!(second, "codex:session-1:run-b:approval-1");
        assert_ne!(first, second);
    }

    #[test]
    fn codex_app_server_approval_mode_preserves_prompt() {
        assert_eq!(codex_app_server_approval_mode("auto"), "auto");
        assert_eq!(codex_app_server_approval_mode("prompt"), "prompt");
        assert_eq!(codex_app_server_approval_mode("fail"), "fail");
        assert_eq!(codex_app_server_approval_mode(""), "prompt");
    }

    #[test]
    fn codex_app_server_cli_path_resolves_from_package_root_not_workspace() {
        let package = TestDir::new("codex-package-root");
        let workspace = TestDir::new("codex-workspace");
        let package_bin = package.path().join("bin");
        let package_dist = package.path().join("dist");
        let workspace_dist = workspace.path().join("dist");
        fs::create_dir_all(&package_bin).expect("package bin should be created");
        fs::create_dir_all(&package_dist).expect("package dist should be created");
        fs::create_dir_all(&workspace_dist).expect("workspace dist should be created");
        fs::write(package.path().join("package.json"), "{}").expect("package json should exist");
        fs::write(package_dist.join("cli.js"), "").expect("package cli should exist");
        fs::write(workspace_dist.join("cli.js"), "").expect("workspace cli should exist");

        let resolved = codex_app_server_cli_path_from_start_dir(&package_bin);

        assert_eq!(resolved, package_dist.join("cli.js"));
        assert_ne!(resolved, workspace_dist.join("cli.js"));
    }

    #[test]
    fn codex_app_server_cli_path_missing_cli_still_points_at_package_root() {
        let package = TestDir::new("codex-package-root-missing-cli");
        let package_bin = package.path().join("bin");
        fs::create_dir_all(&package_bin).expect("package bin should be created");
        fs::write(package.path().join("package.json"), "{}").expect("package json should exist");

        let resolved = codex_app_server_cli_path_from_start_dir(&package_bin);

        assert_eq!(resolved, package.path().join("dist/cli.js"));
    }

    #[tokio::test]
    async fn codex_app_server_cli_isolates_child_usage_file() {
        let _guard = ENV_LOCK.lock().await;
        let root = TestDir::new("codex-isolated-usage");
        let cli_path = root.path().join("cli.js");
        let marker_path = root.path().join("child-usage-file.txt");
        let server_usage_path = root.path().join("server-usage.json");
        fs::write(
            &cli_path,
            r#"const fs = require("fs");
fs.writeFileSync(process.env.MAESTRO_USAGE_MARKER, process.env.MAESTRO_USAGE_FILE || "");
console.log(JSON.stringify({ type: "turn", phase: "start", role: "assistant" }));
console.log(JSON.stringify({ type: "item", subtype: "message_complete", data: { text: "ok", stopReason: "stop" } }));
"#,
        )
        .expect("cli fixture should be written");
        let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
        let previous_usage_file = env::var_os("MAESTRO_USAGE_FILE");
        let previous_marker = env::var_os("MAESTRO_USAGE_MARKER");
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
        env::set_var("MAESTRO_USAGE_FILE", &server_usage_path);
        env::set_var("MAESTRO_USAGE_MARKER", &marker_path);

        let output = run_codex_app_server_cli(root.path(), "gpt-5.5", "fail", "hello", &[])
            .await
            .expect("fixture should emit assistant output");
        let child_usage_file =
            fs::read_to_string(&marker_path).expect("child should record usage file path");

        if let Some(previous) = previous_cli {
            env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
        }
        if let Some(previous) = previous_usage_file {
            env::set_var("MAESTRO_USAGE_FILE", previous);
        } else {
            env::remove_var("MAESTRO_USAGE_FILE");
        }
        if let Some(previous) = previous_marker {
            env::set_var("MAESTRO_USAGE_MARKER", previous);
        } else {
            env::remove_var("MAESTRO_USAGE_MARKER");
        }

        assert_eq!(output.text, "ok");
        assert_ne!(PathBuf::from(child_usage_file.trim()), server_usage_path);
        assert!(child_usage_file.trim().ends_with("usage.json"));
    }

    #[tokio::test]
    async fn codex_headless_bridge_round_trips_prompt_approval() {
        let _guard = ENV_LOCK.lock().await;
        let root = TestDir::new("codex-headless-approval");
        let cli_path = root.path().join("cli.js");
        let marker_path = root.path().join("approval-response.json");
        fs::write(
            &cli_path,
            r#"const fs = require("fs");
const readline = require("readline");
const marker = process.env.MAESTRO_APPROVAL_RESPONSE_MARKER;
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({
      type: "server_request",
      request_id: "approval-1",
      request_type: "approval",
      call_id: "approval-1",
      tool: "write",
      args: { path: "file.txt" },
      reason: "Need approval"
    });
  } else if (msg.type === "server_request_response") {
    fs.writeFileSync(marker, JSON.stringify(msg));
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "approved output", is_thinking: false });
    send({
      type: "response_end",
      response_id: "response-1",
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_read_tokens: 1,
        cache_write_tokens: 0,
        total_tokens: 8,
        total_cost_usd: 0.01,
        model_id: "gpt-5.5",
        provider: "openai-codex"
      },
      tools_summary: { tools_used: ["write"], calls_succeeded: 1, calls_failed: 0 },
      duration_ms: 1
    });
  } else if (msg.type === "shutdown") {
    process.exit(0);
  }
});
"#,
        )
        .expect("cli fixture should be written");
        let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
        let previous_marker = env::var_os("MAESTRO_APPROVAL_RESPONSE_MARKER");
        let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
        env::set_var("MAESTRO_APPROVAL_RESPONSE_MARKER", &marker_path);
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "5000");

        let state = test_app_state_with_sessions(HashMap::new());
        let (_client, server) = tcp_stream_pair().await;
        let cwd = root.path().to_path_buf();
        let state_for_run = state.clone();
        let run = tokio::spawn(async move {
            let mut server = server;
            run_codex_app_server_headless_cli(
                &mut server,
                CodexBridgeTransport::Sse,
                &state_for_run,
                Some("session-1"),
                &cwd,
                "gpt-5.5",
                "hello",
                &[],
            )
            .await
        });

        let deadline = Instant::now() + Duration::from_secs(2);
        let (external_request_id, sender) = loop {
            let mut pending = state.pending_tool_responses.lock().await;
            let pending_id = pending
                .keys()
                .find(|id| id.starts_with("codex:session-1:") && id.ends_with(":approval-1"))
                .cloned();
            if let Some(pending_id) = pending_id {
                let sender = pending
                    .remove(&pending_id)
                    .expect("pending approval sender should exist");
                break (pending_id, sender);
            }
            drop(pending);
            assert!(
                Instant::now() < deadline,
                "headless approval request should be registered"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        sender
            .send((external_request_id, true, None))
            .expect("approval response should send");
        let result = run.await.expect("headless run should join");

        if let Some(previous) = previous_cli {
            env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
        }
        if let Some(previous) = previous_marker {
            env::set_var("MAESTRO_APPROVAL_RESPONSE_MARKER", previous);
        } else {
            env::remove_var("MAESTRO_APPROVAL_RESPONSE_MARKER");
        }
        if let Some(previous) = previous_timeout {
            env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        }

        let output = result.expect("headless bridge should complete");
        let approval_response: Value = serde_json::from_str(
            &fs::read_to_string(&marker_path).expect("approval response should be recorded"),
        )
        .expect("approval response should be json");

        assert_eq!(output.text, "approved output");
        assert_eq!(output.usage.expect("usage").input_tokens, 5);
        assert_eq!(approval_response["type"], "server_request_response");
        assert_eq!(approval_response["request_id"], "approval-1");
        assert_eq!(approval_response["approved"], true);
    }

    #[tokio::test]
    async fn codex_headless_bridge_streams_tool_events_over_websocket() {
        let _guard = ENV_LOCK.lock().await;
        let root = TestDir::new("codex-headless-ws-tools");
        let cli_path = root.path().join("cli.js");
        fs::write(
            &cli_path,
            r#"const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({
      type: "tool_call",
      call_id: "collab-call-ws",
      tool: "codex.subagent.spawnAgent",
      args: {
        codexTool: "spawnAgent",
        receiverThreadIds: ["child-thread-ws"],
        prompt: "Inspect the websocket bridge"
      }
    });
    send({
      type: "tool_end",
      call_id: "collab-call-ws",
      success: true
    });
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "websocket output", is_thinking: false });
    send({ type: "response_end", response_id: "response-1", duration_ms: 1 });
  } else if (msg.type === "shutdown") {
    process.exit(0);
  }
});
"#,
        )
        .expect("cli fixture should be written");
        let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
        let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "5000");

        let state = test_app_state_with_sessions(HashMap::new());
        let (mut client, server) = tcp_stream_pair().await;
        let state_for_run = state.clone();
        let run = tokio::spawn(async move {
            let mut server = server;
            handle_codex_app_server_chat_transport(
                &mut server,
                &state_for_run,
                Some("session-ws"),
                "gpt-5.5",
                "hello",
                &[],
                CodexBridgeTransport::WebSocket,
            )
            .await
        });
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut bytes))
            .await
            .expect("WebSocket stream should close")
            .expect("WebSocket frames should be readable");
        let result = run.await.expect("headless websocket run should join");

        if let Some(previous) = previous_cli {
            env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
        }
        if let Some(previous) = previous_timeout {
            env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        }

        result.expect("headless WebSocket bridge should complete");
        let events = server_websocket_json_values(&bytes);
        assert!(events.iter().any(|event| event["type"] == "agent_start"));
        let start = events
            .iter()
            .find(|event| event["type"] == "tool_execution_start")
            .expect("tool start should stream over WebSocket");
        let end = events
            .iter()
            .find(|event| event["type"] == "tool_execution_end")
            .expect("tool end should stream over WebSocket");
        assert_eq!(start["toolCallId"], "collab-call-ws");
        assert_eq!(start["toolName"], "codex.subagent.spawnAgent");
        assert_eq!(start["args"]["receiverThreadIds"][0], "child-thread-ws");
        assert_eq!(
            start["args"]["childRunIds"][0],
            "codex-thread:child-thread-ws"
        );
        assert_eq!(
            start["args"]["codexWorkGraph"]["childRuns"][0]["childRunId"],
            "codex-thread:child-thread-ws"
        );
        assert_eq!(end["toolCallId"], "collab-call-ws");
        assert_eq!(end["isError"], false);
        assert!(events.iter().any(|event| {
            event["type"] == "message_update" && event["message"]["content"] == "websocket output"
        }));
        assert!(events.iter().any(|event| event["type"] == "done"));
    }

    #[tokio::test]
    async fn codex_headless_approval_wait_does_not_consume_request_timeout() {
        let _guard = ENV_LOCK.lock().await;
        let root = TestDir::new("codex-headless-approval-timeout");
        let cli_path = root.path().join("cli.js");
        fs::write(
            &cli_path,
            r#"const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({
      type: "server_request",
      request_id: "approval-wait",
      request_type: "approval",
      call_id: "approval-wait",
      tool: "write",
      args: { path: "file.txt" },
      reason: "Need approval"
    });
  } else if (msg.type === "server_request_response") {
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "waited output", is_thinking: false });
    send({ type: "response_end", response_id: "response-1", duration_ms: 1 });
  } else if (msg.type === "shutdown") {
    process.exit(0);
  }
});
"#,
        )
        .expect("cli fixture should be written");
        let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
        let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "500");

        let state = test_app_state_with_sessions(HashMap::new());
        let (_client, server) = tcp_stream_pair().await;
        let cwd = root.path().to_path_buf();
        let state_for_run = state.clone();
        let run = tokio::spawn(async move {
            let mut server = server;
            run_codex_app_server_headless_cli(
                &mut server,
                CodexBridgeTransport::Sse,
                &state_for_run,
                Some("session-wait"),
                &cwd,
                "gpt-5.5",
                "hello",
                &[],
            )
            .await
        });

        let expected_prefix = "codex:session-wait:";
        let expected_suffix = ":approval-wait";
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if state
                .pending_tool_responses
                .lock()
                .await
                .keys()
                .any(|id| id.starts_with(expected_prefix) && id.ends_with(expected_suffix))
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "headless approval request should be registered"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        tokio::time::sleep(Duration::from_millis(650)).await;
        let mut pending = state.pending_tool_responses.lock().await;
        let external_request_id = pending
            .keys()
            .find(|id| id.starts_with(expected_prefix) && id.ends_with(expected_suffix))
            .cloned()
            .expect("approval wait should remain pending after request timeout window");
        let sender = pending
            .remove(&external_request_id)
            .expect("approval wait should have a pending sender");
        drop(pending);
        sender
            .send((external_request_id, true, None))
            .expect("approval response should send");
        let result = run.await.expect("headless run should join");

        if let Some(previous) = previous_cli {
            env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
        }
        if let Some(previous) = previous_timeout {
            env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        }

        assert_eq!(
            result
                .expect("manual approval wait should not time out")
                .text,
            "waited output"
        );
    }

    #[tokio::test]
    async fn codex_headless_bridge_keeps_valid_output_after_nonzero_shutdown() {
        let _guard = ENV_LOCK.lock().await;
        let root = TestDir::new("codex-headless-nonzero-shutdown");
        let cli_path = root.path().join("cli.js");
        fs::write(
            &cli_path,
            r#"const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "kept output", is_thinking: false });
    send({
      type: "response_end",
      response_id: "response-1",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 2,
        total_cost_usd: 0.01,
        model_id: "gpt-5.5",
        provider: "openai-codex"
      },
      tools_summary: { tools_used: [], calls_succeeded: 0, calls_failed: 0 },
      duration_ms: 1
    });
  } else if (msg.type === "shutdown") {
    process.exit(7);
  }
});
"#,
        )
        .expect("cli fixture should be written");
        let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
        let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "5000");

        let state = test_app_state_with_sessions(HashMap::new());
        let (_client, mut server) = tcp_stream_pair().await;
        let output = run_codex_app_server_headless_cli(
            &mut server,
            CodexBridgeTransport::Sse,
            &state,
            None,
            root.path(),
            "gpt-5.5",
            "hello",
            &[],
        )
        .await;

        if let Some(previous) = previous_cli {
            env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
        }
        if let Some(previous) = previous_timeout {
            env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        }

        assert_eq!(
            output.expect("valid protocol output should win").text,
            "kept output"
        );
    }

    #[tokio::test]
    async fn codex_headless_bridge_keeps_valid_output_after_broken_pipe_shutdown() {
        let _guard = ENV_LOCK.lock().await;
        let root = TestDir::new("codex-headless-broken-pipe-shutdown");
        let cli_path = root.path().join("cli.js");
        fs::write(
            &cli_path,
            r#"const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "kept after broken pipe", is_thinking: false });
    send({ type: "response_end", response_id: "response-1", duration_ms: 1 });
    process.stdin.destroy();
    setTimeout(() => process.exit(0), 10);
  } else if (msg.type === "shutdown") {
    process.exit(0);
  }
});
"#,
        )
        .expect("cli fixture should be written");
        let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
        let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "5000");

        let state = test_app_state_with_sessions(HashMap::new());
        let (_client, mut server) = tcp_stream_pair().await;
        let output = run_codex_app_server_headless_cli(
            &mut server,
            CodexBridgeTransport::Sse,
            &state,
            None,
            root.path(),
            "gpt-5.5",
            "hello",
            &[],
        )
        .await;

        if let Some(previous) = previous_cli {
            env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
        }
        if let Some(previous) = previous_timeout {
            env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        }

        assert_eq!(
            output
                .expect("valid output should survive a broken shutdown pipe")
                .text,
            "kept after broken pipe"
        );
    }

    #[tokio::test]
    async fn codex_headless_bridge_bounds_shutdown_wait_after_valid_output() {
        let _guard = ENV_LOCK.lock().await;
        let root = TestDir::new("codex-headless-hung-shutdown");
        let cli_path = root.path().join("cli.js");
        fs::write(
            &cli_path,
            r#"const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    send({ type: "response_start", response_id: "response-1" });
    send({ type: "response_chunk", response_id: "response-1", content: "bounded output", is_thinking: false });
    send({ type: "response_end", response_id: "response-1", duration_ms: 1 });
  } else if (msg.type === "shutdown") {
    setInterval(() => {}, 1000);
  }
});
"#,
        )
        .expect("cli fixture should be written");
        let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
        let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        let previous_shutdown_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS");
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "5000");
        env::set_var("MAESTRO_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS", "50");

        let state = test_app_state_with_sessions(HashMap::new());
        let (_client, mut server) = tcp_stream_pair().await;
        let started = Instant::now();
        let output = run_codex_app_server_headless_cli(
            &mut server,
            CodexBridgeTransport::Sse,
            &state,
            None,
            root.path(),
            "gpt-5.5",
            "hello",
            &[],
        )
        .await;

        if let Some(previous) = previous_cli {
            env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
        }
        if let Some(previous) = previous_timeout {
            env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        }
        if let Some(previous) = previous_shutdown_timeout {
            env::set_var("MAESTRO_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS");
        }

        assert_eq!(
            output
                .expect("valid output should survive a hung shutdown")
                .text,
            "bounded output"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "hung shutdown should be bounded"
        );
    }

    #[tokio::test]
    async fn codex_app_server_timeout_kills_child_process() {
        let _guard = ENV_LOCK.lock().await;
        let root = TestDir::new("codex-timeout");
        let cli_path = root.path().join("cli.js");
        let marker_path = root.path().join("still-running.txt");
        fs::write(
            &cli_path,
            r#"const fs = require("fs");
setTimeout(() => {
  fs.writeFileSync(process.env.MAESTRO_TIMEOUT_MARKER, "still running");
}, 150);
"#,
        )
        .expect("cli fixture should be written");
        let previous_cli = env::var_os("MAESTRO_CODEX_APP_SERVER_CLI");
        let previous_timeout = env::var_os("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        let previous_marker = env::var_os("MAESTRO_TIMEOUT_MARKER");
        env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", &cli_path);
        env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", "50");
        env::set_var("MAESTRO_TIMEOUT_MARKER", &marker_path);

        let result = run_codex_app_server_cli(root.path(), "gpt-5.5", "fail", "hello", &[]).await;

        tokio::time::sleep(Duration::from_millis(250)).await;
        let marker_exists = marker_path.exists();

        if let Some(previous) = previous_cli {
            env::set_var("MAESTRO_CODEX_APP_SERVER_CLI", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_CLI");
        }
        if let Some(previous) = previous_timeout {
            env::set_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_TIMEOUT_MS");
        }
        if let Some(previous) = previous_marker {
            env::set_var("MAESTRO_TIMEOUT_MARKER", previous);
        } else {
            env::remove_var("MAESTRO_TIMEOUT_MARKER");
        }

        assert!(matches!(
            result,
            Err(ref error) if error == "Codex app-server request timed out"
        ));
        assert!(
            !marker_exists,
            "timed out child process should be terminated before it can keep running"
        );
    }

    fn auth_test_config() -> Config {
        Config {
            listen_host: "127.0.0.1".to_string(),
            listen_port: 0,
            api_key: Some("api-key".to_string()),
            require_key: true,
            csrf_token: None,
            require_csrf: false,
            cwd: PathBuf::from("."),
            session_store_path: PathBuf::from("sessions.json"),
            command_prefs_path: PathBuf::from("command-prefs.json"),
            usage_file_path: PathBuf::from("usage.jsonl"),
            a2a_tasks_file_path: unique_test_dir("maestro-a2a-tasks").join("tasks.json"),
            static_root: PathBuf::from("dist"),
            static_cache_max_age: 0,
            llm_gateway_models_url: None,
            llm_gateway_token: None,
            llm_gateway_org_id: None,
            llm_gateway_timeout_ms: 2_500,
        }
    }

    fn bearer_head(token: &str) -> RequestHead {
        RequestHead {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([("authorization".to_string(), format!("Bearer {token}"))]),
        }
    }

    fn shared_secret_bearer_token(secret: &[u8], user_id: &str) -> String {
        let signature = hmac_sha256_hex(secret, user_id.as_bytes());
        format!("{}.{}", URL_SAFE_NO_PAD.encode(user_id), signature)
    }

    fn csrf_head(method: &str, token: Option<&str>) -> RequestHead {
        csrf_head_for_path(method, "/api/status", token)
    }

    fn csrf_head_for_path(method: &str, path: &str, token: Option<&str>) -> RequestHead {
        let mut headers = HashMap::new();
        if let Some(token) = token {
            headers.insert("x-maestro-csrf".to_string(), token.to_string());
        }
        RequestHead {
            method: method.to_string(),
            path: path.to_string(),
            query: HashMap::new(),
            headers,
        }
    }

    fn test_session_record(id: &str) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            owner: None,
            title: "Test Session".to_string(),
            created_at: "2026-04-27T00:00:00Z".to_string(),
            updated_at: "2026-04-27T00:00:00Z".to_string(),
            message_count: 0,
            favorite: None,
            tags: Vec::new(),
            messages: Vec::new(),
        }
    }

    fn test_app_state_with_sessions(sessions: HashMap<String, SessionRecord>) -> AppState {
        let config = Arc::new(auth_test_config());
        let (a2a_task_events, _) = broadcast::channel(256);
        AppState {
            config: config.clone(),
            started_at: Instant::now(),
            selected_model: Arc::new(Mutex::new(emergency_default_model())),
            telemetry_override: Arc::new(Mutex::new(None)),
            training_override: Arc::new(Mutex::new(None)),
            background_settings: Arc::new(Mutex::new(BackgroundSettings::default())),
            framework_preference: Arc::new(Mutex::new(None)),
            command_prefs: Arc::new(Mutex::new(CommandPrefs::default())),
            sessions: Arc::new(Mutex::new(SessionStore {
                sessions,
                shared_sessions: HashMap::new(),
            })),
            session_store_persist_enabled: true,
            session_persist_lock: Arc::new(Mutex::new(())),
            usage_persist_lock: Arc::new(Mutex::new(())),
            shared_sessions: Arc::new(Mutex::new(HashMap::new())),
            approval_modes: Arc::new(Mutex::new(HashMap::new())),
            pending_tool_responses: Arc::new(Mutex::new(HashMap::new())),
            a2a_tasks: Arc::new(Mutex::new(HashMap::new())),
            a2a_task_persist_lock: Arc::new(Mutex::new(())),
            a2a_task_events,
            a2a_task_event_history: Arc::new(Mutex::new(HashMap::new())),
            a2a_cancel_senders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        env::temp_dir().join(format!("{prefix}-{}-{now}", process::id()))
    }

    async fn tcp_stream_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let addr = listener
            .local_addr()
            .expect("listener should have local addr");
        let connect = TcpStream::connect(addr);
        let accept = listener.accept();
        let (client, accepted) = tokio::join!(connect, accept);
        let client = client.expect("client should connect");
        let (server, _) = accepted.expect("listener should accept");
        (client, server)
    }

    fn response_json(response: Vec<u8>) -> Value {
        let body = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| &response[index + 4..])
            .expect("response should contain header separator");
        serde_json::from_slice(body).expect("response body should be json")
    }

    fn response_status(response: &[u8]) -> u16 {
        let text = std::str::from_utf8(response).expect("response should be utf-8");
        let status = text
            .lines()
            .next()
            .expect("response should include status line")
            .split_whitespace()
            .nth(1)
            .expect("status line should include code");
        status.parse().expect("status code should parse")
    }

    fn response_body_text(response: &str) -> &str {
        let separator = response
            .find("\r\n\r\n")
            .expect("response should contain header separator");
        &response[separator + 4..]
    }

    fn server_websocket_json_values(bytes: &[u8]) -> Vec<Value> {
        let mut values = Vec::new();
        let mut cursor = 0usize;
        while cursor < bytes.len() {
            assert!(bytes.len() >= cursor + 2, "incomplete WebSocket frame");
            let opcode = bytes[cursor] & 0x0f;
            if opcode == 0x8 {
                break;
            }
            assert_eq!(opcode, 0x1, "expected text WebSocket frame");
            assert_eq!(
                bytes[cursor + 1] & 0x80,
                0,
                "server WebSocket frames should not be masked"
            );
            let mut offset = cursor + 2;
            let mut len = (bytes[cursor + 1] & 0x7f) as usize;
            if len == 126 {
                assert!(bytes.len() >= offset + 2, "incomplete extended length");
                len = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
                offset += 2;
            } else if len == 127 {
                assert!(bytes.len() >= offset + 8, "incomplete extended length");
                len = u64::from_be_bytes([
                    bytes[offset],
                    bytes[offset + 1],
                    bytes[offset + 2],
                    bytes[offset + 3],
                    bytes[offset + 4],
                    bytes[offset + 5],
                    bytes[offset + 6],
                    bytes[offset + 7],
                ]) as usize;
                offset += 8;
            }
            assert!(bytes.len() >= offset + len, "incomplete WebSocket payload");
            values.push(
                serde_json::from_slice(&bytes[offset..offset + len])
                    .expect("WebSocket payload should be JSON"),
            );
            cursor = offset + len;
        }
        values
    }

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "maestro-control-plane-{label}-{}-{}",
                process::id(),
                ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("test dir should be created");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn parses_request_path_without_query() {
        let request =
            b"GET /api/status?action=mark-onboarding-seen HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let head = parse_request_head(request).expect("request should parse");

        assert_eq!(head.method, "GET");
        assert_eq!(head.path, "/api/status");
        assert_eq!(
            head.query.get("action"),
            Some(&"mark-onboarding-seen".to_string())
        );
        assert_eq!(head.headers.get("host"), Some(&"localhost".to_string()));
    }

    #[test]
    fn parses_percent_encoded_query_components() {
        let request =
            b"GET /api/artifact-access?filename=logs%2Ftoday%20one.txt&action=mark+done HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let head = parse_request_head(request).expect("request should parse");

        assert_eq!(
            head.query.get("filename"),
            Some(&"logs/today one.txt".to_string())
        );
        assert_eq!(head.query.get("action"), Some(&"mark done".to_string()));
    }

    #[test]
    fn combines_duplicate_headers_in_parse_request_head() {
        let request = b"GET /api/status HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 10.0.0.1\r\nx-forwarded-for: 10.0.0.2\r\nCookie: a=1\r\nCookie: b=2\r\n\r\n";
        let head = parse_request_head(request).expect("request should parse");

        assert_eq!(
            head.headers.get("x-forwarded-for"),
            Some(&"10.0.0.1, 10.0.0.2".to_string())
        );
        assert_eq!(head.headers.get("cookie"), Some(&"a=1, b=2".to_string()));
    }

    #[test]
    fn query_flag_treats_present_valueless_param_as_true() {
        let head = parse_request_head(
            b"GET /artifact?download&standalone=0 HTTP/1.1\r\nHost: localhost\r\n\r\n",
        )
        .expect("request should parse");

        assert!(query_flag(&head, "download"));
        assert!(!query_flag(&head, "standalone"));
        assert!(!query_flag(&head, "missing"));
    }

    #[test]
    fn authorizes_shared_secret_bearer_token() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous = env::var_os("MAESTRO_AUTH_SHARED_SECRET");
        env::set_var("MAESTRO_AUTH_SHARED_SECRET", "shared-secret");

        let user_id = "user-123";
        let signature = hmac_sha256_hex(b"shared-secret", user_id.as_bytes());
        let token = format!("{}.{}", URL_SAFE_NO_PAD.encode(user_id), signature);

        assert!(authorize(&bearer_head(&token), &auth_test_config()).is_ok());
        assert_eq!(
            auth_context(&bearer_head(&token), &auth_test_config()).and_then(|auth| auth.subject),
            Some("user-123".to_string())
        );
        assert!(authorize(&bearer_head("bad-token"), &auth_test_config()).is_err());

        if let Some(previous) = previous {
            env::set_var("MAESTRO_AUTH_SHARED_SECRET", previous);
        } else {
            env::remove_var("MAESTRO_AUTH_SHARED_SECRET");
        }
    }

    #[test]
    fn csrf_validation_requires_matching_token_for_mutating_api_and_a2a_requests() {
        let mut config = auth_test_config();
        config.require_csrf = true;
        config.csrf_token = Some("csrf-token".to_string());

        assert!(validate_csrf(&csrf_head("POST", Some("csrf-token")), &config).is_ok());
        assert!(validate_csrf(&csrf_head("POST", Some("wrong-token")), &config).is_err());
        assert!(validate_csrf(&csrf_head("POST", None), &config).is_err());
        assert!(validate_csrf(
            &csrf_head_for_path("POST", "/message:send", Some("csrf-token")),
            &config,
        )
        .is_ok());
        assert!(
            validate_csrf(&csrf_head_for_path("POST", "/message:send", None), &config).is_err()
        );
        assert!(validate_csrf(
            &csrf_head_for_path("POST", "/message:stream", Some("csrf-token")),
            &config,
        )
        .is_ok());
        assert!(validate_csrf(
            &csrf_head_for_path("POST", "/message:stream", None),
            &config
        )
        .is_err());
        assert!(validate_csrf(
            &csrf_head_for_path(
                "POST",
                "/tasks/maestro-task-1:subscribe",
                Some("csrf-token")
            ),
            &config,
        )
        .is_ok());
        assert!(validate_csrf(
            &csrf_head_for_path("POST", "/tasks/maestro-task-1:subscribe", None),
            &config
        )
        .is_err());
        assert!(validate_csrf(
            &csrf_head_for_path("POST", "/tasks/maestro-task-1:cancel", Some("csrf-token")),
            &config,
        )
        .is_ok());
        assert!(validate_csrf(
            &csrf_head_for_path("POST", "/tasks/maestro-task-1:cancel", None),
            &config
        )
        .is_err());
        assert!(validate_csrf(&csrf_head("GET", None), &config).is_ok());
    }

    #[test]
    fn authorizes_hs256_jwt_bearer_token() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous_secret = env::var_os("MAESTRO_JWT_SECRET");
        let previous_alg = env::var_os("MAESTRO_JWT_ALG");
        let previous_aud = env::var_os("MAESTRO_JWT_AUD");
        let previous_iss = env::var_os("MAESTRO_JWT_ISS");
        env::set_var("MAESTRO_JWT_SECRET", "jwt-secret");
        env::remove_var("MAESTRO_JWT_ALG");
        env::remove_var("MAESTRO_JWT_AUD");
        env::remove_var("MAESTRO_JWT_ISS");

        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
            .saturating_add(60);
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"sub":"user-123","exp":{expires_at}}}"#));
        let signing_input = format!("{header}.{payload}");
        let signature = hmac_sha256_base64url(b"jwt-secret", signing_input.as_bytes());
        let token = format!("{signing_input}.{signature}");

        assert!(authorize(&bearer_head(&token), &auth_test_config()).is_ok());
        assert_eq!(
            auth_context(&bearer_head(&token), &auth_test_config()).and_then(|auth| auth.subject),
            Some("user-123".to_string())
        );

        if let Some(previous) = previous_secret {
            env::set_var("MAESTRO_JWT_SECRET", previous);
        } else {
            env::remove_var("MAESTRO_JWT_SECRET");
        }
        if let Some(previous) = previous_alg {
            env::set_var("MAESTRO_JWT_ALG", previous);
        }
        if let Some(previous) = previous_aud {
            env::set_var("MAESTRO_JWT_AUD", previous);
        }
        if let Some(previous) = previous_iss {
            env::set_var("MAESTRO_JWT_ISS", previous);
        }
    }

    #[tokio::test]
    async fn jwks_auth_check_does_not_panic_inside_tokio_runtime() {
        let _guard = ENV_LOCK.lock().await;
        let previous_url = env::var_os("MAESTRO_JWT_JWKS_URL");
        let previous_alg = env::var_os("MAESTRO_JWT_ALG");
        let previous_secret = env::var_os("MAESTRO_JWT_SECRET");
        env::set_var("MAESTRO_JWT_JWKS_URL", "http://127.0.0.1:1/jwks.json");
        env::set_var("MAESTRO_JWT_ALG", "RS256");
        env::remove_var("MAESTRO_JWT_SECRET");

        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(r#"{"sub":"user-123","exp":4102444800}"#);
        let token = format!("{header}.{payload}.signature");

        let result =
            std::panic::catch_unwind(|| authorize(&bearer_head(&token), &auth_test_config()));
        assert!(
            result.is_ok(),
            "authorize should not panic inside a Tokio runtime"
        );
        assert!(result.expect("authorize should return a result").is_err());

        if let Some(previous) = previous_url {
            env::set_var("MAESTRO_JWT_JWKS_URL", previous);
        } else {
            env::remove_var("MAESTRO_JWT_JWKS_URL");
        }
        if let Some(previous) = previous_alg {
            env::set_var("MAESTRO_JWT_ALG", previous);
        } else {
            env::remove_var("MAESTRO_JWT_ALG");
        }
        if let Some(previous) = previous_secret {
            env::set_var("MAESTRO_JWT_SECRET", previous);
        } else {
            env::remove_var("MAESTRO_JWT_SECRET");
        }
    }

    #[test]
    fn detects_local_control_plane_routes() {
        let request = b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let head = parse_request_head(request).expect("request should parse");

        assert!(is_local_endpoint(&head));
    }

    #[test]
    fn detects_a2a_control_plane_routes() {
        for request in [
            "GET /.well-known/agent-card.json HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "GET /tasks/maestro-task-1 HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "GET /tasks HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "GET /extendedAgentCard HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "GET /tasks/maestro-task-1/pushNotificationConfigs HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /tasks/maestro-task-1/pushNotificationConfigs HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "DELETE /tasks/maestro-task-1/pushNotificationConfigs/config-1 HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /tasks/maestro-task-1:cancel HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "OPTIONS /message:send HTTP/1.1\r\nHost: localhost\r\n\r\n",
        ] {
            let head = parse_request_head(request.as_bytes()).expect("request should parse");
            assert!(is_a2a_endpoint(&head), "{request} should be A2A");
        }
    }

    #[test]
    fn detects_a2a_streaming_routes_separately() {
        for request in [
            "POST /message:stream HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "GET /tasks/maestro-task-1:subscribe HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /tasks/maestro-task-1:subscribe HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "GET /tasks/maestro-task-1/subscribe HTTP/1.1\r\nHost: localhost\r\n\r\n",
        ] {
            let head = parse_request_head(request.as_bytes()).expect("request should parse");
            assert!(
                is_a2a_streaming_endpoint(&head),
                "{request} should be streaming A2A"
            );
            assert!(
                !is_a2a_endpoint(&head),
                "{request} should not be handled by non-streaming A2A routing"
            );
        }
    }

    #[test]
    fn detects_platform_a2a_push_callback_route() {
        let head =
            parse_request_head(b"POST /api/platform/a2a/push HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .expect("request should parse");

        assert!(is_platform_a2a_push_endpoint(&head));
        assert!(!is_a2a_endpoint(&head));
    }

    #[test]
    fn a2a_agent_card_advertises_http_json_interface() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous_a2a_url = env::var_os("MAESTRO_A2A_PUBLIC_URL");
        let previous_a2a_host = env::var_os("MAESTRO_A2A_PUBLIC_HOST");
        let previous_control_url = env::var_os("MAESTRO_CONTROL_PUBLIC_URL");
        let previous_control_host = env::var_os("MAESTRO_CONTROL_PUBLIC_HOST");
        env::remove_var("MAESTRO_A2A_PUBLIC_URL");
        env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
        env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
        env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
        let head = parse_request_head(
            b"GET /.well-known/agent-card.json HTTP/1.1\r\nHost: attacker.test\r\nx-forwarded-proto: https\r\n\r\n",
        )
        .expect("request should parse");
        let card = a2a_agent_card(&head, &auth_test_config());

        assert_eq!(card["protocolVersion"], A2A_PROTOCOL_VERSION);
        assert_eq!(card["url"], "http://127.0.0.1:0");
        assert_eq!(card["supportedInterfaces"][0]["url"], "http://127.0.0.1:0");
        assert_eq!(
            card["supportedInterfaces"][0]["protocolBinding"],
            "HTTP+JSON"
        );
        assert_eq!(card["capabilities"]["streaming"], true);
        assert_eq!(card["capabilities"]["pushNotifications"], true);
        assert_eq!(card["capabilities"]["extendedAgentCard"], true);
        assert_eq!(
            card["capabilities"]["extensions"][0]["uri"],
            EVALOPS_A2A_EXTENSION_URI
        );
        assert_eq!(
            card["securitySchemes"]["maestroApiKey"]["name"],
            "x-maestro-api-key"
        );
        assert_eq!(card["skills"][0]["id"], "maestro-tui-turn");
        let skill_ids = card["skills"]
            .as_array()
            .expect("skills should be an array")
            .iter()
            .filter_map(|skill| skill.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(skill_ids.contains(&"maestro.subagent.code-review"));
        assert!(skill_ids.contains(&"maestro.subagent.test-runner"));
        assert!(skill_ids.contains(&"maestro.subagent.repo-explorer"));
        let code_review_skill = card["skills"]
            .as_array()
            .expect("skills should be an array")
            .iter()
            .find(|skill| skill["id"] == "maestro.subagent.code-review")
            .expect("code review subagent skill should be advertised");
        assert_eq!(
            code_review_skill["metadata"]["requestMetadataPath"],
            "evalops.subagentRequest"
        );
        assert_eq!(
            code_review_skill["attributes"]["subagentLaneId"],
            "code-review"
        );
        assert_eq!(
            code_review_skill["attributes"]["requestMetadataPath"],
            "evalops.subagentRequest"
        );
        assert_eq!(
            code_review_skill["requiredContextGrants"],
            serde_json::json!(["repo:read", "pull-request:read", "evidence:read"])
        );
        assert_eq!(
            code_review_skill["approvalPolicyRef"],
            "maestro.subagent.code-review.target-policy"
        );
        assert_eq!(code_review_skill["maxAutonomy"], "bounded");
        assert_eq!(
            code_review_skill["requiredArtifactKinds"],
            serde_json::json!(["review.summary"])
        );
        assert_eq!(
            code_review_skill["allowedTaskClasses"],
            serde_json::json!(["code.review", "risk.analysis"])
        );
        assert_eq!(
            code_review_skill["deniedTaskClasses"],
            serde_json::json!([
                "credential.materialization",
                "secret.exfiltration",
                "unbounded.repository.write"
            ])
        );
        if let Some(previous_a2a_url) = previous_a2a_url {
            env::set_var("MAESTRO_A2A_PUBLIC_URL", previous_a2a_url);
        } else {
            env::remove_var("MAESTRO_A2A_PUBLIC_URL");
        }
        if let Some(previous_a2a_host) = previous_a2a_host {
            env::set_var("MAESTRO_A2A_PUBLIC_HOST", previous_a2a_host);
        } else {
            env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
        }
        if let Some(previous_control_url) = previous_control_url {
            env::set_var("MAESTRO_CONTROL_PUBLIC_URL", previous_control_url);
        } else {
            env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
        }
        if let Some(previous_control_host) = previous_control_host {
            env::set_var("MAESTRO_CONTROL_PUBLIC_HOST", previous_control_host);
        } else {
            env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
        }
    }

    #[test]
    fn a2a_agent_card_uses_configured_public_host_for_wildcard_binds() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous_a2a_host = env::var_os("MAESTRO_A2A_PUBLIC_HOST");
        let previous_a2a_url = env::var_os("MAESTRO_A2A_PUBLIC_URL");
        let previous_control_url = env::var_os("MAESTRO_CONTROL_PUBLIC_URL");
        env::set_var("MAESTRO_A2A_PUBLIC_HOST", "mini.example.test");
        env::remove_var("MAESTRO_A2A_PUBLIC_URL");
        env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
        let mut config = auth_test_config();
        config.listen_host = "0.0.0.0".to_string();
        config.listen_port = 18787;
        let head = parse_request_head(
            b"GET /.well-known/agent-card.json HTTP/1.1\r\nHost: attacker.test\r\n\r\n",
        )
        .expect("request should parse");
        let card = a2a_agent_card(&head, &config);

        assert_eq!(card["url"], "http://mini.example.test:18787");
        assert_eq!(
            card["supportedInterfaces"][0]["url"],
            "http://mini.example.test:18787"
        );

        if let Some(previous_a2a_host) = previous_a2a_host {
            env::set_var("MAESTRO_A2A_PUBLIC_HOST", previous_a2a_host);
        } else {
            env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
        }
        if let Some(previous_a2a_url) = previous_a2a_url {
            env::set_var("MAESTRO_A2A_PUBLIC_URL", previous_a2a_url);
        } else {
            env::remove_var("MAESTRO_A2A_PUBLIC_URL");
        }
        if let Some(previous_control_url) = previous_control_url {
            env::set_var("MAESTRO_CONTROL_PUBLIC_URL", previous_control_url);
        } else {
            env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
        }
    }

    #[test]
    fn a2a_agent_card_formats_ipv6_listen_hosts() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous_hostname = env::var_os("HOSTNAME");
        let previous_computername = env::var_os("COMPUTERNAME");
        let previous_a2a_url = env::var_os("MAESTRO_A2A_PUBLIC_URL");
        let previous_a2a_host = env::var_os("MAESTRO_A2A_PUBLIC_HOST");
        let previous_control_url = env::var_os("MAESTRO_CONTROL_PUBLIC_URL");
        let previous_control_host = env::var_os("MAESTRO_CONTROL_PUBLIC_HOST");
        env::remove_var("HOSTNAME");
        env::remove_var("COMPUTERNAME");
        env::remove_var("MAESTRO_A2A_PUBLIC_URL");
        env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
        env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
        env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
        let mut config = auth_test_config();
        config.listen_host = "::1".to_string();
        config.listen_port = 18787;
        let head = parse_request_head(
            b"GET /.well-known/agent-card.json HTTP/1.1\r\nHost: attacker.test\r\n\r\n",
        )
        .expect("request should parse");
        let card = a2a_agent_card(&head, &config);

        assert_eq!(card["url"], "http://[::1]:18787");
        assert_eq!(card["supportedInterfaces"][0]["url"], "http://[::1]:18787");

        if let Some(previous_hostname) = previous_hostname {
            env::set_var("HOSTNAME", previous_hostname);
        } else {
            env::remove_var("HOSTNAME");
        }
        if let Some(previous_computername) = previous_computername {
            env::set_var("COMPUTERNAME", previous_computername);
        } else {
            env::remove_var("COMPUTERNAME");
        }
        if let Some(previous_a2a_url) = previous_a2a_url {
            env::set_var("MAESTRO_A2A_PUBLIC_URL", previous_a2a_url);
        } else {
            env::remove_var("MAESTRO_A2A_PUBLIC_URL");
        }
        if let Some(previous_a2a_host) = previous_a2a_host {
            env::set_var("MAESTRO_A2A_PUBLIC_HOST", previous_a2a_host);
        } else {
            env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
        }
        if let Some(previous_control_url) = previous_control_url {
            env::set_var("MAESTRO_CONTROL_PUBLIC_URL", previous_control_url);
        } else {
            env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
        }
        if let Some(previous_control_host) = previous_control_host {
            env::set_var("MAESTRO_CONTROL_PUBLIC_HOST", previous_control_host);
        } else {
            env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
        }
    }

    #[test]
    fn a2a_agent_card_formats_configured_ipv6_public_host() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous_a2a_host = env::var_os("MAESTRO_A2A_PUBLIC_HOST");
        let previous_a2a_url = env::var_os("MAESTRO_A2A_PUBLIC_URL");
        let previous_control_url = env::var_os("MAESTRO_CONTROL_PUBLIC_URL");
        let previous_control_host = env::var_os("MAESTRO_CONTROL_PUBLIC_HOST");
        env::set_var("MAESTRO_A2A_PUBLIC_HOST", "::1");
        env::remove_var("MAESTRO_A2A_PUBLIC_URL");
        env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
        env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
        let mut config = auth_test_config();
        config.listen_host = "0.0.0.0".to_string();
        config.listen_port = 18787;
        let head = parse_request_head(
            b"GET /.well-known/agent-card.json HTTP/1.1\r\nHost: attacker.test\r\n\r\n",
        )
        .expect("request should parse");
        let card = a2a_agent_card(&head, &config);

        assert_eq!(card["url"], "http://[::1]:18787");
        assert_eq!(card["supportedInterfaces"][0]["url"], "http://[::1]:18787");

        if let Some(previous_a2a_host) = previous_a2a_host {
            env::set_var("MAESTRO_A2A_PUBLIC_HOST", previous_a2a_host);
        } else {
            env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
        }
        if let Some(previous_a2a_url) = previous_a2a_url {
            env::set_var("MAESTRO_A2A_PUBLIC_URL", previous_a2a_url);
        } else {
            env::remove_var("MAESTRO_A2A_PUBLIC_URL");
        }
        if let Some(previous_control_url) = previous_control_url {
            env::set_var("MAESTRO_CONTROL_PUBLIC_URL", previous_control_url);
        } else {
            env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
        }
        if let Some(previous_control_host) = previous_control_host {
            env::set_var("MAESTRO_CONTROL_PUBLIC_HOST", previous_control_host);
        } else {
            env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
        }
    }

    #[test]
    fn a2a_agent_card_percent_encodes_scoped_ipv6_public_host() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous_a2a_host = env::var_os("MAESTRO_A2A_PUBLIC_HOST");
        let previous_a2a_url = env::var_os("MAESTRO_A2A_PUBLIC_URL");
        let previous_control_url = env::var_os("MAESTRO_CONTROL_PUBLIC_URL");
        let previous_control_host = env::var_os("MAESTRO_CONTROL_PUBLIC_HOST");
        env::set_var("MAESTRO_A2A_PUBLIC_HOST", "fe80::1%en0");
        env::remove_var("MAESTRO_A2A_PUBLIC_URL");
        env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
        env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
        let mut config = auth_test_config();
        config.listen_host = "0.0.0.0".to_string();
        config.listen_port = 18787;
        let head = parse_request_head(
            b"GET /.well-known/agent-card.json HTTP/1.1\r\nHost: attacker.test\r\n\r\n",
        )
        .expect("request should parse");
        let card = a2a_agent_card(&head, &config);

        assert_eq!(card["url"], "http://[fe80::1%25en0]:18787");
        assert_eq!(
            card["supportedInterfaces"][0]["url"],
            "http://[fe80::1%25en0]:18787"
        );

        if let Some(previous_a2a_host) = previous_a2a_host {
            env::set_var("MAESTRO_A2A_PUBLIC_HOST", previous_a2a_host);
        } else {
            env::remove_var("MAESTRO_A2A_PUBLIC_HOST");
        }
        if let Some(previous_a2a_url) = previous_a2a_url {
            env::set_var("MAESTRO_A2A_PUBLIC_URL", previous_a2a_url);
        } else {
            env::remove_var("MAESTRO_A2A_PUBLIC_URL");
        }
        if let Some(previous_control_url) = previous_control_url {
            env::set_var("MAESTRO_CONTROL_PUBLIC_URL", previous_control_url);
        } else {
            env::remove_var("MAESTRO_CONTROL_PUBLIC_URL");
        }
        if let Some(previous_control_host) = previous_control_host {
            env::set_var("MAESTRO_CONTROL_PUBLIC_HOST", previous_control_host);
        } else {
            env::remove_var("MAESTRO_CONTROL_PUBLIC_HOST");
        }
    }

    #[test]
    fn a2a_send_message_honors_return_immediately_configuration() {
        let request = A2ASendMessageRequest {
            message: A2AMessageBody {
                message_id: Some("msg-1".to_string()),
                context_id: Some("ctx-1".to_string()),
                task_id: None,
                role: Some("ROLE_USER".to_string()),
                parts: vec![A2APartBody {
                    text: Some("hello".to_string()),
                    url: None,
                    data: None,
                    metadata: None,
                    filename: None,
                    media_type: Some("text/plain".to_string()),
                }],
                metadata: None,
                extensions: None,
                reference_task_ids: None,
            },
            configuration: Some(serde_json::json!({ "returnImmediately": true })),
            metadata: None,
        };

        assert!(a2a_return_immediately(&request).expect("configuration should be valid"));
    }

    #[test]
    fn a2a_user_message_value_replaces_empty_context_id() {
        let message = A2AMessageBody {
            message_id: Some("msg-1".to_string()),
            context_id: Some("   ".to_string()),
            task_id: None,
            role: Some("ROLE_USER".to_string()),
            parts: vec![A2APartBody {
                text: Some("hello".to_string()),
                url: None,
                data: None,
                metadata: None,
                filename: None,
                media_type: Some("text/plain".to_string()),
            }],
            metadata: None,
            extensions: None,
            reference_task_ids: None,
        };

        let value = a2a_user_message_value(&message, "ctx-1");

        assert_eq!(value["contextId"], "ctx-1");
    }

    #[test]
    fn a2a_context_id_ignores_whitespace_before_falling_back() {
        let request = A2ASendMessageRequest {
            message: A2AMessageBody {
                message_id: Some("msg-1".to_string()),
                context_id: Some("   ".to_string()),
                task_id: None,
                role: Some("ROLE_USER".to_string()),
                parts: vec![A2APartBody {
                    text: Some("hello".to_string()),
                    url: None,
                    data: None,
                    metadata: None,
                    filename: None,
                    media_type: Some("text/plain".to_string()),
                }],
                metadata: None,
                extensions: None,
                reference_task_ids: None,
            },
            configuration: None,
            metadata: None,
        };
        let head = RequestHead {
            method: "POST".to_string(),
            path: "/message:send".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([(
                "x-evalops-session-id".to_string(),
                " header-ctx ".to_string(),
            )]),
        };

        assert_eq!(a2a_context_id(&request, &head), "header-ctx");
    }

    #[test]
    fn a2a_context_id_falls_back_when_message_context_is_blank() {
        let request = A2ASendMessageRequest {
            message: A2AMessageBody {
                message_id: Some("msg-1".to_string()),
                context_id: Some("   ".to_string()),
                task_id: None,
                role: Some("ROLE_USER".to_string()),
                parts: vec![A2APartBody {
                    text: Some("hello".to_string()),
                    url: None,
                    data: None,
                    metadata: Some(serde_json::json!({ "sessionId": " metadata-ctx " })),
                    filename: None,
                    media_type: Some("text/plain".to_string()),
                }],
                metadata: Some(serde_json::json!({ "sessionId": " metadata-ctx " })),
                extensions: None,
                reference_task_ids: None,
            },
            configuration: None,
            metadata: None,
        };
        let head = parse_request_head(
            b"POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-evalops-session-id: header-ctx\r\n\r\n",
        )
        .expect("request should parse");

        assert_eq!(a2a_context_id(&request, &head), "metadata-ctx");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_runs_fake_turn_and_records_task() {
        let _guard = ENV_LOCK.lock().await;
        let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "hello from fake native turn");

        let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}],"metadata":{"agentId":"ts-tui"}}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nx-evalops-workspace-id: ws-1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let task = &response["task"];

        assert_eq!(task["contextId"], "ctx-1");
        assert_eq!(task["status"]["state"], "TASK_STATE_COMPLETED");
        assert_eq!(
            task["artifacts"][0]["parts"][0]["text"],
            "hello from fake native turn"
        );
        assert_eq!(task["metadata"]["workspaceId"], "ws-1");
        assert_eq!(state.a2a_tasks.lock().await.len(), 1);

        if let Some(previous_fake) = previous_fake {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_records_extensions_and_push_config() {
        let _guard = ENV_LOCK.lock().await;
        let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
        let previous_disable_delivery = env::var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY").ok();
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "hello with push config");
        env::set_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY", "1");

        let body = format!(
            r#"{{
                "message": {{
                    "messageId": "msg-push",
                    "contextId": "ctx-push",
                    "role": "ROLE_USER",
                    "extensions": ["{EVALOPS_A2A_EXTENSION_URI}"],
                    "parts": [{{"text": "hello", "mediaType": "text/plain"}}]
                }},
                "configuration": {{
                    "taskPushNotificationConfig": {{
                        "id": "notify-1",
                        "url": "https://hooks.example/a2a",
                        "token": "notify-token",
                        "authentication": {{
                            "schemes": ["Bearer"],
                            "credentials": "auth-token"
                        }}
                    }}
                }}
            }}"#
        );
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nA2A-Extensions: {EVALOPS_A2A_EXTENSION_URI}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let task = &response["task"];

        assert_eq!(task["status"]["state"], "TASK_STATE_COMPLETED");
        assert_eq!(
            task["metadata"]["a2aExtensions"][0],
            EVALOPS_A2A_EXTENSION_URI
        );
        assert_eq!(
            task["metadata"]["pushNotificationConfigs"][0]["taskId"],
            task["id"]
        );
        assert_eq!(
            task["metadata"]["pushNotificationConfigs"][0]["token"],
            "<redacted>"
        );
        let stored_tasks = state.a2a_tasks.lock().await;
        let stored_task = stored_tasks
            .get(task["id"].as_str().expect("task id should be a string"))
            .expect("task should be stored");
        assert_eq!(
            stored_task["metadata"]["pushNotificationConfigs"][0]["token"],
            "notify-token"
        );
        assert!(task["metadata"].get("configuration").is_none());

        if let Some(previous_fake) = previous_fake {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
        }
        if let Some(previous_disable_delivery) = previous_disable_delivery {
            env::set_var(
                "MAESTRO_A2A_PUSH_DISABLE_DELIVERY",
                previous_disable_delivery,
            );
        } else {
            env::remove_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn platform_a2a_push_callback_accepts_status_updates() {
        let _guard = ENV_LOCK.lock().await;
        let previous_token = env::var_os("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
        env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");

        let state = test_app_state_with_sessions(HashMap::new());
        let body = r#"{
            "statusUpdate": {
                "taskId": "platform-run-1",
                "contextId": "ctx-platform-1",
                "status": {
                    "state": "TASK_STATE_COMPLETED",
                    "message": {
                        "messageId": "status-platform-run-1",
                        "contextId": "ctx-platform-1",
                        "role": "ROLE_AGENT",
                        "parts": [{"text": "Platform run completed", "mediaType": "text/plain"}]
                    },
                    "timestamp": "2026-05-17T00:00:00Z"
                },
                "metadata": {
                    "runtimeEventId": "event-1",
                    "runtimeEventType": "RUNTIME_EVENT_TYPE_RUN_SUCCEEDED"
                }
            }
        }"#;
        let request = format!(
            "POST /api/platform/a2a/push HTTP/1.1\r\nHost: localhost\r\nX-A2a-Notification-Token: callback-token\r\nContent-Type: application/a2a+json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let (mut client, server) = tcp_stream_pair().await;
        let state_for_server = state.clone();
        let server_task =
            tokio::spawn(async move { handle_connection(server, state_for_server).await });

        client
            .write_all(request.as_bytes())
            .await
            .expect("request should write");
        client.shutdown().await.expect("client should shutdown");
        let mut response = Vec::new();
        client
            .read_to_end(&mut response)
            .await
            .expect("response should read");
        server_task
            .await
            .expect("server task should join")
            .expect("server should handle request");

        assert_eq!(response_status(&response), 202);
        let parsed = response_json(response);
        assert_eq!(parsed["accepted"], true);
        assert_eq!(parsed["taskId"], "platform-run-1");
        let tasks = state.a2a_tasks.lock().await;
        let task = tasks
            .get("platform-run-1")
            .expect("platform task should be recorded");
        assert_eq!(task["contextId"], "ctx-platform-1");
        assert_eq!(task["status"]["state"], "TASK_STATE_COMPLETED");
        assert_eq!(
            task["metadata"]["lastPlatformStatusUpdate"]["runtimeEventType"],
            "RUNTIME_EVENT_TYPE_RUN_SUCCEEDED"
        );

        if let Some(previous_token) = previous_token {
            env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", previous_token);
        } else {
            env::remove_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn platform_a2a_push_callback_rejects_invalid_token() {
        let _guard = ENV_LOCK.lock().await;
        let previous_token = env::var_os("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
        env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");

        let body = r#"{"statusUpdate":{"taskId":"platform-run-1","status":{"state":"TASK_STATE_WORKING"}}}"#;
        let request = format!(
            "POST /api/platform/a2a/push HTTP/1.1\r\nHost: localhost\r\nX-A2a-Notification-Token: wrong-token\r\nContent-Type: application/a2a+json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            handle_platform_a2a_push_endpoint(&mut server, &mut initial, head, &state).await;

        assert_eq!(response_status(&response), 401);
        assert!(state.a2a_tasks.lock().await.is_empty());

        if let Some(previous_token) = previous_token {
            env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", previous_token);
        } else {
            env::remove_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn platform_a2a_push_callback_requires_configured_token() {
        let _guard = ENV_LOCK.lock().await;
        let previous_primary = env::var_os("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
        let previous_legacy = env::var_os("MAESTRO_A2A_CALLBACK_TOKEN");
        env::remove_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
        env::remove_var("MAESTRO_A2A_CALLBACK_TOKEN");

        let body = r#"{"statusUpdate":{"taskId":"platform-run-1","status":{"state":"TASK_STATE_WORKING"}}}"#;
        let request = format!(
            "POST /api/platform/a2a/push HTTP/1.1\r\nHost: localhost\r\nX-A2a-Notification-Token: callback-token\r\nContent-Type: application/a2a+json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            handle_platform_a2a_push_endpoint(&mut server, &mut initial, head, &state).await;

        assert_eq!(response_status(&response), 503);
        let parsed = response_json(response);
        assert_eq!(parsed["error"]["code"], "CALLBACK_TOKEN_NOT_CONFIGURED");
        assert!(state.a2a_tasks.lock().await.is_empty());

        if let Some(previous_primary) = previous_primary {
            env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", previous_primary);
        } else {
            env::remove_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
        }
        if let Some(previous_legacy) = previous_legacy {
            env::set_var("MAESTRO_A2A_CALLBACK_TOKEN", previous_legacy);
        } else {
            env::remove_var("MAESTRO_A2A_CALLBACK_TOKEN");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn platform_a2a_push_callback_records_artifact_updates() {
        let _guard = ENV_LOCK.lock().await;
        let previous_token = env::var_os("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
        env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");

        let state = test_app_state_with_sessions(HashMap::new());
        let body = r#"{
            "artifactUpdate": {
                "taskId": "platform-run-2",
                "contextId": "ctx-platform-2",
                "artifact": {
                    "artifactId": "artifact-1",
                    "name": "result",
                    "parts": [{"text": "artifact text", "mediaType": "text/plain"}]
                },
                "lastChunk": true
            }
        }"#;
        let request = format!(
            "POST /api/platform/a2a/push HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer callback-token\r\nContent-Type: application/a2a+json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;

        let response =
            handle_platform_a2a_push_endpoint(&mut server, &mut initial, head, &state).await;

        assert_eq!(response_status(&response), 202);
        let tasks = state.a2a_tasks.lock().await;
        let task = tasks
            .get("platform-run-2")
            .expect("platform artifact task should be recorded");
        assert_eq!(task["artifacts"][0]["artifactId"], "artifact-1");
        assert_eq!(task["artifacts"][0]["parts"][0]["text"], "artifact text");

        if let Some(previous_token) = previous_token {
            env::set_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", previous_token);
        } else {
            env::remove_var("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn platform_a2a_push_callback_preserves_existing_context_without_context_update() {
        let state = test_app_state_with_sessions(HashMap::new());
        state.a2a_tasks.lock().await.insert(
            "platform-run-3".to_string(),
            serde_json::json!({
                "id": "platform-run-3",
                "contextId": "ctx-existing",
                "status": {"state": "TASK_STATE_WORKING"},
                "history": [],
                "artifacts": []
            }),
        );

        let status_update = serde_json::json!({
            "taskId": "platform-run-3",
            "status": {"state": "TASK_STATE_COMPLETED"}
        });
        let task = apply_platform_a2a_status_update(&state, &status_update)
            .await
            .expect("status update should be accepted");
        assert_eq!(task["contextId"], "ctx-existing");

        let artifact_update = serde_json::json!({
            "taskId": "platform-run-3",
            "artifact": {
                "artifactId": "artifact-ctx",
                "parts": [{"text": "keeps context", "mediaType": "text/plain"}]
            }
        });
        let task = apply_platform_a2a_artifact_update(&state, &artifact_update)
            .await
            .expect("artifact update should be accepted");
        assert_eq!(task["contextId"], "ctx-existing");
        assert_eq!(task["artifacts"][0]["artifactId"], "artifact-ctx");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_rejects_unsupported_extensions() {
        let body = r#"{"message":{"messageId":"msg-extension","contextId":"ctx-extension","role":"ROLE_USER","extensions":["https://example.test/a2a/extensions/unsupported/v1"],"parts":[{"text":"hello","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert_eq!(response["error"]["code"], "EXTENSION_NOT_SUPPORTED");
        assert!(state.a2a_tasks.lock().await.is_empty());
    }

    #[test]
    fn a2a_push_notification_payloads_use_stream_response_shape() {
        let terminal_task = a2a_task_value(
            "task-push-payload",
            "ctx-push-payload",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-push-payload", "done"),
            Vec::new(),
            vec![serde_json::json!({
                "artifactId": "artifact-1",
                "parts": [{ "text": "artifact text", "mediaType": "text/plain" }]
            })],
            serde_json::json!({
                "workspaceId": "ws-1",
                "pushNotificationConfigs": [{
                    "id": "notify-1",
                    "taskId": "task-push-payload",
                    "url": "https://hooks.example/a2a",
                    "token": "notify-token",
                    "authentication": {
                        "schemes": ["Bearer"],
                        "credentials": "secret"
                    }
                }]
            }),
        );

        let payloads = a2a_push_notification_payloads(&terminal_task);

        assert_eq!(payloads.len(), 3);
        assert_eq!(
            payloads[0]["statusUpdate"]["taskId"],
            serde_json::json!("task-push-payload")
        );
        assert_eq!(
            payloads[1]["artifactUpdate"]["artifact"]["artifactId"],
            serde_json::json!("artifact-1")
        );
        assert_eq!(
            payloads[2]["task"]["id"],
            serde_json::json!("task-push-payload")
        );
        assert_eq!(
            payloads[0]["statusUpdate"]["metadata"]["workspaceId"],
            "ws-1"
        );
        assert!(payloads[0]["statusUpdate"]["metadata"]
            .get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
            .is_none());
        assert!(payloads[1]["artifactUpdate"]["metadata"]
            .get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
            .is_none());
        assert!(payloads[2]["task"]["metadata"]
            .get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
            .is_none());

        for payload in payloads {
            let stream_response_fields = ["task", "message", "statusUpdate", "artifactUpdate"]
                .into_iter()
                .filter(|field| payload.get(field).is_some())
                .count();
            assert_eq!(stream_response_fields, 1);
        }
    }

    #[test]
    fn a2a_push_notification_config_rejects_unaddressable_ids() {
        for id in ["bad/id", "bad:id"] {
            let result = normalize_a2a_push_notification_config(
                "task-push",
                serde_json::json!({
                    "id": id,
                    "taskId": "task-push",
                    "url": "https://hooks.example/a2a"
                }),
                true,
            );

            assert!(result.is_err(), "expected {id} to be rejected");
        }
    }

    #[test]
    fn a2a_push_notification_config_generates_distinct_ids_when_missing() {
        let first = normalize_a2a_push_notification_config(
            "task-push",
            serde_json::json!({
                "taskId": "task-push",
                "url": "https://hooks.example/a2a"
            }),
            true,
        )
        .expect("first config should normalize");
        let second = normalize_a2a_push_notification_config(
            "task-push",
            serde_json::json!({
                "taskId": "task-push",
                "url": "https://hooks.example/a2a"
            }),
            true,
        )
        .expect("second config should normalize");

        let first_id = first["id"].as_str().expect("first id should exist");
        let second_id = second["id"].as_str().expect("second id should exist");
        assert_ne!(first_id, "task-push");
        assert_ne!(second_id, "task-push");
        assert_ne!(first_id, second_id);
        assert!(first_id.starts_with("pushcfg-"));
        assert!(second_id.starts_with("pushcfg-"));
    }

    #[test]
    fn a2a_push_private_ip_check_includes_ipv4_mapped_ipv6() {
        let mapped_loopback = "::ffff:127.0.0.1"
            .parse::<IpAddr>()
            .expect("mapped IPv6 parses");

        assert!(a2a_push_ip_is_private(mapped_loopback));
    }

    #[test]
    fn a2a_push_authorization_header_accepts_schemes_list() {
        let authentication = serde_json::json!({
            "schemes": ["Bearer"],
            "credentials": "secret"
        });
        let header = a2a_push_authorization_header(
            authentication
                .as_object()
                .expect("authentication should be an object"),
        );

        assert_eq!(header.as_deref(), Some("Bearer secret"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_ignores_push_config_metadata_smuggling() {
        let _guard = ENV_LOCK.lock().await;
        let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
        let previous_disable_delivery = env::var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY").ok();
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "hello without smuggled push");
        env::set_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY", "1");

        let body = r#"{
            "message": {
                "messageId": "msg-smuggle",
                "contextId": "ctx-smuggle",
                "role": "ROLE_USER",
                "parts": [{"text": "hello", "mediaType": "text/plain"}],
                "metadata": {
                    "pushNotificationConfigs": [
                        {"id": "msg-smuggled", "url": "https://hooks.example/a2a"}
                    ]
                }
            },
            "metadata": {
                "pushNotificationConfigs": [
                    {"id": "request-smuggled", "url": "https://hooks.example/a2a"}
                ]
            }
        }"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert!(response["task"]["metadata"]
            .get(A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY)
            .is_none());

        if let Some(previous_fake) = previous_fake {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
        }
        if let Some(previous_disable_delivery) = previous_disable_delivery {
            env::set_var(
                "MAESTRO_A2A_PUSH_DISABLE_DELIVERY",
                previous_disable_delivery,
            );
        } else {
            env::remove_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_push_notification_config_crud_updates_task_metadata() {
        let _guard = ENV_LOCK.lock().await;
        let previous_disable_delivery = env::var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY").ok();
        env::set_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY", "1");
        let state = test_app_state_with_sessions(HashMap::new());
        let task = a2a_task_value(
            "task-push",
            "ctx-push",
            "TASK_STATE_WORKING",
            a2a_agent_message("ctx-push", "working"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("task-push".to_string(), task);

        let body = r#"{"id":"notify-1","taskId":"task-push","url":"https://hooks.example/a2a","token":"notify-token"}"#;
        let request = format!(
            "POST /tasks/task-push/pushNotificationConfigs HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let created =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        assert_eq!(created["id"], "notify-1");
        assert_eq!(created["taskId"], "task-push");
        assert_eq!(created["token"], "<redacted>");
        assert_eq!(
            state.a2a_tasks.lock().await["task-push"]["metadata"]["pushNotificationConfigs"][0]
                ["token"],
            "notify-token"
        );

        let mut initial =
            b"GET /tasks/task-push/pushNotificationConfigs HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n".to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let listed =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        assert_eq!(listed["configs"][0]["id"], "notify-1");
        assert_eq!(listed["configs"][0]["token"], "<redacted>");

        let mut initial =
            b"GET /tasks/task-push/pushNotificationConfigs/notify-1 HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n".to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let fetched =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        assert_eq!(fetched["token"], "<redacted>");

        let mut initial =
            b"DELETE /tasks/task-push/pushNotificationConfigs/notify-1 HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n".to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let deleted =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        assert_eq!(deleted, serde_json::json!({}));
        assert!(state.a2a_tasks.lock().await["task-push"]["metadata"]
            .get("pushNotificationConfigs")
            .is_none());

        let mut initial =
            b"DELETE /tasks/task-push/pushNotificationConfigs/notify-1 HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n".to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let deleted_again =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        assert_eq!(deleted_again, serde_json::json!({}));

        if let Some(previous_disable_delivery) = previous_disable_delivery {
            env::set_var(
                "MAESTRO_A2A_PUSH_DISABLE_DELIVERY",
                previous_disable_delivery,
            );
        } else {
            env::remove_var("MAESTRO_A2A_PUSH_DISABLE_DELIVERY");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_requires_csrf_token_when_enabled() {
        let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let base_state = test_app_state_with_sessions(HashMap::new());
        let mut config = auth_test_config();
        config.require_csrf = true;
        config.csrf_token = Some("csrf-token".to_string());
        let state = AppState {
            config: Arc::new(config),
            ..base_state
        };

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert_eq!(response["error"], "Forbidden: invalid CSRF token");
        assert!(state.a2a_tasks.lock().await.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_rejects_non_boolean_return_immediately() {
        let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]},"configuration":{"returnImmediately":"true"}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert_eq!(response["error"]["code"], "INVALID_REQUEST");
        assert_eq!(
            response["error"]["message"],
            "A2A configuration returnImmediately must be a boolean"
        );
        assert!(state.a2a_tasks.lock().await.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_rejects_non_object_configuration() {
        let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]},"configuration":"oops"}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert_eq!(response["error"]["code"], "INVALID_REQUEST");
        assert_eq!(
            response["error"]["message"],
            "A2A configuration must be an object"
        );
        assert!(state.a2a_tasks.lock().await.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_rejects_incompatible_protocol_version() {
        let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:send?a2a-version=2.0 HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert_eq!(response["error"]["code"], "UNSUPPORTED_VERSION");
        assert_eq!(
            response["error"]["message"],
            "Unsupported A2A protocol version 2.0; expected 1.0"
        );
        assert!(state.a2a_tasks.lock().await.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_tasks_list_only_returns_tasks_owned_by_subject() {
        let _guard = ENV_LOCK.lock().await;
        let previous_secret = env::var_os("MAESTRO_AUTH_SHARED_SECRET");
        env::set_var("MAESTRO_AUTH_SHARED_SECRET", "shared-secret");
        let state = test_app_state_with_sessions(HashMap::new());
        for (task_id, owner) in [
            ("owned-task", Some("user-123")),
            ("other-task", Some("user-456")),
            ("unowned-task", None),
        ] {
            let mut metadata = Map::new();
            if let Some(owner) = owner {
                metadata.insert("ownerSubject".to_string(), Value::String(owner.to_string()));
            }
            let task = a2a_task_value(
                task_id,
                "ctx-1",
                "TASK_STATE_COMPLETED",
                a2a_agent_message("ctx-1", "done"),
                Vec::new(),
                Vec::new(),
                Value::Object(metadata),
            );
            state
                .a2a_tasks
                .lock()
                .await
                .insert(task_id.to_string(), task);
        }
        let token = shared_secret_bearer_token(b"shared-secret", "user-123");
        let request = format!(
            "GET /tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\r\n"
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let tasks = response["tasks"]
            .as_array()
            .expect("tasks should be an array");

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["id"], "owned-task");

        if let Some(previous_secret) = previous_secret {
            env::set_var("MAESTRO_AUTH_SHARED_SECRET", previous_secret);
        } else {
            env::remove_var("MAESTRO_AUTH_SHARED_SECRET");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_tasks_list_supports_spec_filters_pagination_and_payload_trimming() {
        let state = test_app_state_with_sessions(HashMap::new());
        for (task_id, context_id, status, timestamp) in [
            (
                "task-a",
                "ctx-1",
                "TASK_STATE_COMPLETED",
                "2026-05-15T00:03:00+00:00",
            ),
            (
                "task-b",
                "ctx-1",
                "TASK_STATE_COMPLETED",
                "2026-05-15T00:02:00Z",
            ),
            (
                "task-c",
                "ctx-2",
                "TASK_STATE_WORKING",
                "2026-05-15T00:01:00Z",
            ),
            (
                "task-d",
                "ctx-1",
                "TASK_STATE_COMPLETED",
                "2026-05-14T19:04:00-05:00",
            ),
        ] {
            let mut task = a2a_task_value(
                task_id,
                context_id,
                status,
                a2a_agent_message(context_id, "done"),
                vec![
                    a2a_agent_message(context_id, "first"),
                    a2a_agent_message(context_id, "second"),
                ],
                vec![serde_json::json!({
                    "artifactId": format!("{task_id}-artifact"),
                    "parts": [{ "text": "artifact", "mediaType": "text/plain" }]
                })],
                serde_json::json!({}),
            );
            task["status"]["timestamp"] = Value::String(timestamp.to_string());
            state
                .a2a_tasks
                .lock()
                .await
                .insert(task_id.to_string(), task);
        }
        let request = "GET /tasks?contextId=ctx-1&status=completed&pageSize=1&historyLength=1 HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
        let mut initial = request.as_bytes().to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let tasks = response["tasks"]
            .as_array()
            .expect("tasks should be an array");

        assert_eq!(response["totalSize"], 3);
        assert_eq!(response["pageSize"], 1);
        let next_page_token = response["nextPageToken"]
            .as_str()
            .expect("next page token should be a string");
        assert!(!next_page_token.is_empty());
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["id"], "task-d");
        assert_eq!(tasks[0]["history"].as_array().unwrap().len(), 1);
        assert!(tasks[0].get("artifacts").is_none());

        let mut newer_task = a2a_task_value(
            "task-e",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "newer"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        newer_task["status"]["timestamp"] = Value::String("2026-05-15T00:05:00Z".to_string());
        state
            .a2a_tasks
            .lock()
            .await
            .insert("task-e".to_string(), newer_task);
        let request = format!(
            "GET /tasks?contextId=ctx-1&status=completed&pageSize=1&historyLength=1&pageToken={next_page_token} HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n"
        );
        let mut initial = request.as_bytes().to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let tasks = response["tasks"]
            .as_array()
            .expect("tasks should be an array");

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["id"], "task-a");

        let request = "GET /tasks?statusTimestampAfter=2026-05-15T00:03:00Z HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
        let mut initial = request.as_bytes().to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let tasks = response["tasks"]
            .as_array()
            .expect("tasks should be an array");

        assert_eq!(response["totalSize"], 3);
        assert_eq!(tasks[0]["id"], "task-e");
        assert_eq!(tasks[1]["id"], "task-d");
        assert_eq!(tasks[2]["id"], "task-a");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_tasks_list_rejects_invalid_history_length() {
        let state = test_app_state_with_sessions(HashMap::new());
        let request = "GET /tasks?historyLength=abc HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
        let mut initial = request.as_bytes().to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert_eq!(response["error"]["code"], "INVALID_REQUEST");
        assert_eq!(
            response["error"]["message"],
            "A2A query parameter historyLength must be an integer"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_task_store_persists_control_plane_tasks_to_ledger_file() {
        let root = TestDir::new("a2a-task-ledger");
        let base_state = test_app_state_with_sessions(HashMap::new());
        let mut config = auth_test_config();
        config.a2a_tasks_file_path = root.path().join("tasks.json");
        let state = AppState {
            config: Arc::new(config),
            ..base_state
        };
        tokio::fs::write(
            &state.config.a2a_tasks_file_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "tasks": [
                    {
                        "id": "remote-ledger-row",
                        "kind": "message",
                        "peer": "peer-b",
                        "taskId": "remote-task",
                        "text": "remote peer task",
                        "state": "TASK_STATE_COMPLETED",
                        "createdAt": "2026-05-15T00:00:00Z",
                        "updatedAt": "2026-05-15T00:01:00Z"
                    },
                    {
                        "id": "maestro-control-plane-other-task",
                        "kind": "message",
                        "peer": A2A_CONTROL_PLANE_LEDGER_PEER,
                        "taskId": "other-control-plane-task",
                        "contextId": "ctx-other",
                        "text": "other process request",
                        "responseText": "other process response",
                        "state": "TASK_STATE_COMPLETED",
                        "createdAt": "2026-05-15T00:00:00Z",
                        "updatedAt": "2026-05-15T00:03:00Z",
                        "metadata": { "workspaceId": "other-ws" }
                    },
                    {
                        "id": "raw-legacy-task",
                        "contextId": "ctx-legacy",
                        "status": {
                            "state": "TASK_STATE_COMPLETED",
                            "message": {
                                "messageId": "legacy-msg",
                                "contextId": "ctx-legacy",
                                "role": "ROLE_AGENT",
                                "parts": [{ "text": "legacy complete" }]
                            },
                            "timestamp": "2026-05-15T00:02:00Z"
                        },
                        "history": [
                            {
                                "messageId": "legacy-user",
                                "contextId": "ctx-legacy",
                                "role": "ROLE_USER",
                                "parts": [{ "text": "legacy request" }]
                            }
                        ],
                        "metadata": { "workspaceId": "legacy-ws" }
                    }
                ]
            }))
            .expect("ledger should serialize"),
        )
        .await
        .expect("existing ledger should be written");
        let task = a2a_task_value(
            "maestro-task-durable",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "complete"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({ "workspaceId": "ws-1" }),
        );
        let raw_legacy_task = load_a2a_tasks(&state.config.a2a_tasks_file_path)
            .await
            .remove("raw-legacy-task")
            .expect("raw legacy task should hydrate before migration");
        state
            .a2a_tasks
            .lock()
            .await
            .insert("raw-legacy-task".to_string(), raw_legacy_task);

        store_a2a_task_unless_canceled(&state, "maestro-task-durable", task).await;
        let loaded = load_a2a_tasks(&state.config.a2a_tasks_file_path).await;
        let ledger: Value = serde_json::from_slice(
            &tokio::fs::read(&state.config.a2a_tasks_file_path)
                .await
                .expect("ledger should be readable"),
        )
        .expect("ledger should be json");
        let entries = ledger["tasks"]
            .as_array()
            .expect("ledger tasks should be an array");
        let remote_entry = entries
            .iter()
            .find(|entry| entry["peer"] == "peer-b")
            .expect("remote peer ledger row should be retained");
        let other_control_plane_entry = entries
            .iter()
            .find(|entry| {
                entry["peer"] == A2A_CONTROL_PLANE_LEDGER_PEER
                    && entry["taskId"] == "other-control-plane-task"
            })
            .expect("other process control-plane row should be retained");
        let control_plane_entry = entries
            .iter()
            .find(|entry| {
                entry["peer"] == A2A_CONTROL_PLANE_LEDGER_PEER
                    && entry["taskId"] == "maestro-task-durable"
            })
            .expect("control-plane ledger row should be written");
        let raw_legacy_entries = entries
            .iter()
            .filter(|entry| entry["id"] == "raw-legacy-task")
            .count();

        assert_eq!(remote_entry["taskId"], "remote-task");
        assert_eq!(
            other_control_plane_entry["metadata"]["workspaceId"],
            "other-ws"
        );
        assert_eq!(control_plane_entry["taskId"], "maestro-task-durable");
        assert_eq!(control_plane_entry["state"], "TASK_STATE_COMPLETED");
        assert_eq!(
            control_plane_entry["peerDisplayName"],
            A2A_CONTROL_PLANE_LEDGER_DISPLAY_NAME
        );
        assert_eq!(control_plane_entry["a2aTask"]["id"], "maestro-task-durable");
        assert_eq!(
            raw_legacy_entries, 0,
            "raw legacy A2A rows should be migrated away from the shared TS ledger shape"
        );
        assert!(entries.iter().any(|entry| {
            entry["peer"] == A2A_CONTROL_PLANE_LEDGER_PEER
                && entry["taskId"] == "raw-legacy-task"
                && entry["a2aTask"]["id"] == "raw-legacy-task"
        }));
        assert!(!loaded.contains_key("remote-task"));
        assert_eq!(
            loaded["maestro-task-durable"]["metadata"]["workspaceId"],
            "ws-1"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_task_store_waits_for_shared_ledger_file_lock() {
        let root = TestDir::new("a2a-task-ledger-lock");
        let base_state = test_app_state_with_sessions(HashMap::new());
        let mut config = auth_test_config();
        config.a2a_tasks_file_path = root.path().join("tasks.json");
        let state = AppState {
            config: Arc::new(config),
            ..base_state
        };
        let lock_path = a2a_task_ledger_lock_path(&state.config.a2a_tasks_file_path);
        tokio::fs::create_dir_all(&lock_path)
            .await
            .expect("test lock should be created");
        let task = a2a_task_value(
            "maestro-task-locked",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "complete"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        let state_for_store = state.clone();
        let store = tokio::spawn(async move {
            store_a2a_task_unless_canceled(&state_for_store, "maestro-task-locked", task).await;
        });

        tokio::time::sleep(Duration::from_millis(A2A_LEDGER_LOCK_RETRY_MS * 3)).await;
        assert!(
            !tokio::fs::try_exists(&state.config.a2a_tasks_file_path)
                .await
                .expect("ledger existence should be checkable"),
            "persist should wait for the shared TS ledger lock before writing"
        );
        tokio::fs::remove_dir_all(&lock_path)
            .await
            .expect("test lock should be released");
        tokio::time::timeout(Duration::from_secs(2), store)
            .await
            .expect("store should finish after lock release")
            .expect("store task should join");

        assert!(
            tokio::fs::try_exists(&state.config.a2a_tasks_file_path)
                .await
                .expect("ledger existence should be checkable"),
            "ledger should be written after lock release"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_task_ledger_lock_heartbeat_refreshes_while_owned() {
        let root = TestDir::new("a2a-task-ledger-lock-heartbeat");
        let tasks_path = root.path().join("tasks.json");
        let file_lock = acquire_a2a_task_ledger_file_lock(&tasks_path)
            .await
            .expect("lock should be acquired");
        let heartbeat_path = file_lock.path.join(A2A_LEDGER_LOCK_HEARTBEAT_FILE);
        let first_heartbeat = tokio::fs::read_to_string(&heartbeat_path)
            .await
            .expect("heartbeat should be readable");

        let heartbeat_task =
            spawn_a2a_task_ledger_lock_heartbeat(&file_lock, Duration::from_millis(10));
        tokio::time::sleep(Duration::from_millis(35)).await;
        heartbeat_task.abort();
        let _ = heartbeat_task.await;

        let refreshed_heartbeat = tokio::fs::read_to_string(&heartbeat_path)
            .await
            .expect("heartbeat should still be readable");
        assert_ne!(refreshed_heartbeat, first_heartbeat);

        release_a2a_task_ledger_file_lock(file_lock).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_task_load_skips_remote_cli_ledger_entries() {
        let root = TestDir::new("a2a-task-ledger-remote-skip");
        let tasks_path = root.path().join("tasks.json");
        tokio::fs::write(
            &tasks_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "tasks": [
                    {
                        "id": "remote-ledger-row",
                        "kind": "message",
                        "peer": "peer-b",
                        "taskId": "remote-task",
                        "text": "remote peer task",
                        "state": "TASK_STATE_COMPLETED",
                        "createdAt": "2026-05-15T00:00:00Z",
                        "updatedAt": "2026-05-15T00:01:00Z"
                    },
                    {
                        "id": "raw-legacy-task",
                        "contextId": "ctx-legacy",
                        "status": {
                            "state": "TASK_STATE_COMPLETED",
                            "message": {
                                "messageId": "legacy-msg",
                                "contextId": "ctx-legacy",
                                "role": "ROLE_AGENT",
                                "parts": [{ "text": "legacy complete" }]
                            }
                        },
                        "metadata": { "workspaceId": "legacy-ws" }
                    },
                    {
                        "id": "maestro-control-plane-local-task",
                        "kind": "message",
                        "peer": A2A_CONTROL_PLANE_LEDGER_PEER,
                        "taskId": "local-task",
                        "contextId": "ctx-local",
                        "text": "local request",
                        "responseText": "local response",
                        "state": "TASK_STATE_COMPLETED",
                        "transcript": [
                            { "role": "user", "text": "local request", "messageId": "msg-local" },
                            { "role": "agent", "text": "local response", "state": "TASK_STATE_COMPLETED" }
                        ],
                        "createdAt": "2026-05-15T00:00:00Z",
                        "updatedAt": "2026-05-15T00:02:00Z",
                        "metadata": { "workspaceId": "local-ws" }
                    }
                ]
            }))
            .expect("ledger should serialize"),
        )
        .await
        .expect("ledger should be written");

        let loaded = load_a2a_tasks(&tasks_path).await;

        assert!(!loaded.contains_key("remote-task"));
        assert_eq!(
            loaded["raw-legacy-task"]["metadata"]["workspaceId"],
            "legacy-ws"
        );
        assert_eq!(loaded["local-task"]["metadata"]["workspaceId"], "local-ws");
        assert_eq!(
            loaded["local-task"]["status"]["message"]["parts"][0]["text"],
            "local response"
        );
        assert_eq!(loaded["local-task"]["history"].as_array().unwrap().len(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_task_persist_rewrites_legacy_control_plane_ledger_entries() {
        let root = TestDir::new("a2a-task-ledger-legacy-rewrite");
        let base_state = test_app_state_with_sessions(HashMap::new());
        let mut config = auth_test_config();
        config.a2a_tasks_file_path = root.path().join("tasks.json");
        let state = AppState {
            config: Arc::new(config),
            ..base_state
        };
        tokio::fs::write(
            &state.config.a2a_tasks_file_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "tasks": [
                    {
                        "id": "remote-ledger-row",
                        "kind": "message",
                        "peer": "peer-b",
                        "taskId": "remote-task",
                        "text": "remote peer task",
                        "state": "TASK_STATE_COMPLETED",
                        "createdAt": "2026-05-15T00:00:00Z",
                        "updatedAt": "2026-05-15T00:01:00Z"
                    },
                    {
                        "id": "raw-legacy-task",
                        "contextId": "ctx-legacy",
                        "status": {
                            "state": "TASK_STATE_COMPLETED",
                            "message": {
                                "messageId": "legacy-msg",
                                "contextId": "ctx-legacy",
                                "role": "ROLE_AGENT",
                                "parts": [{ "text": "legacy complete" }]
                            }
                        },
                        "metadata": { "workspaceId": "legacy-ws" }
                    }
                ]
            }))
            .expect("ledger should serialize"),
        )
        .await
        .expect("ledger should be written");

        let loaded = load_a2a_tasks(&state.config.a2a_tasks_file_path).await;
        state.a2a_tasks.lock().await.extend(loaded);

        persist_a2a_tasks(&state).await;

        let ledger: Value = serde_json::from_slice(
            &tokio::fs::read(&state.config.a2a_tasks_file_path)
                .await
                .expect("ledger should be readable"),
        )
        .expect("ledger should be json");
        let entries = ledger["tasks"]
            .as_array()
            .expect("ledger tasks should be an array");
        let control_plane_entry = entries
            .iter()
            .find(|entry| entry["taskId"] == "raw-legacy-task")
            .expect("legacy task should be rewritten as a control-plane row");

        assert_eq!(entries.len(), 2);
        assert_eq!(control_plane_entry["peer"], A2A_CONTROL_PLANE_LEDGER_PEER);
        assert_eq!(control_plane_entry["a2aTask"]["id"], "raw-legacy-task");
        assert_eq!(
            control_plane_entry["a2aTask"]["metadata"]["workspaceId"],
            "legacy-ws"
        );
        assert!(!entries
            .iter()
            .any(|entry| entry.get("peer").is_none() && entry["id"] == "raw-legacy-task"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_stream_emits_task_status_and_artifact_events() {
        let _guard = ENV_LOCK.lock().await;
        let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "streamed fake response");
        let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-stream","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:stream HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let state = test_app_state_with_sessions(HashMap::new());
        let (mut client, server) = tcp_stream_pair().await;
        let state_for_run = state.clone();
        let run = tokio::spawn(async move {
            handle_a2a_streaming_endpoint(server, initial, head, state_for_run).await
        });
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut bytes))
            .await
            .expect("stream response should close")
            .expect("stream response should be readable");
        run.await
            .expect("stream task should join")
            .expect("stream endpoint should succeed");
        let response = String::from_utf8(bytes).expect("response should be utf-8");

        assert!(response.contains("Content-Type: text/event-stream"));
        assert!(response.contains("event: task"));
        assert!(response.contains("event: statusUpdate"));
        assert!(response.contains("event: artifactUpdate"));
        assert!(response.contains("\"statusUpdate\""));
        assert!(response.contains("\"artifactUpdate\""));
        assert!(response.contains("streamed fake response"));
        assert_eq!(state.a2a_tasks.lock().await.len(), 1);

        if let Some(previous_fake) = previous_fake {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_task_subscribe_rejects_existing_terminal_task() {
        let state = test_app_state_with_sessions(HashMap::new());
        let task = a2a_task_value(
            "maestro-task-subscribe",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "complete"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-subscribe".to_string(), task);
        let request = "GET /tasks/maestro-task-subscribe:subscribe HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
        let initial = request.as_bytes().to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (mut client, server) = tcp_stream_pair().await;
        let state_for_run = state.clone();
        let run = tokio::spawn(async move {
            handle_a2a_streaming_endpoint(server, initial, head, state_for_run).await
        });
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut bytes))
            .await
            .expect("subscribe response should close")
            .expect("subscribe response should be readable");
        run.await
            .expect("subscribe task should join")
            .expect("subscribe endpoint should succeed");
        let response = String::from_utf8(bytes).expect("response should be utf-8");
        let body: Value =
            serde_json::from_str(response_body_text(&response)).expect("body should be json");

        assert!(response.contains("400 Bad Request"));
        assert_eq!(body["error"]["code"], "UNSUPPORTED_OPERATION");
        assert!(body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("terminal tasks cannot be subscribed"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_task_subscribe_streams_active_task_until_terminal_update() {
        let _guard = ENV_LOCK.lock().await;
        let previous_timeout = env::var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS").ok();
        let previous_heartbeat = env::var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS").ok();
        env::set_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS", "250");
        env::set_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS", "10");
        let state = test_app_state_with_sessions(HashMap::new());
        let initial_task = a2a_task_value(
            "maestro-task-active-subscribe",
            "ctx-1",
            "TASK_STATE_WORKING",
            a2a_agent_message("ctx-1", "working"),
            vec![a2a_agent_message("ctx-1", "working")],
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-active-subscribe".to_string(), initial_task);
        let request = "GET /tasks/maestro-task-active-subscribe:subscribe HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
        let initial = request.as_bytes().to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (mut client, server) = tcp_stream_pair().await;
        let state_for_run = state.clone();
        let run = tokio::spawn(async move {
            handle_a2a_streaming_endpoint(server, initial, head, state_for_run).await
        });
        let mut response_bytes = vec![0_u8; 4096];
        let initial_len =
            tokio::time::timeout(Duration::from_secs(2), client.read(&mut response_bytes))
                .await
                .expect("subscribe response should start")
                .expect("subscribe response should be readable");
        response_bytes.truncate(initial_len);
        tokio::time::sleep(Duration::from_millis(30)).await;
        let terminal_task = a2a_task_value(
            "maestro-task-active-subscribe",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "complete"),
            vec![
                a2a_agent_message("ctx-1", "working"),
                a2a_agent_message("ctx-1", "complete"),
            ],
            vec![serde_json::json!({
                "artifactId": "artifact-1",
                "parts": [{ "text": "artifact body", "mediaType": "text/plain" }]
            })],
            serde_json::json!({}),
        );
        state.a2a_tasks.lock().await.insert(
            "maestro-task-active-subscribe".to_string(),
            terminal_task.clone(),
        );
        publish_a2a_task_update(&state, &terminal_task).await;
        tokio::time::timeout(
            Duration::from_secs(2),
            client.read_to_end(&mut response_bytes),
        )
        .await
        .expect("subscribe response should close")
        .expect("subscribe response should be readable");
        run.await
            .expect("subscribe task should join")
            .expect("subscribe endpoint should succeed");
        let response = String::from_utf8(response_bytes).expect("response should be utf-8");

        assert!(response.contains("Content-Type: text/event-stream"));
        assert!(response.contains("event: task"));
        assert!(response.contains("event: statusUpdate"));
        assert!(response.contains("event: artifactUpdate"));
        assert!(response.contains("TASK_STATE_COMPLETED"));
        assert!(response.contains("artifact body"));

        if let Some(previous_timeout) = previous_timeout {
            env::set_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS", previous_timeout);
        } else {
            env::remove_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS");
        }
        if let Some(previous_heartbeat) = previous_heartbeat {
            env::set_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS", previous_heartbeat);
        } else {
            env::remove_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_task_subscribe_times_out_active_stream() {
        let _guard = ENV_LOCK.lock().await;
        let previous_timeout = env::var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS").ok();
        let previous_heartbeat = env::var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS").ok();
        env::set_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS", "40");
        env::set_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS", "10");
        let state = test_app_state_with_sessions(HashMap::new());
        let initial_task = a2a_task_value(
            "maestro-task-timeout-subscribe",
            "ctx-1",
            "TASK_STATE_WORKING",
            a2a_agent_message("ctx-1", "working"),
            vec![a2a_agent_message("ctx-1", "working")],
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-timeout-subscribe".to_string(), initial_task);
        let request = "GET /tasks/maestro-task-timeout-subscribe:subscribe HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
        let initial = request.as_bytes().to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (mut client, server) = tcp_stream_pair().await;
        let state_for_run = state.clone();
        let run = tokio::spawn(async move {
            handle_a2a_streaming_endpoint(server, initial, head, state_for_run).await
        });
        let mut response_bytes = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(1),
            client.read_to_end(&mut response_bytes),
        )
        .await
        .expect("subscribe response should close after timeout")
        .expect("subscribe response should be readable");
        run.await
            .expect("subscribe task should join")
            .expect("subscribe endpoint should succeed");
        let response = String::from_utf8(response_bytes).expect("response should be utf-8");

        assert!(response.contains("Content-Type: text/event-stream"));
        assert!(response.contains("TASK_STATE_WORKING"));
        assert!(response.contains(": keep-alive"));

        if let Some(previous_timeout) = previous_timeout {
            env::set_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS", previous_timeout);
        } else {
            env::remove_var("MAESTRO_A2A_SUBSCRIBE_TIMEOUT_MS");
        }
        if let Some(previous_heartbeat) = previous_heartbeat {
            env::set_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS", previous_heartbeat);
        } else {
            env::remove_var("MAESTRO_A2A_SUBSCRIBE_HEARTBEAT_MS");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_task_subscribe_reconciles_current_task_after_broadcast_lag() {
        let base_state = test_app_state_with_sessions(HashMap::new());
        let (a2a_task_events, _) = broadcast::channel(1);
        let state = AppState {
            a2a_task_events,
            ..base_state
        };
        let initial_task = a2a_task_value(
            "maestro-task-lagged-subscribe",
            "ctx-1",
            "TASK_STATE_WORKING",
            a2a_agent_message("ctx-1", "working"),
            vec![a2a_agent_message("ctx-1", "working")],
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-lagged-subscribe".to_string(), initial_task);
        let request = "GET /tasks/maestro-task-lagged-subscribe:subscribe HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
        let initial = request.as_bytes().to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (mut client, server) = tcp_stream_pair().await;
        let state_for_run = state.clone();
        let run = tokio::spawn(async move {
            handle_a2a_streaming_endpoint(server, initial, head, state_for_run).await
        });
        let mut response_bytes = vec![0_u8; 4096];
        let initial_len =
            tokio::time::timeout(Duration::from_secs(2), client.read(&mut response_bytes))
                .await
                .expect("subscribe response should start")
                .expect("subscribe response should be readable");
        response_bytes.truncate(initial_len);

        let intermediate_task = a2a_task_value(
            "maestro-task-lagged-subscribe",
            "ctx-1",
            "TASK_STATE_WORKING",
            a2a_agent_message("ctx-1", "halfway after lag"),
            vec![
                a2a_agent_message("ctx-1", "working"),
                a2a_agent_message("ctx-1", "halfway after lag"),
            ],
            Vec::new(),
            serde_json::json!({}),
        );
        state.a2a_tasks.lock().await.insert(
            "maestro-task-lagged-subscribe".to_string(),
            intermediate_task.clone(),
        );
        publish_a2a_task_update(&state, &intermediate_task).await;
        let terminal_task = a2a_task_value(
            "maestro-task-lagged-subscribe",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "complete after lag"),
            vec![
                a2a_agent_message("ctx-1", "working"),
                a2a_agent_message("ctx-1", "halfway after lag"),
                a2a_agent_message("ctx-1", "complete after lag"),
            ],
            Vec::new(),
            serde_json::json!({}),
        );
        state.a2a_tasks.lock().await.insert(
            "maestro-task-lagged-subscribe".to_string(),
            terminal_task.clone(),
        );
        publish_a2a_task_update(&state, &terminal_task).await;
        for index in 0..4 {
            let unrelated_task = a2a_task_value(
                &format!("unrelated-task-{index}"),
                "ctx-other",
                "TASK_STATE_WORKING",
                a2a_agent_message("ctx-other", "noise"),
                Vec::new(),
                Vec::new(),
                serde_json::json!({}),
            );
            publish_a2a_task_update(&state, &unrelated_task).await;
        }

        tokio::time::timeout(
            Duration::from_secs(2),
            client.read_to_end(&mut response_bytes),
        )
        .await
        .expect("subscribe response should close after reconciling lag")
        .expect("subscribe response should be readable");
        run.await
            .expect("subscribe task should join")
            .expect("subscribe endpoint should succeed");
        let response = String::from_utf8(response_bytes).expect("response should be utf-8");

        assert!(response.contains("TASK_STATE_COMPLETED"));
        assert!(response.contains("halfway after lag"));
        assert!(response.contains("complete after lag"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_rejects_task_follow_up_from_other_subject() {
        let _guard = ENV_LOCK.lock().await;
        let previous_secret = env::var_os("MAESTRO_AUTH_SHARED_SECRET");
        let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
        env::set_var("MAESTRO_AUTH_SHARED_SECRET", "shared-secret");
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "should not run");
        let state = test_app_state_with_sessions(HashMap::new());
        let existing_message = a2a_agent_message("ctx-1", "Need more input");
        let task = a2a_task_value(
            "owned-task",
            "ctx-1",
            "TASK_STATE_INPUT_REQUIRED",
            existing_message.clone(),
            vec![existing_message],
            Vec::new(),
            serde_json::json!({ "ownerSubject": "user-123" }),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("owned-task".to_string(), task);
        let token = shared_secret_bearer_token(b"shared-secret", "user-456");
        let body = r#"{"message":{"messageId":"msg-2","contextId":"ctx-1","taskId":"owned-task","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert_eq!(response["error"]["code"], "TASK_NOT_FOUND");
        assert_eq!(
            state.a2a_tasks.lock().await["owned-task"]["status"]["state"],
            "TASK_STATE_INPUT_REQUIRED"
        );

        if let Some(previous_secret) = previous_secret {
            env::set_var("MAESTRO_AUTH_SHARED_SECRET", previous_secret);
        } else {
            env::remove_var("MAESTRO_AUTH_SHARED_SECRET");
        }
        if let Some(previous_fake) = previous_fake {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_preserves_owner_metadata_on_unrestricted_follow_up() {
        let _guard = ENV_LOCK.lock().await;
        let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "follow-up response");
        let state = test_app_state_with_sessions(HashMap::new());
        let existing_message = a2a_agent_message("ctx-1", "Need more input");
        let task = a2a_task_value(
            "owned-task",
            "ctx-1",
            "TASK_STATE_INPUT_REQUIRED",
            existing_message.clone(),
            vec![existing_message],
            Vec::new(),
            serde_json::json!({
                "ownerSubject": "user-123",
                "workspaceId": "ws-old"
            }),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("owned-task".to_string(), task);
        let body = r#"{"message":{"messageId":"msg-2","contextId":"ctx-1","taskId":"owned-task","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nx-evalops-workspace-id: ws-new\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let task = &response["task"];

        assert_eq!(task["id"], "owned-task");
        assert_eq!(task["metadata"]["ownerSubject"], "user-123");
        assert_eq!(task["metadata"]["workspaceId"], "ws-new");
        assert_eq!(
            state.a2a_tasks.lock().await["owned-task"]["metadata"]["ownerSubject"],
            "user-123"
        );

        if let Some(previous_fake) = previous_fake {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_rejects_unknown_task_id() {
        let _guard = ENV_LOCK.lock().await;
        let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "should not run");

        let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","taskId":"missing-task","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert_eq!(response["error"]["code"], "TASK_NOT_FOUND");
        assert!(state.a2a_tasks.lock().await.is_empty());

        if let Some(previous_fake) = previous_fake {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_reuses_existing_task_id_and_history() {
        let _guard = ENV_LOCK.lock().await;
        let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "follow-up response");

        let body = r#"{"message":{"messageId":"msg-2","taskId":"maestro-task-1","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nx-evalops-session-id: header-ctx\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());
        let existing_message = a2a_agent_message("ctx-1", "Need more input");
        let task = a2a_task_value(
            "maestro-task-1",
            "ctx-1",
            "TASK_STATE_INPUT_REQUIRED",
            existing_message.clone(),
            vec![existing_message],
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-1".to_string(), task);

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let task = &response["task"];

        assert_eq!(task["id"], "maestro-task-1");
        assert_eq!(task["contextId"], "ctx-1");
        assert_eq!(task["status"]["state"], "TASK_STATE_COMPLETED");
        assert_eq!(task["history"].as_array().unwrap().len(), 3);
        assert_eq!(task["history"][1]["contextId"], "ctx-1");
        assert_eq!(task["history"][2]["parts"][0]["text"], "follow-up response");

        if let Some(previous_fake) = previous_fake {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_rejects_terminal_task_id() {
        let body = r#"{"message":{"messageId":"msg-2","contextId":"ctx-1","taskId":"maestro-task-1","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());
        let task = a2a_task_value(
            "maestro-task-1",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "complete"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-1".to_string(), task);

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert_eq!(response["error"]["code"], "UNSUPPORTED_OPERATION");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_rejects_active_task_id() {
        let body = r#"{"message":{"messageId":"msg-2","contextId":"ctx-1","taskId":"maestro-task-1","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());
        let task = a2a_task_value(
            "maestro-task-1",
            "ctx-1",
            "TASK_STATE_WORKING",
            a2a_agent_message("ctx-1", "working"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-1".to_string(), task);
        let (cancel_tx, _cancel_rx) = watch::channel(false);
        state
            .a2a_cancel_senders
            .lock()
            .await
            .insert("maestro-task-1".to_string(), cancel_tx);

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let stored = state.a2a_tasks.lock().await;

        assert_eq!(response["error"]["code"], "UNSUPPORTED_OPERATION");
        assert_eq!(
            stored["maestro-task-1"]["status"]["state"],
            "TASK_STATE_WORKING"
        );
        assert_eq!(state.a2a_cancel_senders.lock().await.len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_claims_input_task_before_launch() {
        let state = test_app_state_with_sessions(HashMap::new());
        let existing_message = a2a_agent_message("ctx-1", "Need more input");
        let task = a2a_task_value(
            "maestro-task-1",
            "ctx-1",
            "TASK_STATE_INPUT_REQUIRED",
            existing_message.clone(),
            vec![existing_message],
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-1".to_string(), task);
        let head = RequestHead {
            method: "POST".to_string(),
            path: "/message:send".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };
        let request = A2ASendMessageRequest {
            message: A2AMessageBody {
                message_id: Some("msg-2".to_string()),
                context_id: None,
                task_id: Some("maestro-task-1".to_string()),
                role: Some("ROLE_USER".to_string()),
                parts: vec![A2APartBody {
                    text: Some("follow up".to_string()),
                    url: None,
                    data: None,
                    metadata: None,
                    filename: None,
                    media_type: Some("text/plain".to_string()),
                }],
                metadata: None,
                extensions: None,
                reference_task_ids: None,
            },
            configuration: None,
            metadata: None,
        };
        let auth = AuthContext {
            subject: None,
            unrestricted: true,
        };

        let claimed = claim_a2a_send_task(
            &state,
            &request,
            &head,
            &auth,
            serde_json::json!({ "test": "metadata" }),
        )
        .await
        .expect("input-required task should be claimed");
        let stored = state.a2a_tasks.lock().await;

        assert_eq!(claimed.task_id, "maestro-task-1");
        assert_eq!(claimed.context_id, "ctx-1");
        assert_eq!(claimed.history.len(), 2);
        assert_eq!(
            stored["maestro-task-1"]["status"]["state"],
            "TASK_STATE_WORKING"
        );
        drop(stored);

        let response = response_json(
            claim_a2a_send_task(&state, &request, &head, &auth, serde_json::json!({}))
                .await
                .expect_err("already-claimed task should reject overlap"),
        );
        assert_eq!(response["error"]["code"], "UNSUPPORTED_OPERATION");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_message_send_restores_claimed_task_when_cancel_sender_registration_fails() {
        let body = r#"{"message":{"messageId":"msg-2","contextId":"ctx-1","taskId":"maestro-task-1","role":"ROLE_USER","parts":[{"text":"follow up","mediaType":"text/plain"}]}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());
        let existing_message = a2a_agent_message("ctx-1", "Need more input");
        let task = a2a_task_value(
            "maestro-task-1",
            "ctx-1",
            "TASK_STATE_INPUT_REQUIRED",
            existing_message.clone(),
            vec![existing_message],
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-1".to_string(), task);
        let (cancel_tx, _cancel_rx) = watch::channel(false);
        state
            .a2a_cancel_senders
            .lock()
            .await
            .insert("maestro-task-1".to_string(), cancel_tx);

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let stored = state.a2a_tasks.lock().await;

        assert_eq!(response["error"]["code"], "UNSUPPORTED_OPERATION");
        assert_eq!(
            stored["maestro-task-1"]["status"]["state"],
            "TASK_STATE_INPUT_REQUIRED"
        );
        assert_eq!(
            stored["maestro-task-1"]["history"]
                .as_array()
                .expect("history should be an array")
                .len(),
            1
        );
        drop(stored);
        assert_eq!(state.a2a_cancel_senders.lock().await.len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_cancel_rejects_terminal_tasks() {
        let (_client, mut server) = tcp_stream_pair().await;
        let mut initial =
            b"POST /tasks/maestro-task-1:cancel HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n"
                .to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let state = test_app_state_with_sessions(HashMap::new());
        let task = a2a_task_value(
            "maestro-task-1",
            "ctx-1",
            "TASK_STATE_COMPLETED",
            a2a_agent_message("ctx-1", "complete"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-1".to_string(), task);

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let stored = state.a2a_tasks.lock().await;

        assert_eq!(response["error"]["code"], "TASK_NOT_CANCELABLE");
        assert_eq!(
            stored["maestro-task-1"]["status"]["state"],
            "TASK_STATE_COMPLETED"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_cancel_clears_stale_artifacts() {
        let (_client, mut server) = tcp_stream_pair().await;
        let mut initial =
            b"POST /tasks/maestro-task-1:cancel HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n"
                .to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let state = test_app_state_with_sessions(HashMap::new());
        let task = a2a_task_value(
            "maestro-task-1",
            "ctx-1",
            "TASK_STATE_INPUT_REQUIRED",
            a2a_agent_message("ctx-1", "waiting"),
            Vec::new(),
            vec![serde_json::json!({
                "artifactId": "stale-artifact",
                "parts": [{ "text": "stale", "mediaType": "text/plain" }]
            })],
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-1".to_string(), task);

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let stored = state.a2a_tasks.lock().await;

        assert_eq!(response["status"]["state"], "TASK_STATE_CANCELED");
        assert_eq!(response["artifacts"].as_array().unwrap().len(), 0);
        assert_eq!(
            stored["maestro-task-1"]["artifacts"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_async_completion_preserves_canceled_task_state() {
        let _guard = ENV_LOCK.lock().await;
        let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "late response");

        let state = test_app_state_with_sessions(HashMap::new());
        let task = a2a_task_value(
            "maestro-task-1",
            "ctx-1",
            "TASK_STATE_CANCELED",
            a2a_agent_message("ctx-1", "Task canceled"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("maestro-task-1".to_string(), task);

        let user_message = a2a_user_message_value(
            &A2AMessageBody {
                message_id: Some("msg-1".to_string()),
                context_id: Some("ctx-1".to_string()),
                task_id: Some("maestro-task-1".to_string()),
                role: Some("ROLE_USER".to_string()),
                parts: vec![A2APartBody {
                    text: Some("hello".to_string()),
                    url: None,
                    data: None,
                    metadata: None,
                    filename: None,
                    media_type: Some("text/plain".to_string()),
                }],
                metadata: None,
                extensions: None,
                reference_task_ids: None,
            },
            "ctx-1",
        );
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let task = complete_a2a_task(
            &state,
            "hello".to_string(),
            "maestro-task-1".to_string(),
            "ctx-1".to_string(),
            vec![user_message],
            serde_json::json!({}),
            cancel_rx,
        )
        .await;
        let stored = state.a2a_tasks.lock().await;

        assert_eq!(task["status"]["state"], "TASK_STATE_CANCELED");
        assert_eq!(
            stored["maestro-task-1"]["status"]["state"],
            "TASK_STATE_CANCELED"
        );

        if let Some(previous_fake) = previous_fake {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_cancel_signals_return_immediately_worker() {
        let _guard = ENV_LOCK.lock().await;
        let previous_fake = env::var("MAESTRO_A2A_FAKE_RESPONSE").ok();
        let previous_delay = env::var("MAESTRO_A2A_FAKE_RESPONSE_DELAY_MS").ok();
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE", "late response");
        env::set_var("MAESTRO_A2A_FAKE_RESPONSE_DELAY_MS", "500");

        let body = r#"{"message":{"messageId":"msg-1","contextId":"ctx-1","role":"ROLE_USER","parts":[{"text":"hello","mediaType":"text/plain"}]},"configuration":{"returnImmediately":true}}"#;
        let request = format!(
            "POST /message:send HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let task_id = response["task"]["id"]
            .as_str()
            .expect("task id should be present")
            .to_string();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            state.a2a_tasks.lock().await[&task_id]["status"]["state"],
            "TASK_STATE_WORKING"
        );

        let cancel_request = format!(
            "POST /tasks/{task_id}:cancel HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n"
        );
        let mut cancel_initial = cancel_request.into_bytes();
        let cancel_head = parse_request_head(&cancel_initial).expect("request should parse");
        let (_client, mut cancel_server) = tcp_stream_pair().await;
        let cancel_response = response_json(
            handle_a2a_endpoint(&mut cancel_server, &mut cancel_initial, cancel_head, &state).await,
        );
        assert_eq!(cancel_response["status"]["state"], "TASK_STATE_CANCELED");

        tokio::time::sleep(Duration::from_millis(600)).await;
        let stored = state.a2a_tasks.lock().await;
        assert_eq!(stored[&task_id]["status"]["state"], "TASK_STATE_CANCELED");
        assert_eq!(stored[&task_id]["artifacts"].as_array().unwrap().len(), 0);

        if let Some(previous_fake) = previous_fake {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE", previous_fake);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE");
        }
        if let Some(previous_delay) = previous_delay {
            env::set_var("MAESTRO_A2A_FAKE_RESPONSE_DELAY_MS", previous_delay);
        } else {
            env::remove_var("MAESTRO_A2A_FAKE_RESPONSE_DELAY_MS");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_cancel_requires_csrf_token_when_enabled() {
        let base_state = test_app_state_with_sessions(HashMap::new());
        let mut config = auth_test_config();
        config.require_csrf = true;
        config.csrf_token = Some("csrf-token".to_string());
        let state = AppState {
            config: Arc::new(config),
            ..base_state
        };
        state.a2a_tasks.lock().await.insert(
            "maestro-task-1".to_string(),
            a2a_task_value(
                "maestro-task-1",
                "ctx-1",
                "TASK_STATE_WORKING",
                a2a_agent_message("ctx-1", "working"),
                Vec::new(),
                Vec::new(),
                serde_json::json!({ "workspaceId": "ws-1" }),
            ),
        );

        let request = "POST /tasks/maestro-task-1:cancel HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
        let mut initial = request.as_bytes().to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);

        assert_eq!(response["error"], "Forbidden: invalid CSRF token");
        assert_eq!(
            state.a2a_tasks.lock().await["maestro-task-1"]["status"]["state"],
            "TASK_STATE_WORKING"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_task_store_evicts_old_terminal_tasks() {
        let state = test_app_state_with_sessions(HashMap::new());
        let working_task = a2a_task_value(
            "working-task",
            "ctx-1",
            "TASK_STATE_WORKING",
            a2a_agent_message("ctx-1", "still running"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        store_a2a_task_unless_canceled(&state, "working-task", working_task).await;

        for index in 0..=A2A_TERMINAL_TASK_STORE_LIMIT {
            let task_id = format!("terminal-task-{index}");
            let mut task = a2a_task_value(
                &task_id,
                "ctx-1",
                "TASK_STATE_COMPLETED",
                a2a_agent_message("ctx-1", "done"),
                Vec::new(),
                Vec::new(),
                serde_json::json!({}),
            );
            task["status"]["timestamp"] = Value::String(format!(
                "2026-05-15T00:{:02}:{:02}Z",
                index / 60,
                index % 60
            ));
            store_a2a_task_unless_canceled(&state, &task_id, task).await;
        }

        let newest_terminal_task_id = format!("terminal-task-{A2A_TERMINAL_TASK_STORE_LIMIT}");
        let stored = state.a2a_tasks.lock().await;

        assert_eq!(stored.len(), A2A_TERMINAL_TASK_STORE_LIMIT + 1);
        assert!(stored.contains_key("working-task"));
        assert!(!stored.contains_key("terminal-task-0"));
        assert!(stored.contains_key(&newest_terminal_task_id));
        assert_eq!(
            stored
                .values()
                .filter(|task| a2a_task_is_terminal(task))
                .count(),
            A2A_TERMINAL_TASK_STORE_LIMIT
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a2a_cancel_prunes_terminal_task_store() {
        let state = test_app_state_with_sessions(HashMap::new());
        for index in 0..A2A_TERMINAL_TASK_STORE_LIMIT {
            let task_id = format!("terminal-task-{index}");
            let mut task = a2a_task_value(
                &task_id,
                "ctx-1",
                "TASK_STATE_COMPLETED",
                a2a_agent_message("ctx-1", "done"),
                Vec::new(),
                Vec::new(),
                serde_json::json!({}),
            );
            task["status"]["timestamp"] = Value::String(format!(
                "2026-05-15T00:{:02}:{:02}Z",
                index / 60,
                index % 60
            ));
            state.a2a_tasks.lock().await.insert(task_id, task);
        }
        let task = a2a_task_value(
            "cancel-task",
            "ctx-1",
            "TASK_STATE_INPUT_REQUIRED",
            a2a_agent_message("ctx-1", "Need more input"),
            Vec::new(),
            Vec::new(),
            serde_json::json!({}),
        );
        state
            .a2a_tasks
            .lock()
            .await
            .insert("cancel-task".to_string(), task);
        let request = b"POST /tasks/cancel-task:cancel HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\n\r\n";
        let mut initial = request.to_vec();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;

        let response =
            response_json(handle_a2a_endpoint(&mut server, &mut initial, head, &state).await);
        let stored = state.a2a_tasks.lock().await;

        assert_eq!(response["status"]["state"], "TASK_STATE_CANCELED");
        assert!(stored.contains_key("cancel-task"));
        assert!(!stored.contains_key("terminal-task-0"));
        assert_eq!(
            stored
                .values()
                .filter(|task| a2a_task_is_terminal(task))
                .count(),
            A2A_TERMINAL_TASK_STORE_LIMIT
        );
    }

    #[test]
    fn detects_migrated_web_api_routes() {
        for target in [
            "/api/model",
            "/api/files",
            "/api/commands",
            "/api/config",
            "/api/usage",
            "/api/approvals",
            "/api/telemetry",
            "/api/training",
            "/api/sessions",
            "/api/sessions/session-1",
            "/api/sessions/session-1/timeline",
            "/api/sessions/session-1/artifacts",
            "/api/sessions/session-1/artifact-access",
            "/api/sessions/session-1/artifacts/report.html",
            "/api/sessions/session-1/attachments/file-1",
            "/api/sessions/shared/session-1",
            "/api/sessions/shared/session-1/attachments/file-1",
        ] {
            let request = format!("GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n");
            let head = parse_request_head(request.as_bytes()).expect("request should parse");
            assert!(is_local_endpoint(&head), "{target} should be local");
        }
    }

    #[test]
    fn detects_session_create_and_pending_resume_routes() {
        for request in [
            "POST /api/sessions HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/sessions/session-1/share HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/sessions/session-1/export HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/sessions/session-1/attachments/att-1/extract HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/attachments/extract HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/approvals HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "PATCH /api/sessions/session-1 HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "DELETE /api/sessions/session-1 HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/pending-requests/request-1/resume HTTP/1.1\r\nHost: localhost\r\n\r\n",
            "POST /api/pending-requests/codex%3Asession-1%3Arun-1%3Aapproval-1/resume HTTP/1.1\r\nHost: localhost\r\n\r\n",
        ] {
            let head = parse_request_head(request.as_bytes()).expect("request should parse");
            assert!(is_local_endpoint(&head), "{request} should be local");
        }
    }

    #[test]
    fn pending_resume_path_decodes_url_encoded_request_ids() {
        assert_eq!(
            pending_request_id_from_resume_path(
                "/api/pending-requests/codex%3Asession-1%3Arun-1%3Aapproval-1/resume"
            )
            .as_deref(),
            Some("codex:session-1:run-1:approval-1")
        );
        assert!(
            pending_request_id_from_resume_path("/api/pending-requests/bad%2Fid/resume").is_none()
        );
    }

    #[test]
    fn detects_api_options_preflight_as_local() {
        let head = parse_request_head(
            b"OPTIONS /api/chat HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:4173\r\nAccess-Control-Request-Method: POST\r\n\r\n",
        )
        .expect("request should parse");
        assert!(is_local_endpoint(&head));

        let response = response(204, "text/plain; charset=utf-8", &[]);
        let text = String::from_utf8(response).expect("response should be utf-8");
        assert!(text.starts_with("HTTP/1.1 204 No Content\r\n"));
        assert!(text.contains("Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS\r\n"));
    }

    #[tokio::test]
    async fn background_update_parses_body_and_returns_update_contract() {
        let body = r#"{"enabled":true}"#;
        let request = format!(
            "POST /api/background?action=notify HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_local_endpoint(&mut server, &mut initial, head, &state).await);
        let settings = state.background_settings.lock().await.clone();
        let status = background_response(
            &RequestHead {
                method: "GET".to_string(),
                path: "/api/background".to_string(),
                query: HashMap::new(),
                headers: HashMap::new(),
            },
            &settings,
        );

        assert_eq!(response.get("success").and_then(Value::as_bool), Some(true));
        assert_eq!(
            response.get("message").and_then(Value::as_str),
            Some("Background task notifications enabled.")
        );
        assert!(response.get("settings").is_none());
        assert_eq!(
            status
                .pointer("/settings/notificationsEnabled")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[tokio::test]
    async fn framework_update_parses_body_and_returns_contract_shape() {
        let body = r#"{"framework":"fastapi","scope":"workspace"}"#;
        let request = format!(
            "POST /api/framework HTTP/1.1\r\nHost: localhost\r\nx-maestro-api-key: api-key\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut initial = request.into_bytes();
        let head = parse_request_head(&initial).expect("request should parse");
        let (_client, mut server) = tcp_stream_pair().await;
        let state = test_app_state_with_sessions(HashMap::new());

        let response =
            response_json(handle_local_endpoint(&mut server, &mut initial, head, &state).await);
        let framework = state.framework_preference.lock().await.clone();
        let status = framework_response(
            &RequestHead {
                method: "GET".to_string(),
                path: "/api/framework".to_string(),
                query: HashMap::new(),
                headers: HashMap::new(),
            },
            framework.as_deref(),
        );

        assert_eq!(response.get("success").and_then(Value::as_bool), Some(true));
        assert_eq!(
            response.get("framework").and_then(Value::as_str),
            Some("fastapi")
        );
        assert_eq!(
            response.get("scope").and_then(Value::as_str),
            Some("workspace")
        );
        assert!(response.get("summary").and_then(Value::as_str).is_some());
        assert_eq!(
            status.get("framework").and_then(Value::as_str),
            Some("fastapi")
        );
    }

    #[test]
    fn artifact_access_actions_decode_and_filter_query_actions() {
        let actions = artifact_access_actions(Some(&"view%2Cfile%2Cbad%2Czip%2Cfile".to_string()))
            .expect("valid actions should be extracted");
        assert_eq!(actions, vec!["view", "file", "zip"]);
    }

    #[test]
    fn parses_session_attachment_extract_path() {
        assert_eq!(
            session_attachment_extract_id("attachments/att%201/extract"),
            Some("att 1".to_string())
        );
        assert!(session_attachment_extract_id("attachments/att-1").is_none());
        assert!(session_attachment_extract_id("artifacts/report.txt").is_none());
    }

    #[test]
    fn extracts_text_attachment_without_node_runtime() {
        let output = extract_attachment_request(ExtractAttachmentRequest {
            file_name: "notes.md".to_string(),
            mime_type: Some("text/markdown".to_string()),
            content_base64: BASE64_STANDARD.encode("hello from rust"),
            max_chars: Some(5),
        })
        .expect("text extraction should succeed");

        assert_eq!(output.format, "text");
        assert_eq!(output.size_bytes, "hello from rust".len());
        assert_eq!(output.extracted_text, "hello");
        assert!(output.truncated);
    }

    #[test]
    fn extracts_text_attachment_from_data_url_content() {
        let output = extract_attachment_request(ExtractAttachmentRequest {
            file_name: "notes.txt".to_string(),
            mime_type: None,
            content_base64: format!("data:text/plain;base64,{}", BASE64_STANDARD.encode("hello")),
            max_chars: None,
        })
        .expect("data url extraction should succeed");

        assert_eq!(output.extracted_text, "hello");
    }

    #[test]
    fn extracts_docx_attachment_without_node_runtime() {
        let docx = build_store_zip([(
            "word/document.xml",
            br#"<w:document><w:body><w:p><w:r><w:t>Hello &amp; Rust</w:t></w:r></w:p></w:body></w:document>"#
                .as_slice(),
        )])
        .expect("docx zip should build");

        let output = extract_document_text(
            docx,
            "notes.docx".to_string(),
            Some(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    .to_string(),
            ),
            None,
        )
        .expect("docx extraction should succeed");

        assert_eq!(output.format, "docx");
        assert!(output.extracted_text.contains("Hello & Rust"));
    }

    #[test]
    fn builds_store_zip_archive_without_node_runtime() {
        let zip = build_store_zip([("artifact.txt", b"hello artifact".as_slice())])
            .expect("zip archive should build");

        assert!(zip.starts_with(&[0x50, 0x4b, 0x03, 0x04]));
        assert!(zip
            .windows("artifact.txt".len())
            .any(|window| window == b"artifact.txt"));
        assert!(zip
            .windows("hello artifact".len())
            .any(|window| window == b"hello artifact"));
        assert!(zip
            .windows(4)
            .any(|window| window == [0x50, 0x4b, 0x05, 0x06]));
    }

    #[test]
    fn artifact_view_wraps_html_in_sandboxed_viewer() {
        let mut session = create_session_record(Some("Artifacts".to_string()), None);
        session.messages.push(composer_assistant_message_with_tools(
            "created",
            "",
            None,
            &[serde_json::json!({
                "id": "tool-1",
                "name": "artifacts",
                "status": "completed",
                "args": {
                    "command": "create",
                    "filename": "report.html",
                    "content": "<script>window.top.location='https://example.com'</script>"
                },
                "result": { "isError": false }
            })],
        ));

        let head = RequestHead {
            method: "GET".to_string(),
            path: "/api/sessions/session-1/artifacts/report.html/view".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };
        let response = serve_session_artifact(&head, &session, "artifacts/report.html/view");
        let text = String::from_utf8(response).expect("response should be utf-8");

        assert!(text.starts_with("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8"));
        assert!(text.contains("Content-Security-Policy: default-src 'none'"));
        assert!(text.contains("sandbox=\"allow-scripts allow-forms allow-popups allow-downloads\""));
        assert!(text.contains("srcdoc=\"&lt;script&gt;window.top.location=&#39;https://example.com&#39;&lt;/script&gt;\""));
        assert!(!text.contains("<script>window.top.location"));
    }

    #[test]
    fn assistant_tool_metadata_reconstructs_artifacts_after_persist() {
        let mut tools = Vec::new();
        record_tool_call_metadata(
            &mut tools,
            "tool-1",
            "artifacts",
            serde_json::json!({
                "command": "create",
                "filename": "report.html",
                "content": "<h1>Hello</h1>"
            }),
        );
        update_tool_metadata_status(&mut tools, "tool-1", "running");
        finish_tool_metadata(&mut tools, "tool-1", true);

        let mut session = create_session_record(Some("Artifacts".to_string()), None);
        session.messages.push(composer_assistant_message_with_tools(
            "done", "", None, &tools,
        ));

        let artifacts = reconstruct_session_artifacts(&session);
        assert_eq!(
            artifacts.get("report.html"),
            Some(&"<h1>Hello</h1>".to_string())
        );
    }

    #[test]
    fn assistant_usage_cost_uses_contract_shape() {
        let message = composer_assistant_message(
            "done",
            "",
            Some(TokenUsage {
                input_tokens: 1,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_write_tokens: 4,
                cost: None,
            }),
        );

        assert_eq!(message["usage"]["cost"]["input"], 0.0);
        assert_eq!(message["usage"]["cost"]["output"], 0.0);
        assert_eq!(message["usage"]["cost"]["cacheRead"], 0.0);
        assert_eq!(message["usage"]["cost"]["cacheWrite"], 0.0);
        assert_eq!(message["usage"]["cost"]["total"], 0.0);
    }

    #[tokio::test]
    async fn usage_buckets_include_contract_breakdown_fields() {
        let path = env::temp_dir().join(format!(
            "maestro-usage-{}-{}.json",
            process::id(),
            ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let usage = serde_json::json!([{
            "provider": "openai",
            "model": "gpt-5.1-codex-max",
            "tokensInput": 10,
            "tokensOutput": 20,
            "tokensCacheRead": 3,
            "tokensCacheWrite": 4,
            "cost": 0.12
        }]);
        tokio::fs::write(&path, usage.to_string())
            .await
            .expect("usage file should be written");

        let snapshot = usage_snapshot(&path).await;
        let provider = snapshot
            .pointer("/summary/byProvider/openai")
            .expect("provider bucket should exist");
        let model = snapshot
            .pointer("/summary/byModel")
            .and_then(|models| models.get("openai/gpt-5.1-codex-max"))
            .expect("model bucket should exist");

        assert_eq!(provider.get("calls").and_then(Value::as_u64), Some(1));
        assert_eq!(
            provider.get("cachedTokens").and_then(Value::as_u64),
            Some(7)
        );
        assert_eq!(model.get("calls").and_then(Value::as_u64), Some(1));
        assert_eq!(model.get("cachedTokens").and_then(Value::as_u64), Some(7));

        let _ = tokio::fs::remove_file(path).await;
    }

    #[test]
    fn onboarding_snapshot_honors_seen_count_limit() {
        let first_seen = compute_onboarding_snapshot(false, false, 1, false);
        assert!(first_seen.should_show);
        assert_eq!(first_seen.seen_count, 1);

        let capped =
            compute_onboarding_snapshot(false, false, MAX_PROJECT_ONBOARDING_IMPRESSIONS, false);
        assert!(!capped.should_show);
        assert_eq!(capped.seen_count, MAX_PROJECT_ONBOARDING_IMPRESSIONS);
    }

    #[test]
    fn share_options_honor_expiry_and_access_limits() {
        let options = share_options_from_value(&serde_json::json!({
            "expiresInHours": 999,
            "maxAccesses": 0
        }));

        assert_eq!(options.expires_in_hours, 168);
        assert_eq!(options.max_accesses, Some(1));
        assert!(!options.allow_sensitive_content);

        let unlimited = share_options_from_value(&serde_json::json!({
            "maxAccesses": Value::Null,
            "allowSensitiveContent": true
        }));
        assert_eq!(unlimited.max_accesses, None);
        assert!(unlimited.allow_sensitive_content);
    }

    #[test]
    fn session_store_preserves_shared_session_grants() {
        let store = SessionStore {
            sessions: HashMap::from([("session-1".to_string(), test_session_record("session-1"))]),
            shared_sessions: HashMap::from([(
                "share-token".to_string(),
                SharedSessionGrant {
                    session_id: "session-1".to_string(),
                    expires_at: 1_900_000_000_000,
                    max_accesses: Some(3),
                    access_count: 1,
                },
            )]),
        };

        let encoded = serde_json::to_vec(&store).expect("store should serialize");
        let decoded = decode_session_store(&encoded).expect("store should decode");
        let grant = decoded
            .shared_sessions
            .get("share-token")
            .expect("share grant should persist");

        assert_eq!(grant.session_id, "session-1");
        assert_eq!(grant.max_accesses, Some(3));
        assert_eq!(grant.access_count, 1);
    }

    #[test]
    fn session_sensitive_content_detection_flags_secrets() {
        let mut session = test_session_record("session-1");
        session.messages.push(serde_json::json!({
            "role": "user",
            "content": "my api_key is secret"
        }));

        assert!(session_contains_sensitive_content(&session));
    }

    #[test]
    fn subject_auth_only_sees_owned_sessions() {
        let mut session = test_session_record("session-1");
        session.owner = Some("user-123".to_string());
        let owner = AuthContext {
            subject: Some("user-123".to_string()),
            unrestricted: false,
        };
        let other_user = AuthContext {
            subject: Some("user-456".to_string()),
            unrestricted: false,
        };
        let admin = AuthContext {
            subject: None,
            unrestricted: true,
        };

        assert!(session_visible_to_auth(&session, &owner));
        assert!(!session_visible_to_auth(&session, &other_user));
        assert!(session_visible_to_auth(&session, &admin));
    }

    #[test]
    fn decodes_legacy_session_store_shapes() {
        let wrapped = decode_session_store(
            br#"{"sessions":{"session-1":{"id":"session-1","title":"One","createdAt":"2026-04-27T00:00:00Z","updatedAt":"2026-04-27T00:00:00Z","messageCount":0,"messages":[]}}}"#,
        )
        .expect("wrapped store should decode");
        assert!(wrapped.sessions.contains_key("session-1"));

        let mapped = decode_session_store(
            br#"{"session-2":{"id":"session-2","title":"Two","createdAt":"2026-04-27T00:00:00Z","updatedAt":"2026-04-27T00:00:00Z","messageCount":0,"messages":[]}}"#,
        )
        .expect("map store should decode");
        assert!(mapped.sessions.contains_key("session-2"));

        let array = decode_session_store(
            br#"[{"id":"session-3","title":"Three","createdAt":"2026-04-27T00:00:00Z","updatedAt":"2026-04-27T00:00:00Z","messageCount":0,"messages":[]}]"#,
        )
        .expect("array store should decode");
        assert!(array.sessions.contains_key("session-3"));
    }

    #[tokio::test]
    async fn shared_attachment_reads_do_not_consume_or_require_page_access() {
        let mut session = test_session_record("session-1");
        session.messages.push(serde_json::json!({
            "role": "user",
            "content": "see attachment",
            "attachments": [{
                "id": "att-1",
                "fileName": "note.txt",
                "mimeType": "text/plain",
                "content": BASE64_STANDARD.encode("hello")
            }]
        }));
        let state =
            test_app_state_with_sessions(HashMap::from([(session.id.clone(), session.clone())]));
        state.shared_sessions.lock().await.insert(
            "share-token".to_string(),
            SharedSessionGrant {
                session_id: session.id.clone(),
                expires_at: now_millis().saturating_add(60_000),
                max_accesses: Some(1),
                access_count: 1,
            },
        );

        let response = handle_shared_session_get(
            &state,
            SharedSessionPath {
                token: "share-token",
                tail: Some("attachments/att-1"),
            },
        )
        .await;
        let text = String::from_utf8(response).expect("response should be utf-8");

        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.ends_with("hello"));
    }

    #[tokio::test]
    async fn shared_session_get_uses_share_token_without_api_auth() {
        let mut session = test_session_record("session-1");
        session.messages.push(serde_json::json!({
            "role": "user",
            "content": "shared hello"
        }));
        let state =
            test_app_state_with_sessions(HashMap::from([(session.id.clone(), session.clone())]));
        state.shared_sessions.lock().await.insert(
            "share-token".to_string(),
            SharedSessionGrant {
                session_id: session.id.clone(),
                expires_at: now_millis().saturating_add(60_000),
                max_accesses: Some(2),
                access_count: 0,
            },
        );
        let mut server = tcp_stream_pair().await.0;
        let head = parse_request_head(
            b"GET /api/sessions/shared/share-token HTTP/1.1\r\nHost: localhost\r\n\r\n",
        )
        .expect("request should parse");

        let response = handle_session_endpoint(&mut server, &mut Vec::new(), &head, &state).await;
        let text = String::from_utf8(response).expect("response should be utf-8");

        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.contains("shared hello"));
    }

    #[tokio::test]
    async fn chat_user_message_rejects_unowned_existing_session() {
        let mut session = test_session_record("session-1");
        session.owner = Some("other-user".to_string());
        let state = test_app_state_with_sessions(HashMap::from([(session.id.clone(), session)]));
        let auth = AuthContext {
            subject: Some("user-123".to_string()),
            unrestricted: false,
        };
        let chat = ChatRequest {
            model: None,
            thinking_level: None,
            session_id: Some("session-1".to_string()),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: Value::String("hello".to_string()),
                attachments: Vec::new(),
                extra: Map::new(),
            }],
        };

        let result = record_chat_user_message(&state, &chat, &auth).await;
        let stored = state.sessions.lock().await;

        assert!(result.is_err());
        assert!(stored.sessions["session-1"].messages.is_empty());
    }

    #[tokio::test]
    async fn chat_user_message_preserves_requested_id_when_creating_session() {
        let state = test_app_state_with_sessions(HashMap::new());
        let auth = AuthContext {
            subject: Some("user-123".to_string()),
            unrestricted: false,
        };
        let chat = ChatRequest {
            model: None,
            thinking_level: None,
            session_id: Some("requested-session".to_string()),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: Value::String("hello".to_string()),
                attachments: Vec::new(),
                extra: Map::new(),
            }],
        };

        record_chat_user_message(&state, &chat, &auth)
            .await
            .expect("message should be recorded");
        let stored = state.sessions.lock().await;
        let session = stored
            .sessions
            .get("requested-session")
            .expect("session should use requested key");

        assert_eq!(session.id, "requested-session");
        assert_eq!(session.message_count, 1);
    }

    #[test]
    fn session_read_payloads_omit_inline_attachment_content() {
        let mut session = test_session_record("session-1");
        session.messages.push(serde_json::json!({
            "role": "user",
            "content": "see attachment",
            "attachments": [{
                "id": "att-1",
                "fileName": "note.txt",
                "mimeType": "text/plain",
                "content": BASE64_STANDARD.encode("hello")
            }]
        }));

        let full = session_full_value(&session);
        let attachment = &full["messages"][0]["attachments"][0];
        assert!(attachment.get("content").is_none());
        assert_eq!(
            attachment.get("contentOmitted").and_then(Value::as_bool),
            Some(true)
        );

        let list = session_attachments_value(&session);
        assert!(list["attachments"][0].get("content").is_none());

        let response = serve_session_attachment(&session, "attachments/att-1");
        let text = String::from_utf8(response).expect("response should be utf-8");
        assert!(text.ends_with("hello"));
    }

    #[test]
    fn export_options_require_explicit_sensitive_confirmation() {
        let default_options = export_options_from_body(&[]).expect("empty body should parse");
        assert_eq!(default_options.format, "json");
        assert!(!default_options.allow_sensitive_content);

        let confirmed = export_options_from_value(&serde_json::json!({
            "format": "markdown",
            "allowSensitiveContent": true
        }));
        assert_eq!(confirmed.format, "markdown");
        assert!(confirmed.allow_sensitive_content);
    }

    #[test]
    fn timeline_items_use_run_timeline_schema() {
        let mut session = test_session_record("session-1");
        session.messages.push(serde_json::json!({
            "role": "user",
            "timestamp": "2026-04-27T00:00:00Z",
            "content": "hello"
        }));

        let timeline = session_timeline_value(&session);
        assert_eq!(timeline["sessionId"], "session-1");
        assert_eq!(timeline["items"][0]["sessionId"], "session-1");
        assert_eq!(timeline["items"][0]["type"], "message.user");
        assert_eq!(timeline["items"][0]["visibility"], "user");
    }

    #[test]
    fn generated_share_tokens_are_opaque() {
        let session_id = "session-123";
        let token = generate_share_token().expect("share token should be generated");

        assert_ne!(token, session_id);
        assert!(!token.contains(session_id));
        assert!(token.len() >= 32);
    }

    #[test]
    fn shared_session_paths_do_not_parse_as_regular_sessions() {
        assert!(session_path_from_path("/api/sessions/shared/token-1").is_none());
        let shared = shared_session_path_from_path("/api/sessions/shared/token-1/attachments/a1")
            .expect("shared path should parse");
        assert_eq!(shared.token, "token-1");
        assert_eq!(shared.tail, Some("attachments/a1"));
    }

    #[test]
    fn websocket_origin_check_allows_local_and_rejects_cross_site() {
        let allowed = parse_request_head(
            b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:4173\r\n\r\n",
        )
        .expect("request should parse");
        assert!(origin_allowed(&allowed));

        let packaged_origin = parse_request_head(
            b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost:8080\r\nOrigin: http://localhost:8080\r\n\r\n",
        )
        .expect("request should parse");
        assert!(origin_allowed(&packaged_origin));

        let rejected = parse_request_head(
            b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\nOrigin: https://evil.example\r\n\r\n",
        )
        .expect("request should parse");
        assert!(!origin_allowed(&rejected));
    }

    #[tokio::test]
    async fn allowed_request_origin_is_echoed_in_cors_response_headers() {
        let head = parse_request_head(
            b"GET /api/status HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:3000\r\n\r\n",
        )
        .expect("request should parse");

        let response = with_response_cors_origin(requested_cors_origin(&head), async {
            response(200, "application/json", b"{}")
        })
        .await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.contains("Access-Control-Allow-Origin: http://localhost:3000\r\n"));
        assert!(!response.contains("Access-Control-Allow-Origin: http://localhost:4173\r\n"));
    }

    #[tokio::test]
    async fn cors_response_allows_platform_organization_header() {
        let response = with_response_cors_origin("http://localhost:3000".to_string(), async {
            response(204, "text/plain; charset=utf-8", &[])
        })
        .await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.contains("x-organization-id"));
        assert!(response.contains("x-a2a-notification-token"));
    }

    #[test]
    fn chat_body_limit_allows_base64_attachments() {
        const {
            assert!(MAX_JSON_BODY_BYTES >= 32 * 1024 * 1024);
            assert!(MAX_EXTRACT_JSON_BODY_BYTES > (MAX_EXTRACT_INPUT_BYTES * 4 / 3));
        }
    }

    #[test]
    fn detects_chat_websocket_route_separately_from_sse() {
        let head = parse_request_head(b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .expect("request should parse");

        assert!(is_chat_websocket_endpoint(&head));
        assert!(!is_chat_endpoint(&head));
    }

    #[test]
    fn computes_websocket_accept_key() {
        assert_eq!(
            websocket_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn parses_masked_websocket_text_frame() {
        let payload = br#"{"messages":[]}"#;
        let mask = [0x37, 0xfa, 0x21, 0x3d];
        let mut frame = vec![0x81, 0x80 | payload.len() as u8];
        frame.extend_from_slice(&mask);
        for (index, byte) in payload.iter().enumerate() {
            frame.push(byte ^ mask[index % mask.len()]);
        }

        let parsed = try_parse_websocket_text_message(&mut frame)
            .expect("frame should parse")
            .expect("frame should be complete");

        assert_eq!(parsed, payload);
        assert!(frame.is_empty());
    }

    #[test]
    fn parses_fragmented_masked_websocket_text_frame() {
        let first = br#"{"messages":"#;
        let second = br#"[]}"#;
        let mask = [0x37, 0xfa, 0x21, 0x3d];
        let mut frame = vec![0x01, 0x80 | first.len() as u8];
        frame.extend_from_slice(&mask);
        for (index, byte) in first.iter().enumerate() {
            frame.push(byte ^ mask[index % mask.len()]);
        }
        frame.extend_from_slice(&[0x80, 0x80 | second.len() as u8]);
        frame.extend_from_slice(&mask);
        for (index, byte) in second.iter().enumerate() {
            frame.push(byte ^ mask[index % mask.len()]);
        }

        let parsed = try_parse_websocket_text_message(&mut frame)
            .expect("fragmented frame should parse")
            .expect("fragmented frame should be complete");

        assert_eq!(parsed, br#"{"messages":[]}"#);
        assert!(frame.is_empty());
    }

    #[test]
    fn pending_request_resume_maps_approval_and_tool_results() {
        let approval = pending_request_resume_value(
            "approval-1",
            &serde_json::json!({ "kind": "approval", "decision": "denied" }),
        );
        assert_eq!(
            approval
                .pointer("/request/resolution")
                .and_then(Value::as_str),
            Some("denied")
        );

        let tool = pending_request_resume_value(
            "tool-1",
            &serde_json::json!({ "content": [], "isError": true }),
        );
        assert_eq!(
            tool.pointer("/request/kind").and_then(Value::as_str),
            Some("client_tool")
        );
        assert_eq!(
            tool.pointer("/request/resolution").and_then(Value::as_str),
            Some("failed")
        );

        let (approved, result) = pending_tool_response_from_payload(
            &serde_json::json!({ "kind": "approval", "decision": "denied" }),
        );
        assert!(!approved);
        assert!(result.is_none());

        let (approved, result) =
            pending_tool_response_from_payload(&serde_json::json!({ "content": "ok" }));
        assert!(approved);
        assert_eq!(result.expect("tool result").output, "ok");
    }

    #[test]
    fn composer_content_preserves_non_text_blocks() {
        let content = serde_json::json!([
            { "type": "text", "text": "hello" },
            { "type": "tool_result", "toolUseId": "tool-1", "content": "world" }
        ]);
        let rendered = composer_text_content(&content);

        assert!(rendered.contains("hello"));
        assert!(rendered.contains("tool_result"));
        assert!(rendered.contains("tool-1"));
    }

    #[test]
    fn resolves_provider_model_ids() {
        let registry = ModelRegistry {
            models: builtin_models(),
            aliases: HashMap::new(),
        };
        let model =
            resolve_model("openai/gpt-5.1-codex-max", &registry).expect("model should resolve");

        assert_eq!(model.provider, "openai");
        assert_eq!(model.id, "gpt-5.1-codex-max");
        assert_eq!(model.api, "openai-responses");

        let codex_app_server = resolve_model("openai-codex/gpt-5.1-codex-max", &registry)
            .expect("codex app-server model should resolve");
        assert_eq!(codex_app_server.provider, "openai-codex");
        assert_eq!(codex_app_server.id, "gpt-5.1-codex-max");
        assert_eq!(codex_app_server.api, "openai-codex-app-server");
    }

    #[test]
    fn resolves_configured_models_and_aliases() {
        let config = serde_json::json!({
            "aliases": { "fast": "local/llama-fast" },
            "providers": [{
                "id": "local",
                "name": "Local",
                "api": "openai-responses",
                "models": [{
                    "id": "llama-fast",
                    "name": "Llama Fast",
                    "reasoning": false,
                    "input": ["text", "image"],
                    "contextWindow": 8192,
                    "maxTokens": 2048,
                    "cost": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0
                    }
                }]
            }]
        });
        let mut registry = ModelRegistry {
            models: builtin_models(),
            aliases: HashMap::new(),
        };
        merge_configured_models(&mut registry, &config);

        let model = resolve_model("fast", &registry).expect("alias should resolve");

        assert_eq!(model.provider, "local");
        assert_eq!(model.id, "llama-fast");
        assert!(model.capabilities.vision);
    }

    #[test]
    fn merges_platform_model_catalog_from_llm_gateway_payload() {
        let catalog = serde_json::json!({
            "data": [{
                "id": "openai",
                "models": [{
                    "id": "gpt-5.1-codex-max",
                    "name": "GPT-5.1 Codex Max",
                    "provider": "openai",
                    "pricing": {
                        "input": 1.25,
                        "output": 10.0
                    },
                    "capabilities": {
                        "context_length": 400000,
                        "max_tokens": 128000,
                        "supports_streaming": true,
                        "supports_functions": true,
                        "supports_vision": true
                    },
                    "supports_reasoning": true
                }]
            }],
            "external_providers": [{
                "id": "together-ai",
                "models": [{
                    "id": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                    "name": "Llama 3.3 70B Instruct Turbo",
                    "reasoning": false,
                    "tool_call": true,
                    "cost": {
                        "input": 0.88,
                        "output": 0.88,
                        "cache_read": 0.0,
                        "cache_write": 0.0
                    },
                    "limit": {
                        "context": 131072,
                        "output": 4096
                    },
                    "modalities": {
                        "input": ["text", "image"],
                        "output": ["text"]
                    }
                }]
            }]
        });
        let mut registry = ModelRegistry {
            models: builtin_models(),
            aliases: HashMap::new(),
        };

        merge_llm_gateway_model_catalog(&mut registry, &catalog);

        let codex = resolve_model("openai/gpt-5.1-codex-max", &registry).expect("codex model");
        assert_eq!(codex.max_tokens, 128_000);
        assert_eq!(codex.api, "openai-responses");
        assert!(codex.capabilities.reasoning);

        let codex_app_server =
            resolve_model("openai-codex/gpt-5.5", &registry).expect("codex app-server model");
        assert_eq!(codex_app_server.api, "openai-codex-app-server");
        assert_eq!(codex_app_server.max_tokens, 128_000);

        let llama = resolve_model(
            "together-ai/meta-llama/Llama-3.3-70B-Instruct-Turbo",
            &registry,
        )
        .expect("external model");
        assert_eq!(llama.context_window, 131_072);
        assert!(llama.capabilities.vision);
        assert_eq!(llama.cost.input, 0.88);
    }

    #[test]
    fn merges_openrouter_model_catalog_payload() {
        let catalog = serde_json::json!({
            "data": [{
                "id": "anthropic/claude-sonnet-4.5",
                "name": "Anthropic: Claude Sonnet 4.5",
                "context_length": 200000,
                "architecture": {
                    "input_modalities": ["text", "image"],
                    "output_modalities": ["text"]
                },
                "pricing": {
                    "prompt": "0.000003",
                    "completion": "0.000015",
                    "input_cache_read": "0.0000003",
                    "input_cache_write": "0.00000375"
                },
                "top_provider": {
                    "context_length": 200000,
                    "max_completion_tokens": 64000,
                    "is_moderated": true
                },
                "supported_parameters": [
                    "include_reasoning",
                    "max_tokens",
                    "reasoning",
                    "tool_choice",
                    "tools"
                ]
            }]
        });
        let mut registry = ModelRegistry {
            models: builtin_models(),
            aliases: HashMap::new(),
        };

        merge_llm_gateway_model_catalog(&mut registry, &catalog);
        let model = resolve_model("openrouter/anthropic/claude-sonnet-4.5", &registry)
            .expect("openrouter model should resolve");

        assert_eq!(model.provider, "openrouter");
        assert_eq!(model.id, "anthropic/claude-sonnet-4.5");
        assert_eq!(model.api, "openai-completions");
        assert_eq!(model.context_window, 200_000);
        assert_eq!(model.max_tokens, 64_000);
        assert!(model.capabilities.vision);
        assert!(model.capabilities.tools);
        assert!(model.capabilities.reasoning);
        assert_eq!(model.cost.input, 0.000003);
        assert_eq!(model.cost.cache_write, 0.00000375);
    }

    #[test]
    fn default_model_handles_empty_registry() {
        let registry = ModelRegistry {
            models: Vec::new(),
            aliases: HashMap::new(),
        };

        let model = default_model_from_registry(&registry);

        assert_eq!(model.id, "claude-sonnet-4-5-20250514");
    }

    #[test]
    fn head_response_keeps_get_content_length_without_body() {
        let response = response_with_cache_and_length(
            200,
            "text/plain; charset=utf-8",
            &[],
            60,
            "hello".len(),
        );
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.contains("Content-Length: 5\r\n"));
        assert!(response.ends_with("\r\n\r\n"));
    }

    #[test]
    #[should_panic(expected = "response Content-Length 10 does not match body length 5")]
    fn response_with_length_rejects_nonempty_body_length_mismatch() {
        let _response = response_with_extra_headers_and_length(200, "text/plain", b"hello", "", 10);
    }

    #[test]
    fn parse_git_status_counts_both_porcelain_columns() {
        let status = parse_git_status(
            " M unstaged.txt\nM  staged.txt\nMM both.txt\nAM added_modified.txt\nD  staged_delete.txt\n D worktree_delete.txt\n R renamed.txt\n C copied.txt\nUU conflicted.txt\n?? new.txt\n",
        );

        assert_eq!(status.modified, 5);
        assert_eq!(status.added, 3);
        assert_eq!(status.deleted, 2);
        assert_eq!(status.untracked, 1);
        assert_eq!(status.total, 10);
    }

    #[test]
    fn json_response_has_header_body_separator() {
        let response = json_response(200, &serde_json::json!({ "ok": true }));

        assert!(response.windows(4).any(|window| window == b"\r\n\r\n"));
        let response = String::from_utf8(response).expect("response should be utf-8");
        assert!(response.contains("x-composer-csrf"));
        assert!(response.contains("x-maestro-artifact-access"));
    }

    #[test]
    fn json_response_uses_conflict_reason_phrase() {
        let response = json_response(409, &serde_json::json!({ "error": "Conflict" }));
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.starts_with("HTTP/1.1 409 Conflict\r\n"));
    }

    #[tokio::test]
    async fn response_cors_origin_matches_allowed_request_origin() {
        let head = parse_request_head(
            b"GET /api/status HTTP/1.1\r\nHost: localhost\r\nOrigin: http://127.0.0.1:5173\r\n\r\n",
        )
        .expect("request should parse");
        let response = with_response_cors_origin(requested_cors_origin(&head), async {
            json_response(200, &serde_json::json!({ "ok": true }))
        })
        .await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.contains("Access-Control-Allow-Origin: http://127.0.0.1:5173\r\n"));
        assert!(response.contains("Access-Control-Allow-Credentials: true\r\n"));
        assert!(response.contains("Vary: Origin\r\n"));
    }

    #[tokio::test]
    async fn sse_headers_vary_by_request_origin() {
        let head = parse_request_head(
            b"GET /api/chat HTTP/1.1\r\nHost: localhost\r\nOrigin: http://127.0.0.1:5173\r\n\r\n",
        )
        .expect("request should parse");
        let response =
            with_response_cors_origin(requested_cors_origin(&head), async { sse_headers() }).await;

        assert!(response.contains("Access-Control-Allow-Origin: http://127.0.0.1:5173\r\n"));
        assert!(response.contains("Vary: Origin\r\n"));
    }

    #[tokio::test]
    async fn wildcard_cors_origin_omits_credentials_header() {
        let response = with_response_cors_origin("*".to_string(), async {
            json_response(200, &serde_json::json!({ "ok": true }))
        })
        .await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.contains("Access-Control-Allow-Origin: *\r\n"));
        assert!(!response.contains("Access-Control-Allow-Credentials: true\r\n"));
    }

    #[test]
    fn wildcard_web_origin_allows_websocket_origins() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous = env::var_os("MAESTRO_WEB_ORIGIN");
        env::set_var("MAESTRO_WEB_ORIGIN", "*");
        let head = parse_request_head(
            b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\nOrigin: https://app.example.com\r\n\r\n",
        )
        .expect("request should parse");

        assert!(origin_allowed(&head));

        if let Some(previous) = previous {
            env::set_var("MAESTRO_WEB_ORIGIN", previous);
        } else {
            env::remove_var("MAESTRO_WEB_ORIGIN");
        }
    }

    #[test]
    fn openrouter_catalog_requires_explicit_configuration() {
        let _guard = ENV_LOCK.blocking_lock();
        let vars = [
            "MAESTRO_LLM_GATEWAY_MODELS_URL",
            "MAESTRO_LLM_GATEWAY_URL",
            "MAESTRO_OPENROUTER_MODELS_URL",
            "MAESTRO_ENABLE_OPENROUTER_MODELS",
            "MAESTRO_OPENROUTER_API_KEY",
            "OPENROUTER_API_KEY",
        ];
        let previous = vars.map(|name| (name, env::var_os(name)));
        for name in vars {
            env::remove_var(name);
        }

        assert!(llm_gateway_models_url().is_none());

        env::set_var("MAESTRO_ENABLE_OPENROUTER_MODELS", "1");
        assert_eq!(
            llm_gateway_models_url().as_deref(),
            Some("https://openrouter.ai/api/v1/models")
        );

        env::set_var("MAESTRO_ENABLE_OPENROUTER_MODELS", "0");
        assert!(llm_gateway_models_url().is_none());

        env::set_var("MAESTRO_OPENROUTER_API_KEY", "key");
        assert_eq!(
            llm_gateway_models_url().as_deref(),
            Some("https://openrouter.ai/api/v1/models")
        );

        for (name, value) in previous {
            if let Some(value) = value {
                env::set_var(name, value);
            } else {
                env::remove_var(name);
            }
        }
    }

    #[test]
    fn chat_prompt_preserves_structured_history() {
        let chat = ChatRequest {
            model: None,
            thinking_level: None,
            session_id: None,
            messages: vec![
                ChatMessage {
                    role: "assistant".to_string(),
                    content: Value::String("I can inspect that.".to_string()),
                    attachments: Vec::new(),
                    extra: {
                        let mut extra = Map::new();
                        extra.insert(
                            "tools".to_string(),
                            serde_json::json!([{ "id": "call-1", "name": "read_file" }]),
                        );
                        extra
                    },
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: serde_json::json!([
                        { "type": "text", "text": "What about this image?" },
                        { "type": "image", "url": "attachment://att-1" }
                    ]),
                    attachments: vec![ChatAttachment {
                        id: Some("att-1".to_string()),
                        attachment_type: Some("image".to_string()),
                        file_name: Some("screen.png".to_string()),
                        mime_type: Some("image/png".to_string()),
                        content: None,
                        content_omitted: Some(true),
                        extracted_text: None,
                    }],
                    extra: Map::new(),
                },
            ],
        };

        let prompt = build_prompt_from_chat(&chat);

        assert!(prompt.contains("\"tools\""));
        assert!(prompt.contains("\"type\": \"image\""));
        assert!(prompt.contains("\"attachments\""));
    }

    #[test]
    fn spa_entry_response_uses_no_store() {
        let response =
            response_with_no_store_and_length(200, "text/html; charset=utf-8", &[], "index".len());
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.contains("Content-Length: 5\r\n"));
        assert!(response.contains("Cache-Control: no-store, no-cache, must-revalidate\r\n"));
    }

    #[test]
    fn runtime_config_script_serializes_csrf_without_api_key() {
        let mut config = auth_test_config();
        config.csrf_token = Some("csrf\"token".to_string());

        let script =
            String::from_utf8(runtime_config_script(&config)).expect("script should be utf-8");

        assert!(!script.contains("api-key"));
        assert!(script.contains("delete window.__MAESTRO_API_KEY__;"));
        assert!(script.contains("window.__MAESTRO_CSRF_TOKEN__ = \"csrf\\\"token\";"));
    }

    #[test]
    fn runtime_config_head_reports_script_length_without_body() {
        let mut config = auth_test_config();
        config.csrf_token = Some("csrf-token".to_string());
        let head = RequestHead {
            method: "HEAD".to_string(),
            path: RUNTIME_CONFIG_SCRIPT_PATH.to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };
        let expected_length = runtime_config_script(&config).len();

        let response = runtime_config_response(&head, &config);
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.contains("Content-Type: application/javascript; charset=utf-8\r\n"));
        assert!(response.contains(&format!("Content-Length: {expected_length}\r\n")));
        assert!(response.ends_with("\r\n\r\n"));
    }

    #[tokio::test]
    async fn spa_entry_injects_runtime_config_script_when_browser_auth_configured() {
        let root = TestDir::new("runtime-config-spa");
        let index = "<html><head><title>Maestro</title></head><body>ok</body></html>";
        fs::write(root.path().join("index.html"), index).expect("index should be written");
        let mut config = auth_test_config();
        config.static_root = root.path().to_path_buf();
        config.csrf_token = Some("csrf-token".to_string());
        let head = RequestHead {
            method: "GET".to_string(),
            path: "/".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([("x-maestro-api-key".to_string(), "api-key".to_string())]),
        };

        let response = static_response(&head, &config).await;
        let response = String::from_utf8(response).expect("response should be utf-8");
        let body = response_body_text(&response);

        assert!(body.contains(RUNTIME_CONFIG_SCRIPT_TAG));
        assert!(body.contains("</head><body>ok</body>"));
        assert!(!body.contains("window.__MAESTRO_API_KEY__ ="));
        assert!(response.contains(&format!(
            "Set-Cookie: {RUNTIME_SESSION_COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Lax\r\n",
            runtime_session_api_key_cookie_value(&config).expect("cookie should be available")
        )));
        assert!(response.contains(&format!("Content-Length: {}\r\n", body.len())));
    }

    #[test]
    fn runtime_session_cookie_authorizes_same_origin_browser_requests() {
        let config = auth_test_config();
        let cookie = runtime_session_cookie_value(&config, "jonathan@evalops.dev")
            .expect("cookie should be available");
        let head = RequestHead {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([(
                "cookie".to_string(),
                format!("theme=dark; {RUNTIME_SESSION_COOKIE_NAME}={cookie}; other=value"),
            )]),
        };

        let context = auth_context(&head, &config).expect("cookie should authorize request");

        assert!(!context.unrestricted);
        assert_eq!(context.subject.as_deref(), Some("jonathan@evalops.dev"));
    }

    #[test]
    fn bearer_token_identity_wins_over_runtime_session_cookie() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous = env::var_os("MAESTRO_AUTH_SHARED_SECRET");
        env::set_var("MAESTRO_AUTH_SHARED_SECRET", "shared-secret");
        let config = auth_test_config();
        let cookie = runtime_session_cookie_value(&config, "cookie-user")
            .expect("cookie should be available");
        let bearer_user = "bearer-user";
        let signature = hmac_sha256_hex(b"shared-secret", bearer_user.as_bytes());
        let token = format!("{}.{}", URL_SAFE_NO_PAD.encode(bearer_user), signature);
        let head = RequestHead {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([
                ("authorization".to_string(), format!("Bearer {token}")),
                (
                    "cookie".to_string(),
                    format!("{RUNTIME_SESSION_COOKIE_NAME}={cookie}"),
                ),
            ]),
        };

        let context = auth_context(&head, &config).expect("bearer token should authorize");

        assert_eq!(context.subject.as_deref(), Some(bearer_user));
        assert!(!context.unrestricted);

        if let Some(previous) = previous {
            env::set_var("MAESTRO_AUTH_SHARED_SECRET", previous);
        } else {
            env::remove_var("MAESTRO_AUTH_SHARED_SECRET");
        }
    }

    #[test]
    fn loopback_api_key_runtime_session_cookie_keeps_legacy_unrestricted_access() {
        let config = auth_test_config();
        let cookie =
            runtime_session_api_key_cookie_value(&config).expect("cookie should be available");
        let head = RequestHead {
            method: "GET".to_string(),
            path: "/api/sessions".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([(
                "cookie".to_string(),
                format!("{RUNTIME_SESSION_COOKIE_NAME}={cookie}"),
            )]),
        };

        let context = auth_context(&head, &config).expect("api-key cookie should authorize");

        assert!(context.subject.is_none());
        assert!(context.unrestricted);
    }

    #[test]
    fn scoped_runtime_session_cookie_for_api_key_sentinel_subject_stays_scoped() {
        let config = auth_test_config();
        let subject = "api-key:unrestricted";
        let cookie =
            runtime_session_cookie_value(&config, subject).expect("cookie should be available");
        let head = RequestHead {
            method: "GET".to_string(),
            path: "/api/sessions".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([(
                "cookie".to_string(),
                format!("{RUNTIME_SESSION_COOKIE_NAME}={cookie}"),
            )]),
        };

        let context = auth_context(&head, &config).expect("scoped cookie should authorize");

        assert_eq!(context.subject.as_deref(), Some(subject));
        assert!(!context.unrestricted);
    }

    #[test]
    fn trusted_proxy_auth_requires_shared_proxy_token() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous = env::var_os("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN");
        env::set_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN", "proxy-secret");
        let config = auth_test_config();
        let spoofed = RequestHead {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([(
                "x-auth-request-email".to_string(),
                "jonathan@evalops.dev".to_string(),
            )]),
        };
        let trusted = RequestHead {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([
                (
                    "x-auth-request-email".to_string(),
                    "jonathan@evalops.dev".to_string(),
                ),
                (
                    "x-maestro-proxy-auth".to_string(),
                    "proxy-secret".to_string(),
                ),
            ]),
        };

        assert!(auth_context(&spoofed, &config).is_none());
        let context = auth_context(&trusted, &config).expect("proxy token should authorize");
        assert_eq!(context.subject.as_deref(), Some("jonathan@evalops.dev"));
        assert!(!context.unrestricted);

        if let Some(previous) = previous {
            env::set_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN", previous);
        } else {
            env::remove_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN");
        }
    }

    #[test]
    fn trusted_proxy_token_counts_as_configured_auth() {
        let _guard = ENV_LOCK.blocking_lock();
        let previous = env::var_os("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN");
        env::set_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN", "proxy-secret");
        let mut config = auth_test_config();
        config.api_key = None;
        config.require_key = false;
        let head = RequestHead {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };

        assert!(auth_context(&head, &config).is_none());

        if let Some(previous) = previous {
            env::set_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN", previous);
        } else {
            env::remove_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN");
        }
    }

    #[test]
    fn web_auth_mode_matrix_pins_control_plane_access() {
        let _guard = ENV_LOCK.blocking_lock();
        let preserved_env: Vec<_> = [
            "MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN",
            "MAESTRO_AUTH_SHARED_SECRET",
            "MAESTRO_JWT_SECRET",
            "MAESTRO_JWT_JWKS_URL",
        ]
        .iter()
        .map(|name| (*name, env::var_os(name)))
        .collect();
        for (name, _) in &preserved_env {
            env::remove_var(name);
        }

        let api_key_config = auth_test_config();
        let mut open_dev_config = auth_test_config();
        open_dev_config.api_key = None;
        open_dev_config.require_key = false;
        let scoped_cookie = runtime_session_cookie_value(&api_key_config, "web-user")
            .expect("scoped cookie should be available");
        let api_key_cookie = runtime_session_api_key_cookie_value(&api_key_config)
            .expect("api-key cookie should be available");

        struct AuthMatrixCase {
            name: &'static str,
            config: Config,
            headers: HashMap<String, String>,
            expected_subject: Option<&'static str>,
            expected_unrestricted: Option<bool>,
        }

        let cases = vec![
            AuthMatrixCase {
                name: "open local dev when no auth is configured",
                config: open_dev_config.clone(),
                headers: HashMap::new(),
                expected_subject: None,
                expected_unrestricted: Some(true),
            },
            AuthMatrixCase {
                name: "api key configured rejects anonymous requests",
                config: api_key_config.clone(),
                headers: HashMap::new(),
                expected_subject: None,
                expected_unrestricted: None,
            },
            AuthMatrixCase {
                name: "api key header grants unrestricted loopback access",
                config: api_key_config.clone(),
                headers: HashMap::from([("x-maestro-api-key".to_string(), "api-key".to_string())]),
                expected_subject: None,
                expected_unrestricted: Some(true),
            },
            AuthMatrixCase {
                name: "bearer api key grants unrestricted loopback access",
                config: api_key_config.clone(),
                headers: HashMap::from([(
                    "authorization".to_string(),
                    "Bearer api-key".to_string(),
                )]),
                expected_subject: None,
                expected_unrestricted: Some(true),
            },
            AuthMatrixCase {
                name: "scoped runtime session cookie stays subject-scoped",
                config: api_key_config.clone(),
                headers: HashMap::from([(
                    "cookie".to_string(),
                    format!("{RUNTIME_SESSION_COOKIE_NAME}={scoped_cookie}"),
                )]),
                expected_subject: Some("web-user"),
                expected_unrestricted: Some(false),
            },
            AuthMatrixCase {
                name: "legacy api-key runtime session cookie stays unrestricted",
                config: api_key_config.clone(),
                headers: HashMap::from([(
                    "cookie".to_string(),
                    format!("{RUNTIME_SESSION_COOKIE_NAME}={api_key_cookie}"),
                )]),
                expected_subject: None,
                expected_unrestricted: Some(true),
            },
        ];

        for case in cases {
            let head = RequestHead {
                method: "GET".to_string(),
                path: "/api/status".to_string(),
                query: HashMap::new(),
                headers: case.headers,
            };
            let context = auth_context(&head, &case.config);
            match case.expected_unrestricted {
                Some(unrestricted) => {
                    let context = context.unwrap_or_else(|| {
                        panic!("{} should authorize", case.name);
                    });
                    assert_eq!(
                        context.subject.as_deref(),
                        case.expected_subject,
                        "{} subject",
                        case.name
                    );
                    assert_eq!(
                        context.unrestricted, unrestricted,
                        "{} unrestricted",
                        case.name
                    );
                }
                None => assert!(context.is_none(), "{} should reject", case.name),
            }
        }

        env::set_var("MAESTRO_AUTH_SHARED_SECRET", "shared-secret");
        let bearer_user = "bearer-user";
        let signature = hmac_sha256_hex(b"shared-secret", bearer_user.as_bytes());
        let bearer = format!("{}.{}", URL_SAFE_NO_PAD.encode(bearer_user), signature);
        let bearer_head = RequestHead {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([("authorization".to_string(), format!("Bearer {bearer}"))]),
        };
        let bearer_context =
            auth_context(&bearer_head, &open_dev_config).expect("bearer should authorize");
        assert_eq!(bearer_context.subject.as_deref(), Some(bearer_user));
        assert!(!bearer_context.unrestricted);

        env::remove_var("MAESTRO_AUTH_SHARED_SECRET");
        env::set_var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN", "proxy-secret");
        let proxy_head = RequestHead {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            query: HashMap::new(),
            headers: HashMap::from([
                (
                    "x-auth-request-email".to_string(),
                    "proxy-user@evalops.dev".to_string(),
                ),
                (
                    "x-maestro-proxy-auth".to_string(),
                    "proxy-secret".to_string(),
                ),
            ]),
        };
        let proxy_context =
            auth_context(&proxy_head, &open_dev_config).expect("proxy should authorize");
        assert_eq!(
            proxy_context.subject.as_deref(),
            Some("proxy-user@evalops.dev")
        );
        assert!(!proxy_context.unrestricted);

        for (name, value) in preserved_env {
            if let Some(value) = value {
                env::set_var(name, value);
            } else {
                env::remove_var(name);
            }
        }
    }

    #[tokio::test]
    async fn loopback_api_key_web_first_load_requires_authenticated_cookie_issuer() {
        let root = TestDir::new("runtime-config-spa-loopback-api-key");
        fs::write(root.path().join("index.html"), "<html><head></head></html>")
            .expect("index should be written");
        let mut config = auth_test_config();
        config.static_root = root.path().to_path_buf();
        config.listen_host = "127.0.0.1".to_string();
        let head = RequestHead {
            method: "GET".to_string(),
            path: "/".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };

        let response = static_response(&head, &config).await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(!response.contains("Set-Cookie: maestro_web_session="));
    }

    #[tokio::test]
    async fn spa_entry_does_not_mint_session_cookie_without_authenticated_issuer() {
        let root = TestDir::new("runtime-config-spa-unauth");
        fs::write(root.path().join("index.html"), "<html><head></head></html>")
            .expect("index should be written");
        let mut config = auth_test_config();
        config.static_root = root.path().to_path_buf();
        config.listen_host = "0.0.0.0".to_string();
        let head = RequestHead {
            method: "GET".to_string(),
            path: "/".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };

        let response = static_response(&head, &config).await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(!response.contains("Set-Cookie: maestro_web_session="));
    }

    #[tokio::test]
    async fn spa_entry_head_uses_injected_body_length() {
        let root = TestDir::new("runtime-config-spa-head");
        let index = "<html><head></head><body>ok</body></html>";
        fs::write(root.path().join("index.html"), index).expect("index should be written");
        let mut config = auth_test_config();
        config.static_root = root.path().to_path_buf();
        let expected_length = spa_entry_body(index.as_bytes(), &config).len();
        let head = RequestHead {
            method: "HEAD".to_string(),
            path: "/".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };

        let response = static_response(&head, &config).await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.contains(&format!("Content-Length: {expected_length}\r\n")));
        assert!(response.ends_with("\r\n\r\n"));
    }

    #[tokio::test]
    async fn spa_entry_without_browser_auth_does_not_inject_runtime_config() {
        let root = TestDir::new("runtime-config-spa-disabled");
        let index = "<html><head></head><body>ok</body></html>";
        fs::write(root.path().join("index.html"), index).expect("index should be written");
        let mut config = auth_test_config();
        config.static_root = root.path().to_path_buf();
        config.api_key = None;
        config.csrf_token = None;
        let head = RequestHead {
            method: "GET".to_string(),
            path: "/".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };

        let response = static_response(&head, &config).await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(!response.contains(RUNTIME_CONFIG_SCRIPT_PATH));
        assert!(response.contains(index));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn canonical_static_path_rejects_symlink_escape() {
        let base = env::temp_dir().join(format!(
            "maestro-static-test-{}-{}",
            process::id(),
            ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let root = base.join("static");
        let outside = base.join("outside");
        tokio::fs::create_dir_all(&root).await.expect("create root");
        tokio::fs::create_dir_all(&outside)
            .await
            .expect("create outside");
        tokio::fs::write(outside.join("secret.txt"), "secret")
            .await
            .expect("write secret");
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("secret.txt"))
            .expect("create symlink");

        assert!(matches!(
            canonical_static_path(&root, &root.join("secret.txt")).await,
            StaticPathResolution::Forbidden
        ));

        let _ = tokio::fs::remove_dir_all(base).await;
    }

    #[test]
    fn missing_asset_paths_do_not_spa_fallback() {
        let asset = RequestHead {
            method: "GET".to_string(),
            path: "/assets/app.js".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };
        let route = RequestHead {
            method: "GET".to_string(),
            path: "/settings".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };

        assert!(!should_spa_fallback(&asset));
        assert!(should_spa_fallback(&route));
    }

    #[test]
    fn prepared_attachments_drop_removes_temp_dir() {
        let dir = env::temp_dir().join(format!(
            "maestro-attachment-drop-test-{}-{}",
            process::id(),
            ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        std::fs::write(dir.join("file.txt"), "contents").expect("write temp file");

        drop(PreparedAttachments {
            paths: Vec::new(),
            temp_dir: Some(dir.clone()),
        });

        assert!(!dir.exists());
    }

    #[test]
    fn emergency_default_model_is_available_without_registry_entries() {
        let model = emergency_default_model();

        assert_eq!(model.provider, "anthropic");
        assert!(!model.id.is_empty());
    }

    #[test]
    fn action_body_rejects_missing_or_unknown_actions() {
        assert_eq!(
            parse_action_body(br#"{"action":"reset"}"#, &["on", "off", "reset"])
                .expect("reset should parse"),
            "reset"
        );
        assert!(parse_action_body(br#"{}"#, &["on", "off", "reset"]).is_err());
        assert!(parse_action_body(br#"{"action":"maybe"}"#, &["on", "off", "reset"]).is_err());
    }

    #[test]
    fn training_on_maps_to_opted_in() {
        let status = training_status(Some(false));

        assert_eq!(
            status.get("preference").and_then(Value::as_str),
            Some("opted-in")
        );
        assert_eq!(status.get("optOut").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn telemetry_flag_accepts_common_truthy_values() {
        for value in ["1", "true", "TRUE", "True", "yes", "YES", "on", "On"] {
            assert!(
                telemetry_enabled(None, Some(value), false, false),
                "{value} should enable telemetry"
            );
        }
    }

    #[test]
    fn telemetry_explicit_false_overrides_endpoint_and_file_configuration() {
        for value in ["0", "false", "FALSE", "False", "no", "NO", "off", "Off"] {
            assert!(
                !telemetry_enabled(None, Some(value), true, true),
                "{value} should disable telemetry"
            );
        }
    }

    #[test]
    fn resolves_missing_static_paths_within_root() {
        let root = TestDir::new("static-root");
        fs::write(root.path().join("index.html"), "<html></html>")
            .expect("index should be written");

        let resolved =
            resolve_static_path(root.path(), "/assets/app.js").expect("path should stay in root");

        assert_eq!(resolved, root.path().join("assets/app.js"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_static_paths_that_escape_through_symlinks() {
        let root = TestDir::new("static-root");
        let outside = TestDir::new("outside-root");
        let escape = root.path().join("escape");
        fs::write(root.path().join("index.html"), "<html></html>")
            .expect("index should be written");
        fs::write(outside.path().join("secret.txt"), "secret").expect("secret should be written");
        std::os::unix::fs::symlink(outside.path(), &escape).expect("symlink should be created");

        assert!(resolve_static_path(root.path(), "/escape/secret.txt").is_none());
    }

    #[test]
    fn validates_run_script_inputs() {
        assert!(is_valid_script_name("build:all"));
        assert!(!is_valid_script_name("build && rm -rf /"));
        assert!(contains_shell_metachars("foo; bar"));
        assert!(!contains_shell_metachars("--filter packages/web"));
    }

    #[test]
    fn keeps_attachment_only_prompt_non_empty() {
        let chat = ChatRequest {
            model: None,
            thinking_level: None,
            session_id: None,
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: Value::String(String::new()),
                attachments: vec![ChatAttachment {
                    id: Some("att-1".to_string()),
                    attachment_type: Some("image".to_string()),
                    file_name: Some("screen.png".to_string()),
                    mime_type: Some("image/png".to_string()),
                    content: Some("aGVsbG8=".to_string()),
                    content_omitted: None,
                    extracted_text: None,
                }],
                extra: Map::new(),
            }],
        };

        let prompt = build_prompt_from_chat(&chat);

        assert!(prompt.contains("screen.png"));
        assert!(!prompt.trim().is_empty());
    }

    #[tokio::test]
    async fn prepared_attachments_drop_cleans_temp_dir() {
        let chat = ChatRequest {
            model: None,
            thinking_level: None,
            session_id: None,
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: Value::String("hello".to_string()),
                attachments: vec![ChatAttachment {
                    id: Some("att-1".to_string()),
                    attachment_type: Some("image".to_string()),
                    file_name: Some("screen.png".to_string()),
                    mime_type: Some("image/png".to_string()),
                    content: Some("aGVsbG8=".to_string()),
                    content_omitted: None,
                    extracted_text: None,
                }],
                extra: Map::new(),
            }],
        };

        let cwd = TestDir::new("attachment-cwd");
        let attachments = prepare_chat_attachments(&chat, cwd.path())
            .await
            .expect("attachments should prepare");
        let temp_dir = attachments
            .temp_dir
            .clone()
            .expect("temp dir should be created");

        drop(attachments);

        assert!(!temp_dir.exists(), "temp dir should be removed on drop");
    }

    #[tokio::test]
    async fn prepared_attachments_use_workspace_for_docker_sandbox() {
        let _guard = ENV_LOCK.lock().await;
        let cwd = TestDir::new("attachment-docker-cwd");
        let previous_bridge = env::var_os("MAESTRO_CODEX_APP_SERVER_SANDBOX");
        let previous_sandbox = env::var_os("MAESTRO_SANDBOX_MODE");
        env::set_var("MAESTRO_CODEX_APP_SERVER_SANDBOX", "docker");
        env::remove_var("MAESTRO_SANDBOX_MODE");
        let chat = ChatRequest {
            model: None,
            thinking_level: None,
            session_id: None,
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: Value::String("hello".to_string()),
                attachments: vec![ChatAttachment {
                    id: Some("att-1".to_string()),
                    attachment_type: Some("file".to_string()),
                    file_name: Some("token.txt".to_string()),
                    mime_type: Some("text/plain".to_string()),
                    content: Some("aGVsbG8=".to_string()),
                    content_omitted: None,
                    extracted_text: None,
                }],
                extra: Map::new(),
            }],
        };

        let attachments = prepare_chat_attachments(&chat, cwd.path())
            .await
            .expect("attachments should prepare");

        if let Some(previous) = previous_bridge {
            env::set_var("MAESTRO_CODEX_APP_SERVER_SANDBOX", previous);
        } else {
            env::remove_var("MAESTRO_CODEX_APP_SERVER_SANDBOX");
        }
        if let Some(previous) = previous_sandbox {
            env::set_var("MAESTRO_SANDBOX_MODE", previous);
        } else {
            env::remove_var("MAESTRO_SANDBOX_MODE");
        }

        let temp_dir = attachments
            .temp_dir
            .clone()
            .expect("temp dir should be created");
        assert!(temp_dir.starts_with(cwd.path()));
        assert!(attachments
            .paths
            .iter()
            .all(|path| Path::new(path).starts_with(cwd.path())));
    }

    #[tokio::test]
    async fn missing_static_asset_returns_404_instead_of_index() {
        let static_root = unique_test_dir("maestro-static-asset");
        fs::create_dir_all(&static_root).expect("static root should exist");
        fs::write(static_root.join("index.html"), "<html>ok</html>").expect("index should exist");

        let head = RequestHead {
            method: "GET".to_string(),
            path: "/assets/app.js".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };
        let config = Config {
            listen_host: "127.0.0.1".to_string(),
            listen_port: 8080,
            api_key: None,
            require_key: false,
            csrf_token: None,
            require_csrf: false,
            cwd: PathBuf::from("."),
            session_store_path: static_root.join("sessions.json"),
            command_prefs_path: static_root.join("command-prefs.json"),
            usage_file_path: static_root.join("usage.json"),
            a2a_tasks_file_path: static_root.join("a2a-tasks.json"),
            static_root: static_root.clone(),
            static_cache_max_age: 60,
            llm_gateway_models_url: None,
            llm_gateway_token: None,
            llm_gateway_org_id: None,
            llm_gateway_timeout_ms: 2_500,
        };

        let response = static_response(&head, &config).await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert!(!response.contains("<html>ok</html>"));

        let _ = fs::remove_dir_all(static_root);
    }

    #[tokio::test]
    async fn missing_spa_route_falls_back_to_index() {
        let static_root = unique_test_dir("maestro-static-spa");
        fs::create_dir_all(&static_root).expect("static root should exist");
        fs::write(static_root.join("index.html"), "<html>ok</html>").expect("index should exist");

        let head = RequestHead {
            method: "GET".to_string(),
            path: "/chat/session".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };
        let config = Config {
            listen_host: "127.0.0.1".to_string(),
            listen_port: 8080,
            api_key: None,
            require_key: false,
            csrf_token: None,
            require_csrf: false,
            cwd: PathBuf::from("."),
            session_store_path: static_root.join("sessions.json"),
            command_prefs_path: static_root.join("command-prefs.json"),
            usage_file_path: static_root.join("usage.json"),
            a2a_tasks_file_path: static_root.join("a2a-tasks.json"),
            static_root: static_root.clone(),
            static_cache_max_age: 60,
            llm_gateway_models_url: None,
            llm_gateway_token: None,
            llm_gateway_org_id: None,
            llm_gateway_timeout_ms: 2_500,
        };

        let response = static_response(&head, &config).await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("<html>ok</html>"));

        let _ = fs::remove_dir_all(static_root);
    }

    #[tokio::test]
    async fn delete_session_subpath_returns_404_without_removing_session() {
        let root = TestDir::new("session-delete-subpath");
        let session_id = "session-1".to_string();
        let now = now_rfc3339();
        let session = SessionRecord {
            id: session_id.clone(),
            owner: None,
            title: "Test Session".to_string(),
            created_at: now.clone(),
            updated_at: now,
            message_count: 0,
            favorite: None,
            tags: Vec::new(),
            messages: Vec::new(),
        };
        let state = AppState {
            config: Arc::new(Config {
                listen_host: "127.0.0.1".to_string(),
                listen_port: 8080,
                api_key: Some("api-key".to_string()),
                require_key: true,
                csrf_token: None,
                require_csrf: false,
                cwd: PathBuf::from("."),
                session_store_path: root.path().join("sessions.json"),
                command_prefs_path: root.path().join("command-prefs.json"),
                usage_file_path: root.path().join("usage.json"),
                a2a_tasks_file_path: root.path().join("a2a-tasks.json"),
                static_root: root.path().to_path_buf(),
                static_cache_max_age: 60,
                llm_gateway_models_url: None,
                llm_gateway_token: None,
                llm_gateway_org_id: None,
                llm_gateway_timeout_ms: 2_500,
            }),
            started_at: Instant::now(),
            selected_model: Arc::new(Mutex::new(emergency_default_model())),
            telemetry_override: Arc::new(Mutex::new(None)),
            training_override: Arc::new(Mutex::new(None)),
            background_settings: Arc::new(Mutex::new(BackgroundSettings::default())),
            framework_preference: Arc::new(Mutex::new(None)),
            command_prefs: Arc::new(Mutex::new(CommandPrefs {
                favorites: Vec::new(),
                recents: Vec::new(),
            })),
            sessions: Arc::new(Mutex::new(SessionStore {
                sessions: HashMap::from([(session_id.clone(), session)]),
                shared_sessions: HashMap::new(),
            })),
            session_store_persist_enabled: true,
            session_persist_lock: Arc::new(Mutex::new(())),
            usage_persist_lock: Arc::new(Mutex::new(())),
            shared_sessions: Arc::new(Mutex::new(HashMap::new())),
            approval_modes: Arc::new(Mutex::new(HashMap::new())),
            pending_tool_responses: Arc::new(Mutex::new(HashMap::new())),
            a2a_tasks: Arc::new(Mutex::new(HashMap::new())),
            a2a_task_persist_lock: Arc::new(Mutex::new(())),
            a2a_task_events: broadcast::channel(256).0,
            a2a_task_event_history: Arc::new(Mutex::new(HashMap::new())),
            a2a_cancel_senders: Arc::new(Mutex::new(HashMap::new())),
        };
        let (_client, mut server) = tcp_stream_pair().await;
        let head = RequestHead {
            method: "DELETE".to_string(),
            path: format!("/api/sessions/{session_id}/share"),
            query: HashMap::new(),
            headers: HashMap::from([("x-maestro-api-key".to_string(), "api-key".to_string())]),
        };

        let response = handle_session_endpoint(&mut server, &mut Vec::new(), &head, &state).await;
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert!(state
            .sessions
            .lock()
            .await
            .sessions
            .contains_key(&session_id));
    }

    #[tokio::test]
    async fn invalid_session_store_is_left_untouched_and_future_writes_are_blocked() {
        let root = TestDir::new("invalid-session-store");
        let session_store_path = root.path().join("sessions.json");
        tokio::fs::write(&session_store_path, br#"{"sessions":"invalid"}"#)
            .await
            .expect("fixture should be written");

        let (store, persist_enabled) = load_session_store(&session_store_path).await;
        assert!(store.sessions.is_empty());
        assert!(!persist_enabled);

        let state = AppState {
            config: Arc::new(Config {
                listen_host: "127.0.0.1".to_string(),
                listen_port: 8080,
                api_key: None,
                require_key: false,
                csrf_token: None,
                require_csrf: false,
                cwd: PathBuf::from("."),
                session_store_path: session_store_path.clone(),
                command_prefs_path: root.path().join("command-prefs.json"),
                usage_file_path: root.path().join("usage.json"),
                a2a_tasks_file_path: root.path().join("a2a-tasks.json"),
                static_root: root.path().to_path_buf(),
                static_cache_max_age: 60,
                llm_gateway_models_url: None,
                llm_gateway_token: None,
                llm_gateway_org_id: None,
                llm_gateway_timeout_ms: 2_500,
            }),
            started_at: Instant::now(),
            selected_model: Arc::new(Mutex::new(emergency_default_model())),
            telemetry_override: Arc::new(Mutex::new(None)),
            training_override: Arc::new(Mutex::new(None)),
            background_settings: Arc::new(Mutex::new(BackgroundSettings::default())),
            framework_preference: Arc::new(Mutex::new(None)),
            command_prefs: Arc::new(Mutex::new(CommandPrefs {
                favorites: Vec::new(),
                recents: Vec::new(),
            })),
            sessions: Arc::new(Mutex::new(SessionStore {
                sessions: HashMap::from([(
                    "session-1".to_string(),
                    test_session_record("session-1"),
                )]),
                shared_sessions: HashMap::new(),
            })),
            session_store_persist_enabled: persist_enabled,
            session_persist_lock: Arc::new(Mutex::new(())),
            usage_persist_lock: Arc::new(Mutex::new(())),
            shared_sessions: Arc::new(Mutex::new(HashMap::new())),
            approval_modes: Arc::new(Mutex::new(HashMap::new())),
            pending_tool_responses: Arc::new(Mutex::new(HashMap::new())),
            a2a_tasks: Arc::new(Mutex::new(HashMap::new())),
            a2a_task_persist_lock: Arc::new(Mutex::new(())),
            a2a_task_events: broadcast::channel(256).0,
            a2a_task_event_history: Arc::new(Mutex::new(HashMap::new())),
            a2a_cancel_senders: Arc::new(Mutex::new(HashMap::new())),
        };

        persist_session_store(&state).await;

        let bytes = tokio::fs::read(&session_store_path)
            .await
            .expect("session store should still exist");
        assert_eq!(bytes, br#"{"sessions":"invalid"}"#);
    }

    #[test]
    fn rejects_missing_request_target() {
        let request = b"GET\r\nHost: localhost\r\n\r\n";

        assert!(parse_request_head(request).is_err());
    }

    #[test]
    fn approval_blocked_tool_event_uses_contract_tool_end_shape() {
        let event = approval_blocked_tool_event("call-1", "bash");

        assert_eq!(event["type"], "tool_execution_end");
        assert_eq!(event["toolCallId"], "call-1");
        assert_eq!(event["toolName"], "bash");
        assert_eq!(event["isError"], true);
        assert_eq!(event["result"]["isError"], true);
        assert_eq!(
            event["result"]["content"][0]["text"],
            "Tool execution blocked by approval mode"
        );
    }

    #[test]
    fn failed_tool_metadata_is_marked_error_for_replay() {
        let mut tools = Vec::new();
        record_tool_call_metadata(&mut tools, "tool-1", "bash", serde_json::json!({}));

        finish_tool_metadata(&mut tools, "tool-1", false);

        assert_eq!(tools[0]["status"], "error");
        assert_eq!(tools[0]["result"]["isError"], true);
    }
}
