use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use maestro_tui::headless::{
    AgentState, FromAgentMessage, ServerRequestResolutionStatus, ServerRequestResolvedBy,
    ServerRequestType, ToAgentMessage, HEADLESS_PROTOCOL_VERSION,
};
use maestro_tui::hosted_runner::{
    start_hosted_runner_with_message_executor, HostedRunnerConfig, HostedRunnerError,
    HostedRunnerHeadlessMessageContext, HostedRunnerHeadlessMessageExecutor,
    HostedRunnerHeadlessMessageResult,
};
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncReadExt;

const APPROVAL_TRIGGER_PREFIX: &str = "__maestro_conformance_approval__:";

#[derive(Debug, Deserialize)]
struct ApprovalTrigger {
    request_id: String,
    tool: String,
    args: serde_json::Value,
    reason: String,
}

struct ConformanceExecutor {
    state: Mutex<AgentState>,
}

impl ConformanceExecutor {
    fn new(session_id: String, workspace_root: PathBuf) -> Self {
        let mut state = AgentState {
            protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
            model: Some("gpt-5.4".to_string()),
            provider: Some("openai".to_string()),
            session_id: Some(session_id),
            cwd: Some(workspace_root.to_string_lossy().to_string()),
            last_status: Some("Ready".to_string()),
            is_ready: true,
            ..AgentState::default()
        };
        state.handle_message(FromAgentMessage::Ready {
            protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
            model: "gpt-5.4".to_string(),
            provider: "openai".to_string(),
            session_id: state.session_id.clone(),
        });
        Self {
            state: Mutex::new(state),
        }
    }

    fn record(
        &self,
        sent: &ToAgentMessage,
        messages: &[FromAgentMessage],
    ) -> Result<(), HostedRunnerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| HostedRunnerError::internal("conformance state mutex poisoned"))?;
        state.handle_sent_message(sent);
        for message in messages {
            state.handle_message(message.clone());
        }
        Ok(())
    }
}

impl HostedRunnerHeadlessMessageExecutor for ConformanceExecutor {
    fn execute(
        &self,
        _context: &HostedRunnerHeadlessMessageContext,
        message: ToAgentMessage,
    ) -> Result<HostedRunnerHeadlessMessageResult, HostedRunnerError> {
        let messages = match &message {
            ToAgentMessage::Prompt { content, .. } => {
                if let Some(payload) = content.strip_prefix(APPROVAL_TRIGGER_PREFIX) {
                    let trigger: ApprovalTrigger =
                        serde_json::from_str(payload).map_err(|error| {
                            HostedRunnerError::bad_request(format!(
                                "invalid conformance approval trigger: {error}"
                            ))
                        })?;
                    vec![FromAgentMessage::ServerRequest {
                        request_id: trigger.request_id.clone(),
                        request_type: ServerRequestType::Approval,
                        call_id: trigger.request_id,
                        tool: trigger.tool,
                        args: trigger.args,
                        reason: trigger.reason,
                    }]
                } else {
                    vec![FromAgentMessage::Status {
                        message: format!("Prompt: {content}"),
                    }]
                }
            }
            ToAgentMessage::ServerRequestResponse {
                request_id,
                request_type,
                approved,
                result,
                reason,
                ..
            } => {
                let resolution = match request_type {
                    ServerRequestType::Approval => {
                        if approved.unwrap_or(false) {
                            ServerRequestResolutionStatus::Approved
                        } else {
                            ServerRequestResolutionStatus::Denied
                        }
                    }
                    ServerRequestType::ClientTool => ServerRequestResolutionStatus::Completed,
                    ServerRequestType::UserInput => ServerRequestResolutionStatus::Answered,
                    ServerRequestType::ToolRetry => ServerRequestResolutionStatus::Retried,
                };
                let reason = reason
                    .clone()
                    .or_else(|| result.as_ref().and_then(|result| result.error.clone()));
                vec![FromAgentMessage::ServerRequestResolved {
                    request_id: request_id.clone(),
                    request_type: *request_type,
                    call_id: request_id.clone(),
                    resolution,
                    reason,
                    resolved_by: ServerRequestResolvedBy::User,
                }]
            }
            _ => Vec::new(),
        };
        self.record(&message, &messages)?;
        Ok(HostedRunnerHeadlessMessageResult::runtime_handled(
            messages,
            "Rust hosted runner conformance fixture handled the headless message",
        ))
    }

    fn state(&self) -> Result<Option<AgentState>, HostedRunnerError> {
        Ok(Some(
            self.state
                .lock()
                .map_err(|_| HostedRunnerError::internal("conformance state mutex poisoned"))?
                .clone(),
        ))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = HostedRunnerConfig::from_env()?;
    let session_id = config
        .maestro_session_id
        .clone()
        .unwrap_or_else(|| config.runner_session_id.clone());
    let workspace_root = config.workspace_root.clone();
    let executor = Arc::new(ConformanceExecutor::new(session_id.clone(), workspace_root));
    let handle = start_hosted_runner_with_message_executor(config, executor).await?;

    let mut stdout = std::io::stdout();
    writeln!(
        stdout,
        "{}",
        json!({
            "baseUrl": handle.base_url(),
            "sessionId": session_id,
        })
    )?;
    stdout.flush()?;

    let mut stdin = tokio::io::stdin();
    let mut buffer = [0_u8; 1];
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = stdin.read(&mut buffer) => {}
    }

    handle.shutdown().await;
    Ok(())
}
