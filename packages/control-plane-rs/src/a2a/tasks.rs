use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::{broadcast, watch};

use crate::a2a_skill_catalog::A2A_SUBAGENT_REQUEST_METADATA_PATH;
use crate::auth::{a2a_task_id_from_cancel_path, a2a_task_id_from_subscribe_path, AuthContext};
use crate::http::{
    json_response, percent_decode_component, read_request_body, response,
    response_with_extra_headers, RequestHead,
};
use crate::{
    auth_context, env_u64, json_string_from_object, now_millis, now_rfc3339, send_sse, sse_headers,
    trimmed_env, truthy_env, validate_csrf, AppState, CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
};

use super::ledger::persist_a2a_tasks;
use super::{a2a_agent_card, a2a_extended_agent_card, run_a2a_native_turn, A2ATurnResult};

pub(crate) const A2A_PROTOCOL_VERSION: &str = "1.0";
pub(crate) const A2A_DEFAULT_TURN_TIMEOUT_MS: u64 = 180_000;
pub(crate) const A2A_DEFAULT_RESPONSE_END_SETTLE_MS: u64 = 250;
pub(crate) const A2A_TERMINAL_TASK_STORE_LIMIT: usize = 128;
pub(crate) const A2A_DEFAULT_LIST_PAGE_SIZE: usize = 50;
pub(crate) const A2A_MAX_LIST_PAGE_SIZE: usize = 100;
pub(crate) const A2A_DEFAULT_SUBSCRIBE_TIMEOUT_MS: u64 = 60_000;
pub(crate) const A2A_DEFAULT_SUBSCRIBE_HEARTBEAT_MS: u64 = 15_000;
const A2A_TASK_EVENT_REPLAY_LIMIT: usize = 256;
const A2A_PUSH_NOTIFICATION_CONFIG_LIMIT: usize = 16;
const A2A_DEFAULT_PUSH_TIMEOUT_MS: u64 = 10_000;
pub(crate) const A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY: &str = "pushNotificationConfigs";
pub(crate) const EVALOPS_A2A_EXTENSION_URI: &str =
    "https://evalops.com/a2a/extensions/operating-plane/v1";
pub(crate) const A2A_CONTROL_PLANE_LEDGER_PEER: &str = "maestro-control-plane";
pub(crate) const A2A_CONTROL_PLANE_LEDGER_DISPLAY_NAME: &str = "Maestro Control Plane";
const PLATFORM_A2A_PUSH_PATH: &str = "/api/platform/a2a/push";
static A2A_ID_FALLBACK_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) type A2ACancelSender = watch::Sender<bool>;
pub(crate) type A2ACancelReceiver = watch::Receiver<bool>;

#[derive(Clone, Debug)]
pub(crate) struct A2ATaskUpdateEvent {
    pub(crate) task_id: String,
    pub(crate) sequence: u64,
    pub(crate) task: Value,
}

#[derive(Debug, Default)]
pub(crate) struct A2ATaskEventHistory {
    pub(crate) next_sequence: u64,
    pub(crate) events: Vec<A2ATaskUpdateEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct A2APartBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) media_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct A2AMessageBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) context_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) role: Option<String>,
    #[serde(default)]
    pub(crate) parts: Vec<A2APartBody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) extensions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reference_task_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct A2ASendMessageRequest {
    pub(crate) message: A2AMessageBody,
    #[serde(default)]
    pub(crate) configuration: Option<Value>,
    #[serde(default)]
    pub(crate) metadata: Option<Value>,
}

#[derive(Debug)]
pub(crate) struct A2ASendTarget {
    pub(crate) task_id: String,
    pub(crate) context_id: String,
    pub(crate) history: Vec<Value>,
    pub(crate) previous_task: Option<Value>,
    pub(crate) metadata: Value,
}

