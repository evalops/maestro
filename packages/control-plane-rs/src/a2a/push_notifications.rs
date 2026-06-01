use serde_json::{Map, Value};
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;
use tokio::net::TcpStream;

use crate::auth::AuthContext;
use crate::http::{
    json_response, percent_decode_component, read_request_body, response_with_extra_headers,
    RequestHead,
};
use crate::{env_u64, now_rfc3339, trimmed_env, truthy_env, AppState};

use super::ledger::persist_a2a_tasks;
use super::tasks::{
    a2a_agent_message, a2a_artifact_update_event, a2a_error_response, a2a_status_update_event,
    a2a_task_is_terminal, a2a_task_visible_to_auth, generate_a2a_id, publish_a2a_task_update,
    A2ASendMessageRequest, A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY,
};

const A2A_PUSH_NOTIFICATION_CONFIG_LIMIT: usize = 16;
const A2A_DEFAULT_PUSH_TIMEOUT_MS: u64 = 10_000;
const PLATFORM_A2A_PUSH_PATH: &str = "/api/platform/a2a/push";

pub(crate) fn is_platform_a2a_push_endpoint(head: &RequestHead) -> bool {
    head.path == PLATFORM_A2A_PUSH_PATH
}

pub(super) fn a2a_push_notification_config_path(path: &str) -> Option<(String, Option<String>)> {
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

pub(super) fn a2a_redact_push_notification_metadata(task: &mut Value) {
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

pub(super) fn dispatch_a2a_push_notifications(task: &Value) {
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

pub(super) async fn a2a_push_notification_config_from_send_request(
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

pub(super) fn a2a_metadata_key_is_reserved(key: &str) -> bool {
    key == A2A_PUSH_NOTIFICATION_CONFIG_METADATA_KEY
}

pub(super) fn a2a_metadata_with_push_notification_config(
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

pub(super) async fn handle_a2a_push_notification_config_list(
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

pub(super) async fn handle_a2a_push_notification_config_get(
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

pub(super) async fn handle_a2a_push_notification_config_create(
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

pub(super) async fn handle_a2a_push_notification_config_delete(
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
