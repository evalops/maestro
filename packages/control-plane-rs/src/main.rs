use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use maestro_tui::agent::{FromAgent, NativeAgent, NativeAgentConfig, TokenUsage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{self, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::Mutex;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_JSON_BODY_BYTES: usize = 2 * 1024 * 1024;
static ATTACHMENT_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
struct Config {
    listen_host: String,
    listen_port: u16,
    api_key: Option<String>,
    require_key: bool,
    cwd: PathBuf,
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
    telemetry_override: Arc<Mutex<Option<bool>>>,
    training_override: Arc<Mutex<Option<bool>>>,
    command_prefs: Arc<Mutex<CommandPrefs>>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    let config = Arc::new(Config::from_env());
    let listener = TcpListener::bind(config.listen_addr()).await?;
    eprintln!(
        "maestro rust server listening on http://{}",
        config.listen_addr()
    );

    let state = AppState {
        config,
        started_at: Instant::now(),
        selected_model: Arc::new(Mutex::new(default_model().await)),
        telemetry_override: Arc::new(Mutex::new(None)),
        training_override: Arc::new(Mutex::new(None)),
        command_prefs: Arc::new(Mutex::new(CommandPrefs {
            favorites: Vec::new(),
            recents: Vec::new(),
        })),
    };

    loop {
        let (stream, _) = listener.accept().await?;
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

fn is_local_endpoint(head: &RequestHead) -> bool {
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
        )
    )
}

async fn handle_local_endpoint(
    stream: &mut TcpStream,
    initial: &mut Vec<u8>,
    head: RequestHead,
    state: &AppState,
) -> Vec<u8> {
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
            *state.command_prefs.lock().await = prefs;
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
            json_response(200, &usage_snapshot())
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
        _ => json_response(404, &serde_json::json!({ "error": "Not found" })),
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
        .unwrap_or_else(|| registry.models[0].clone())
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

fn model_config_path() -> String {
    env::var("MAESTRO_MODELS_FILE").unwrap_or_else(|_| {
        maestro_home()
            .join("models.json")
            .to_string_lossy()
            .to_string()
    })
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

fn usage_snapshot() -> Value {
    let totals = serde_json::json!({
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
    });
    serde_json::json!({
        "summary": {
            "totalCost": 0,
            "totalRequests": 0,
            "totalTokens": 0,
            "tokensDetailed": totals,
            "totalTokensDetailed": totals,
            "totalTokensBreakdown": totals,
            "totalCachedTokens": 0,
            "byProvider": {},
            "byModel": {}
        },
        "hasData": false
    })
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

    let args = args.trim();
    let command = if args.is_empty() {
        format!("npm run {script}")
    } else {
        format!("npm run {script} -- {args}")
    };

    match Command::new("sh")
        .arg("-lc")
        .arg(&command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .await
    {
        Ok(output) => json_response(
            200,
            &serde_json::json!({
                "success": output.status.success(),
                "exitCode": output.status.code().unwrap_or(1),
                "stdout": String::from_utf8_lossy(&output.stdout),
                "stderr": String::from_utf8_lossy(&output.stderr),
                "command": command,
            }),
        ),
        Err(error) => json_response(
            500,
            &serde_json::json!({ "error": format!("failed to run script: {error}") }),
        ),
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
    let enabled = override_value.unwrap_or_else(|| {
        matches!(flag.as_deref(), Some("1" | "true" | "TRUE"))
            || endpoint.is_some()
            || env::var("MAESTRO_TELEMETRY_FILE").is_ok()
            || env::var("PLAYWRIGHT_TELEMETRY_FILE").is_ok()
    });
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    role: String,
    content: Value,
    #[serde(default)]
    attachments: Vec<ChatAttachment>,
}

#[derive(Debug, Deserialize)]
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

struct PreparedAttachments {
    paths: Vec<String>,
    temp_dir: Option<PathBuf>,
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

    let body = read_request_body(&mut stream, &mut initial, &head).await?;
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

    let model = chat
        .model
        .or_else(|| env::var("MAESTRO_DEFAULT_MODEL").ok())
        .unwrap_or_else(|| "claude-sonnet-4-5-20250514".to_string());
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

    if let Some(session_id) = chat.session_id.as_deref() {
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
                let message = composer_assistant_message(&assistant_text, &thinking_text, usage);
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

async fn cleanup_prepared_attachments(attachments: PreparedAttachments) {
    if let Some(temp_dir) = attachments.temp_dir {
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
            .filter_map(|block| {
                let object = block.as_object()?;
                if object.get("type")?.as_str()? == "text" {
                    object.get("text")?.as_str()
                } else {
                    None
                }
            })
            .collect::<String>(),
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

async fn send_sse(stream: &mut TcpStream, value: &Value) -> Result<(), String> {
    let body = serde_json::to_string(value).map_err(|error| error.to_string())?;
    stream
        .write_all(format!("data: {body}\n\n").as_bytes())
        .await
        .map_err(|error| error.to_string())
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
    let lines: Vec<&str> = status_output
        .lines()
        .filter(|line| !line.is_empty())
        .collect();
    let status = GitStatus {
        modified: lines.iter().filter(|line| line.starts_with(" M")).count(),
        added: lines.iter().filter(|line| line.starts_with("A ")).count(),
        deleted: lines.iter().filter(|line| line.starts_with(" D")).count(),
        untracked: lines.iter().filter(|line| line.starts_with("??")).count(),
        total: lines.len(),
    };
    Some(GitSnapshot { branch, status })
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
    OnboardingSnapshot {
        should_show: !completed
            && steps
                .iter()
                .any(|step| step.is_enabled && !step.is_complete),
        completed,
        seen_count: 0,
        steps,
    }
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
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        _ => "OK",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Credentials: true\r\nAccess-Control-Allow-Headers: authorization,content-type,x-composer-api-key,x-maestro-api-key,x-composer-client,x-maestro-client,x-composer-client-tools,x-maestro-client-tools,x-composer-slim-events,x-maestro-slim-events\r\nAccess-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS\r\n",
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
            "/api/telemetry",
            "/api/training",
        ] {
            let request = format!("GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n");
            let head = parse_request_head(request.as_bytes()).expect("request should parse");
            assert!(is_local_endpoint(&head), "{target} should be local");
        }
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
