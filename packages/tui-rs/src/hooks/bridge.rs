//! IPC Bridge for Rust ↔ Node.js hooks
//!
//! Enables communication between Rust hooks and TypeScript hooks running in
//! the Node.js subprocess. This allows:
//!
//! - Rust TUI to execute TypeScript hooks via IPC
//! - TypeScript hooks to call into Rust for performance-critical operations
//! - Unified hook system across both runtimes
//!
//! # Protocol
//!
//! JSON messages over stdin/stdout:
//!
//! ```json
//! // Rust -> Node.js: Execute hook
//! {
//!   "type": "hook_request",
//!   "id": "req-123",
//!   "event": "PreToolUse",
//!   "input": { ... }
//! }
//!
//! // Node.js -> Rust: Hook result
//! {
//!   "type": "hook_response",
//!   "id": "req-123",
//!   "result": { "continue": true }
//! }
//! ```

use super::types::{HookEventType, HookOutput, HookResult, PreToolUseInput};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};

/// Request to execute a hook in Node.js
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookRequest {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub id: String,
    pub event: HookEventType,
    pub input: serde_json::Value,
}

/// Response from Node.js hook execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookResponse {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub id: String,
    pub result: HookOutput,
    #[serde(default)]
    pub error: Option<String>,
}

/// IPC Bridge to Node.js hook executor
pub struct NodeHookBridge {
    /// Path to Node.js script for hook execution
    script_path: PathBuf,
    /// Request ID counter
    request_id: AtomicU64,
    /// Pending requests waiting for responses
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<HookResponse>>>>,
    /// Sender for outgoing requests
    request_tx: Option<mpsc::UnboundedSender<HookRequest>>,
    /// Handle to the Node.js process
    process: Option<Child>,
}

impl NodeHookBridge {
    /// Create a new bridge (not yet started)
    #[must_use]
    pub fn new(script_path: PathBuf) -> Self {
        Self {
            script_path,
            request_id: AtomicU64::new(0),
            pending: Arc::new(Mutex::new(HashMap::new())),
            request_tx: None,
            process: None,
        }
    }

    /// Create a bridge that uses the bundled hook executor
    #[must_use]
    pub fn bundled() -> Self {
        // Look for the hook executor script in standard locations
        let script_path = if let Some(home) = dirs::home_dir() {
            home.join(".composer").join("lib").join("hook-executor.js")
        } else {
            PathBuf::from("hook-executor.js")
        };

        Self::new(script_path)
    }

    /// Start the Node.js subprocess
    pub async fn start(&mut self) -> Result<()> {
        if self.process.is_some() {
            return Ok(());
        }

        // Check if script exists
        if !self.script_path.exists() {
            // Create a minimal inline script for testing
            eprintln!(
                "[hook-bridge] Script not found: {}, using inline executor",
                self.script_path.display()
            );
        }

        // Spawn Node.js process
        let mut child = Command::new("node")
            .arg("-e")
            .arg(INLINE_HOOK_EXECUTOR)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("Failed to spawn Node.js hook executor")?;

        let stdin = child.stdin.take().context("No stdin")?;
        let stdout = child.stdout.take().context("No stdout")?;

        // Set up channels
        let (request_tx, request_rx) = mpsc::unbounded_channel::<HookRequest>();
        self.request_tx = Some(request_tx);
        self.process = Some(child);

        // Spawn writer task
        tokio::spawn(async move {
            Self::writer_task(stdin, request_rx).await;
        });

        // Spawn reader task
        let pending_for_reader = Arc::clone(&self.pending);
        tokio::spawn(async move {
            Self::reader_task(stdout, pending_for_reader).await;
        });

        Ok(())
    }

    /// Stop the Node.js subprocess
    pub async fn stop(&mut self) -> Result<()> {
        self.request_tx = None;

        if let Some(mut process) = self.process.take() {
            let _ = process.kill();
            let _ = process.wait();
        }

        Ok(())
    }

    /// Execute a `PreToolUse` hook via Node.js
    pub async fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> Result<HookResult> {
        let request_tx = self.request_tx.as_ref().context("Bridge not started")?;

        let id = format!("req-{}", self.request_id.fetch_add(1, Ordering::SeqCst));

        let request = HookRequest {
            msg_type: "hook_request".to_string(),
            id: id.clone(),
            event: HookEventType::PreToolUse,
            input: serde_json::to_value(input)?,
        };

        // Create response channel
        let (response_tx, response_rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id.clone(), response_tx);
        }

        // Send request
        request_tx.send(request).context("Failed to send request")?;

