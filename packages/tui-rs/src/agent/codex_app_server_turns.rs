//! Codex app-server turn transport for `openai-codex/*` models.
//!
//! Routes turns through `CodexAppServerClient` (`thread/start`, `turn/start`)
//! so ChatGPT OAuth refresh stays owned by Codex. Dynamic tools and approval
//! server-requests are queued for the native agent to service.

use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::Duration;

use crate::codex_app_server::{
    agent_message_completed_text, agent_message_text_from_notifications,
    is_agent_message_notification, CodexAppServerClient, IncomingServerRequest, InitializeOptions,
    Notification, ServerRequestWaitError, ThreadStartParams, TurnStartParams,
};

/// Result of a single text turn over Codex app-server.
#[derive(Debug, Clone)]
pub struct CodexAppServerTurnResult {
    pub thread_id: String,
    pub turn_id: String,
    pub assistant_text: String,
    pub raw_completion: Value,
}

/// One dynamic tool exposed to Codex app-server.
#[derive(Debug, Clone)]
pub struct DynamicToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Session wrapper that owns one app-server process and one thread.
pub struct CodexAppServerTurnSession {
    client: CodexAppServerClient,
    thread_id: String,
    model: String,
}

impl CodexAppServerTurnSession {
    /// Spawn app-server, initialize, and start a thread for `model`.
    ///
    /// `instructions` is the Maestro system prompt / prompt context (when
    /// present). Passed as `developerInstructions` on `thread/start` so Codex
    /// receives the same standing instructions the HTTP path embeds.
    pub async fn connect(
        model: impl Into<String>,
        cwd: Option<String>,
        approval_policy: Option<String>,
        sandbox: Option<String>,
        dynamic_tools: &[DynamicToolSpec],
        instructions: Option<String>,
    ) -> Result<Self> {
        let model = model.into();
        let client = CodexAppServerClient::spawn(None, None, None)
            .await
            .context("spawn Codex app-server")?;
        client
            .initialize(InitializeOptions {
                experimental_api: true,
                ..Default::default()
            })
            .await
            .context("initialize Codex app-server")?;

        // Native agent will answer item/tool/call and approval RPCs.
        client.set_external_server_requests(true);

        let mut extra = Map::new();
        if !dynamic_tools.is_empty() {
            let tools: Vec<Value> = dynamic_tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.input_schema,
                    })
                })
                .collect();
            extra.insert("dynamicTools".to_owned(), Value::Array(tools));
        }
        if let Some(instructions) = instructions.filter(|s| !s.trim().is_empty()) {
            // `ThreadStartParams` (app-server-protocol v2) field for standing
            // instructions. There is no `instructions` key, and setting
            // `baseInstructions` would replace Codex's own base prompt.
            extra.insert("developerInstructions".to_owned(), json!(instructions));
        }

        let thread = client
            .start_thread(
                ThreadStartParams {
                    model: model.clone(),
                    cwd,
                    approval_policy,
                    sandbox,
                    extra: if extra.is_empty() {
                        None
                    } else {
                        Some(Value::Object(extra))
                    },
                },
                None,
            )
            .await
            .context("thread/start")?;

        Ok(Self {
            client,
            thread_id: thread.thread_id,
            model,
        })
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn client(&self) -> &CodexAppServerClient {
        &self.client
    }

    /// Start a user text turn (returns as soon as `turn/start` succeeds).
    pub async fn start_text_turn(
        &self,
        text: impl Into<String>,
        timeout_ms: Option<u64>,
    ) -> Result<String> {
        let turn = self
            .client
            .start_turn(TurnStartParams::text(&self.thread_id, text), timeout_ms)
            .await
            .context("turn/start")?;
        Ok(turn.turn_id)
    }

    /// Interrupt an in-flight turn (`turn/interrupt`).
    pub async fn interrupt_turn(&self, turn_id: &str, timeout_ms: Option<u64>) -> Result<()> {
        use crate::codex_app_server::TurnInterruptParams;
        self.client
            .interrupt_turn(
                TurnInterruptParams {
                    thread_id: self.thread_id.clone(),
                    turn_id: turn_id.to_owned(),
                },
                timeout_ms,
            )
            .await
            .context("turn/interrupt")?;
        Ok(())
    }

    /// Steer the active turn with additional user text (`turn/steer`).
    pub async fn steer_text(
        &self,
        expected_turn_id: &str,
        text: impl Into<String>,
        timeout_ms: Option<u64>,
    ) -> Result<String> {
        use crate::codex_app_server::TurnSteerParams;
        let result = self
            .client
            .steer_turn(
                TurnSteerParams::text(&self.thread_id, expected_turn_id, text),
                timeout_ms,
            )
            .await
            .context("turn/steer")?;
        Ok(result.turn_id)
    }

    /// Drain assistant message notifications (streaming deltas + completed
    /// agentMessage items) and return the best text we can assemble.
    async fn take_assistant_text(&self) -> String {
        let notes = self
            .client
            .take_notifications_where(is_agent_message_notification)
            .await;
        // Prefer fully-accumulated text from item/completed when present.
        let mut completed_parts = Vec::new();
        for n in &notes {
            if let Some(text) = agent_message_completed_text(n) {
                completed_parts.push(text);
            }
        }
        if !completed_parts.is_empty() {
            return completed_parts.join("");
        }
        agent_message_text_from_notifications(&notes)
    }

    /// Wait until the turn completes; returns assistant text collected so far.
    pub async fn wait_turn_complete(
        &self,
        turn_id: &str,
        timeout_ms: Option<u64>,
    ) -> Result<CodexAppServerTurnResult> {
        let completed = self
            .client
            .wait_for_turn_completion(turn_id, timeout_ms)
            .await
            .context("wait for turn completion")?;

        let assistant_text = self.take_assistant_text().await;

        Ok(CodexAppServerTurnResult {
            thread_id: self.thread_id.clone(),
            turn_id: turn_id.to_owned(),
            assistant_text,
            raw_completion: completed.params,
        })
    }

    /// Wait for either a server-request (tool/approval) or turn completion.
    pub async fn wait_server_request_or_turn_complete(
        &self,
        turn_id: &str,
        timeout_ms: Option<u64>,
    ) -> Result<TurnWaitEvent> {
        let wait_ms = timeout_ms.unwrap_or(10 * 60 * 1000);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("Timed out waiting for turn {turn_id} progress");
            }
            let slice_ms = remaining.min(Duration::from_millis(250)).as_millis() as u64;

            // Prefer server-requests (tool calls / approvals) with a short wait.
            match self.client.wait_for_server_request(Some(slice_ms)).await {
                Ok(request) => return Ok(TurnWaitEvent::ServerRequest(request)),
                Err(ServerRequestWaitError::Timeout) => {}
                Err(ServerRequestWaitError::Closed) => {
                    bail!("Codex app-server client is closed");
                }
            }

            // Check if turn completed notifications arrived during the wait.
            let completed = self
                .client
                .take_notifications_where(|n| {
                    let matches_turn = n
                        .params
                        .as_ref()
                        .and_then(|p| {
                            p.get("turnId")
                                .or_else(|| p.get("turn").and_then(|t| t.get("id")))
                                .or_else(|| p.get("id"))
                        })
                        .and_then(Value::as_str)
                        .map(|id| id == turn_id)
                        .unwrap_or(true);
                    matches_turn
                        && (n.method == "turn/completed"
                            || n.method == "turn/complete"
                            || n.method == "turn/completed/v2"
                            || (n.method == "codex/event"
                                && n.params
                                    .as_ref()
                                    .and_then(|p| p.get("msg"))
                                    .and_then(|m| m.get("type"))
                                    .and_then(Value::as_str)
                                    == Some("turn_complete")))
                })
                .await;
            if let Some(notification) = completed.into_iter().next() {
                let assistant_text = self.take_assistant_text().await;
                return Ok(TurnWaitEvent::Completed(CodexAppServerTurnResult {
                    thread_id: self.thread_id.clone(),
                    turn_id: turn_id.to_owned(),
                    assistant_text,
                    raw_completion: notification.params.unwrap_or(Value::Null),
                }));
            }
        }
    }

    /// Drain recent agent message deltas without removing completion events.
    pub async fn take_message_deltas(&self) -> Vec<Notification> {
        self.client
            .take_notifications_where(|n| n.method.starts_with("item/agentMessage"))
            .await
    }
}

