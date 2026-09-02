//! Turn Tracker - Integrates `TurnCollector` with Agent Events
//!
//! Tracks agent turns by observing `FromAgent` events and emits canonical
//! wide events at turn completion.

use crate::agent::{FromAgent, TokenUsage};
use crate::telemetry::{
    ApprovalMode, CanonicalTurnEvent, ErrorDetails, FeatureFlags, ModelInfo, SandboxMode,
    TailSamplingConfig, TelemetryIdentityScope, TokenUsage as TelemetryTokenUsage, TurnCollector,
    TurnStatus,
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
    /// Identity tenant scope verified before the model turn. This stays on the
    /// canonical event only so the private first-party outbox can reject a
    /// retry under a different signed-in tenant.
    pub identity_scope: Option<TelemetryIdentityScope>,
}

/// Tracks agent turns and emits canonical wide events.
pub struct TurnTracker {
    config: TurnTrackerConfig,
    context: TurnTrackerContext,
    turn_number: u32,
    current_turn: Option<TurnCollector>,
    current_identity_scope: Option<TelemetryIdentityScope>,
    current_response_id: Option<String>,
    accumulated_usage: Option<TokenUsage>,
}

impl TurnTracker {
    /// Create a new turn tracker.
    #[must_use]
    pub fn new(config: TurnTrackerConfig) -> Self {
        Self {
            config,
            context: TurnTrackerContext::default(),
            turn_number: 0,
            current_turn: None,
            current_identity_scope: None,
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

    /// Update the verified Identity scope used by turns that start after this
    /// point. A running turn retains the scope captured at `ResponseStart`.
    pub fn set_identity_scope(&mut self, identity_scope: Option<TelemetryIdentityScope>) {
        self.context.identity_scope = identity_scope;
    }

    /// Get the current turn number.
    #[must_use]
    pub fn turn_number(&self) -> u32 {
        self.turn_number
    }

    /// Handle an agent event. Returns the canonical event if a turn completed.
    pub fn handle_event(&mut self, event: &FromAgent) -> Option<CanonicalTurnEvent> {
        match event {
            FromAgent::Ready { model, provider } | FromAgent::ModelChanged { model, provider } => {
                self.set_model(ModelInfo {
                    id: model.clone(),
                    provider: provider.clone(),
                    thinking_level: crate::telemetry::ThinkingLevel::Off,
                });
                None
            }
            FromAgent::ResponseStart { response_id } => {
                if self.current_turn.is_none() {
                    self.start_turn(response_id.clone());
                } else {
                    self.current_response_id = Some(response_id.clone());
                }
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
                // A provider response can be followed by tools and another
                // model call. Record its timing/usage without declaring the
                // enclosing native turn successful.
                if let Some(ref mut turn) = self.current_turn {
                    turn.record_llm_end();
                }
                if let Some(usage) = usage {
                    if let Some(total) = self.accumulated_usage.as_mut() {
                        total.input_tokens = total.input_tokens.saturating_add(usage.input_tokens);
                        total.output_tokens =
                            total.output_tokens.saturating_add(usage.output_tokens);
                        total.cache_read_tokens = total
                            .cache_read_tokens
                            .saturating_add(usage.cache_read_tokens);
                        total.cache_write_tokens = total
                            .cache_write_tokens
                            .saturating_add(usage.cache_write_tokens);
                        total.cost = match (total.cost, usage.cost) {
                            (Some(previous), Some(current)) => Some(previous + current),
                            (previous, current) => previous.or(current),
                        };
                    } else {
                        self.accumulated_usage = Some(usage.clone());
                    }
                }
                None
            }
            FromAgent::TurnCompleted { .. } => self.end_turn(TurnStatus::Success, None),
            FromAgent::TurnInterrupted { reason, .. } => self.end_turn(
                TurnStatus::Error,
                Some(ErrorDetails {
                    category: Some("interrupted".to_string()),
                    message: Some(reason.clone()),
                }),
            ),
            FromAgent::CodexUsageState {
                usage: Some(usage), ..
            } => {
                self.accumulated_usage = Some(usage.clone());
                None
            }
            FromAgent::Error {
                message,
                fatal,
                terminal,
            } => {
                // Only end turn on fatal errors. Non-fatal errors are informational
                // (e.g., "Attachment blocked", "Attachment too large") and the turn continues.
                if *fatal || *terminal {
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
            FromAgent::ProviderError { kind, message } => self.end_turn(
                TurnStatus::Error,
                Some(ErrorDetails {
                    category: Some(format!("provider_{kind:?}").to_ascii_lowercase()),
                    message: Some(message.clone()),
                }),
            ),
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
        self.current_identity_scope = self.context.identity_scope.clone();

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
        let identity_scope = self.current_identity_scope.take();
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

        let mut event = turn.complete(status, tokens, cost_usd, error_details, None);
        event.identity_scope = identity_scope;
        Some(event)
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
            approval_inline_env: None,
        });
        assert!(event.is_none());

        // Tool end
        let event = tracker.handle_event(&FromAgent::ToolEnd {
            call_id: "call-1".to_string(),
            success: true,
            result: None,
            receipt: None,
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
        assert!(event.is_none(), "model response end is not a turn terminal");
        let event = tracker.handle_event(&FromAgent::TurnCompleted {
            response_id: "done".to_string(),
        });
        assert!(event.is_some());
        let event = event.unwrap();
        assert_eq!(event.turn_number, 1);
        assert_eq!(event.status, TurnStatus::Success);
        assert_eq!(event.tool_count, 1);
    }

    #[test]
    fn response_end_then_provider_error_records_error_not_success() {
        let mut tracker = TurnTracker::new(TurnTrackerConfig {
            session_id: "provider-error-session".to_string(),
            sampling_config: TailSamplingConfig::default(),
        });
        assert!(
            tracker
                .handle_event(&FromAgent::ResponseStart {
                    response_id: "resp-1".to_string(),
                })
                .is_none()
        );
        assert!(
            tracker
                .handle_event(&FromAgent::ResponseEnd {
                    response_id: "resp-1".to_string(),
                    usage: None,
                })
                .is_none()
        );

        let event = tracker
            .handle_event(&FromAgent::ProviderError {
                kind: maestro_ai::ProviderStreamErrorKind::TransientProtocol,
                message: "missing terminal event".to_string(),
            })
            .expect("provider terminal should end telemetry turn");
        assert_eq!(event.status, TurnStatus::Error);
        assert_eq!(
            event.error_message.as_deref(),
            Some("missing terminal event")
        );
    }

    #[test]
    fn successful_multi_response_turn_accumulates_usage_until_turn_terminal() {
        let mut tracker = TurnTracker::new(TurnTrackerConfig {
            session_id: "multi-response-session".to_string(),
            sampling_config: TailSamplingConfig::default(),
        });
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "resp-1".to_string(),
        });
        for (response_id, input_tokens, output_tokens, cost) in
            [("resp-1", 10, 4, 0.01), ("resp-2", 20, 6, 0.02)]
        {
            if response_id == "resp-2" {
                assert!(
                    tracker
                        .handle_event(&FromAgent::ResponseStart {
                            response_id: response_id.to_string(),
                        })
                        .is_none()
                );
                assert_eq!(tracker.turn_number(), 1);
            }
            assert!(
                tracker
                    .handle_event(&FromAgent::ResponseEnd {
                        response_id: response_id.to_string(),
                        usage: Some(TokenUsage {
                            input_tokens,
                            output_tokens,
                            cache_read_tokens: 0,
                            cache_write_tokens: 0,
                            cost: Some(cost),
                        }),
                    })
                    .is_none()
            );
        }

        let event = tracker
            .handle_event(&FromAgent::TurnCompleted {
                response_id: "done".to_string(),
            })
            .expect("explicit terminal should complete telemetry turn");
        assert_eq!(event.tokens.input, 30);
        assert_eq!(event.tokens.output, 10);
        assert!((event.cost_usd - 0.03).abs() < f64::EPSILON);
    }

    #[test]
    fn turn_keeps_the_identity_scope_verified_at_response_start() {
        let mut tracker = TurnTracker::new(TurnTrackerConfig {
            session_id: "identity-scope-session".to_string(),
            sampling_config: TailSamplingConfig::default(),
        });
        let origin_scope = TelemetryIdentityScope::new("org-a", Some("workspace-a"))
            .expect("complete origin scope");
        let switched_scope = TelemetryIdentityScope::new("org-b", Some("workspace-b"))
            .expect("complete switched scope");

        tracker.set_identity_scope(Some(origin_scope.clone()));
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "origin-response".to_string(),
        });
        tracker.set_identity_scope(Some(switched_scope.clone()));
        let origin_event = tracker
            .handle_event(&FromAgent::TurnCompleted {
                response_id: "origin-complete".to_string(),
            })
            .expect("origin turn completion");
        assert_eq!(origin_event.identity_scope, Some(origin_scope));

        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "switched-response".to_string(),
        });
        let switched_event = tracker
            .handle_event(&FromAgent::TurnCompleted {
                response_id: "switched-complete".to_string(),
            })
            .expect("switched turn completion");
        assert_eq!(switched_event.identity_scope, Some(switched_scope));
    }
}