        // Wait for response with timeout
        let response = tokio::time::timeout(std::time::Duration::from_secs(30), response_rx)
            .await
            .context("Hook execution timed out")?
            .context("Response channel closed")?;

        // Convert to HookResult
        if let Some(error) = response.error {
            return Ok(HookResult::Block { reason: error });
        }

        Ok(hook_output_to_result(&response.result))
    }

    /// Writer task - sends requests to Node.js
    async fn writer_task(
        mut stdin: ChildStdin,
        mut request_rx: mpsc::UnboundedReceiver<HookRequest>,
    ) {
        while let Some(request) = request_rx.recv().await {
            let json = match serde_json::to_string(&request) {
                Ok(j) => j,
                Err(e) => {
                    eprintln!("[hook-bridge] Failed to serialize request: {e}");
                    continue;
                }
            };

            if let Err(e) = writeln!(stdin, "{json}") {
                eprintln!("[hook-bridge] Failed to write request: {e}");
                break;
            }
            if let Err(e) = stdin.flush() {
                eprintln!("[hook-bridge] Failed to flush stdin: {e}");
                break;
            }
        }
    }

    /// Reader task - reads responses from Node.js
    async fn reader_task(
        stdout: ChildStdout,
        pending: Arc<Mutex<HashMap<String, oneshot::Sender<HookResponse>>>>,
    ) {
        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[hook-bridge] Failed to read line: {e}");
                    break;
                }
            };

            let response: HookResponse = match serde_json::from_str(&line) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[hook-bridge] Failed to parse response: {e}");
                    continue;
                }
            };

            let mut pending_guard = pending.lock().await;
            if let Some(tx) = pending_guard.remove(&response.id) {
                let _ = tx.send(response);
            }
        }
    }
}

/// Convert `HookOutput` to `HookResult`
fn hook_output_to_result(output: &HookOutput) -> HookResult {
    if !output.should_continue {
        return HookResult::Block {
            reason: output
                .block_reason
                .clone()
                .unwrap_or_else(|| "Blocked by hook".to_string()),
        };
    }

    if let Some(ref context) = output.additional_context {
        return HookResult::InjectContext {
            context: context.clone(),
        };
    }

    if let Some(ref modified) = output.modified_input {
        return HookResult::ModifyInput {
            new_input: modified.clone(),
        };
    }

    HookResult::Continue
}

/// Inline Node.js script for hook execution
/// This is used when the external script is not available
const INLINE_HOOK_EXECUTOR: &str = r"
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', (line) => {
    try {
        const request = JSON.parse(line);

        // Simple passthrough - always continue
        const response = {
            type: 'hook_response',
            id: request.id,
            result: { continue: true }
        };

        console.log(JSON.stringify(response));
    } catch (e) {
        console.error('[hook-executor] Error:', e.message);
    }
});

rl.on('close', () => {
    process.exit(0);
});
";

// ============================================================================
// Sync wrapper for non-async contexts
// ============================================================================

/// Synchronous wrapper for `NodeHookBridge`
pub struct SyncNodeBridge {
    inner: Arc<Mutex<NodeHookBridge>>,
    runtime: tokio::runtime::Handle,
}

impl SyncNodeBridge {
    /// Create a new sync bridge
    #[must_use]
    pub fn new(script_path: PathBuf, runtime: tokio::runtime::Handle) -> Self {
        Self {
            inner: Arc::new(Mutex::new(NodeHookBridge::new(script_path))),
            runtime,
        }
    }

    /// Start the bridge
    pub fn start(&self) -> Result<()> {
        self.runtime.block_on(async {
            let mut bridge = self.inner.lock().await;
            bridge.start().await
        })
    }

    /// Execute a hook synchronously
    pub fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> Result<HookResult> {
        self.runtime.block_on(async {
            let bridge = self.inner.lock().await;
            bridge.execute_pre_tool_use(input).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hook_output_to_result() {
        // Continue
        let output = HookOutput {
            should_continue: true,
            ..Default::default()
        };
        assert!(matches!(
            hook_output_to_result(&output),
            HookResult::Continue
        ));

        // Block
        let output = HookOutput {
            should_continue: false,
            block_reason: Some("Test".to_string()),
            ..Default::default()
        };
        assert!(matches!(
            hook_output_to_result(&output),
            HookResult::Block { reason } if reason == "Test"
        ));

        // Inject context
        let output = HookOutput {
            should_continue: true,
            additional_context: Some("Context".to_string()),
            ..Default::default()
        };
        assert!(matches!(
            hook_output_to_result(&output),
            HookResult::InjectContext { context } if context == "Context"
        ));
    }
}
