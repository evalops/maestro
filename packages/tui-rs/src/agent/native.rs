//! Native Rust agent
//!
//! A fully native agent implementation that communicates directly with AI providers.
//! Replaces the Node.js subprocess architecture with pure Rust.
//!
//! The agent uses a background task architecture:
//! - `NativeAgent` is the handle held by the TUI
//! - `NativeAgentRunner` runs in a background task and owns mutable state
//! - Communication happens via channels, so `prompt()` returns immediately

use std::collections::HashMap;

use anyhow::Result;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{FromAgent, TokenUsage, ToolResult};
use crate::ai::{
    ContentBlock, Message, MessageContent, RequestConfig, Role, StreamEvent, Tool,
    ThinkingConfig, UnifiedClient,
};
use crate::tools::{ToolExecutor, ToolRegistry};

/// Configuration for the native agent
#[derive(Debug, Clone)]
pub struct NativeAgentConfig {
    /// Model to use (e.g., "claude-opus-4-5-20251101", "gpt-5.1-codex-max")
    pub model: String,
    /// Maximum tokens for responses
    pub max_tokens: u32,
    /// System prompt
    pub system_prompt: Option<String>,
    /// Whether extended thinking is enabled
    pub thinking_enabled: bool,
    /// Token budget for thinking (if enabled)
    pub thinking_budget: u32,
    /// Current working directory
    pub cwd: String,
}

impl Default for NativeAgentConfig {
    fn default() -> Self {
        Self {
            model: "claude-sonnet-4-5-20250514".to_string(),
            max_tokens: 16384,
            system_prompt: None,
            thinking_enabled: false,
            thinking_budget: 10000,
            cwd: std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string()),
        }
    }
}

/// Tool definition with execution handler
#[derive(Clone)]
pub struct ToolDefinition {
    /// Tool metadata for the AI
    pub tool: Tool,
    /// Whether this tool requires user approval
    pub requires_approval: bool,
}

/// Command sent to the background agent runner
enum AgentCommand {
    Prompt { content: String },
    Cancel,
    SetModel { model: String },
    ClearHistory,
}

/// The native agent handle (held by TUI)
///
/// This is a lightweight handle that communicates with the background runner
/// via channels. All methods return immediately.
pub struct NativeAgent {
    /// Channel to send commands to the background runner
    command_tx: mpsc::UnboundedSender<AgentCommand>,
    /// Sender for tool responses (kept for creating receivers)
    tool_response_tx: mpsc::UnboundedSender<(String, bool, Option<ToolResult>)>,
    /// Channel to send events to the TUI (for send_ready)
    event_tx: mpsc::UnboundedSender<FromAgent>,
    /// Model name
    model_name: String,
    /// Provider name
    provider_name: String,
}

impl NativeAgent {
    /// Create a new native agent
    ///
    /// Returns the agent handle and a receiver for events.
    /// The agent spawns a background task that processes prompts.
    pub fn new(config: NativeAgentConfig) -> Result<(Self, mpsc::UnboundedReceiver<FromAgent>)> {
        let client = UnifiedClient::from_model(&config.model)?;
        let provider = client.provider();

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (tool_response_tx, tool_response_rx) = mpsc::unbounded_channel();
        let (command_tx, command_rx) = mpsc::unbounded_channel();

        // Build tool definitions from the registry
        let registry = ToolRegistry::new();
        let tools: HashMap<String, ToolDefinition> = registry
            .tools()
            .map(|td| (td.tool.name.clone(), td.clone()))
            .collect();

        // Create tool executor
        let tool_executor = ToolExecutor::new(&config.cwd);

        // Create the background runner
        let runner = NativeAgentRunner {
            client,
            config: config.clone(),
            messages: Vec::new(),
            tools,
            tool_executor,
            event_tx: event_tx.clone(),
            tool_response_rx,
            command_rx,
            busy: false,
            cancel_token: None,
        };

        // Spawn the background task
        tokio::spawn(async move {
            runner.run().await;
        });

        let agent = Self {
            command_tx,
            tool_response_tx,
            event_tx,
            model_name: config.model,
            provider_name: format!("{:?}", provider),
        };

        Ok((agent, event_rx))
    }

