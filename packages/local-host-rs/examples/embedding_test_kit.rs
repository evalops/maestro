//! Run a caller-owned tool through the deterministic embedding test kit.

use anyhow::Result;
use maestro_local_host::agent::{ToolDefinition, ToolResult};
use maestro_local_host::ai::{ScriptedBlock, ScriptedResponse, StopReason, Tool};
use maestro_local_host::embedding::{EmbeddedRunProgress, test_kit::ScriptedEmbeddingBuilder};

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
        .start_runner()?;

    match session.run("Check the project status.").await? {
        EmbeddedRunProgress::AwaitingTool(pending) => {
            session.external_result(&pending, ToolResult::success("ready"))?;
            let completed = match session.resume().await? {
                EmbeddedRunProgress::Completed(completed) => completed,
                EmbeddedRunProgress::AwaitingTool(_) => {
                    anyhow::bail!("unexpected second tool call")
                }
            };
            print!("{}", completed.output());
        }
        EmbeddedRunProgress::Completed(completed) => print!("{}", completed.output()),
    }

    session.shutdown().await;
    Ok(())
}