/// Event while driving a Codex app-server turn.
pub enum TurnWaitEvent {
    ServerRequest(IncomingServerRequest),
    Completed(CodexAppServerTurnResult),
}

/// True when the configured model should use Codex app-server turns.
pub fn model_should_use_app_server_turns(model: &str) -> bool {
    crate::codex_auth::model_uses_openai_codex(model)
}

/// Strip a possible `openai-codex/` prefix for thread/start model ids.
pub fn codex_thread_model_id(model: &str) -> String {
    let trimmed = model.trim();
    if let Some(rest) = trimmed.strip_prefix("openai-codex/") {
        return rest.trim().to_owned();
    }
    if let Some(rest) = trimmed.strip_prefix("codex/") {
        return rest.trim().to_owned();
    }
    trimmed.to_owned()
}

/// Map native tool definitions into app-server dynamic tool specs.
pub fn dynamic_tools_from_native(
    tools: &HashMap<String, crate::agent::ToolDefinition>,
) -> Vec<DynamicToolSpec> {
    let mut specs: Vec<DynamicToolSpec> = tools
        .values()
        .map(|definition| {
            let tool = &definition.tool;
            DynamicToolSpec {
                name: sanitize_dynamic_tool_name(&tool.name),
                description: tool.description.clone(),
                input_schema: tool.input_schema.clone(),
            }
        })
        .collect();
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    specs
}

