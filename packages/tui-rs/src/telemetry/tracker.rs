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
    cost_complete: bool,
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
            cost_complete: true,
        }
    }

    /// Bind future turns to the saved conversation used by transcript capture.
    pub fn set_session_id(&mut self, session_id: String) {
        self.config.session_id = session_id;
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
            FromAgent::BoostChanged { status, .. } => {
                use crate::model_dynamics::BoostStatus;
                let features = &mut self.context.features;
                match status {
                    BoostStatus::Suggested => features.boost_suggested = true,
                    BoostStatus::Pending => features.boost_requested = true,
                    BoostStatus::Active => features.boost_applied = true,
                    BoostStatus::Idle => return None,
                }
                if let Some(turn) = &mut self.current_turn {
                    turn.set_features(features.clone());
                }
                None
            }
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
            FromAgent::StreamObservation { observation } => {
                if let Some(turn) = &mut self.current_turn {
                    turn.record_stream_observation(*observation);
                }
                None
            }
            FromAgent::RequestRetryObservation => {
                if let Some(turn) = &mut self.current_turn {
                    turn.record_request_retry();
                }
                None
            }
            FromAgent::CompactionMeasured { duration_ms } => {
                if let Some(turn) = &mut self.current_turn {
                    turn.record_compaction_duration(*duration_ms);
                }
                None
            }
            FromAgent::ResponseChunk {
                content,
                is_thinking,
                ..
            } => {
                if !is_thinking && !content.is_empty() {
                    if let Some(turn) = &mut self.current_turn {
                        turn.record_output();
                    }
                }
                None
            }
            FromAgent::Compaction {
                auto,
                tokens_before,
                ..
            } => {
                if let Some(turn) = &mut self.current_turn {
                    turn.record_compaction(*auto, *tokens_before);
                }
                None
            }
            FromAgent::ToolStart { .. } => {
                // Skip - ToolCall already records the start with the actual tool name.
                // ToolStart fires after ToolCall and would overwrite with "unknown".
                None
            }
            FromAgent::ToolEnd {
                call_id,
                success,
                receipt,
                ..
            } => {
                if let Some(ref mut turn) = self.current_turn {
                    turn.record_tool_receipt(call_id, receipt.as_ref());
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
            FromAgent::ResponseEnd { response_id, usage } => {
                // Count only the end paired with the active provider response.
                // Native also emits a UI cleanup ResponseEnd after its final
                // provider end; it must not invent another unmetered response.
                if self.current_response_id.as_ref() != Some(response_id) {
                    return None;
                }
                self.current_response_id = None;
                // A provider response can be followed by tools and another
                // model call. Record its timing/usage without declaring the
                // enclosing native turn successful.
                if let Some(ref mut turn) = self.current_turn {
                    turn.record_llm_end();
                    turn.record_response_coverage(
                        usage.is_some(),
                        usage.as_ref().and_then(|value| value.cost).is_some(),
                    );
                }
                self.cost_complete &= usage.as_ref().and_then(|usage| usage.cost).is_some();
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
            FromAgent::TurnInterrupted { .. } => {
                // The native producer emits this event when a request is cancelled.
                let mut event = self.end_turn(TurnStatus::Aborted, None)?;
                event.abort_reason = Some(crate::telemetry::AbortReason::User);
                Some(event)
            }
            FromAgent::CodexUsageState {
                usage: Some(usage), ..
            } => {
                self.cost_complete = usage.cost.is_some();
                self.accumulated_usage = Some(usage.clone());
                None
            }
            FromAgent::Error {
                message,
                fatal,
                terminal,
                ..
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
        self.cost_complete = true;
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
        // Reset at the task terminal event, not at model restoration: an
        // unavailable boost may restore Idle before the first response starts.
        self.context.features.boost_suggested = false;
        self.context.features.boost_requested = false;
        self.context.features.boost_applied = false;
        let mut turn = self.current_turn.take()?;
        let identity_scope = self.current_identity_scope.take();
        if self.current_response_id.is_some() {
            turn.record_llm_end();
            turn.record_response_coverage(false, false);
            self.cost_complete = false;
        }
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
        event.reported_cost_usd = self
            .accumulated_usage
            .as_ref()
            .and_then(|usage| usage.cost)
            .filter(|cost| self.cost_complete && cost.is_finite() && *cost >= 0.0);
        event.identity_scope = identity_scope;
        Some(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_session_identity_survives_mid_turn_changes_and_resume() {
        let mut tracker = TurnTracker::new(TurnTrackerConfig {
            session_id: "runtime-run".into(),
            sampling_config: TailSamplingConfig::default(),
        });
        tracker.set_session_id("saved-conversation".into());
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "response-1".into(),
        });
        tracker.set_session_id("resumed-conversation".into());
        assert_eq!(
            tracker
                .end_turn(TurnStatus::Success, None)
                .unwrap()
                .session_id,
            "saved-conversation"
        );
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "response-2".into(),
        });
        assert_eq!(
            tracker
                .end_turn(TurnStatus::Success, None)
                .unwrap()
                .session_id,
            "resumed-conversation"
        );
    }

    #[test]
    fn response_coverage_requires_matching_open_response_and_ignores_cleanup() {
        let mut tracker = TurnTracker::new(TurnTrackerConfig {
            session_id: "coverage".into(),
            sampling_config: TailSamplingConfig::default(),
        });
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "provider".into(),
        });
        // An unmatched end must not consume the active provider response.
        tracker.handle_event(&FromAgent::ResponseEnd {
            response_id: "cleanup".into(),
            usage: None,
        });
        let usage = TokenUsage {
            input_tokens: 12,
            output_tokens: 4,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost: Some(0.01),
        };
        tracker.handle_event(&FromAgent::ResponseEnd {
            response_id: "provider".into(),
            usage: Some(usage.clone()),
        });
        // Duplicate provider end and native UI cleanup both carry no new response.
        tracker.handle_event(&FromAgent::ResponseEnd {
            response_id: "provider".into(),
            usage: Some(usage),
        });
        tracker.handle_event(&FromAgent::ResponseEnd {
            response_id: "done".into(),
            usage: None,
        });
        let event = tracker.end_turn(TurnStatus::Success, None).unwrap();
        let m = event.measurements.unwrap();
        assert_eq!(
            (
                m.response_count,
                m.responses_with_usage,
                m.responses_with_cost
            ),
            (1, 1, 1)
        );
        assert_eq!(event.tokens.input, 12);
        assert_eq!(event.reported_cost_usd, Some(0.01));

        // A real matched response with missing usage still counts as unmetered,
        // even if its arbitrary response ID happens to equal the cleanup label.
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "done".into(),
        });
        tracker.handle_event(&FromAgent::ResponseEnd {
            response_id: "done".into(),
            usage: None,
        });
        let event = tracker.end_turn(TurnStatus::Success, None).unwrap();
        let m = event.measurements.unwrap();
        assert_eq!(
            (
                m.response_count,
                m.responses_with_usage,
                m.responses_with_cost
            ),
            (1, 0, 0)
        );
        assert_eq!(event.reported_cost_usd, None);
    }

    #[test]
    fn tracker_measurements_preserve_missingness_and_observed_output() {
        let mut tracker = TurnTracker::new(TurnTrackerConfig {
            session_id: "fixture".into(),
            sampling_config: TailSamplingConfig::default(),
        });
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "r".into(),
        });
        for (content, is_thinking) in [("", false), ("private reasoning", true)] {
            tracker.handle_event(&FromAgent::ResponseChunk {
                response_id: "r".into(),
                content: content.into(),
                is_thinking,
            });
        }
        let missing = tracker
            .end_turn(TurnStatus::Success, None)
            .unwrap()
            .measurements
            .unwrap();
        assert_eq!(missing.first_output_ms, None);
        assert_eq!(missing.stream_stall_count, None);
        assert_eq!(missing.stream_open_failure_count, None);
        assert_eq!(missing.responses_with_usage, 0);
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "r2".into(),
        });
        tracker.handle_event(&FromAgent::ResponseChunk {
            response_id: "r2".into(),
            content: "visible output".into(),
            is_thinking: false,
        });
        for observation in [
            crate::ai::StreamObservation::Observed,
            crate::ai::StreamObservation::OpenFailed,
            crate::ai::StreamObservation::IdleTimeout,
            crate::ai::StreamObservation::Retry,
            crate::ai::StreamObservation::Recovery,
        ] {
            tracker.handle_event(&FromAgent::StreamObservation { observation });
        }
        tracker.handle_event(&FromAgent::RequestRetryObservation);
        let observed = tracker
            .end_turn(TurnStatus::Success, None)
            .unwrap()
            .measurements
            .unwrap();
        assert!(observed.first_output_ms.is_some());
        assert_eq!(observed.stream_stall_count, Some(1));
        assert_eq!(observed.stream_open_failure_count, Some(1));
        assert_eq!(observed.stream_disconnect_count, Some(0));
        assert_eq!(observed.stream_retry_count, Some(1));
        assert_eq!(observed.stream_recovery_count, Some(1));
        assert_eq!(observed.request_retry_count, 1);
    }

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
            coding_completion: None,
            coding_child_records: Vec::new(),
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
                coding_completion: None,
                coding_child_records: Vec::new(),
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
                coding_completion: None,
                coding_child_records: Vec::new(),
            })
            .expect("origin turn completion");
        assert_eq!(origin_event.identity_scope, Some(origin_scope));

        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "switched-response".to_string(),
        });
        let switched_event = tracker
            .handle_event(&FromAgent::TurnCompleted {
                response_id: "switched-complete".to_string(),
                coding_completion: None,
                coding_child_records: Vec::new(),
            })
            .expect("switched turn completion");
        assert_eq!(switched_event.identity_scope, Some(switched_scope));
    }
}

