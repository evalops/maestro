//! Minimal A2A HTTP client for Agent Card discovery, message send, and task poll.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct A2AServiceConfig {
    pub base_url: String,
    pub token: Option<String>,
    pub organization_id: Option<String>,
    pub workspace_id: Option<String>,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub actor_id: Option<String>,
    pub timeout_ms: u64,
    pub max_attempts: u64,
}

#[derive(Debug, Clone)]
pub struct SendMessageInput {
    pub text: String,
    pub message_id: String,
    pub context_id: Option<String>,
    pub task_id: Option<String>,
    pub metadata: Option<Value>,
    pub return_immediately: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct A2ATask {
    pub id: String,
    #[serde(default)]
    pub context_id: Option<String>,
    pub status: A2ATaskStatus,
    #[serde(default)]
    pub artifacts: Option<Vec<A2AArtifact>>,
    #[serde(default)]
    pub history: Option<Vec<A2AMessage>>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct A2ATaskStatus {
    pub state: String,
    #[serde(default)]
    pub message: Option<A2AMessage>,
    #[serde(default)]
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct A2AMessage {
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub context_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub parts: Vec<A2APart>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct A2APart {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct A2AArtifact {
    #[serde(default)]
    pub artifact_id: Option<String>,
    #[serde(default)]
    pub parts: Vec<A2APart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResult {
    pub task: A2ATask,
}

pub async fn discover_agent_card(config: &A2AServiceConfig) -> Result<Value> {
    let url = format!(
        "{}/.well-known/agent-card.json",
        config.base_url.trim_end_matches('/')
    );
    request_json(config, reqwest::Method::GET, &url, None).await
}

pub async fn send_message(
    config: &A2AServiceConfig,
    input: SendMessageInput,
) -> Result<SendMessageResult> {
    let url = format!("{}/message:send", config.base_url.trim_end_matches('/'));
    let mut message = json!({
        "messageId": input.message_id,
        "role": "ROLE_USER",
        "parts": [{
            "text": input.text,
            "mediaType": "text/plain"
        }],
    });
    if let Some(context_id) = &input.context_id {
        message["contextId"] = json!(context_id);
    }
    if let Some(task_id) = &input.task_id {
        message["taskId"] = json!(task_id);
    }
    let mut metadata = serde_json::Map::new();
    if let Some(Value::Object(extra)) = input.metadata {
        metadata.extend(extra);
    } else if let Some(extra) = input.metadata {
        metadata.insert("extra".into(), extra);
    }
    if let Some(workspace_id) = &config.workspace_id {
        metadata.insert("workspaceId".into(), json!(workspace_id));
    }
    if let Some(agent_id) = &config.agent_id {
        metadata.insert("agentId".into(), json!(agent_id));
    }
    if let Some(session_id) = &config.session_id {
        metadata.insert("sessionId".into(), json!(session_id));
    }
    if let Some(actor_id) = &config.actor_id {
        metadata.insert("actorId".into(), json!(actor_id));
    }
    if !metadata.is_empty() {
        message["metadata"] = Value::Object(metadata);
    }
    let body = json!({
        "message": message,
        "configuration": {
            "returnImmediately": input.return_immediately
        }
    });
    let response = request_json(config, reqwest::Method::POST, &url, Some(body)).await?;
    parse_send_result(response)
}

pub async fn get_task(config: &A2AServiceConfig, task_id: &str) -> Result<A2ATask> {
    let trimmed = task_id.trim();
    if trimmed.is_empty() {
        bail!("A2A task id is required");
    }
    let url = format!(
        "{}/tasks/{}",
        config.base_url.trim_end_matches('/'),
        urlencoding::encode(trimmed)
    );
    let response = request_json(config, reqwest::Method::GET, &url, None).await?;
    parse_task(response)
}

pub async fn wait_for_task(
    config: &A2AServiceConfig,
    task_id: &str,
    max_wait_ms: u64,
    interval_ms: u64,
) -> Result<A2ATask> {
    let deadline = std::time::Instant::now() + Duration::from_millis(max_wait_ms);
    let mut last = get_task(config, task_id).await?;
    while !is_terminal_state(&last.status.state) && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(interval_ms.max(100))).await;
        last = get_task(config, task_id).await?;
    }
    if !is_terminal_state(&last.status.state) {
        bail!(
            "Timed out waiting for A2A task {}; last state {}",
            task_id,
            last.status.state
        );
    }
    Ok(last)
}

pub fn extract_task_text(task: &A2ATask) -> Option<String> {
    if let Some(message) = &task.status.message {
        if let Some(text) = first_message_text(message) {
            return Some(text);
        }
    }
    if let Some(artifacts) = &task.artifacts {
        for artifact in artifacts {
            for part in &artifact.parts {
                if let Some(text) = part
                    .text
                    .as_ref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                {
                    return Some(text.to_string());
                }
            }
        }
    }
    if let Some(history) = &task.history {
        for message in history.iter().rev() {
            let role = message.role.as_deref().unwrap_or("").to_ascii_lowercase();
            if role.contains("agent") {
                if let Some(text) = first_message_text(message) {
                    return Some(text);
                }
            }
        }
    }
    None
}

pub fn is_terminal_state(state: &str) -> bool {
    is_final_state(state) || is_action_required_state(state)
}

pub fn is_final_state(state: &str) -> bool {
    is_completed_state(state) || is_failed_state(state)
}

pub fn is_completed_state(state: &str) -> bool {
    matches_state(
        state,
        &["COMPLETED", "SUCCEEDED", "SUCCESS", "TASK_STATE_COMPLETED"],
    )
}

pub fn is_failed_state(state: &str) -> bool {
    matches_state(
        state,
        &[
            "FAILED",
            "CANCELED",
            "CANCELLED",
            "REJECTED",
            "TASK_STATE_FAILED",
            "TASK_STATE_CANCELED",
            "TASK_STATE_CANCELLED",
        ],
    )
}

pub fn is_action_required_state(state: &str) -> bool {
    matches_state(
        state,
        &[
            "INPUT_REQUIRED",
            "AUTH_REQUIRED",
            "TASK_STATE_INPUT_REQUIRED",
            "TASK_STATE_AUTH_REQUIRED",
        ],
    )
}

fn matches_state(state: &str, candidates: &[&str]) -> bool {
    let normalized = normalize_state(state);
    candidates.iter().any(|candidate| {
        let candidate = normalize_state(candidate);
        normalized == candidate
            || normalized.ends_with(&format!("_{candidate}"))
            || candidate.ends_with(&format!("_{normalized}"))
    })
}

fn normalize_state(state: &str) -> String {
    state.trim().to_ascii_uppercase().replace([' ', '-'], "_")
}

fn first_message_text(message: &A2AMessage) -> Option<String> {
    message
        .parts
        .iter()
        .filter_map(|part| part.text.as_ref())
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_send_result(response: Value) -> Result<SendMessageResult> {
    if let Ok(result) = serde_json::from_value::<SendMessageResult>(response.clone()) {
        return Ok(result);
    }
    if response.get("id").is_some() && response.get("status").is_some() {
        return Ok(SendMessageResult {
            task: parse_task(response)?,
        });
    }
    if let Some(task) = response.get("result").or_else(|| response.get("task")) {
        return Ok(SendMessageResult {
            task: parse_task(task.clone())?,
        });
    }
    bail!("A2A send response did not include a task");
}

fn parse_task(value: Value) -> Result<A2ATask> {
    serde_json::from_value(value).context("parse A2A task")
}

async fn request_json(
    config: &A2AServiceConfig,
    method: reqwest::Method,
    url: &str,
    body: Option<Value>,
) -> Result<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms.max(1_000)))
        .build()
        .context("build HTTP client")?;
    let headers = build_headers(config)?;
    let max_attempts = config.max_attempts.max(1);
    let mut last_error = None;
    for attempt in 1..=max_attempts {
        let mut request = client.request(method.clone(), url).headers(headers.clone());
        if let Some(body) = &body {
            request = request.json(body);
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                if status.is_success() {
                    if text.trim().is_empty() {
                        return Ok(json!({}));
                    }
                    return serde_json::from_str(&text)
                        .with_context(|| format!("decode A2A JSON response from {url}"));
                }
                let detail = parse_error_detail(&text);
                let error = anyhow::anyhow!(
                    "Platform A2A request failed with {status}{}{}",
                    if detail.is_empty() { "" } else { ": " },
                    detail
                );
                if status.is_server_error() && attempt < max_attempts {
                    last_error = Some(error);
                    tokio::time::sleep(Duration::from_millis(100 * attempt)).await;
                    continue;
                }
                return Err(error);
            }
            Err(error) => {
                last_error = Some(error.into());
                if attempt < max_attempts {
                    tokio::time::sleep(Duration::from_millis(100 * attempt)).await;
                    continue;
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("A2A request failed")))
}

fn parse_error_detail(text: &str) -> String {
    if let Ok(payload) = serde_json::from_str::<Value>(text) {
        if let Some(message) = payload
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .or_else(|| payload.pointer("/error/code").and_then(|v| v.as_str()))
            .or_else(|| payload.get("message").and_then(|v| v.as_str()))
        {
            return message.to_string();
        }
    }
    text.chars().take(240).collect()
}

fn build_headers(config: &A2AServiceConfig) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Some(token) = &config.token {
        let value = format!("Bearer {token}");
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&value).context("invalid Authorization header")?,
        );
    }
    insert_optional_header(
        &mut headers,
        "X-Organization-ID",
        config.organization_id.as_deref(),
    )?;
    insert_optional_header(
        &mut headers,
        "X-EvalOps-Workspace-Id",
        config.workspace_id.as_deref(),
    )?;
    insert_optional_header(
        &mut headers,
        "X-EvalOps-Agent-Id",
        config.agent_id.as_deref(),
    )?;
    insert_optional_header(
        &mut headers,
        "X-EvalOps-Session-Id",
        config.session_id.as_deref(),
    )?;
    insert_optional_header(
        &mut headers,
        "X-EvalOps-Actor-Id",
        config.actor_id.as_deref(),
    )?;
    Ok(headers)
}

fn insert_optional_header(headers: &mut HeaderMap, name: &str, value: Option<&str>) -> Result<()> {
    if let Some(value) = value.map(str::trim).filter(|s| !s.is_empty()) {
        headers.insert(
            HeaderName::from_bytes(name.as_bytes()).context("header name")?,
            HeaderValue::from_str(value).with_context(|| format!("invalid {name} header"))?,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