fn sanitize_dynamic_tool_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        out = "maestro_tool".to_owned();
    }
    if out == "mcp" || out.starts_with("mcp__") {
        out = format!("maestro_{out}");
    }
    out.chars().take(128).collect()
}

/// Build the JSON-RPC result body for a successful dynamic tool call.
///
/// Shape matches `codex-rs/app-server-protocol` `DynamicToolCallResponse`:
/// `contentItems` + `success`.
pub fn tool_call_success_result(text: impl Into<String>) -> Value {
    json!({
        "success": true,
        "contentItems": [
            { "type": "inputText", "text": text.into() }
        ]
    })
}

/// Build the JSON-RPC result body for a failed dynamic tool call.
pub fn tool_call_error_result(message: impl Into<String>) -> Value {
    json!({
        "success": false,
        "contentItems": [
            { "type": "inputText", "text": message.into() }
        ]
    })
}

/// Extract tool name + arguments from an `item/tool/call` params object.
pub fn parse_tool_call_params(params: &Value) -> Result<(String, String, Value)> {
    let tool = params
        .get("tool")
        .or_else(|| params.get("toolName"))
        .or_else(|| params.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if tool.is_empty() {
        bail!("item/tool/call missing tool name");
    }
    let call_id = params
        .get("callId")
        .or_else(|| params.get("toolCallId"))
        .or_else(|| params.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow::anyhow!("item/tool/call missing callId"))?;
    let args = params
        .get("arguments")
        .cloned()
        .or_else(|| params.get("args").cloned())
        .unwrap_or_else(|| json!({}));
    Ok((tool, call_id, args))
}

/// Approval decision payload for Codex app-server.
pub fn approval_decision(accept: bool) -> Value {
    if accept {
        json!({ "decision": "accept" })
    } else {
        json!({ "decision": "decline" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_codex_models_select_app_server_turns() {
        assert!(model_should_use_app_server_turns("openai-codex/gpt-5.5"));
        assert!(!model_should_use_app_server_turns("openai/gpt-5.5"));
        assert!(!model_should_use_app_server_turns(
            "anthropic/claude-sonnet-4"
        ));
    }

    #[test]
    fn strips_provider_prefix_for_thread_model() {
        assert_eq!(codex_thread_model_id("openai-codex/gpt-5.5"), "gpt-5.5");
        assert_eq!(codex_thread_model_id("gpt-5.5"), "gpt-5.5");
    }

    #[test]
    fn parses_tool_call_params() {
        let (tool, call_id, args) = parse_tool_call_params(&json!({
            "tool": "read",
            "callId": "c1",
            "arguments": { "path": "src/main.rs" }
        }))
        .unwrap();
        assert_eq!(tool, "read");
        assert_eq!(call_id, "c1");
        assert_eq!(args["path"], "src/main.rs");
    }

    #[test]
    fn rejects_tool_call_without_call_id() {
        let err = parse_tool_call_params(&json!({
            "tool": "read",
            "arguments": {}
        }))
        .unwrap_err();
        assert!(err.to_string().contains("callId"));
    }

    #[test]
    fn sanitizes_dynamic_tool_names() {
        assert_eq!(sanitize_dynamic_tool_name("bash tool"), "bash_tool");
        assert_eq!(sanitize_dynamic_tool_name("mcp"), "maestro_mcp");
    }
}