#[cfg(test)]
mod boost_tests {
    use super::*;
    #[test]
    fn boost_measurements_survive_restore_and_partial_cost_is_unavailable() {
        use crate::model_dynamics::BoostStatus;
        let mut tracker = TurnTracker::new(TurnTrackerConfig {
            session_id: "boost-test".into(),
            sampling_config: TailSamplingConfig::default(),
        });
        tracker.handle_event(&FromAgent::BoostChanged {
            status: BoostStatus::Pending,
            thinking: None,
        });
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "one".into(),
        });
        tracker.handle_event(&FromAgent::BoostChanged {
            status: BoostStatus::Suggested,
            thinking: None,
        });
        tracker.handle_event(&FromAgent::BoostChanged {
            status: BoostStatus::Active,
            thinking: None,
        });
        for cost in [Some(0.01), None] {
            tracker.handle_event(&FromAgent::ResponseStart {
                response_id: "one".into(),
            });
            tracker.handle_event(&FromAgent::ResponseEnd {
                response_id: "one".into(),
                usage: Some(TokenUsage {
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                    cost,
                }),
            });
        }
        tracker.handle_event(&FromAgent::BoostChanged {
            status: BoostStatus::Idle,
            thinking: None,
        });
        let event = tracker
            .handle_event(&FromAgent::TurnCompleted {
                response_id: "one".into(),
                coding_completion: None,
                coding_child_records: Vec::new(),
            })
            .unwrap();
        let exported = event.external_projection();
        assert!(exported.boost_requested && exported.boost_suggested && exported.boost_applied);
        assert!(exported.reported_cost_usd.is_none());
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "two".into(),
        });
        tracker.handle_event(&FromAgent::ResponseEnd {
            response_id: "two".into(),
            usage: Some(TokenUsage {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cost: Some(0.02),
            }),
        });
        let event = tracker
            .handle_event(&FromAgent::TurnCompleted {
                response_id: "two".into(),
                coding_completion: None,
                coding_child_records: Vec::new(),
            })
            .unwrap();
        assert!(
            !event.features.boost_applied
                && !event.features.boost_requested
                && !event.features.boost_suggested
        );
        assert_eq!(event.reported_cost_usd, Some(0.02));
    }
}

