//! Agent process management
//!
//! Spawns and communicates with the Node.js agent subprocess.

use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use super::{FromAgent, ToAgent};

/// Manages the Node.js agent subprocess
pub struct AgentProcess {
    child: Child,
    stdin: tokio::process::ChildStdin,
    /// Channel to receive messages from the agent
    pub rx: mpsc::UnboundedReceiver<FromAgent>,
}

impl AgentProcess {
    /// Spawn a new agent process
    ///
    /// # Arguments
    /// * `node_path` - Path to node executable (or "node" to use PATH)
    /// * `script_path` - Path to the agent script
    /// * `args` - Additional arguments to pass
    pub async fn spawn(node_path: &str, script_path: &str, args: &[String]) -> Result<Self> {
        let mut cmd = Command::new(node_path);
        cmd.arg(script_path)
            .arg("--headless") // Run in headless mode for IPC
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()); // Let errors go to terminal

        let mut child = cmd.spawn().context("Failed to spawn agent process")?;

        let stdin = child.stdin.take().context("Failed to get stdin")?;
        let stdout = child.stdout.take().context("Failed to get stdout")?;

        // Create channel for messages
        let (tx, rx) = mpsc::unbounded_channel();

        // Spawn reader task
        tokio::spawn(async move {
            let reader = BufReader::with_capacity(1024 * 1024, stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<FromAgent>(&line) {
                    Ok(msg) => {
                        if tx.send(msg).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to parse agent message: {}", e);
                    }
                }
            }
        });

        Ok(Self { child, stdin, rx })
    }

    /// Send a message to the agent
    pub async fn send(&mut self, msg: ToAgent) -> Result<()> {
        let json = serde_json::to_string(&msg)?;
        self.stdin.write_all(json.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// Send a prompt to the agent
    pub async fn prompt(&mut self, content: String, attachments: Vec<String>) -> Result<()> {
        self.send(ToAgent::Prompt {
            content,
            attachments,
        })
        .await
    }

    /// Send an interrupt signal
    pub async fn interrupt(&mut self) -> Result<()> {
        self.send(ToAgent::Interrupt).await
    }

    /// Respond to a tool call
    pub async fn tool_response(
        &mut self,
        call_id: String,
        approved: bool,
        result: Option<super::ToolResult>,
    ) -> Result<()> {
        self.send(ToAgent::ToolResponse {
            call_id,
            approved,
            result,
        })
        .await
    }

    /// Shutdown the agent gracefully
    pub async fn shutdown(&mut self) -> Result<()> {
        self.send(ToAgent::Shutdown).await?;
        // Give it a moment to clean up
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _ = self.child.kill().await;
        Ok(())
    }

    /// Check if the agent process is still running
    pub fn is_running(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        // Try to kill the child process on drop
        let _ = self.child.start_kill();
    }
}
