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
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{self, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
#[cfg(test)]
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc, watch, Mutex};

mod a2a;
mod a2a_platform_registration;
mod a2a_skill_catalog;
mod auth;
mod codex_compat;
mod codex_subagent_dispatch;
mod http;
mod markitdown;
mod model_catalog;
mod runtime_assets;
mod sessions;

pub(crate) use a2a::{
    a2a_agent_card, a2a_agent_message, a2a_agent_skills, a2a_context_id,
    a2a_public_base_url_for_config, a2a_push_authorization_header, a2a_push_ip_is_private,
    a2a_push_notification_payloads, a2a_return_immediately, a2a_task_is_terminal,
    a2a_task_ledger_lock_path, a2a_task_value, a2a_user_message_value,
    acquire_a2a_task_ledger_file_lock, apply_platform_a2a_artifact_update,
    apply_platform_a2a_status_update, claim_a2a_send_task, complete_a2a_task, handle_a2a_endpoint,
    handle_a2a_streaming_endpoint, handle_platform_a2a_push_endpoint, is_a2a_endpoint,
    is_a2a_streaming_endpoint, is_platform_a2a_push_endpoint, load_a2a_tasks,
    normalize_a2a_push_notification_config, persist_a2a_tasks, publish_a2a_task_update,
    release_a2a_task_ledger_file_lock, spawn_a2a_task_ledger_lock_heartbeat,
    store_a2a_task_unless_canceled, A2ACancelReceiver, A2ACancelSender, A2AMessageBody,
    A2APartBody, A2ASendMessageRequest, A2ATaskEventHistory, A2ATaskUpdateEvent,
    A2A_CONTROL_PLANE_LEDGER_DISPLAY_NAME, A2A_CONTROL_PLANE_LEDGER_PEER,
    A2A_DEFAULT_LIST_PAGE_SIZE, A2A_DEFAULT_RESPONSE_END_SETTLE_MS, A2A_DEFAULT_TURN_TIMEOUT_MS,
    A2A_LEDGER_LOCK_HEARTBEAT_FILE, A2A_LEDGER_LOCK_RETRY_MS, A2A_MAX_LIST_PAGE_SIZE,
    A2A_PROTOCOL_VERSION, A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY, A2A_TERMINAL_TASK_STORE_LIMIT,
    EVALOPS_A2A_EXTENSION_URI,
};
use a2a_platform_registration::maybe_spawn_a2a_platform_registration_loop;
#[cfg(test)]
use a2a_platform_registration::{
    a2a_platform_heartbeat_payload, a2a_platform_register_payload,
    a2a_platform_registration_enabled, normalize_platform_base_url, platform_error_is_conflict,
    register_or_update_a2a_platform_agent, resolve_a2a_platform_registration_config,
    send_a2a_platform_heartbeat, A2APlatformRegistrationConfig,
};
#[cfg(test)]
use a2a_skill_catalog::A2A_SUBAGENT_REQUEST_METADATA_PATH;
use auth::*;
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
use markitdown::{extract_with_markitdown, should_prefer_markitdown, should_try_markitdown};
use model_catalog::{available_models, default_model, resolve_model, ModelInfo};
#[cfg(test)]
use model_catalog::{
    builtin_models, default_model_from_registry, emergency_default_model, merge_configured_models,
    merge_llm_gateway_model_catalog, ModelRegistry,
};
use runtime_assets::*;
use sessions::*;

const MAX_EXTRACT_JSON_BODY_BYTES: usize = 72 * 1024 * 1024;
const DEFAULT_EXTRACT_MAX_CHARS: usize = 200_000;
const MAX_EXTRACT_INPUT_BYTES: usize = 50 * 1024 * 1024;
const MAX_PROJECT_ONBOARDING_IMPRESSIONS: u8 = 4;
const CODEX_SUBAGENT_WORK_GRAPH_SCHEMA: &str = "evalops.maestro.codex.subagent-workgraph.v1";
static CODEX_BRIDGE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static CODEX_HEADLESS_RUN_COUNTER: AtomicU64 = AtomicU64::new(0);
static ATTACHMENT_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
type PendingToolResponseSender = mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>;

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
    println!(
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
    maybe_spawn_a2a_platform_registration_loop(config.clone());

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
    extractor: String,
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
mod tests;