#[cfg(test)]
mod droid_telemetry_tests {
    use super::*;
    use maestro_runtime::{
        ExecutionPhase, ExecutionReceipt, ExecutionSource, ExecutionStatus, ToolReceiptDetails,
    };

    fn tracker() -> TurnTracker {
        let mut tracker = TurnTracker::new(TurnTrackerConfig {
            session_id: "private-session".into(),
            sampling_config: TailSamplingConfig::default(),
        });
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "r".into(),
        });
        tracker
    }

    #[test]
    fn unfinished_response_cannot_export_a_complete_cost() {
        let mut tracker = tracker();
        tracker.handle_event(&FromAgent::ResponseEnd {
            response_id: "r".into(),
            usage: Some(TokenUsage {
                input_tokens: 10,
                output_tokens: 2,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cost: Some(0.25),
            }),
        });
        tracker.handle_event(&FromAgent::ResponseStart {
            response_id: "unfinished".into(),
        });
        let event = tracker
            .handle_event(&FromAgent::TurnInterrupted {
                response_id: "unfinished".into(),
                reason: "cancelled".into(),
            })
            .unwrap();
        assert!(event.reported_cost_usd.is_none());
        assert_eq!(event.status, TurnStatus::Aborted);
        assert_eq!(
            event.abort_reason,
            Some(crate::telemetry::AbortReason::User)
        );
    }

    #[test]
    fn receipt_outcomes_separate_denials_and_cancellation_from_failures() {
        let mut tracker = tracker();
        let statuses = [
            ExecutionStatus::Succeeded,
            ExecutionStatus::Failed,
            ExecutionStatus::Denied,
            ExecutionStatus::Cancelled {
                phase: ExecutionPhase::Queued,
            },
            ExecutionStatus::Indeterminate,
        ];
        for (index, status) in statuses.into_iter().enumerate() {
            let id = index.to_string();
            tracker.handle_event(&FromAgent::ToolCall {
                call_id: id.clone(),
                tool: "private-mcp-name".into(),
                args: serde_json::json!({"secret": "never-export"}),
                requires_approval: false,
                approval_inline_env: None,
            });
            let end = FromAgent::ToolEnd {
                call_id: id.clone(),
                success: status == ExecutionStatus::Succeeded,
                result: None,
                receipt: Some(ExecutionReceipt {
                    code_authority: None,
                    call_id: id,
                    tool_name: "private-mcp-name".into(),
                    source: ExecutionSource::Native,
                    status,
                    duration_ms: Some(37),
                    policy: None,
                    details: ToolReceiptDetails::None,
                }),
            };
            tracker.handle_event(&end);
            tracker.handle_event(&end); // replay must not count twice
        }
        let external = tracker
            .end_turn(TurnStatus::Success, None)
            .unwrap()
            .external_projection();
        let json = serde_json::to_value(external).unwrap();
        assert_eq!(json["tool_outcomes"]["succeeded"], 1);
        assert_eq!(json["tool_outcomes"]["failed"], 1);
        assert_eq!(json["tool_outcomes"]["denied"], 1);
        assert_eq!(json["tool_outcomes"]["cancelled"], 1);
        assert_eq!(json["tool_outcomes"]["indeterminate"], 1);
        assert_eq!(json["tool_outcomes"]["measured_execution_count"], 3);
        assert_eq!(json["tool_outcomes"]["execution_duration_ms"], 111);
        assert!(!json.to_string().contains("private-mcp-name"));
        assert!(!json.to_string().contains("never-export"));
    }
}