pub(crate) fn is_a2a_endpoint(head: &RequestHead) -> bool {
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

pub(crate) fn is_a2a_streaming_endpoint(head: &RequestHead) -> bool {
    (head.method == "POST" && head.path == "/message:stream")
        || ((head.method == "GET" || head.method == "POST")
            && a2a_task_id_from_subscribe_path(&head.path).is_some())
}

pub(crate) fn is_platform_a2a_push_endpoint(head: &RequestHead) -> bool {
    head.path == PLATFORM_A2A_PUSH_PATH
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

pub(crate) async fn handle_a2a_endpoint(
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

pub(crate) async fn handle_a2a_streaming_endpoint(
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

pub(crate) async fn handle_platform_a2a_push_endpoint(
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

pub(crate) async fn record_platform_a2a_push_payload(
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

pub(crate) async fn apply_platform_a2a_status_update(
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

pub(crate) async fn apply_platform_a2a_artifact_update(
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

pub(crate) async fn cancel_a2a_task(
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

pub(crate) fn a2a_task_status_state(task: &Value) -> Option<&str> {
    task.get("status")
        .and_then(|status| status.get("state"))
        .and_then(Value::as_str)
}

pub(super) fn a2a_task_status_timestamp(task: &Value) -> Option<&str> {
    task.get("status")
        .and_then(|status| status.get("timestamp"))
        .and_then(Value::as_str)
}

pub(crate) fn a2a_task_is_terminal(task: &Value) -> bool {
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

pub(crate) fn a2a_task_visible_to_auth(task: &Value, auth: &AuthContext) -> bool {
    if auth.unrestricted {
        return true;
    }
    auth.subject
        .as_deref()
        .is_some_and(|subject| a2a_task_owner_subject(task) == Some(subject))
}

pub(crate) async fn publish_a2a_task_update(state: &AppState, task: &Value) {
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

pub(crate) fn a2a_push_notification_payloads(task: &Value) -> Vec<Value> {
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

pub(crate) fn a2a_push_authorization_header(authentication: &Map<String, Value>) -> Option<String> {
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

pub(crate) async fn claim_a2a_send_task(
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

pub(crate) fn normalize_a2a_push_notification_config(
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

pub(crate) fn normalize_a2a_push_notification_config_without_dns(
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

pub(crate) fn validate_a2a_push_notification_url(
    url: &str,
    resolve_dns: bool,
) -> Result<(), String> {
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

pub(crate) fn a2a_push_ip_is_private(addr: IpAddr) -> bool {
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

pub(crate) fn a2a_task_with_push_notification_config(
    task: &Value,
    config: Value,
) -> Result<Value, String> {
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

pub(crate) fn a2a_task_without_push_notification_config(
    task: &Value,
    config_id: &str,
) -> Option<Value> {
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

pub(crate) async fn store_a2a_task_unless_canceled(
    state: &AppState,
    task_id: &str,
    task: Value,
) -> Value {
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

pub(crate) fn prune_a2a_terminal_tasks(tasks: &mut HashMap<String, Value>) {
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

pub(crate) async fn register_a2a_cancel_sender(
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

pub(crate) async fn handle_a2a_message_send(
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

pub(crate) async fn complete_a2a_task(
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
    maybe_attach_a2a_subagent_work_graph(&mut metadata, &task_id, &context_id);
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

fn maybe_attach_a2a_subagent_work_graph(metadata: &mut Value, task_id: &str, context_id: &str) {
    let Some(metadata_object) = metadata.as_object_mut() else {
        return;
    };
    if metadata_object.get("workGraph").is_some() {
        return;
    }
    let Some(subagent_request) = metadata_object
        .get(A2A_SUBAGENT_REQUEST_METADATA_PATH)
        .and_then(Value::as_object)
    else {
        return;
    };
    let skill_id = json_string_from_object(subagent_request, &["skillId", "skill_id"]);
    let role = json_string_from_object(subagent_request, &["role"]);
    let swarm_id = json_string_from_object(subagent_request, &["swarmId", "swarm_id"]);
    let work_item_id = json_string_from_object(subagent_request, &["taskId", "task_id"])
        .unwrap_or_else(|| task_id.to_string());
    let child_run_id = format!("a2a-task:{task_id}");
    let tool_call_id = format!("a2a-subagent-dispatch:{task_id}");
    let correlation_path = if let Some(swarm_id) = swarm_id.as_deref() {
        format!("maestro-swarm/{swarm_id}/{work_item_id}/a2a/{task_id}")
    } else {
        format!("a2a/{context_id}/{task_id}")
    };

    metadata_object.insert(
        "workGraph".to_string(),
        serde_json::json!({
            "schemaVersion": CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
            "state": "completed",
            "itemCount": 1,
            "activeItemCount": 0,
            "blockedItemCount": 0,
            "waitingItemCount": 0,
            "childRunCount": 1,
            "childRunIds": [child_run_id],
            "toolCallCount": 1,
            "pendingToolCallCount": 0,
            "toolExecutionIds": [tool_call_id],
            "waitItemCount": 0,
            "waitIds": [],
            "stateCounts": { "completed": 1 },
            "correlationPath": correlation_path,
            "rawPayloadWithheld": true,
            "codexSubagents": {
                "edgeCount": 1,
                "toolCallIds": [tool_call_id],
                "childRunIds": [child_run_id],
                "threadIds": [],
                "edges": [{
                    "spawnToolCallId": tool_call_id,
                    "childRunId": child_run_id,
                    "operation": "a2a.subagent.dispatch",
                    "status": "completed",
                    "role": role,
                    "workItemState": "completed",
                    "completionGate": "terminal-task",
                    "workItemId": work_item_id,
                    "skillId": skill_id
                }]
            }
        }),
    );
}

pub(crate) fn a2a_message_text(message: &A2AMessageBody) -> Option<String> {
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

pub(crate) fn a2a_context_id(request: &A2ASendMessageRequest, head: &RequestHead) -> String {
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

pub(crate) fn a2a_user_message_value(message: &A2AMessageBody, context_id: &str) -> Value {
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

pub(crate) fn a2a_agent_message(context_id: &str, text: &str) -> Value {
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

pub(crate) fn a2a_task_value(
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

pub(crate) fn a2a_task_metadata(
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

pub(crate) fn a2a_return_immediately(
    request: &A2ASendMessageRequest,
) -> Result<bool, &'static str> {
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

pub(crate) fn generate_a2a_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::fill(&mut bytes).is_ok() {
        return format!("{prefix}-{}", URL_SAFE_NO_PAD.encode(bytes));
    }
    let counter = A2A_ID_FALLBACK_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{}-{counter}", now_millis(), process::id())
}

pub(crate) fn a2a_error_response(status: u16, code: &str, message: &str) -> Vec<u8> {
    json_response(
        status,
        &serde_json::json!({ "error": { "code": code, "message": message } }),
    )
}
