//! Run a caller-owned tool through the deterministic embedding test kit.

use anyhow::Result;
use maestro_local_host::agent::{FromAgent, ToolDefinition, ToolResult};
use maestro_local_host::ai::{ScriptedBlock, ScriptedResponse, StopReason, Tool};
use maestro_local_host::embedding::{EmbeddedToolResponse, test_kit::ScriptedEmbeddingBuilder};

#[tokio::main]
async fn main() -> Result<()> {
    let cwd = std::env::current_dir()?;
    let tool = ToolDefinition {
        tool: Tool::new("lookup_status", "Return the current project status").with_schema(
            serde_json::json!({
                "type": "object",
                "additionalProperties": false
            }),
        ),
        requires_approval: true,
    };
    let script = vec![
        ScriptedResponse {
            blocks: vec![ScriptedBlock::ToolUse {
                id: "lookup-status-1".to_owned(),
                name: "lookup_status".to_owned(),
                input: serde_json::json!({}),
            }],
            stop_reason: StopReason::ToolUse,
            error: None,
        },
        ScriptedResponse::text("The project status is ready."),
    ];
    let mut session = ScriptedEmbeddingBuilder::new(script)
        .working_directory(&cwd)
        .external_tools([tool])
        .start()?;

    let result = match session.agent().prompt("Check the project status.").await {
        Ok(()) => loop {
            let Some(event) = session.events().recv().await else {
                break Err(anyhow::anyhow!("embedded agent event stream ended"));
            };
            match event {
                FromAgent::ToolCall { call_id, tool, .. } if tool == "lookup_status" => {
                    if let Err(error) =
                        session
                            .agent()
                            .send_tool_response(EmbeddedToolResponse::external_result(
                                call_id,
                                ToolResult::success("ready"),
                            ))
                    {
                        break Err(error);
                    }
                }
                FromAgent::ResponseChunk {
                    content,
                    is_thinking: false,
                    ..
                } => print!("{content}"),
                FromAgent::TurnCompleted { .. } => break Ok(()),
                FromAgent::ProviderError { message, .. } => break Err(anyhow::anyhow!(message)),
                FromAgent::TurnInterrupted { reason, .. } => {
                    break Err(anyhow::anyhow!(reason));
                }
                _ => {}
            }
        },
        Err(error) => Err(error),
    };

    session.shutdown().await;
    result
}
