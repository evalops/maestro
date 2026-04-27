use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use maestro_tui::agent::{FromAgent, NativeAgent, NativeAgentConfig, TokenUsage, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{self, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_JSON_BODY_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_EXTRACT_MAX_CHARS: usize = 200_000;
const MAX_EXTRACT_INPUT_BYTES: usize = 50 * 1024 * 1024;
const MAX_PROJECT_ONBOARDING_IMPRESSIONS: u8 = 4;
const CORS_ALLOW_HEADERS: &str = "authorization,content-type,x-composer-artifact-access,x-composer-api-key,x-composer-approval-mode,x-composer-client,x-composer-client-tools,x-composer-csrf,x-composer-agent-id,x-composer-slim-events,x-composer-workspace,x-composer-workspace-id,x-maestro-artifact-access,x-maestro-api-key,x-maestro-approval-mode,x-maestro-agent-id,x-maestro-client,x-maestro-client-tools,x-maestro-csrf,x-maestro-slim-events,x-maestro-workspace,x-maestro-workspace-id,x-csrf-token";
static ATTACHMENT_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
type PendingToolResponseSender = mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>;

#[derive(Debug, Clone)]
struct Config {
    listen_host: String,
    listen_port: u16,
    api_key: Option<String>,
    require_key: bool,
    cwd: PathBuf,
    session_store_path: PathBuf,
    command_prefs_path: PathBuf,
    usage_file_path: PathBuf,
    static_root: PathBuf,
    static_cache_max_age: u64,
}

impl Config {
    fn from_env() -> Self {
        let listen_port = env_u16("PORT", 8080);
        let require_key = env::var("MAESTRO_WEB_REQUIRE_KEY")
            .map(|value| value != "0")
            .unwrap_or_else(|_| env::var("NODE_ENV").map(|v| v != "test").unwrap_or(true));

        Self {
            listen_host: env::var("MAESTRO_CONTROL_HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            listen_port,
            api_key: env::var("MAESTRO_WEB_API_KEY")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            require_key,
            cwd: env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            session_store_path: env::var("MAESTRO_SESSIONS_FILE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from(".maestro/sessions.json")),
            command_prefs_path: command_prefs_path(),
            usage_file_path: usage_file_path(),
            static_root: env::var("MAESTRO_WEB_STATIC_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("packages/web/dist")),
            static_cache_max_age: env::var("MAESTRO_STATIC_MAX_AGE")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(86_400),
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
    telemetry_override: Arc<Mutex<Option<TelemetryOverride>>>,
    training_override: Arc<Mutex<Option<TrainingOverride>>>,
    command_prefs: Arc<Mutex<CommandPrefs>>,
    sessions: Arc<Mutex<SessionStore>>,
    session_persist_lock: Arc<Mutex<()>>,
    usage_persist_lock: Arc<Mutex<()>>,
    approval_modes: Arc<Mutex<HashMap<String, String>>>,
    pending_tool_responses: Arc<Mutex<HashMap<String, PendingToolResponseSender>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TelemetryOverride {
    Enabled,
    Disabled,
}

impl TelemetryOverride {
    fn from_action(action: &str) -> Result<Option<Self>, String> {
        match action {
            "on" => Ok(Some(Self::Enabled)),
            "off" => Ok(Some(Self::Disabled)),
            "reset" => Ok(None),
            _ => Err(format!("unsupported telemetry action \"{action}\"")),
        }
    }

    fn is_enabled(self) -> bool {
        matches!(self, Self::Enabled)
    }

    fn runtime_override(self) -> &'static str {
        if self.is_enabled() {
            "enabled"
        } else {
            "disabled"
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrainingOverride {
    OptedIn,
    OptedOut,
}

impl TrainingOverride {
    fn from_action(action: &str) -> Result<Option<Self>, String> {
        match action {
            "on" => Ok(Some(Self::OptedIn)),
            "off" => Ok(Some(Self::OptedOut)),
            "reset" => Ok(None),
            _ => Err(format!("unsupported training action \"{action}\"")),
        }
    }

    fn is_opt_out(self) -> bool {
        matches!(self, Self::OptedOut)
    }

    fn preference(self) -> &'static str {
        if self.is_opt_out() {
            "opted-out"
        } else {
            "opted-in"
        }
    }
}

#[derive(Debug)]
struct RequestHead {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelInfo {
    id: String,
    provider: String,
    name: String,
    api: String,
    context_window: u32,
    max_tokens: u32,
    reasoning: bool,
    cost: ModelCost,
    capabilities: ModelCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelCost {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelCapabilities {
    streaming: bool,
    tools: bool,
    vision: bool,
    reasoning: bool,
}

#[derive(Debug, Clone)]
struct ModelRegistry {
    models: Vec<ModelInfo>,
    aliases: HashMap<String, String>,
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

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
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
    let config = Arc::new(Config::from_env());
    let listener = TcpListener::bind(config.listen_addr()).await?;
    eprintln!(
        "maestro rust server listening on http://{}",
        config.listen_addr()
    );
    let sessions = load_session_store(&config.session_store_path).await;
    let command_prefs = load_command_prefs(&config.command_prefs_path).await;

    let state = AppState {
        config,
        started_at: Instant::now(),
        selected_model: Arc::new(Mutex::new(default_model().await)),
        telemetry_override: Arc::new(Mutex::new(None)),
        training_override: Arc::new(Mutex::new(None)),
        command_prefs: Arc::new(Mutex::new(command_prefs)),
        sessions: Arc::new(Mutex::new(sessions)),
        session_persist_lock: Arc::new(Mutex::new(())),
        usage_persist_lock: Arc::new(Mutex::new(())),
        approval_modes: Arc::new(Mutex::new(HashMap::new())),
        pending_tool_responses: Arc::new(Mutex::new(HashMap::new())),
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

    if head.method == "OPTIONS" {
        stream
            .write_all(&response(204, "text/plain; charset=utf-8", &[]))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    if is_chat_websocket_endpoint(&head) {
        return handle_chat_websocket_endpoint(stream, initial, head, state).await;
    }

    if is_chat_endpoint(&head) {
        return handle_chat_endpoint(stream, initial, head, state).await;
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

fn pending_request_id_from_resume_path(path: &str) -> Option<&str> {
    let request_id = path
        .strip_prefix("/api/pending-requests/")?
        .strip_suffix("/resume")?;
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
            json_response(200, &serde_json::json!({ "models": available_models().await.models }))
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
            let registry = available_models().await;
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
            json_response(200, &serde_json::json!({ "commands": command_catalog(&state.config.cwd).await }))
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
            json_response(200, &background_response(&head))
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
            json_response(200, &framework_response(&head))
        }
        ("POST", "/api/framework") => {
            if let Err(response) = authorize(&head, &state.config) {
                return response;
            }
            json_response(200, &serde_json::json!({ "success": true, "message": "Framework preference accepted by Rust control plane" }))
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
            let override_value = match TelemetryOverride::from_action(&action) {
                Ok(override_value) => override_value,
                Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
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
            let override_value = match TrainingOverride::from_action(&action) {
                Ok(override_value) => override_value,
                Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
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
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    id: String,
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

async fn handle_session_endpoint(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
) -> Vec<u8> {
    match head.method.as_str() {
        "GET" if head.path == "/api/sessions" => json_response(
            200,
            &serde_json::json!({ "sessions": session_summaries(state).await }),
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
            let session = create_session_record(request.title);
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
                Some("share") => handle_session_share_post(state, session_path).await,
                Some("export") => {
                    handle_session_export_post(stream, initial, head, state, session_path).await
                }
                Some(tail) => {
                    if let Some(attachment_id) = session_attachment_extract_id(tail) {
                        handle_session_attachment_extract(
                            head,
                            state,
                            session_path.id,
                            attachment_id,
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
            if let Some(shared_path) = shared_session_path_from_path(&head.path) {
                return handle_shared_session_get(state, shared_path).await;
            }
            let Some(session_path) = session_path_from_path(&head.path) else {
                return json_response(404, &serde_json::json!({ "error": "Not found" }));
            };
            handle_session_get(head, state, session_path).await
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
            }
            state.sessions.lock().await.sessions.remove(session_path.id);
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
    let Some(sender) = state.pending_tool_responses.lock().await.remove(request_id) else {
        return json_response(
            404,
            &serde_json::json!({ "error": format!("No active pending request: {request_id}") }),
        );
    };
    let (approved, result) = pending_tool_response_from_payload(&payload);
    if sender
        .send((request_id.to_string(), approved, result))
        .is_err()
    {
        return json_response(
            409,
            &serde_json::json!({ "error": "Pending request is no longer active" }),
        );
    }
    json_response(200, &pending_request_resume_value(request_id, &payload))
}

async fn load_session_store(path: &Path) -> SessionStore {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => SessionStore::default(),
    }
}

async fn persist_session_store(state: &AppState) {
    let _persist = state.session_persist_lock.lock().await;
    let store = state.sessions.lock().await.clone();
    if let Some(parent) = state.config.session_store_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&store) {
        let _ = tokio::fs::write(&state.config.session_store_path, bytes).await;
    }
}

fn create_session_record(title: Option<String>) -> SessionRecord {
    let now = now_rfc3339();
    SessionRecord {
        id: new_session_id(),
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

async fn session_summaries(state: &AppState) -> Vec<Value> {
    let mut sessions: Vec<SessionRecord> = state
        .sessions
        .lock()
        .await
        .sessions
        .values()
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

    match session_path.tail {
        None => json_response(200, &session_full_value(&session)),
        Some("timeline") => json_response(
            200,
            &serde_json::json!({
                "source": "local",
                "generatedAt": now_rfc3339(),
                "platformBacked": false,
                "pendingRequestCount": 0,
                "items": session.messages.iter().enumerate().map(|(index, message)| {
                    serde_json::json!({
                        "id": format!("{}-{index}", session.id),
                        "type": "message",
                        "timestamp": message.get("timestamp").cloned().unwrap_or(Value::Null),
                        "message": message
                    })
                }).collect::<Vec<_>>()
            }),
        ),
        Some("share") => json_response(
            200,
            &serde_json::json!({ "sessionId": session.id, "enabled": false, "shareUrl": Value::Null }),
        ),
        Some("export") => json_response(200, &session_full_value(&session)),
        Some("artifacts") => json_response(200, &session_artifacts_value(&session)),
        Some("artifact-access") => session_artifact_access_response(head, &session),
        Some("attachments") => json_response(200, &session_attachments_value(&session)),
        Some("artifacts.zip") => serve_session_artifacts_zip(&session),
        Some(tail) if tail.starts_with("artifacts/") => serve_session_artifact(&session, tail),
        Some(tail) if tail.starts_with("attachments/") => serve_session_attachment(&session, tail),
        _ => json_response(404, &serde_json::json!({ "error": "Not found" })),
    }
}

async fn handle_shared_session_get(
    state: &AppState,
    shared_path: SharedSessionPath<'_>,
) -> Vec<u8> {
    let Some(session) = state
        .sessions
        .lock()
        .await
        .sessions
        .get(shared_path.token)
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

async fn handle_session_share_post(state: &AppState, session_path: SessionPath<'_>) -> Vec<u8> {
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
    let token = session.id;
    json_response(
        200,
        &serde_json::json!({
            "shareToken": token,
            "shareUrl": format!("/share/{token}"),
            "webShareUrl": format!("/share/{token}"),
            "expiresAt": "9999-12-31T23:59:59.999Z",
            "maxAccesses": Value::Null
        }),
    )
}

async fn handle_session_export_post(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
    state: &AppState,
    session_path: SessionPath<'_>,
) -> Vec<u8> {
    let body = match read_request_body(stream, initial, head).await {
        Ok(body) => body,
        Err(error) => return json_response(400, &serde_json::json!({ "error": error })),
    };
    let format = if body.is_empty() {
        "json".to_string()
    } else {
        serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("format")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|format| matches!(format.as_str(), "json" | "markdown" | "text"))
            .unwrap_or_else(|| "json".to_string())
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
    match format.as_str() {
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
    let attachments = session_attachments(session);
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
    let body = match read_request_body(stream, initial, head).await {
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
    extract_attachment_request_response(request)
}

async fn handle_session_attachment_extract(
    head: &RequestHead,
    state: &AppState,
    session_id: &str,
    attachment_id: String,
) -> Vec<u8> {
    let should_force = head
        .query
        .get("force")
        .map(|force| matches!(force.as_str(), "1" | "true"))
        .unwrap_or(false);
    let mut sessions = state.sessions.lock().await;
    let Some(session) = sessions.sessions.get_mut(session_id) else {
        return json_response(404, &serde_json::json!({ "error": "Session not found" }));
    };
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
    let output = match extract_attachment_request(ExtractAttachmentRequest {
        file_name: file_name.clone(),
        mime_type,
        content_base64,
        max_chars: None,
    }) {
        Ok(output) => output,
        Err(error) => {
            return json_response(400, &serde_json::json!({ "error": error }));
        }
    };
    if let Some(object) = attachment.as_object_mut() {
        object.insert(
            "extractedText".to_string(),
            Value::String(output.extracted_text.clone()),
        );
    }
    drop(sessions);
    persist_session_store(state).await;
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

fn extract_attachment_request_response(request: ExtractAttachmentRequest) -> Vec<u8> {
    match extract_attachment_request(request) {
        Ok(output) => attachment_extract_json_response(output.file_name.clone(), output),
        Err(error) if error == "Unsupported document format" => {
            json_response(400, &serde_json::json!({ "error": error }))
        }
        Err(error) => json_response(400, &serde_json::json!({ "error": error })),
    }
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

fn serve_session_artifact(session: &SessionRecord, tail: &str) -> Vec<u8> {
    let Some(rest) = tail.strip_prefix("artifacts/") else {
        return json_response(404, &serde_json::json!({ "error": "Artifact not found" }));
    };
    let filename = percent_decode_component(rest.strip_suffix("/view").unwrap_or(rest));
    let artifacts = reconstruct_session_artifacts(session);
    let Some(content) = artifacts.get(&filename) else {
        return json_response(404, &serde_json::json!({ "error": "Artifact not found" }));
    };
    response_with_no_store(200, mime_for_path(Path::new(&filename)), content.as_bytes())
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

fn percent_decode_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    decoded.push(byte);
                    index += 3;
                    continue;
                }
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).to_string()
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
    value["messages"] = Value::Array(session.messages.clone());
    value
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

fn builtin_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "claude-sonnet-4-5-20250514".to_string(),
            provider: "anthropic".to_string(),
            name: "Claude Sonnet 4.5".to_string(),
            api: "anthropic-messages".to_string(),
            context_window: 200_000,
            max_tokens: 64_000,
            reasoning: true,
            cost: ModelCost {
                input: 3.0,
                output: 15.0,
                cache_read: 0.3,
                cache_write: 3.75,
            },
            capabilities: ModelCapabilities {
                streaming: true,
                tools: true,
                vision: true,
                reasoning: true,
            },
        },
        ModelInfo {
            id: "gpt-5.1-codex-max".to_string(),
            provider: "openai".to_string(),
            name: "GPT-5.1 Codex Max".to_string(),
            api: "openai-codex-responses".to_string(),
            context_window: 400_000,
            max_tokens: 128_000,
            reasoning: true,
            cost: ModelCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
            capabilities: ModelCapabilities {
                streaming: true,
                tools: true,
                vision: true,
                reasoning: true,
            },
        },
    ]
}

async fn available_models() -> ModelRegistry {
    let mut registry = ModelRegistry {
        models: builtin_models(),
        aliases: HashMap::new(),
    };

    let Some(config) = read_json_value(&model_config_path()).await else {
        return registry;
    };
    merge_configured_models(&mut registry, &config);
    registry
}

fn merge_configured_models(registry: &mut ModelRegistry, config: &Value) {
    if let Some(aliases) = config.get("aliases").and_then(Value::as_object) {
        registry
            .aliases
            .extend(aliases.iter().filter_map(|(alias, target)| {
                target
                    .as_str()
                    .map(|target| (alias.to_string(), target.trim().to_string()))
            }));
    }

    let Some(providers) = config.get("providers").and_then(Value::as_array) else {
        return;
    };

    for provider in providers {
        if provider.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(provider_id) = provider.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if provider_id.is_empty() {
            continue;
        }
        let provider_api = provider.get("api").and_then(Value::as_str).map(str::trim);
        let Some(models) = provider.get("models").and_then(Value::as_array) else {
            continue;
        };

        for model in models {
            let Some(id) = model.get("id").and_then(Value::as_str).map(str::trim) else {
                continue;
            };
            if id.is_empty() {
                continue;
            }
            let name = model
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(id);
            let api = model
                .get("api")
                .and_then(Value::as_str)
                .map(str::trim)
                .or(provider_api)
                .unwrap_or("openai-responses");
            let reasoning = model
                .get("reasoning")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let input_modes = model
                .get("input")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let vision = input_modes
                .iter()
                .any(|mode| mode.as_str() == Some("image"));
            let tools = model
                .get("toolUse")
                .or_else(|| model.get("tools"))
                .and_then(Value::as_bool)
                .unwrap_or(true);

            let info = ModelInfo {
                id: id.to_string(),
                provider: provider_id.to_string(),
                name: name.to_string(),
                api: api.to_string(),
                context_window: value_u32(model.get("contextWindow")).unwrap_or(0),
                max_tokens: value_u32(model.get("maxTokens")).unwrap_or(0),
                reasoning,
                cost: model_cost_from_value(model.get("cost")),
                capabilities: ModelCapabilities {
                    streaming: true,
                    tools,
                    vision,
                    reasoning,
                },
            };
            upsert_model(&mut registry.models, info);
        }
    }
}

fn upsert_model(models: &mut Vec<ModelInfo>, model: ModelInfo) {
    if let Some(existing) = models
        .iter_mut()
        .find(|candidate| candidate.provider == model.provider && candidate.id == model.id)
    {
        *existing = model;
    } else {
        models.push(model);
    }
}

fn value_u32(value: Option<&Value>) -> Option<u32> {
    value?.as_u64().and_then(|value| u32::try_from(value).ok())
}

fn model_cost_from_value(value: Option<&Value>) -> ModelCost {
    let Some(cost) = value.and_then(Value::as_object) else {
        return zero_model_cost();
    };
    ModelCost {
        input: cost.get("input").and_then(Value::as_f64).unwrap_or(0.0),
        output: cost.get("output").and_then(Value::as_f64).unwrap_or(0.0),
        cache_read: cost.get("cacheRead").and_then(Value::as_f64).unwrap_or(0.0),
        cache_write: cost
            .get("cacheWrite")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    }
}

fn zero_model_cost() -> ModelCost {
    ModelCost {
        input: 0.0,
        output: 0.0,
        cache_read: 0.0,
        cache_write: 0.0,
    }
}

async fn default_model() -> ModelInfo {
    let registry = available_models().await;
    env::var("MAESTRO_DEFAULT_MODEL")
        .ok()
        .and_then(|model| resolve_model(&model, &registry))
        .or_else(|| registry.models.first().cloned())
        .unwrap_or_else(emergency_default_model)
}

fn emergency_default_model() -> ModelInfo {
    ModelInfo {
        id: "claude-sonnet-4-5-20250514".to_string(),
        provider: "anthropic".to_string(),
        name: "Claude Sonnet 4.5".to_string(),
        api: "anthropic-messages".to_string(),
        context_window: 200_000,
        max_tokens: 64_000,
        reasoning: true,
        cost: ModelCost {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
        },
        capabilities: ModelCapabilities {
            streaming: true,
            tools: true,
            vision: true,
            reasoning: true,
        },
    }
}

fn resolve_model(input: &str, registry: &ModelRegistry) -> Option<ModelInfo> {
    let normalized = input.trim();
    let normalized = registry
        .aliases
        .get(normalized)
        .map(String::as_str)
        .unwrap_or(normalized);
    registry
        .models
        .iter()
        .find(|model| {
            model.id == normalized || format!("{}/{}", model.provider, model.id) == normalized
        })
        .cloned()
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
            let Ok(raw) = tokio::fs::read_to_string(path).await else {
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

fn usage_file_path() -> PathBuf {
    env::var("MAESTRO_USAGE_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| maestro_home().join("usage.json"))
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

fn background_response(head: &RequestHead) -> Value {
    match head.query.get("action").map(String::as_str) {
        Some("history") => serde_json::json!({ "history": [], "truncated": false }),
        Some("path") => serde_json::json!({
            "path": maestro_home().join("background-tasks.jsonl").to_string_lossy(),
            "exists": false,
            "overridden": env::var("MAESTRO_BACKGROUND_TASKS_FILE").is_ok()
        }),
        _ => serde_json::json!({
            "settings": {
                "notificationsEnabled": false,
                "statusDetailsEnabled": false
            },
            "snapshot": {
                "running": 0,
                "total": 0,
                "failed": 0,
                "detailsRedacted": true
            }
        }),
    }
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

fn framework_response(head: &RequestHead) -> Value {
    match head.query.get("action").map(String::as_str) {
        Some("list") => serde_json::json!({ "frameworks": [] }),
        _ => serde_json::json!({
            "framework": "default",
            "source": "rust-control-plane",
            "locked": false,
            "scope": "user"
        }),
    }
}

fn telemetry_status(override_value: Option<TelemetryOverride>) -> Value {
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
    let telemetry_sink_configured = endpoint.is_some()
        || env::var("MAESTRO_TELEMETRY_FILE").is_ok()
        || env::var("PLAYWRIGHT_TELEMETRY_FILE").is_ok();
    let enabled = telemetry_enabled(override_value, flag.as_deref(), telemetry_sink_configured);
    serde_json::json!({
        "enabled": enabled,
        "reason": if override_value.is_some() { "runtime override" } else if enabled { "configured" } else { "disabled" },
        "endpoint": endpoint,
        "filePath": file_path,
        "sampleRate": 1,
        "flagValue": flag,
        "runtimeOverride": override_value.map(TelemetryOverride::runtime_override)
    })
}

fn telemetry_enabled(
    override_value: Option<TelemetryOverride>,
    flag: Option<&str>,
    telemetry_sink_configured: bool,
) -> bool {
    override_value
        .map(TelemetryOverride::is_enabled)
        .unwrap_or_else(|| parse_bool_flag(flag).unwrap_or(telemetry_sink_configured))
}

fn training_status(override_value: Option<TrainingOverride>) -> Value {
    let flag = env::var("MAESTRO_TRAINING_OPT_OUT").ok();
    let opt_out = override_value
        .map(TrainingOverride::is_opt_out)
        .or_else(|| parse_bool_flag(flag.as_deref()));
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
        "runtimeOverride": override_value.map(TrainingOverride::preference)
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

    let registry = available_models().await;
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

async fn record_chat_user_message(state: &AppState, chat: &ChatRequest) {
    let Some(session_id) = chat.session_id.as_deref() else {
        return;
    };
    let Some(latest) = chat.messages.last() else {
        return;
    };
    let mut message = serde_json::json!({
        "role": latest.role.clone(),
        "content": latest.content.clone(),
        "timestamp": now_rfc3339()
    });
    if !latest.attachments.is_empty() {
        message["attachments"] = serde_json::json!(latest.attachments);
    }
    append_session_message(state, session_id, message, Some(&latest.content)).await;
}

async fn record_chat_assistant_message(state: &AppState, session_id: Option<&str>, message: Value) {
    let Some(session_id) = session_id else {
        return;
    };
    append_session_message(state, session_id, message, None).await;
}

async fn append_session_message(
    state: &AppState,
    session_id: &str,
    message: Value,
    title_source: Option<&Value>,
) {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .sessions
        .entry(session_id.to_string())
        .or_insert_with(|| create_session_record(title_source.and_then(title_from_content)));
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

enum StaticPathResolution {
    Found(PathBuf),
    Missing,
    Forbidden,
}

async fn handle_chat_endpoint(
    mut stream: TcpStream,
    mut initial: Vec<u8>,
    head: RequestHead,
    state: AppState,
) -> Result<(), String> {
    if let Err(response) = authorize(&head, &state.config) {
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

    let prompt = build_prompt_from_chat(&chat);
    if prompt.trim().is_empty() {
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

    record_chat_user_message(&state, &chat).await;
    let session_id = chat.session_id.clone();
    let prepared_attachments = match prepare_chat_attachments(&chat).await {
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

    stream
        .write_all(sse_headers().as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    let model = selected_chat_model(&chat, &state).await;
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
                if requires_approval {
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
                let message = composer_assistant_message(&assistant_text, &thinking_text, usage);
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
    if let Err(response) = authorize(&head, &state.config) {
        stream
            .write_all(&response)
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

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

    let prompt = build_prompt_from_chat(&chat);
    if prompt.trim().is_empty() {
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

    record_chat_user_message(&state, &chat).await;
    let session_id = chat.session_id.clone();
    let prepared_attachments = match prepare_chat_attachments(&chat).await {
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

    let model = selected_chat_model(&chat, &state).await;
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
                if requires_approval {
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
                let message = composer_assistant_message(&assistant_text, &thinking_text, usage);
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

async fn prepare_chat_attachments(chat: &ChatRequest) -> Result<PreparedAttachments, String> {
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
            let dir = chat_attachment_temp_dir();
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

fn chat_attachment_temp_dir() -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let counter = ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    env::temp_dir().join(format!("maestro-chat-{}-{now}-{counter}", process::id()))
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
        parts.push("Conversation so far:".to_string());
        for message in chat.messages.iter().take(chat.messages.len() - 1) {
            let content = composer_text_content(&message.content);
            if !content.trim().is_empty() {
                parts.push(format!("{}: {}", message.role, content.trim()));
            }
        }
        parts.push("Current user message:".to_string());
    }

    if let Some(latest) = chat.messages.last() {
        parts.push(composer_text_content(&latest.content));
        let attachment_notes: Vec<String> =
            latest.attachments.iter().map(attachment_note).collect();
        if !attachment_notes.is_empty() {
            parts.push(attachment_notes.join("\n\n"));
        }
    }

    parts.join("\n\n")
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
            "cost": usage.cost.map(|total| serde_json::json!({ "total": total }))
        });
    }
    message
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
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Credentials: true\r\n\r\n",
        cors_origin()
    )
}

fn authorize(head: &RequestHead, config: &Config) -> Result<(), Vec<u8>> {
    let Some(expected) = config.api_key.as_deref() else {
        if config.require_key {
            return Err(json_response(
                401,
                &serde_json::json!({
                    "error": "MAESTRO_WEB_API_KEY is required for API requests"
                }),
            ));
        }
        return Ok(());
    };

    let bearer = head
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);
    let header_key = head
        .headers
        .get("x-maestro-api-key")
        .or_else(|| head.headers.get("x-composer-api-key"))
        .map(String::as_str);

    if bearer == Some(expected) || header_key == Some(expected) {
        Ok(())
    } else {
        Err(json_response(
            401,
            &serde_json::json!({ "error": "Unauthorized" }),
        ))
    }
}

async fn build_status_snapshot(state: &AppState) -> StatusSnapshot {
    let started = Instant::now();
    let cwd = state.config.cwd.clone();
    let git = git_snapshot(&cwd).await;
    let context = ContextSnapshot {
        agent_md: async_path_exists(cwd.join("AGENT.md")).await
            || async_path_exists(cwd.join("AGENTS.md")).await,
        claude_md: async_path_exists(cwd.join("CLAUDE.md")).await,
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
    let mut status = GitStatus::default();
    for line in status_output.lines().filter(|line| !line.is_empty()) {
        status.total += 1;
        let code = line.get(..2).unwrap_or("");
        if code == "??" {
            status.untracked += 1;
            continue;
        }

        let mut chars = code.chars();
        let index_status = chars.next().unwrap_or(' ');
        let worktree_status = chars.next().unwrap_or(' ');
        if index_status == 'D' || worktree_status == 'D' {
            status.deleted += 1;
        } else if matches!(index_status, 'A' | 'R' | 'C') {
            status.added += 1;
        } else {
            status.modified += 1;
        }
    }
    status
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

fn is_static_asset_request(head: &RequestHead) -> bool {
    matches!(head.method.as_str(), "GET" | "HEAD") && !head.path.starts_with("/api/")
}

async fn static_response(head: &RequestHead, config: &Config) -> Vec<u8> {
    let Some(path) = resolve_static_path(&config.static_root, &head.path) else {
        return json_response(403, &serde_json::json!({ "error": "Forbidden" }));
    };

    match canonical_static_path(&config.static_root, &path).await {
        StaticPathResolution::Found(path) => match tokio::fs::read(&path).await {
            Ok(bytes) => {
                if is_spa_entry_path(&path) && head.method == "HEAD" {
                    response_with_no_store_and_length(200, mime_for_path(&path), &[], bytes.len())
                } else if is_spa_entry_path(&path) {
                    response_with_no_store(200, mime_for_path(&path), &bytes)
                } else if head.method == "HEAD" {
                    response_with_cache_and_length(
                        200,
                        mime_for_path(&path),
                        &[],
                        config.static_cache_max_age,
                        bytes.len(),
                    )
                } else {
                    response_with_cache(
                        200,
                        mime_for_path(&path),
                        &bytes,
                        config.static_cache_max_age,
                    )
                }
            }
            Err(_) => json_response(
                404,
                &serde_json::json!({
                    "error": "Not found",
                    "staticRoot": config.static_root
                }),
            ),
        },
        StaticPathResolution::Forbidden => {
            json_response(403, &serde_json::json!({ "error": "Forbidden" }))
        }
        StaticPathResolution::Missing => {
            if !should_spa_fallback(head) {
                return json_response(
                    404,
                    &serde_json::json!({
                        "error": "Not found",
                        "staticRoot": config.static_root
                    }),
                );
            }
            let index = config.static_root.join("index.html");
            match canonical_static_path(&config.static_root, &index).await {
                StaticPathResolution::Found(index) => match tokio::fs::read(&index).await {
                    Ok(bytes) => {
                        if head.method == "HEAD" {
                            response_with_no_store_and_length(
                                200,
                                "text/html; charset=utf-8",
                                &[],
                                bytes.len(),
                            )
                        } else {
                            response_with_no_store(200, "text/html; charset=utf-8", &bytes)
                        }
                    }
                    Err(_) => json_response(
                        404,
                        &serde_json::json!({
                            "error": "Not found",
                            "staticRoot": config.static_root
                        }),
                    ),
                },
                StaticPathResolution::Forbidden => {
                    json_response(403, &serde_json::json!({ "error": "Forbidden" }))
                }
                StaticPathResolution::Missing => json_response(
                    404,
                    &serde_json::json!({
                        "error": "Not found",
                        "staticRoot": config.static_root
                    }),
                ),
            }
        }
    }
}

fn should_spa_fallback(head: &RequestHead) -> bool {
    let trimmed = head.path.trim_end_matches('/');
    let last_segment = trimmed.rsplit('/').next().unwrap_or_default();
    !last_segment.contains('.')
}

async fn canonical_static_path(root: &Path, path: &Path) -> StaticPathResolution {
    let Ok(canonical_root) = tokio::fs::canonicalize(root).await else {
        return StaticPathResolution::Missing;
    };
    match tokio::fs::canonicalize(path).await {
        Ok(canonical_path) if canonical_path.starts_with(&canonical_root) => {
            StaticPathResolution::Found(canonical_path)
        }
        Ok(_) => StaticPathResolution::Forbidden,
        Err(_) => StaticPathResolution::Missing,
    }
}

fn resolve_static_path(root: &Path, request_path: &str) -> Option<PathBuf> {
    let trimmed = request_path.trim_start_matches('/');
    if trimmed
        .split('/')
        .any(|segment| segment == ".." || segment.contains('\\'))
    {
        return None;
    }
    if trimmed.is_empty() {
        Some(root.join("index.html"))
    } else {
        Some(root.join(trimmed))
    }
}

fn is_spa_entry_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("index.html"))
}

fn mime_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

async fn read_request_head(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
) -> Result<RequestHead, String> {
    let mut chunk = [0_u8; 4096];
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed before request headers".into());
        }
        initial.extend_from_slice(&chunk[..read]);
        if initial.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if initial.len() > MAX_HEADER_BYTES {
            return Err("request headers exceeded limit".into());
        }
    }
    parse_request_head(initial)
}

async fn read_request_body(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: &RequestHead,
) -> Result<Vec<u8>, String> {
    let header_end = header_end(initial)?;
    let body_start = header_end + 4;
    let content_length = head
        .headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| "content-length is required".to_string())?;
    if content_length > MAX_JSON_BODY_BYTES {
        return Err(format!(
            "request body exceeded limit: {content_length} > {MAX_JSON_BODY_BYTES}"
        ));
    }

    while initial.len().saturating_sub(body_start) < content_length {
        let mut chunk = [0_u8; 8192];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed before request body completed".into());
        }
        initial.extend_from_slice(&chunk[..read]);
        if initial.len().saturating_sub(body_start) > MAX_JSON_BODY_BYTES {
            return Err("request body exceeded limit".into());
        }
    }

    Ok(initial[body_start..body_start + content_length].to_vec())
}

fn parse_request_head(initial: &[u8]) -> Result<RequestHead, String> {
    let header_end = header_end(initial)?;
    let header_text = std::str::from_utf8(&initial[..header_end])
        .map_err(|error| format!("request headers are not utf-8: {error}"))?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "request line missing".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "request method missing".to_string())?
        .to_uppercase();
    let raw_target = parts
        .next()
        .ok_or_else(|| "request target missing".to_string())?;
    let (path, query) = raw_target
        .split_once('?')
        .map(|(path, query)| (path.to_string(), parse_query(query)))
        .unwrap_or_else(|| (raw_target.to_string(), HashMap::new()));
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_lowercase(), value.trim().to_string()))
        .collect();
    Ok(RequestHead {
        method,
        path,
        query,
        headers,
    })
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .filter_map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            if key.is_empty() {
                None
            } else {
                Some((key.to_string(), value.replace('+', " ")))
            }
        })
        .collect()
}

fn header_end(initial: &[u8]) -> Result<usize, String> {
    initial
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "request header terminator not found".to_string())
}

fn text_response(status: u16, body: &str) -> Vec<u8> {
    response(status, "text/plain; charset=utf-8", body.as_bytes())
}

fn json_response<T: Serialize>(status: u16, value: &T) -> Vec<u8> {
    let body = serde_json::to_vec(value)
        .unwrap_or_else(|_| br#"{"error":"failed to serialize response"}"#.to_vec());
    response(status, "application/json", &body)
}

fn response(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
    response_with_extra_headers(status, content_type, body, "")
}

fn response_with_cache(
    status: u16,
    content_type: &str,
    body: &[u8],
    cache_seconds: u64,
) -> Vec<u8> {
    response_with_extra_headers_and_length(
        status,
        content_type,
        body,
        &format!("Cache-Control: public, max-age={cache_seconds}\r\n"),
        body.len(),
    )
}

fn response_with_cache_and_length(
    status: u16,
    content_type: &str,
    body: &[u8],
    cache_seconds: u64,
    content_length: usize,
) -> Vec<u8> {
    response_with_extra_headers_and_length(
        status,
        content_type,
        body,
        &format!("Cache-Control: public, max-age={cache_seconds}\r\n"),
        content_length,
    )
}

fn response_with_no_store(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
    response_with_no_store_and_length(status, content_type, body, body.len())
}

fn response_with_no_store_and_length(
    status: u16,
    content_type: &str,
    body: &[u8],
    content_length: usize,
) -> Vec<u8> {
    response_with_extra_headers_and_length(
        status,
        content_type,
        body,
        "Cache-Control: no-store, no-cache, must-revalidate\r\n",
        content_length,
    )
}

fn response_with_extra_headers(
    status: u16,
    content_type: &str,
    body: &[u8],
    extra_headers: &str,
) -> Vec<u8> {
    response_with_extra_headers_and_length(status, content_type, body, extra_headers, body.len())
}

fn response_with_extra_headers_and_length(
    status: u16,
    content_type: &str,
    body: &[u8],
    extra_headers: &str,
    content_length: usize,
) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        426 => "Upgrade Required",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        _ => "OK",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Credentials: true\r\nAccess-Control-Allow-Headers: {CORS_ALLOW_HEADERS}\r\nAccess-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS\r\n",
        content_length,
        cors_origin()
    );
    if !extra_headers.is_empty() {
        head.push_str(extra_headers);
        if !extra_headers.ends_with("\r\n") {
            head.push_str("\r\n");
        }
    }
    head.push_str("\r\n");
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn cors_origin() -> String {
    env::var("MAESTRO_WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:4173".into())
}

fn origin_allowed(head: &RequestHead) -> bool {
    let Some(origin) = head.headers.get("origin").map(|origin| origin.trim()) else {
        return true;
    };
    if origin.is_empty() || origin == cors_origin() {
        return true;
    }
    matches!(
        origin,
        "http://localhost:4173"
            | "http://localhost:3000"
            | "http://localhost:5173"
            | "http://127.0.0.1:4173"
            | "http://127.0.0.1:3000"
            | "http://127.0.0.1:5173"
            | "http://[::1]:4173"
            | "http://[::1]:3000"
            | "http://[::1]:5173"
    )
}

fn env_u16(name: &str, default: u16) -> u16 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn detects_local_control_plane_routes() {
        let request = b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let head = parse_request_head(request).expect("request should parse");

        assert!(is_local_endpoint(&head));
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
        ] {
            let head = parse_request_head(request.as_bytes()).expect("request should parse");
            assert!(is_local_endpoint(&head), "{request} should be local");
        }
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

        let rejected = parse_request_head(
            b"GET /api/chat/ws HTTP/1.1\r\nHost: localhost\r\nOrigin: https://evil.example\r\n\r\n",
        )
        .expect("request should parse");
        assert!(!origin_allowed(&rejected));
    }

    #[test]
    fn chat_body_limit_allows_base64_attachments() {
        assert!(MAX_JSON_BODY_BYTES >= 32 * 1024 * 1024);
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
    fn json_response_has_header_body_separator() {
        let response = json_response(200, &serde_json::json!({ "ok": true }));

        assert!(response.windows(4).any(|window| window == b"\r\n\r\n"));
        let response = String::from_utf8(response).expect("response should be utf-8");
        assert!(response.contains("x-composer-csrf"));
        assert!(response.contains("x-maestro-artifact-access"));
    }

    #[test]
    fn spa_entry_response_uses_no_store() {
        let response =
            response_with_no_store_and_length(200, "text/html; charset=utf-8", &[], "index".len());
        let response = String::from_utf8(response).expect("response should be utf-8");

        assert!(response.contains("Content-Length: 5\r\n"));
        assert!(response.contains("Cache-Control: no-store, no-cache, must-revalidate\r\n"));
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
    fn override_parsers_reject_unknown_actions_without_panicking() {
        assert!(TelemetryOverride::from_action("toggle").is_err());
        assert!(TrainingOverride::from_action("toggle").is_err());
    }

    #[test]
    fn training_on_maps_to_opted_in() {
        let status = training_status(Some(TrainingOverride::OptedIn));

        assert_eq!(
            status.get("preference").and_then(Value::as_str),
            Some("opted-in")
        );
        assert_eq!(status.get("optOut").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn telemetry_flag_uses_bool_parser_and_explicit_false_wins() {
        assert!(telemetry_enabled(None, Some("on"), false));
        assert!(telemetry_enabled(None, Some("True"), false));
        assert!(!telemetry_enabled(None, Some("false"), true));
        assert!(telemetry_enabled(
            Some(TelemetryOverride::Enabled),
            Some("false"),
            false
        ));
    }

    #[test]
    fn parses_git_status_for_index_worktree_and_rename_codes() {
        let status = parse_git_status(
            " M modified-in-worktree.rs\nM  staged-modified.rs\nMM staged-and-modified.rs\nA  added.rs\nAM added-and-modified.rs\n D deleted-in-worktree.rs\nD  staged-deleted.rs\nR  renamed.rs -> old-name.rs\nC  copied.rs -> old-copy.rs\nUU conflicted.rs\n?? untracked.rs\n",
        );

        assert_eq!(
            status,
            GitStatus {
                modified: 4,
                added: 4,
                deleted: 2,
                untracked: 1,
                total: 11,
            }
        );
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
            }],
        };

        let prompt = build_prompt_from_chat(&chat);

        assert!(prompt.contains("screen.png"));
        assert!(!prompt.trim().is_empty());
    }

    #[test]
    fn rejects_missing_request_target() {
        let request = b"GET\r\nHost: localhost\r\n\r\n";

        assert!(parse_request_head(request).is_err());
    }
}
