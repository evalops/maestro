use maestro_tui::agent::{FromAgent, NativeAgent, NativeAgentConfig, TokenUsage};
use serde_json::Value;
use std::env;
use std::time::Duration;

use crate::{
    env_u64, finish_tool_metadata, record_tool_call_metadata, trimmed_env, truthy_env,
    A2ACancelReceiver, AppState, A2A_DEFAULT_RESPONSE_END_SETTLE_MS, A2A_DEFAULT_TURN_TIMEOUT_MS,
};

#[derive(Debug, Default)]
pub(crate) struct A2ATurnOutput {
    pub(crate) assistant_text: String,
    pub(crate) thinking_text: String,
    pub(crate) usage: Option<TokenUsage>,
    pub(crate) tools: Vec<Value>,
}

pub(crate) enum A2ATurnResult {
    Completed(A2ATurnOutput),
    Canceled,
}

pub(crate) async fn run_a2a_native_turn(
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
