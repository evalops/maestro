//! Turn Tracker - Integrates TurnCollector with Agent Events
//!
//! Tracks agent turns by observing FromAgent events and emits canonical
//! wide events at turn completion.

use crate::agent::{FromAgent, TokenUsage};
use crate::telemetry::{
    ApprovalMode, CanonicalTurnEvent, ErrorDetails, FeatureFlags, ModelInfo, SandboxMode,
    TailSamplingConfig, TokenUsage as TelemetryTokenUsage, TurnCollector, TurnStatus,
};

/// Configuration for turn tracking.
#[derive(Clone)]
pub struct TurnTrackerConfig {
    /// Session ID for the current session
    pub session_id: String,
    /// Sampling configuration
    pub sampling_config: TailSamplingConfig,
}

/// Context that can be updated during the session.
#[derive(Clone, Default)]
pub struct TurnTrackerContext {
    /// Current model info
    pub model: Option<ModelInfo>,
    /// Sandbox mode in use
    pub sandbox_mode: SandboxMode,
    /// Approval mode in use
    pub approval_mode: ApprovalMode,
    /// Active MCP server names
    pub mcp_servers: Vec<String>,
    /// Number of context sources
    pub context_source_count: u32,
    /// Feature flags
    pub features: FeatureFlags,
}

/// Tracks agent turns and emits canonical wide events.
pub struct TurnTracker {
    config: TurnTrackerConfig,
    context: TurnTrackerContext,
    turn_number: u32,
    current_turn: Option<TurnCollector>,
    current_response_id: Option<String>,
    accumulated_usage: Option<TokenUsage>,
}

impl TurnTracker {
    /// Create a new turn tracker.
    pub fn new(config: TurnTrackerConfig) -> Self {
        Self {
            config,
            context: TurnTrackerContext::default(),
            turn_number: 0,
            current_turn: None,
            current_response_id: None,
            accumulated_usage: None,
        }
    }

    /// Update the context for future turns.
    pub fn update_context(&mut self, context: TurnTrackerContext) {
        self.context = context;
    }

    /// Update model info.
    pub fn set_model(&mut self, model: ModelInfo) {
        if let Some(ref mut turn) = self.current_turn {
            turn.set_model(model.clone());
        }
        self.context.model = Some(model);
    }

    /// Get the current turn number.
    pub fn turn_number(&self) -> u32 {
        self.turn_number
    }

    /// Handle an agent event. Returns the canonical event if a turn completed.
    pub fn handle_event(&mut self, event: &FromAgent) -> Option<CanonicalTurnEvent> {
        match event {
            FromAgent::ResponseStart { response_id } => {
                self.start_turn(response_id.clone());
                // Record LLM start time
                if let Some(ref mut turn) = self.current_turn {
                    turn.record_llm_start();
                }
                None
            }
            FromAgent::ToolStart { .. } => {
                // Skip - ToolCall already records the start with the actual tool name.
                // ToolStart fires after ToolCall and would overwrite with "unknown".
                None
            }
            FromAgent::ToolEnd {
                call_id, success, ..
            } => {
                if let Some(ref mut turn) = self.current_turn {
                    turn.record_tool_end(call_id, *success, None, None);
                }
                None
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                ..
            } => {
                if let Some(ref mut turn) = self.current_turn {
                    let input_size = serde_json::to_string(args)
                        .map(|s| s.len() as u64)
                        .unwrap_or(0);
                    turn.record_tool_start(tool, call_id, Some(input_size));
                }
                None
            }
            FromAgent::ResponseEnd { usage, .. } => {
                // Record LLM end time before completing the turn
                if let Some(ref mut turn) = self.current_turn {
                    turn.record_llm_end();
                }
                self.accumulated_usage = usage.clone();
                self.end_turn(TurnStatus::Success, None)
            }
            FromAgent::Error { message, fatal } => {
                // Only end turn on fatal errors. Non-fatal errors are informational
                // (e.g., "Attachment blocked", "Attachment too large") and the turn continues.
                if *fatal {
                    self.end_turn(
                        TurnStatus::Error,
                        Some(ErrorDetails {
                            category: Some("runtime".to_string()),
                            message: Some(message.clone()),
                        }),
                    )
                } else {
                    None
                }
            }
            FromAgent::Status { .. } => {
                // Status messages are informational (e.g., "Rate limit. Retrying in 1.5s...")
                // and shouldn't end the turn. Rate limiting is handled by ResponseEnd or Error.
                None
            }
            _ => None,
        }
    }

    fn start_turn(&mut self, response_id: String) {
        self.turn_number += 1;
        self.accumulated_usage = None;
        self.current_response_id = Some(response_id);

        let mut turn = TurnCollector::new(
            &self.config.session_id,
            self.turn_number,
            self.config.sampling_config.clone(),
        );

        // Set model from context
        if let Some(ref model) = self.context.model {
            turn.set_model(model.clone());
        }

        // Set context
        turn.set_sandbox_mode(self.context.sandbox_mode);
        turn.set_approval_mode(self.context.approval_mode);
        turn.set_mcp_servers(self.context.mcp_servers.clone());
        turn.set_context_source_count(self.context.context_source_count);
        turn.set_features(self.context.features.clone());

        self.current_turn = Some(turn);
    }

    fn end_turn(
        &mut self,
        status: TurnStatus,
        error_details: Option<ErrorDetails>,
    ) -> Option<CanonicalTurnEvent> {
        let turn = self.current_turn.take()?;
        self.current_response_id = None;

        // Convert token usage
        let tokens = self
            .accumulated_usage
            .as_ref()
            .map(|u| TelemetryTokenUsage {
                input: u.input_tokens,
                output: u.output_tokens,
                cache_read: u.cache_read_tokens,
                cache_write: u.cache_write_tokens,
                thinking: None,
            })
            .unwrap_or_default();

        let cost_usd = self
            .accumulated_usage
            .as_ref()
            .and_then(|u| u.cost)
            .unwrap_or(0.0);

        Some(turn.complete(status, tokens, cost_usd, error_details, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_turn_tracking() {
        let config = TurnTrackerConfig {
            session_id: "test-session".to_string(),
            sampling_config: TailSamplingConfig::default(),
        };
        let mut tracker = TurnTracker::new(config);

        // Start a turn
        let event = tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });
        assert!(event.is_none());
        assert_eq!(tracker.turn_number(), 1);

        // Tool call
        let event = tracker.handle_event(&FromAgent::ToolCall {
            call_id: "call-1".to_string(),
            tool: "bash".to_string(),
            args: serde_json::json!({"command": "ls"}),
            requires_approval: false,
        });
        assert!(event.is_none());

        // Tool end
        let event = tracker.handle_event(&FromAgent::ToolEnd {
            call_id: "call-1".to_string(),
            success: true,
        });
        assert!(event.is_none());

        // Response end
        let event = tracker.handle_event(&FromAgent::ResponseEnd {
            response_id: "resp-1".to_string(),
            usage: Some(TokenUsage {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cost: Some(0.01),
            }),
        });
        assert!(event.is_some());
        let event = event.unwrap();
        assert_eq!(event.turn_number, 1);
        assert_eq!(event.status, TurnStatus::Success);
        assert_eq!(event.tool_count, 1);
    }
}
