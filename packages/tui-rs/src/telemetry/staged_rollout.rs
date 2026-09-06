use std::fs::{self, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use fd_lock::RwLock as FileLock;
use rand::Rng as _;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::telemetry::{
    AbortReason, ApprovalMode, CanonicalTurnEvent, ExternalTurnEvent, SampleReason, SandboxMode,
    TelemetryIdentityScope, TurnStatus,
};

const FIRST_PARTY_TELEMETRY_ENDPOINT: &str = "https://app.evalops.dev/v1/maestro/telemetry";
const OUTBOX_CAPACITY: usize = 256;
const OUTBOX_DEAD_LETTER_CAPACITY: usize = 64;
const OUTBOX_DRAIN_MAX_EVENTS: usize = 32;
const OUTBOX_MAX_EVENT_BYTES: usize = 16 * 1024;
const REMOTE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_BYTES: u64 = 1 << 30;
const MAX_COUNT: u32 = 1_000_000;
const MAX_TOKEN_COUNT: u64 = 100_000_000;
const MAX_COST_USD: f64 = 1_000_000.0;

static OUTBOX_DRAIN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

fn env_value(primary: &str, fallback: &str) -> Option<String> {
    std::env::var(primary)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var(fallback)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
}

fn true_flag(name: &str) -> bool {
    std::env::var(name).ok().is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn telemetry_flag() -> Option<bool> {
    env_value("MAESTRO_TELEMETRY", "PLAYWRIGHT_TELEMETRY").and_then(|value| {
        match value.trim().to_ascii_lowercase().as_str() {
            "0" | "false" => Some(false),
            "1" | "true" => Some(true),
            _ => None,
        }
    })
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn telemetry_file() -> Option<PathBuf> {
    env_value("MAESTRO_TELEMETRY_FILE", "PLAYWRIGHT_TELEMETRY_FILE")
        .map(|path| expand_home(path.trim()))
}

fn default_telemetry_file() -> PathBuf {
    std::env::var("MAESTRO_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|path| expand_home(path.trim()))
        .or_else(|| dirs::home_dir().map(|home| home.join(".maestro")))
        .unwrap_or_else(|| PathBuf::from(".maestro"))
        .join("telemetry.log")
}

fn first_party_outbox_dir() -> PathBuf {
    crate::path_utils::maestro_home_dir()
        .unwrap_or_else(|| PathBuf::from(".maestro"))
        .join("telemetry")
        .join("outbox")
}

fn sample_rate() -> f64 {
    env_value("MAESTRO_TELEMETRY_SAMPLE", "PLAYWRIGHT_TELEMETRY_SAMPLE")
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| value.clamp(0.0, 1.0))
        .unwrap_or(1.0)
}

fn staged_rollout_event(
    event: &str,
    surface_id: &str,
    surface_type: &str,
    owner: Option<&str>,
    source: &str,
) -> Value {
    let mut metadata = serde_json::Map::new();
    if let Some(owner) = owner {
        metadata.insert("owner".into(), json!(owner));
    }
    metadata.insert("source".into(), json!(source));
    json!({
        "type": "staged-rollout-surface",
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "event": event,
        "surfaceId": surface_id,
        "surfaceType": surface_type,
        "metadata": metadata,
    })
}

/// Best-effort staged-rollout telemetry for native CLI surfaces.
pub async fn record_staged_rollout_surface_usage(
    event: &str,
    surface_id: &str,
    surface_type: &str,
    owner: Option<&str>,
    source: &str,
) {
    if true_flag("MAESTRO_INTERNAL_TELEMETRY_DISABLED")
        || true_flag("EVALOPS_INTERNAL_TELEMETRY_DISABLED")
        || telemetry_flag() == Some(false)
    {
        return;
    }

    let file = telemetry_file();
    let endpoint = env_value(
        "MAESTRO_TELEMETRY_ENDPOINT",
        "PLAYWRIGHT_TELEMETRY_ENDPOINT",
    );

    let rate = sample_rate();
    if rate == 0.0 || (rate < 1.0 && rand::rng().random::<f64>() > rate) {
        return;
    }

    let payload = staged_rollout_event(event, surface_id, surface_type, owner, source);
    let encoded = payload.to_string();

    if let Some(endpoint) = endpoint.as_deref() {
        // Best-effort telemetry must never hang the CLI on a dead host.
        let client = reqwest::Client::builder().timeout(REMOTE_TIMEOUT).build();
        if let Ok(client) = client {
            let _ = client
                .post(endpoint)
                .header("content-type", "application/json")
                .body(encoded.clone())
                .send()
                .await;
        }
    }

    append_local_telemetry(file.unwrap_or_else(default_telemetry_file), &encoded);
}

fn append_local_telemetry(path: PathBuf, encoded: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut output) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(output, "{encoded}");
    }
}

/// Closed first-party envelope accepted by `/v1/maestro/telemetry`.
///
/// This is intentionally distinct from [`ExternalTurnEvent`]: the latter is
/// the backwards-compatible custom exporter format, while this type has a
/// UUID idempotency key, a finite provider/error taxonomy, and no tenant or
/// content-bearing fields.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FirstPartyTurnTelemetryEvent {
    schema_version: u16,
    event_id: Uuid,
    #[serde(rename = "type")]
    event_type: FirstPartyEventType,
    timestamp: String,
    turn_number: u32,
    model_provider: FirstPartyModelProvider,
    total_duration_ms: u64,
    llm_duration_ms: u64,
    tool_duration_ms: u64,
    queue_wait_ms: Option<u64>,
    tool_count: u32,
    tool_success_count: u32,
    tool_failure_count: u32,
    tokens: FirstPartyTokenUsage,
    cost_usd: f64,
    sandbox_mode: SandboxMode,
    approval_mode: ApprovalMode,
    mcp_server_count: u32,
    context_source_count: u32,
    message_count: u32,
    input_size_bytes: u64,
    output_size_bytes: u64,
    status: TurnStatus,
    error_category: Option<FirstPartyErrorCategory>,
    abort_reason: Option<AbortReason>,
    sampled: bool,
    sample_reason: SampleReason,
}