    /// Get the sender for tool responses
    pub fn tool_response_sender(
        &self,
    ) -> mpsc::UnboundedSender<(String, bool, Option<ToolResult>)> {
        self.tool_response_tx.clone()
    }

    /// Send the ready event
    pub fn send_ready(&self) {
        let _ = self.event_tx.send(FromAgent::Ready {
            model: self.model_name.clone(),
            provider: self.provider_name.clone(),
        });
    }

    /// Process a user prompt (non-blocking - sends to background task)
    pub async fn prompt(&self, content: String, _attachments: Vec<String>) -> Result<()> {
        self.command_tx
            .send(AgentCommand::Prompt { content })
            .map_err(|e| anyhow::anyhow!("Failed to send prompt: {}", e))?;
        Ok(())
    }

    /// Cancel the current operation
    pub fn cancel(&self) {
        let _ = self.command_tx.send(AgentCommand::Cancel);
    }

    /// Clear conversation history
    pub fn clear_history(&self) {
        let _ = self.command_tx.send(AgentCommand::ClearHistory);
    }

    /// Set the model
    pub fn set_model(&self, model: impl Into<String>) -> Result<()> {
        let model = model.into();
        self.command_tx
            .send(AgentCommand::SetModel { model })
            .map_err(|e| anyhow::anyhow!("Failed to set model: {}", e))?;
        Ok(())
    }
}

/// The background agent runner that owns mutable state
struct NativeAgentRunner {
    /// AI client
    client: UnifiedClient,
    /// Configuration
    config: NativeAgentConfig,
    /// Conversation history
    messages: Vec<Message>,
    /// Tool definitions
    tools: HashMap<String, ToolDefinition>,
    /// Tool executor for running tools
    tool_executor: ToolExecutor,
    /// Channel to send events to the TUI
    event_tx: mpsc::UnboundedSender<FromAgent>,
    /// Channel to receive tool responses from the TUI
    tool_response_rx: mpsc::UnboundedReceiver<(String, bool, Option<ToolResult>)>,
    /// Channel to receive commands
    command_rx: mpsc::UnboundedReceiver<AgentCommand>,
    /// Whether currently processing
    busy: bool,
    /// Cancellation token for the current request
    cancel_token: Option<CancellationToken>,
}

impl NativeAgentRunner {
    /// Run the background task loop
    async fn run(mut self) {
        while let Some(cmd) = self.command_rx.recv().await {
            match cmd {
                AgentCommand::Prompt { content } => {
                    if self.busy {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message: "Agent is busy".to_string(),
                            fatal: false,
                        });
                        continue;
                    }

                    self.busy = true;

                    // Create cancellation token for this request
                    let cancel_token = CancellationToken::new();
                    self.cancel_token = Some(cancel_token.clone());

                    // Add user message to history
                    self.messages.push(Message {
                        role: Role::User,
                        content: MessageContent::text(content),
                    });

                    // Run the agent loop with cancellation support
                    let result = tokio::select! {
                        res = self.run_loop() => res,
                        _ = cancel_token.cancelled() => {
                            Err(anyhow::anyhow!("Request cancelled"))
                        }
                    };

                    if let Err(e) = result {
                        let msg = e.to_string();
                        if msg != "Request cancelled" {
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: format!("Agent error: {}", e),
                                fatal: false,
                            });
                        }
                    }

                    self.busy = false;
                    self.cancel_token = None;

