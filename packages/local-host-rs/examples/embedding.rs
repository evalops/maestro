//! Start a local embedded agent with an authenticated provider configuration.

use anyhow::Result;
use maestro_local_host::agent::FromAgent;
use maestro_local_host::embedding::EmbeddedAgentBuilder;

#[tokio::main]
async fn main() -> Result<()> {
    let cwd = std::env::current_dir()?;
    let mut session = EmbeddedAgentBuilder::new("gpt-5.1-codex-max")
        .working_directory(&cwd)
        .system_prompt("Answer the request with the repository context.")
        .start()?;

    let result = match session.agent().prompt("Summarize this workspace.").await {
        Ok(()) => loop {
            let Some(event) = session.events().recv().await else {
                break Err(anyhow::anyhow!("embedded agent event stream ended"));
            };
            match event {
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