/// Private, durable delivery envelope. The event remains the exact closed
/// Platform contract; `identity_scope` is never serialized into an HTTP body.
/// It binds a retry to the organization/workspace that admitted the native
/// turn, preventing a later account switch from re-attributing the record.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FirstPartyOutboxRecord {
    identity_scope: TelemetryIdentityScope,
    event: FirstPartyTurnTelemetryEvent,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FirstPartyTokenUsage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
enum FirstPartyEventType {
    #[serde(rename = "canonical-turn")]
    CanonicalTurn,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum FirstPartyModelProvider {
    Anthropic,
    #[serde(rename = "azure-openai")]
    AzureOpenai,
    Bedrock,
    Google,
    Llamacpp,
    Ollama,
    Openai,
    Openrouter,
    Other,
    Unknown,
    #[serde(rename = "vertex-ai")]
    VertexAi,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum FirstPartyErrorCategory {
    Interrupted,
    Provider,
    Runtime,
    Other,
}

impl FirstPartyTurnTelemetryEvent {
    fn is_server_valid(&self) -> bool {
        self.schema_version == 1
            && chrono::DateTime::parse_from_rfc3339(&self.timestamp).is_ok()
            && self.turn_number <= MAX_COUNT
            && self.tool_count <= MAX_COUNT
            && self.tool_success_count <= MAX_COUNT
            && self.tool_failure_count <= MAX_COUNT
            && self.mcp_server_count <= MAX_COUNT
            && self.context_source_count <= MAX_COUNT
            && self.message_count <= MAX_COUNT
            && self
                .tool_success_count
                .saturating_add(self.tool_failure_count)
                == self.tool_count
            && self.total_duration_ms <= MAX_DURATION_MS
            && self.llm_duration_ms <= MAX_DURATION_MS
            && self.tool_duration_ms <= MAX_DURATION_MS
            && self
                .queue_wait_ms
                .is_none_or(|value| value <= MAX_DURATION_MS)
            && self.input_size_bytes <= MAX_BYTES
            && self.output_size_bytes <= MAX_BYTES
            && self.tokens.input <= MAX_TOKEN_COUNT
            && self.tokens.output <= MAX_TOKEN_COUNT
            && self.tokens.cache_read <= MAX_TOKEN_COUNT
            && self.tokens.cache_write <= MAX_TOKEN_COUNT
            && self
                .tokens
                .thinking
                .is_none_or(|value| value <= MAX_TOKEN_COUNT)
            && self.cost_usd.is_finite()
            && (0.0..=MAX_COST_USD).contains(&self.cost_usd)
            && self.sampled
            && matches!(
                (self.status, self.abort_reason),
                (TurnStatus::Aborted, Some(_))
                    | (
                        TurnStatus::Success | TurnStatus::Error | TurnStatus::RateLimited,
                        None
                    )
            )
    }
}

fn first_party_event(external: &ExternalTurnEvent) -> Option<FirstPartyTurnTelemetryEvent> {
    let abort_reason = match (external.status, external.abort_reason) {
        (TurnStatus::Aborted, Some(reason)) => Some(reason),
        (TurnStatus::Aborted, None) | (_, Some(_)) => return None,
        _ => None,
    };
    let tool_count = external.tool_count.min(MAX_COUNT);
    let tool_success_count = external.tool_success_count.min(tool_count);
    let tool_failure_count = tool_count.saturating_sub(tool_success_count);
    let cost_usd = if external.cost_usd.is_finite() && external.cost_usd >= 0.0 {
        external.cost_usd.min(MAX_COST_USD)
    } else {
        0.0
    };
    let timestamp = chrono::DateTime::parse_from_rfc3339(&external.timestamp)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|_| {
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });

    Some(FirstPartyTurnTelemetryEvent {
        schema_version: 1,
        event_id: Uuid::new_v4(),
        event_type: FirstPartyEventType::CanonicalTurn,
        timestamp,
        turn_number: external.turn_number.min(MAX_COUNT),
        model_provider: first_party_model_provider(&external.model_provider),
        total_duration_ms: external.total_duration_ms.min(MAX_DURATION_MS),
        llm_duration_ms: external.llm_duration_ms.min(MAX_DURATION_MS),
        tool_duration_ms: external.tool_duration_ms.min(MAX_DURATION_MS),
        queue_wait_ms: external
            .queue_wait_ms
            .map(|value| value.min(MAX_DURATION_MS)),
        tool_count,
        tool_success_count,
        tool_failure_count,
        tokens: FirstPartyTokenUsage {
            input: external.tokens.input.min(MAX_TOKEN_COUNT),
            output: external.tokens.output.min(MAX_TOKEN_COUNT),
            cache_read: external.tokens.cache_read.min(MAX_TOKEN_COUNT),
            cache_write: external.tokens.cache_write.min(MAX_TOKEN_COUNT),
            thinking: external
                .tokens
                .thinking
                .map(|value| value.min(MAX_TOKEN_COUNT)),
        },
        cost_usd,
        sandbox_mode: external.sandbox_mode,
        approval_mode: external.approval_mode,
        mcp_server_count: external.mcp_server_count.min(MAX_COUNT),
        context_source_count: external.context_source_count.min(MAX_COUNT),
        message_count: external.message_count.min(MAX_COUNT),
        input_size_bytes: external.input_size_bytes.min(MAX_BYTES),
        output_size_bytes: external.output_size_bytes.min(MAX_BYTES),
        status: external.status,
        error_category: first_party_error_category(external.error_category.as_deref()),
        abort_reason,
        sampled: true,
        sample_reason: external.sample_reason,
    })
}

fn first_party_model_provider(provider: &str) -> FirstPartyModelProvider {
    let provider = provider.trim();
    if provider.is_empty() {
        FirstPartyModelProvider::Unknown
    } else if provider.eq_ignore_ascii_case("anthropic") {
        FirstPartyModelProvider::Anthropic
    } else if provider.eq_ignore_ascii_case("azure-openai")
        || provider.eq_ignore_ascii_case("azure_openai")
        || provider.eq_ignore_ascii_case("azure")
    {
        FirstPartyModelProvider::AzureOpenai
    } else if provider.eq_ignore_ascii_case("bedrock")
        || provider.eq_ignore_ascii_case("aws-bedrock")
    {
        FirstPartyModelProvider::Bedrock
    } else if provider.eq_ignore_ascii_case("google") || provider.eq_ignore_ascii_case("gemini") {
        FirstPartyModelProvider::Google
    } else if provider.eq_ignore_ascii_case("llamacpp")
        || provider.eq_ignore_ascii_case("llama.cpp")
        || provider.eq_ignore_ascii_case("llama-cpp")
    {
        FirstPartyModelProvider::Llamacpp
    } else if provider.eq_ignore_ascii_case("ollama") {
        FirstPartyModelProvider::Ollama
    } else if provider.eq_ignore_ascii_case("openai") {
        FirstPartyModelProvider::Openai
    } else if provider.eq_ignore_ascii_case("openrouter") {
        FirstPartyModelProvider::Openrouter
    } else if provider.eq_ignore_ascii_case("vertex-ai")
        || provider.eq_ignore_ascii_case("vertex_ai")
    {
        FirstPartyModelProvider::VertexAi
    } else {
        FirstPartyModelProvider::Other
    }
}

fn first_party_error_category(category: Option<&str>) -> Option<FirstPartyErrorCategory> {
    let category = category?.trim();
    if category.is_empty() {
        None
    } else if ["interrupted", "cancelled", "canceled", "user_cancelled"]
        .iter()
        .any(|allowed| category.eq_ignore_ascii_case(allowed))
    {
        Some(FirstPartyErrorCategory::Interrupted)
    } else if [
        "provider",
        "provider_stream",
        "provider_response",
        "authentication",
        "rate_limit",
    ]
    .iter()
    .any(|allowed| category.eq_ignore_ascii_case(allowed))
    {
        Some(FirstPartyErrorCategory::Provider)
    } else if ["runtime", "tool", "sandbox"]
        .iter()
        .any(|allowed| category.eq_ignore_ascii_case(allowed))
    {
        Some(FirstPartyErrorCategory::Runtime)
    } else {
        Some(FirstPartyErrorCategory::Other)
    }
}

fn outbox_paths(outbox_dir: &Path) -> Vec<PathBuf> {
    let mut paths = fs::read_dir(outbox_dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file() || !is_outbox_file_name(&entry.file_name()) {
                return None;
            }
            Some(entry.path())
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn dead_letter_dir(outbox_dir: &Path) -> PathBuf {
    outbox_dir.join("dead-letter")
}

fn ensure_private_directory(path: &Path) -> Option<()> {
    fs::create_dir_all(path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).ok()?;
    }
    Some(())
}

/// Serialize the short list/write/trim transaction across Maestro processes.
/// The network drain intentionally happens outside this lease.
fn with_outbox_lock<T>(outbox_dir: &Path, operation: impl FnOnce() -> Option<T>) -> Option<T> {
    ensure_private_directory(outbox_dir)?;
    let lock_path = outbox_dir.join(".lock");
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        file.set_permissions(fs::Permissions::from_mode(0o600))
            .ok()?;
    }
    let mut lock = FileLock::new(file);
    let guard = lock.write().ok()?;
    let result = operation();
    drop(guard);
    result
}

fn is_outbox_file_name(file_name: &std::ffi::OsStr) -> bool {
    let Some(file_name) = file_name.to_str() else {
        return false;
    };
    let Some(stem) = file_name.strip_suffix(".json") else {
        return false;
    };
    let Some((timestamp, event_id)) = stem.split_once('_') else {
        return false;
    };
    timestamp.parse::<i64>().is_ok() && Uuid::parse_str(event_id).is_ok()
}

fn trim_outbox_paths_to_capacity(
    paths: Vec<PathBuf>,
    capacity: usize,
    preserve: Option<&Path>,
) -> Option<()> {
    let excess = paths.len().saturating_sub(capacity);
    for path in paths
        .into_iter()
        .filter(|path| preserve != Some(path.as_path()))
        .take(excess)
    {
        fs::remove_file(path).ok()?;
    }
    Some(())
}

fn persist_first_party_event(
    outbox_dir: &Path,
    identity_scope: &TelemetryIdentityScope,
    event: &FirstPartyTurnTelemetryEvent,
) -> Option<PathBuf> {
    persist_first_party_event_with_writer(
        outbox_dir,
        identity_scope,
        event,
        crate::path_utils::atomic_private_write,
    )
}

fn persist_first_party_event_with_writer<F>(
    outbox_dir: &Path,
    identity_scope: &TelemetryIdentityScope,
    event: &FirstPartyTurnTelemetryEvent,
    writer: F,
) -> Option<PathBuf>
where
    F: FnOnce(&Path, &[u8]) -> anyhow::Result<()>,
{
    if !identity_scope.is_complete() || !event.is_server_valid() {
        return None;
    }
    let encoded = serde_json::to_vec(&FirstPartyOutboxRecord {
        identity_scope: identity_scope.clone(),
        event: event.clone(),
    })
    .ok()?;
    if encoded.len() > OUTBOX_MAX_EVENT_BYTES {
        return None;
    }

    with_outbox_lock(outbox_dir, || {
        let path = outbox_dir.join(format!(
            "{:020}_{}.json",
            chrono::Utc::now().timestamp_micros(),
            event.event_id
        ));
        // Write first. If the filesystem cannot admit the new record, retain
        // every existing durable event instead of evicting one for nothing.
        writer(&path, &encoded).ok()?;
        trim_outbox_paths_to_capacity(outbox_paths(outbox_dir), OUTBOX_CAPACITY, Some(&path))?;
        Some(path)
    })
}

fn read_bounded_outbox_record(path: &Path) -> Option<FirstPartyOutboxRecord> {
    let file = fs::File::open(path).ok()?;
    let mut reader = file.take((OUTBOX_MAX_EVENT_BYTES + 1) as u64);
    let mut encoded = Vec::new();
    reader.read_to_end(&mut encoded).ok()?;
    if encoded.len() > OUTBOX_MAX_EVENT_BYTES {
        return None;
    }
    let record = serde_json::from_slice::<FirstPartyOutboxRecord>(&encoded).ok()?;
    (record.identity_scope.is_complete() && record.event.is_server_valid()).then_some(record)
}

struct FirstPartyDeliverySession {
    access_token: String,
    identity_scope: TelemetryIdentityScope,
}

fn drain_first_party_outbox(outbox_dir: &Path, identity: &FirstPartyDeliverySession) {
    drain_first_party_outbox_to_endpoint(outbox_dir, identity, FIRST_PARTY_TELEMETRY_ENDPOINT);
}

fn is_permanent_client_rejection(status: StatusCode) -> bool {
    status.is_client_error()
        && !matches!(
            status,
            StatusCode::UNAUTHORIZED
                | StatusCode::FORBIDDEN
                | StatusCode::REQUEST_TIMEOUT
                | StatusCode::CONFLICT
                | StatusCode::TOO_MANY_REQUESTS
        )
}

fn move_to_dead_letter(outbox_dir: &Path, path: &Path) -> bool {
    with_outbox_lock(outbox_dir, || {
        let dead_letters = dead_letter_dir(outbox_dir);
        ensure_private_directory(&dead_letters)?;
        let destination = dead_letters.join(path.file_name()?);
        fs::rename(path, &destination).ok()?;
        trim_outbox_paths_to_capacity(
            outbox_paths(&dead_letters),
            OUTBOX_DEAD_LETTER_CAPACITY,
            Some(&destination),
        )?;
        Some(())
    })
    .is_some()
}

fn drain_first_party_outbox_to_endpoint(
    outbox_dir: &Path,
    identity: &FirstPartyDeliverySession,
    endpoint: &str,
) {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(REMOTE_TIMEOUT)
        .build()
    else {
        return;
    };

    let mut attempted = 0;
    for path in outbox_paths(outbox_dir) {
        if attempted >= OUTBOX_DRAIN_MAX_EVENTS {
            break;
        }
        let Some(record) = read_bounded_outbox_record(&path) else {
            continue;
        };
        // An event may wait through an account or organization switch. Do not
        // let the current bearer reattribute it; retain it until its original
        // authorized scope returns.
        if record.identity_scope != identity.identity_scope {
            continue;
        }
        attempted += 1;
        let Ok(encoded) = serde_json::to_vec(&record.event) else {
            continue;
        };
        let response = client
            .post(endpoint)
            .bearer_auth(&identity.access_token)
            .header("content-type", "application/json")
            .body(encoded)
            .send();
        match response {
            Ok(response) if response.status().is_success() => {
                // A failed delete is harmless: the server idempotency key is
                // the UUID embedded in this same durable record, so a later
                // retry is a safe duplicate rather than a new event.
                let _ = fs::remove_file(path);
            }
            Ok(response) if is_permanent_client_rejection(response.status()) => {
                // A closed-schema rejection can never become valid through a
                // token refresh. Quarantine it and continue so it cannot
                // permanently poison later valid records in FIFO order.
                if !move_to_dead_letter(outbox_dir, &path) {
                    break;
                }
            }
            Ok(_) | Err(_) => {
                // Retain auth refresh, 429, and transient failures for a
                // later turn. Stop to avoid a busy client repeatedly hitting
                // a degraded first-party service.
                break;
            }
        }
    }
}

#[cfg(test)]
fn first_party_delivery_session() -> Option<FirstPartyDeliverySession> {
    // Unit tests must never discover a developer's stored Identity session
    // and issue an unexpected production request. Transport behavior is
    // tested through the injected loopback endpoint below instead.
    None
}

#[cfg(not(test))]
fn first_party_delivery_session() -> Option<FirstPartyDeliverySession> {
    let session = crate::credential_mode::current_verified_identity_session().ok()?;
    Some(FirstPartyDeliverySession {
        access_token: session.access_token,
        identity_scope: TelemetryIdentityScope::new(
            &session.organization_id,
            session.workspace_id.as_deref(),
        )?,
    })
}

fn schedule_first_party_outbox_drain() {
    if OUTBOX_DRAIN_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }

    let outbox_dir = first_party_outbox_dir();
    let worker = std::thread::Builder::new()
        .name("maestro-telemetry".to_owned())
        .spawn(move || {
            if let Some(identity) = first_party_delivery_session() {
                drain_first_party_outbox(&outbox_dir, &identity);
            }
            OUTBOX_DRAIN_IN_FLIGHT.store(false, Ordering::Release);
        });
    if worker.is_err() {
        OUTBOX_DRAIN_IN_FLIGHT.store(false, Ordering::Release);
    }
}

fn schedule_custom_export(endpoint: String, encoded: String) {
    // `MAESTRO_TELEMETRY_ENDPOINT` remains a user-configured, content-free
    // compatibility exporter. It never receives the Identity bearer used by
    // the fixed first-party telemetry route.
    let _ = std::thread::Builder::new()
        .name("maestro-telemetry-custom".to_owned())
        .spawn(move || {
            let Ok(client) = reqwest::blocking::Client::builder()
                .timeout(REMOTE_TIMEOUT)
                .build()
            else {
                return;
            };
            let _ = client
                .post(endpoint)
                .header("content-type", "application/json")
                .body(encoded)
                .send();
        });
}

/// Persist and export the content-free projection of a completed native turn.
///
/// Every sampled, non-opted-out turn keeps the existing local JSONL receipt,
/// then is queued privately for the fixed first-party endpoint. The Identity
/// bearer is loaded only by a background worker and is never written to the
/// outbox or sent to a configured custom exporter.
pub fn record_canonical_turn_event(event: &CanonicalTurnEvent) {
    if !event.sampled
        || true_flag("MAESTRO_INTERNAL_TELEMETRY_DISABLED")
        || true_flag("EVALOPS_INTERNAL_TELEMETRY_DISABLED")
        || telemetry_flag() == Some(false)
    {
        return;
    }

    let configured_file = telemetry_file();
    let configured_endpoint = env_value(
        "MAESTRO_TELEMETRY_ENDPOINT",
        "PLAYWRIGHT_TELEMETRY_ENDPOINT",
    );
    let external = event.external_projection();
    let Ok(encoded) = serde_json::to_string(&external) else {
        return;
    };

    // Keep the original local durable receipt even when a first-party or
    // custom endpoint is configured. `maestro value` consumes this log and
    // short-lived CLI processes retain their terminal turn at process exit.
    append_local_telemetry(
        configured_file.unwrap_or_else(default_telemetry_file),
        &encoded,
    );

    if let (Some(identity_scope), Some(first_party)) =
        (event.identity_scope.as_ref(), first_party_event(&external))
    {
        if persist_first_party_event(&first_party_outbox_dir(), identity_scope, &first_party)
            .is_some()
        {
            schedule_first_party_outbox_drain();
        }
    }

    if let Some(endpoint) = configured_endpoint {
        schedule_custom_export(endpoint, encoded);
    }
}

#[cfg(test)]
#[path = "staged_rollout_test.rs"]
mod tests;