                    // Signal that we're done (TUI can clear busy state)
                    let _ = self.event_tx.send(FromAgent::ResponseEnd {
                        response_id: "done".to_string(),
                        usage: None,
                    });
                }
                AgentCommand::Cancel => {
                    if let Some(token) = &self.cancel_token {
                        token.cancel();
                    }
                    self.busy = false;
                }
                AgentCommand::SetModel { model } => {
                    match UnifiedClient::from_model(&model) {
                        Ok(client) => {
                            self.client = client;
                            self.config.model = model;
                        }
                        Err(e) => {
                            let _ = self.event_tx.send(FromAgent::Error {
                                message: format!("Failed to set model: {}", e),
                                fatal: false,
                            });
                        }
                    }
                }
                AgentCommand::ClearHistory => {
                    self.messages.clear();
                }
            }
        }
    }

    /// Build request configuration
    fn build_config(&self) -> RequestConfig {
        let tools: Vec<Tool> = self.tools.values().map(|d| d.tool.clone()).collect();

        let thinking = if self.config.thinking_enabled {
            Some(ThinkingConfig::enabled(self.config.thinking_budget))
        } else {
            None
        };

        RequestConfig {
            model: self.config.model.clone(),
            max_tokens: self.config.max_tokens,
            temperature: if self.config.thinking_enabled {
                None // Temperature must be 1 or omitted for thinking
            } else {
                Some(0.7)
            },
            system: self.config.system_prompt.clone(),
            tools,
            thinking,
        }
    }

    /// Run the agent loop until complete or interrupted
    async fn run_loop(&mut self) -> Result<()> {
        loop {
            let response_id = Uuid::new_v4().to_string();

            // Signal response start
            let _ = self.event_tx.send(FromAgent::ResponseStart {
                response_id: response_id.clone(),
            });

            // Make the API call
            let config = self.build_config();
            let mut rx = self.client.stream(&self.messages, &config).await?;

            // Collect the response
            let mut assistant_content: Vec<ContentBlock> = Vec::new();
            let mut current_text = String::new();
            let mut current_thinking = String::new();
            let mut current_tool: Option<(String, String, String)> = None; // (id, name, json)
            let mut usage = TokenUsage::default();
            let mut pending_tool_calls: Vec<(String, String, serde_json::Value)> = Vec::new();

            // Process stream events
            while let Some(event) = rx.recv().await {
                match event {
                    StreamEvent::MessageStart { .. } => {}
                    StreamEvent::ContentBlockStart { index: _, block } => {
                        match &block {
                            ContentBlock::Text { text } => {
                                current_text = text.clone();
                            }
                            ContentBlock::Thinking { thinking } => {
                                current_thinking = thinking.clone();
                            }
                            ContentBlock::ToolUse { id, name, .. } => {
                                current_tool = Some((id.clone(), name.clone(), String::new()));
                            }
                            _ => {}
                        }
                    }
                    StreamEvent::TextDelta { text, .. } => {
                        current_text.push_str(&text);
                        let _ = self.event_tx.send(FromAgent::ResponseChunk {
                            response_id: response_id.clone(),
                            content: text,
                            is_thinking: false,
                        });
                    }
                    StreamEvent::ThinkingDelta { thinking, .. } => {
                        current_thinking.push_str(&thinking);
                        let _ = self.event_tx.send(FromAgent::ResponseChunk {
                            response_id: response_id.clone(),
                            content: thinking,
                            is_thinking: true,
                        });
                    }
                    StreamEvent::InputJsonDelta { partial_json, .. } => {
                        if let Some((_, _, ref mut json)) = current_tool {
                            json.push_str(&partial_json);
                        }
                    }
                    StreamEvent::ContentBlockStop { index: _ } => {
                        // Finalize current content block
                        if !current_text.is_empty() {
                            assistant_content.push(ContentBlock::Text {
                                text: std::mem::take(&mut current_text),
                            });
                        }
                        if !current_thinking.is_empty() {
                            assistant_content.push(ContentBlock::Thinking {
                                thinking: std::mem::take(&mut current_thinking),
                            });
                        }
                        if let Some((id, name, json)) = current_tool.take() {
                            let input: serde_json::Value =
                                serde_json::from_str(&json).unwrap_or(serde_json::json!({}));
                            assistant_content.push(ContentBlock::ToolUse {
                                id: id.clone(),
                                name: name.clone(),
                                input: input.clone(),
                            });
                            pending_tool_calls.push((id, name, input));
                        }
                    }
                    StreamEvent::Usage {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                    } => {
                        usage.input_tokens = input_tokens;
                        usage.output_tokens = output_tokens;
                        usage.cache_read_tokens = cache_read_tokens.unwrap_or(0);
                        usage.cache_write_tokens = cache_creation_tokens.unwrap_or(0);
                    }
                    StreamEvent::MessageStop => {
                        break;
                    }
                    StreamEvent::Error { message } => {
                        let _ = self.event_tx.send(FromAgent::Error {
                            message,
                            fatal: false,
                        });
                        break;
                    }
                }
            }

            // Add assistant message to history
            if !assistant_content.is_empty() {
                self.messages.push(Message {
                    role: Role::Assistant,
                    content: MessageContent::Blocks(assistant_content),
                });
            }

            // Signal response end
            let _ = self.event_tx.send(FromAgent::ResponseEnd {
                response_id: response_id.clone(),
                usage: Some(usage),
            });

            // If there are tool calls, handle them
            if !pending_tool_calls.is_empty() {
                let mut tool_results: Vec<ContentBlock> = Vec::new();

                for (call_id, tool_name, args) in pending_tool_calls {
                    // Check if this tool requires approval
                    let requires_approval = self
                        .tools
                        .get(&tool_name)
                        .map(|d| d.requires_approval)
                        .unwrap_or(true); // Default to requiring approval

                    // Send tool call event
                    let _ = self.event_tx.send(FromAgent::ToolCall {
                        call_id: call_id.clone(),
                        tool: tool_name.clone(),
                        args: args.clone(),
                        requires_approval,
                    });

                    // If requires approval, wait for response
                    let (approved, result) = if requires_approval {
                        // Wait for tool response from TUI
                        match self.tool_response_rx.recv().await {
                            Some((id, approved, result)) if id == call_id => (approved, result),
                            Some(_) => {
                                // Wrong call_id, treat as not approved
                                (false, None)
                            }
                            None => {
                                // Channel closed
                                return Ok(());
                            }
                        }
                    } else {
                        // Auto-approved, execute immediately
                        // Note: ToolExecutor sends ToolStart/ToolEnd events internally
                        let result = self.execute_tool(&tool_name, &args, &call_id).await;

                        (true, Some(result))
                    };

                    // Build tool result for conversation
                    let result_content = if approved {
                        if let Some(res) = result {
                            if res.success {
                                res.output
                            } else {
                                format!("Error: {}", res.error.unwrap_or_default())
                            }
                        } else {
                            "Tool executed successfully".to_string()
                        }
                    } else {
                        "Tool call was denied by user".to_string()
                    };

                    tool_results.push(ContentBlock::ToolResult {
                        tool_use_id: call_id,
                        content: result_content,
                        is_error: Some(!approved),
                    });
                }

                // Add tool results to history
                self.messages.push(Message {
                    role: Role::User,
                    content: MessageContent::Blocks(tool_results),
                });

                // Continue the loop to process the tool results
                continue;
            }

            // No tool calls, we're done
            break;
        }

        Ok(())
    }

    /// Execute a tool using the ToolExecutor
    async fn execute_tool(&self, tool_name: &str, args: &serde_json::Value, call_id: &str) -> ToolResult {
        self.tool_executor
            .execute(tool_name, args, Some(&self.event_tx), call_id)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default() {
        let config = NativeAgentConfig::default();
        assert!(config.model.starts_with("claude"));
        assert_eq!(config.max_tokens, 16384);
        assert!(!config.thinking_enabled);
    }

    #[test]
    fn test_config_with_custom_model() {
        let config = NativeAgentConfig {
            model: "gpt-5.1-codex-max".to_string(),
            max_tokens: 8192,
            system_prompt: Some("You are a helpful assistant.".to_string()),
            thinking_enabled: true,
            thinking_budget: 5000,
            cwd: "/tmp".to_string(),
        };
        assert_eq!(config.model, "gpt-5.1-codex-max");
        assert_eq!(config.max_tokens, 8192);
        assert!(config.thinking_enabled);
        assert_eq!(config.thinking_budget, 5000);
    }

    #[test]
    fn test_thinking_config() {
        let thinking = ThinkingConfig::enabled(10000);
        assert_eq!(thinking.thinking_type, "enabled");
        assert_eq!(thinking.budget_tokens, 10000);
    }

    #[test]
    fn test_tool_definition_clone() {
        let tool_def = ToolDefinition {
            tool: Tool::new("test", "A test tool").with_schema(serde_json::json!({
                "type": "object",
                "properties": {}
            })),
            requires_approval: true,
        };
        let cloned = tool_def.clone();
        assert_eq!(cloned.tool.name, "test");
        assert!(cloned.requires_approval);
    }

    #[test]
    fn test_tool_registry_integration() {
        // Verify tools are registered correctly from registry
        let registry = ToolRegistry::new();
        let tools: Vec<_> = registry.tools().collect();

        // Should have bash, read, write, glob, grep
        assert!(tools.len() >= 5);

        // Verify tool names
        let names: Vec<_> = tools.iter().map(|t| t.tool.name.as_str()).collect();
        assert!(names.contains(&"bash"));
        assert!(names.contains(&"read"));
        assert!(names.contains(&"write"));
        assert!(names.contains(&"glob"));
        assert!(names.contains(&"grep"));
    }

    #[test]
    fn test_request_config_building() {
        let config = NativeAgentConfig {
            model: "claude-sonnet-4-5-20250514".to_string(),
            max_tokens: 8192,
            system_prompt: Some("Test system prompt".to_string()),
            thinking_enabled: false,
            thinking_budget: 0,
            cwd: ".".to_string(),
        };

        // Build request config manually to verify structure
        let tools: Vec<Tool> = ToolRegistry::new()
            .tools()
            .map(|td| td.tool.clone())
            .collect();

        let request_config = RequestConfig {
            model: config.model.clone(),
            max_tokens: config.max_tokens,
            temperature: Some(0.7),
            system: config.system_prompt.clone(),
            tools,
            thinking: None,
        };

        assert_eq!(request_config.model, "claude-sonnet-4-5-20250514");
        assert_eq!(request_config.max_tokens, 8192);
        assert!(request_config.system.is_some());
        assert!(!request_config.tools.is_empty());
    }

    #[test]
    fn test_thinking_config_with_budget() {
        let config = NativeAgentConfig {
            model: "claude-opus-4-5-20251101".to_string(),
            max_tokens: 16384,
            system_prompt: None,
            thinking_enabled: true,
            thinking_budget: 15000,
            cwd: ".".to_string(),
        };

        let thinking = if config.thinking_enabled {
            Some(ThinkingConfig::enabled(config.thinking_budget))
        } else {
            None
        };

        assert!(thinking.is_some());
        let thinking = thinking.unwrap();
        assert_eq!(thinking.thinking_type, "enabled");
        assert_eq!(thinking.budget_tokens, 15000);
    }

    #[test]
    fn test_from_agent_variants() {
        // Test that FromAgent variants serialize/deserialize correctly
        let ready = FromAgent::Ready {
            model: "claude-sonnet".to_string(),
            provider: "Anthropic".to_string(),
        };
        if let FromAgent::Ready { model, provider } = ready {
            assert_eq!(model, "claude-sonnet");
            assert_eq!(provider, "Anthropic");
        } else {
            panic!("Expected Ready variant");
        }

        let chunk = FromAgent::ResponseChunk {
            response_id: "resp_123".to_string(),
            content: "Hello".to_string(),
            is_thinking: false,
        };
        if let FromAgent::ResponseChunk { content, is_thinking, .. } = chunk {
            assert_eq!(content, "Hello");
            assert!(!is_thinking);
        } else {
            panic!("Expected ResponseChunk variant");
        }
    }

    #[test]
    fn test_tool_result_structure() {
        let success_result = ToolResult {
            success: true,
            output: "Command executed successfully".to_string(),
            error: None,
        };
        assert!(success_result.success);
        assert!(!success_result.output.is_empty());
        assert!(success_result.error.is_none());

        let error_result = ToolResult {
            success: false,
            output: String::new(),
            error: Some("Permission denied".to_string()),
        };
        assert!(!error_result.success);
        assert!(error_result.output.is_empty());
        assert!(error_result.error.is_some());
    }
}
