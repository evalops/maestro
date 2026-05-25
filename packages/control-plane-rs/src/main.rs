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
#[cfg(test)]
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{self, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
#[cfg(test)]
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
#[cfg(test)]
use tokio::sync::watch;
use tokio::sync::{broadcast, mpsc, Mutex};

mod a2a;
mod a2a_platform_registration;
mod a2a_skill_catalog;
mod auth;
mod chat;
mod codex_bridge;
mod codex_compat;
mod codex_subagent_dispatch;
mod http;
mod local;
mod markitdown;
mod model_catalog;
mod runtime_assets;
mod sessions;

#[allow(unused_imports)]
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
pub(crate) use chat::{
    approval_blocked_tool_event, build_prompt_from_chat, composer_assistant_message,
    composer_assistant_message_with_tools, composer_text_content, finish_tool_metadata,
    handle_chat_endpoint, handle_chat_websocket_endpoint, handle_codex_app_server_chat_transport,
    is_chat_endpoint, is_chat_websocket_endpoint, prepare_chat_attachments,
    record_chat_user_message, record_tool_call_metadata, send_sse, send_ws_json, sse_headers,
    strip_data_url_prefix, try_parse_websocket_text_message, update_tool_metadata_status,
    websocket_accept_key, ChatAttachment, ChatMessage, ChatRequest, ExtractAttachmentRequest,
    ExtractDocumentOutput, PreparedAttachments,
};
pub(crate) use codex_bridge::*;
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
use local::*;
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

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
