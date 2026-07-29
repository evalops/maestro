use super::manifests::*;
use super::*;

impl SharedRunner {
    #[cfg(test)]
    pub(super) fn new(config: HostedRunnerConfig) -> Self {
        Self::new_with_message_executor_and_restore(
            config,
            Arc::new(TransportOnlyHostedRunnerMessageExecutor),
            None,
        )
    }

    pub(super) fn new_with_message_executor_and_restore(
        config: HostedRunnerConfig,
        message_executor: Arc<dyn HostedRunnerHeadlessMessageExecutor>,
        restore_manifest: Option<SnapshotManifest>,
    ) -> Self {
        let session_id = config
            .maestro_session_id
            .clone()
            .or_else(|| {
                restore_manifest
                    .as_ref()
                    .map(|manifest| manifest.maestro_session_id.clone())
            })
            .unwrap_or_else(|| config.runner_session_id.clone());
        let (events, _) = broadcast::channel(MAX_EVENTS);
        let restored_snapshot = restore_manifest
            .as_ref()
            .map(|manifest| manifest.snapshot.clone());
        let restored_cursor = restore_manifest
            .as_ref()
            .and_then(|manifest| manifest.runtime.cursor)
            .or_else(|| restored_snapshot.as_ref().map(|snapshot| snapshot.cursor));
        let last_init = restored_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.last_init.as_ref())
            .and_then(RuntimeInitSnapshot::to_init_config);
        let restore_status = restore_manifest
            .as_ref()
            .map(|manifest| manifest.runtime.flush_status);
        let restore_ready = restore_status
            .map(RuntimeFlushStatus::is_completed)
            .unwrap_or(true);
        let restore_last_error = restore_manifest.as_ref().and_then(|manifest| {
            manifest
                .runtime
                .flush_status
                .restore_last_error(manifest.runtime.error.as_deref())
        });
        let restore_last_error_type = restore_last_error.as_ref().map(|_| "protocol".to_string());
        let shared = Self {
            config: Arc::new(config),
            state: Arc::new(Mutex::new(RunnerState {
                ready: restore_ready,
                draining: false,
                session_id,
                cursor: restored_cursor.unwrap_or(0),
                last_init,
                last_status: Some(
                    restore_status
                        .map(RuntimeFlushStatus::restore_last_status)
                        .unwrap_or("Ready")
                        .to_string(),
                ),
                last_error: restore_last_error,
                last_error_type: restore_last_error_type,
                restored_snapshot,
                controller_connection_id: None,
                connections: HashMap::new(),
                subscriptions: HashMap::new(),
                active_utility_commands: HashMap::new(),
                active_file_watches: HashMap::new(),
                active_response_ids: HashSet::new(),
                envelopes: VecDeque::new(),
            })),
            events,
            message_executor,
        };
        if restore_manifest.is_some() {
            let envelope = shared.reset_envelope("restored_from_snapshot");
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.envelopes.push_back(envelope);
        }
        shared
    }

    pub(super) fn identity(&self) -> HostedRunnerIdentity {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        HostedRunnerIdentity {
            protocol_version: HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION.to_string(),
            runner_session_id: self.config.runner_session_id.clone(),
            owner_instance_id: self.config.owner_instance_id.clone(),
            ready: state.ready,
            draining: state.draining,
        }
    }

    pub(super) fn ensure_attachable(&self) -> HostedResult<()> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !state.ready || state.draining {
            return Err(HostedError::new(
                HostedRunnerErrorCode::RuntimeNotReady,
                "hosted runner is not accepting new attachments",
            ));
        }
        Ok(())
    }

    pub(super) fn snapshot(&self, state: &RunnerState) -> RuntimeSnapshot {
        let agent_state = self.message_executor.state().ok().flatten();
        let agent_state = agent_state.as_ref();
        let restored_state = state
            .restored_snapshot
            .as_ref()
            .map(|snapshot| &snapshot.state);
        let restored_pending_state = state
            .restored_snapshot
            .as_ref()
            .filter(|snapshot| state.cursor <= snapshot.cursor)
            .map(|snapshot| &snapshot.state);
        let prefer_restored_host_state = state.restored_snapshot.is_some();
        let host_ready = state.ready && !state.draining;
        let controller_subscription_id = state
            .controller_connection_id
            .as_ref()
            .and_then(|connection_id| state.connections.get(connection_id))
            .and_then(|connection| {
                connection
                    .subscription_ids
                    .iter()
                    .filter(|subscription_id| {
                        state
                            .subscriptions
                            .get(*subscription_id)
                            .map(|subscription| subscription.role == ConnectionRole::Controller)
                            .unwrap_or(false)
                    })
                    .min()
                    .cloned()
            });
        let preferred_connection = state
            .controller_connection_id
            .as_ref()
            .and_then(|connection_id| state.connections.get(connection_id))
            .or_else(|| state.connections.values().next());
        let connections = state
            .connections
            .values()
            .map(|connection| {
                let attached_subscription_count = connection
                    .subscription_ids
                    .iter()
                    .filter(|subscription_id| {
                        state
                            .subscriptions
                            .get(*subscription_id)
                            .map(|subscription| subscription.attached)
                            .unwrap_or(false)
                    })
                    .count();
                ConnectionState {
                    connection_id: connection.id.clone(),
                    role: connection.role,
                    client_protocol_version: connection.client_protocol_version.clone(),
                    client_info: connection.client_info.clone(),
                    capabilities: connection.capabilities.clone(),
                    opt_out_notifications: (!connection.opt_out_notifications.is_empty())
                        .then(|| connection.opt_out_notifications.clone()),
                    subscription_count: connection.subscription_ids.len(),
                    attached_subscription_count,
                    controller_lease_granted: state.controller_connection_id.as_deref()
                        == Some(connection.id.as_str()),
                    lease_expires_at: Some(lease_expires_at(connection)),
                }
            })
            .collect();
        let protocol_version = agent_state
            .and_then(|state| state.protocol_version.clone())
            .or_else(|| restored_state.and_then(|state| state.protocol_version.clone()))
            .unwrap_or_else(|| HEADLESS_PROTOCOL_VERSION.to_string());
        let git_branch = agent_state
            .and_then(|state| state.git_branch.clone())
            .or_else(|| restored_state.and_then(|state| state.git_branch.clone()))
            .or_else(|| crate::git::current_branch(&self.config.workspace_root));

        RuntimeSnapshot {
            protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
            session_id: state.session_id.clone(),
            cursor: state.cursor,
            last_init: state.last_init.as_ref().map(RuntimeInitSnapshot::from),
            state: RuntimeStateSnapshot {
                protocol_version: Some(protocol_version),
                client_protocol_version: preferred_connection
                    .and_then(|connection| connection.client_protocol_version.clone())
                    .or_else(|| agent_state.and_then(|state| state.client_protocol_version.clone()))
                    .or_else(|| {
                        restored_state.and_then(|state| state.client_protocol_version.clone())
                    }),
                client_info: preferred_connection
                    .and_then(|connection| connection.client_info.clone())
                    .or_else(|| agent_state.and_then(|state| state.client_info.clone()))
                    .or_else(|| restored_state.and_then(|state| state.client_info.clone())),
                capabilities: preferred_connection
                    .and_then(|connection| connection.capabilities.clone())
                    .or_else(|| agent_state.and_then(|state| state.capabilities.clone()))
                    .or_else(|| restored_state.and_then(|state| state.capabilities.clone())),
                opt_out_notifications: preferred_connection
                    .and_then(|connection| {
                        (!connection.opt_out_notifications.is_empty())
                            .then(|| connection.opt_out_notifications.clone())
                    })
                    .or_else(|| agent_state.and_then(|state| state.opt_out_notifications.clone()))
                    .or_else(|| {
                        restored_state.and_then(|state| state.opt_out_notifications.clone())
                    }),
                connection_role: preferred_connection
                    .map(|connection| connection.role)
                    .or_else(|| agent_state.and_then(|state| state.connection_role))
                    .or_else(|| restored_state.and_then(|state| state.connection_role)),
                connection_count: state.connections.len(),
                subscriber_count: state.subscriptions.len(),
                controller_subscription_id,
                controller_connection_id: state.controller_connection_id.clone(),
                connections,
                model: agent_state
                    .and_then(|state| state.model.clone())
                    .or_else(|| restored_state.and_then(|state| state.model.clone()))
                    .or_else(|| Some("rust-hosted-runner".to_string())),
                provider: agent_state
                    .and_then(|state| state.provider.clone())
                    .or_else(|| restored_state.and_then(|state| state.provider.clone()))
                    .or_else(|| Some("rust".to_string())),
                session_id: if prefer_restored_host_state {
                    Some(state.session_id.clone())
                } else {
                    agent_state
                        .and_then(|state| state.session_id.clone())
                        .or_else(|| restored_state.and_then(|state| state.session_id.clone()))
                        .or_else(|| Some(state.session_id.clone()))
                },
                cwd: agent_state
                    .and_then(|state| state.cwd.clone())
                    .or_else(|| restored_state.and_then(|state| state.cwd.clone()))
                    .or_else(|| Some(self.config.workspace_root.to_string_lossy().to_string())),
                git_branch,
                current_response: None,
                pending_approvals: redacted_pending_snapshot(
                    agent_state.map(|state| state.pending_approvals.as_slice()),
                    restored_pending_state.map(|state| state.pending_approvals.as_slice()),
                ),
                pending_client_tools: redacted_pending_snapshot(
                    agent_state.map(|state| state.pending_client_tools.as_slice()),
                    restored_pending_state.map(|state| state.pending_client_tools.as_slice()),
                ),
                pending_mcp_elicitations: restored_pending_state
                    .map(|state| redacted_pending_request_values(&state.pending_mcp_elicitations))
                    .unwrap_or_default(),
                pending_user_inputs: redacted_pending_snapshot(
                    agent_state.map(|state| state.pending_user_inputs.as_slice()),
                    restored_pending_state.map(|state| state.pending_user_inputs.as_slice()),
                ),
                pending_tool_retries: redacted_pending_snapshot(
                    agent_state.map(|state| state.pending_tool_retries.as_slice()),
                    restored_pending_state.map(|state| state.pending_tool_retries.as_slice()),
                ),
                tracked_tools: Vec::new(),
                active_tools: redacted_active_tool_snapshot(agent_state, restored_pending_state),
                codex_subagent_edges: agent_state
                    .map(|state| state.codex_subagent_edges.clone())
                    .or_else(|| restored_state.map(|state| state.codex_subagent_edges.clone()))
                    .unwrap_or_default(),
                active_utility_commands: state.active_utility_commands.values().cloned().collect(),
                active_file_watches: state.active_file_watches.values().cloned().collect(),
                last_error: if host_ready {
                    agent_state
                        .and_then(|state| state.last_error.clone())
                        .or_else(|| state.last_error.clone())
                        .or_else(|| restored_state.and_then(|state| state.last_error.clone()))
                } else {
                    state
                        .last_error
                        .clone()
                        .or_else(|| agent_state.and_then(|state| state.last_error.clone()))
                        .or_else(|| restored_state.and_then(|state| state.last_error.clone()))
                },
                last_error_type: if host_ready {
                    agent_state
                        .and_then(|state| state.last_error_type)
                        .map(|error_type| json_string_value(&error_type))
                        .or_else(|| state.last_error_type.clone())
                        .or_else(|| restored_state.and_then(|state| state.last_error_type.clone()))
                } else {
                    state
                        .last_error_type
                        .clone()
                        .or_else(|| {
                            agent_state
                                .and_then(|state| state.last_error_type)
                                .map(|error_type| json_string_value(&error_type))
                        })
                        .or_else(|| restored_state.and_then(|state| state.last_error_type.clone()))
                },
                last_status: if host_ready && prefer_restored_host_state {
                    state
                        .last_status
                        .clone()
                        .or_else(|| agent_state.and_then(|state| state.last_status.clone()))
                        .or_else(|| restored_state.and_then(|state| state.last_status.clone()))
                } else if host_ready {
                    agent_state
                        .and_then(|state| state.last_status.clone())
                        .or_else(|| state.last_status.clone())
                        .or_else(|| restored_state.and_then(|state| state.last_status.clone()))
                } else {
                    state
                        .last_status
                        .clone()
                        .or_else(|| agent_state.and_then(|state| state.last_status.clone()))
                        .or_else(|| restored_state.and_then(|state| state.last_status.clone()))
                },
                last_response_duration_ms: agent_state
                    .and_then(|state| state.last_response_duration_ms)
                    .or_else(|| restored_state.and_then(|state| state.last_response_duration_ms)),
                last_ttft_ms: agent_state
                    .and_then(|state| state.last_ttft_ms)
                    .or_else(|| restored_state.and_then(|state| state.last_ttft_ms)),
                is_ready: host_ready
                    && agent_state
                        .map(|state| state.is_ready)
                        .or_else(|| restored_state.map(|state| state.is_ready))
                        .unwrap_or(true),
                is_responding: agent_state
                    .map(|state| state.is_responding)
                    .or_else(|| restored_state.map(|state| state.is_responding))
                    .unwrap_or(false),
            },
        }
    }

    pub(super) fn publish_message(&self, state: &mut RunnerState, message: FromAgentMessage) {
        match &message {
            FromAgentMessage::ResponseStart { response_id } => {
                state.active_response_ids.insert(response_id.clone());
            }
            FromAgentMessage::ResponseEnd { response_id, .. } => {
                state.active_response_ids.remove(response_id);
            }
            FromAgentMessage::Error { .. } => state.active_response_ids.clear(),
            _ => {}
        }
        // Reserve the cursor immediately before a response completion for the
        // coarse transcript's durable aggregate. This lets a reconnect resume
        // between the aggregate and ResponseEnd without suppressing either.
        state.cursor = state.cursor.saturating_add(
            if matches!(&message, FromAgentMessage::ResponseEnd { .. }) {
                2
            } else {
                1
            },
        );
        let envelope = StreamEnvelope::Message {
            cursor: state.cursor,
            message: Box::new(crate::transcript::redact_agent_message(message)),
        };
        state.envelopes.push_back(envelope.clone());
        while state.envelopes.len() > MAX_EVENTS {
            state.envelopes.pop_front();
        }
        let _ = self.events.send(envelope);
    }

    pub(super) fn publish_snapshot(&self, state: &mut RunnerState) {
        let envelope = StreamEnvelope::Snapshot {
            snapshot: self.snapshot(state),
        };
        state.envelopes.push_back(envelope.clone());
        while state.envelopes.len() > MAX_EVENTS {
            state.envelopes.pop_front();
        }
        let _ = self.events.send(envelope);
    }

    pub(super) fn reset_envelope(&self, reason: impl Into<String>) -> StreamEnvelope {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.reset_envelope_from_state(&state, reason)
    }

    fn reset_envelope_from_state(
        &self,
        state: &RunnerState,
        reason: impl Into<String>,
    ) -> StreamEnvelope {
        StreamEnvelope::Reset {
            reason: reason.into(),
            snapshot: self.snapshot(state),
        }
    }

    pub(super) fn reset_and_subscribe(
        &self,
        reason: impl Into<String>,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let rx = self.events.subscribe();
        (vec![self.reset_envelope_from_state(&state, reason)], rx)
    }

    pub(super) fn subscribe_from(
        &self,
        cursor: u64,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let rx = self.events.subscribe();
        (self.replay_from_state(&state, cursor), rx)
    }

    /// Coarse transcript filtering needs the retained response prefix to
    /// reconstruct an aggregate after reconnect. Replay the full retained
    /// window while the filter suppresses outputs at or before the requested
    /// cursor. Preserve the normal reset behavior when the cursor has fallen
    /// outside that window.
    pub(super) fn subscribe_coarse_from(
        &self,
        cursor: u64,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let rx = self.events.subscribe();
        let requested = self.replay_from_state(&state, cursor);
        if requested
            .iter()
            .any(|envelope| matches!(envelope, StreamEnvelope::Reset { .. }))
        {
            return (requested, rx);
        }
        if !coarse_replay_has_complete_response_boundaries(
            &state.envelopes,
            &state.active_response_ids,
        ) {
            return (
                vec![self.reset_envelope_from_state(&state, "coarse_replay_incomplete")],
                rx,
            );
        }
        (state.envelopes.iter().cloned().collect(), rx)
    }

    fn replay_from_state(&self, state: &RunnerState, cursor: u64) -> Vec<StreamEnvelope> {
        let first_cursor = state.envelopes.iter().find_map(|envelope| match envelope {
            StreamEnvelope::Message { cursor, .. } | StreamEnvelope::Heartbeat { cursor } => {
                Some(*cursor)
            }
            StreamEnvelope::Snapshot { .. } | StreamEnvelope::Reset { .. } => None,
        });
        if let Some(first_cursor) = first_cursor {
            if cursor > 0 && cursor < first_cursor.saturating_sub(1) {
                return vec![StreamEnvelope::Reset {
                    reason: "replay_gap".to_string(),
                    snapshot: self.snapshot(state),
                }];
            }
        }
        state
            .envelopes
            .iter()
            .filter(|envelope| match envelope {
                StreamEnvelope::Message {
                    cursor: event_cursor,
                    ..
                }
                | StreamEnvelope::Heartbeat {
                    cursor: event_cursor,
                } => *event_cursor > cursor,
                StreamEnvelope::Snapshot { .. } | StreamEnvelope::Reset { .. } => true,
            })
            .cloned()
            .collect()
    }
}

fn coarse_replay_has_complete_response_boundaries(
    envelopes: &VecDeque<StreamEnvelope>,
    live_active_responses: &HashSet<String>,
) -> bool {
    let mut active_responses = HashSet::new();
    for envelope in envelopes {
        let StreamEnvelope::Message { message, .. } = envelope else {
            continue;
        };
        match message.as_ref() {
            FromAgentMessage::ResponseStart { response_id } => {
                active_responses.insert(response_id.as_str());
            }
            FromAgentMessage::ResponseChunk { response_id, .. }
                if !active_responses.contains(response_id.as_str()) =>
            {
                return false;
            }
            FromAgentMessage::ResponseEnd { response_id, .. }
                if response_id == "done" && !active_responses.contains(response_id.as_str()) =>
            {
                // The native agent emits `done` as a turn-lifecycle sentinel,
                // not as the completion of a streamed model response.
            }
            FromAgentMessage::ResponseEnd { response_id, .. }
                if !active_responses.remove(response_id.as_str()) =>
            {
                return false;
            }
            _ => {}
        }
    }
    live_active_responses
        .iter()
        .all(|response_id| active_responses.contains(response_id.as_str()))
}

fn redacted_pending_snapshot(
    live: Option<&[crate::headless::PendingApproval]>,
    restored: Option<&[serde_json::Value]>,
) -> Vec<serde_json::Value> {
    live.filter(|requests| !requests.is_empty())
        .map(redacted_pending_requests)
        .or_else(|| {
            restored
                .filter(|requests| !requests.is_empty())
                .map(redacted_pending_request_values)
        })
        .unwrap_or_default()
}

fn redacted_pending_requests(
    requests: &[crate::headless::PendingApproval],
) -> Vec<serde_json::Value> {
    requests
        .iter()
        .map(|request| {
            let mut redacted = serde_json::Map::new();
            redacted.insert(
                "call_id".to_string(),
                serde_json::Value::String(request.call_id.clone()),
            );
            if let Some(tool_execution_id) = request.tool_execution_id.as_ref() {
                redacted.insert(
                    "tool_execution_id".to_string(),
                    serde_json::Value::String(tool_execution_id.clone()),
                );
            }
            if let Some(request_id) = request.request_id.as_ref() {
                redacted.insert(
                    "request_id".to_string(),
                    serde_json::Value::String(request_id.clone()),
                );
            }
            redacted.insert(
                "tool".to_string(),
                serde_json::Value::String(request.tool.clone()),
            );
            redacted.insert("args".to_string(), serde_json::json!({}));
            if let Some(started_at_ms) = request.started_at_ms {
                redacted.insert(
                    "started_at_ms".to_string(),
                    serde_json::json!(started_at_ms),
                );
            }
            serde_json::Value::Object(redacted)
        })
        .collect()
}

fn redacted_active_tool_snapshot(
    live: Option<&crate::headless::AgentState>,
    restored: Option<&RuntimeStateSnapshot>,
) -> Vec<serde_json::Value> {
    live.filter(|state| !state.active_tools.is_empty())
        .map(|state| {
            state
                .active_tools
                .values()
                .map(|tool| {
                    serde_json::json!({
                        "call_id": tool.call_id,
                        "tool": tool.tool,
                        "output": "",
                    })
                })
                .collect()
        })
        .or_else(|| {
            restored
                .filter(|state| !state.active_tools.is_empty())
                .map(|state| redacted_active_tools(&state.active_tools))
        })
        .unwrap_or_default()
}

fn redacted_pending_request_values(requests: &[serde_json::Value]) -> Vec<serde_json::Value> {
    requests
        .iter()
        .map(redacted_pending_request_value)
        .collect()
}

fn redacted_pending_request_value(request: &serde_json::Value) -> serde_json::Value {
    let mut redacted = serde_json::Map::new();
    redacted.insert(
        "call_id".to_string(),
        request
            .get("call_id")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    insert_optional_json_field(&mut redacted, request, "tool_execution_id");
    if let Some(request_id) = request
        .get("request_id")
        .or_else(|| request.get("id"))
        .filter(|value| !value.is_null())
    {
        redacted.insert("request_id".to_string(), request_id.clone());
    }
    redacted.insert(
        "tool".to_string(),
        request
            .get("tool")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    redacted.insert("args".to_string(), serde_json::json!({}));
    insert_optional_json_field(&mut redacted, request, "started_at_ms");
    serde_json::Value::Object(redacted)
}

fn insert_optional_json_field(
    target: &mut serde_json::Map<String, serde_json::Value>,
    source: &serde_json::Value,
    key: &str,
) {
    if let Some(value) = source.get(key).filter(|value| !value.is_null()) {
        target.insert(key.to_string(), value.clone());
    }
}

fn redacted_active_tools(tools: &[serde_json::Value]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|tool| {
            serde_json::json!({
                "call_id": tool.get("call_id").cloned().unwrap_or(serde_json::Value::Null),
                "tool": tool.get("tool").cloned().unwrap_or(serde_json::Value::Null),
                "output": "",
            })
        })
        .collect()
}

#[cfg(test)]
mod coarse_replay_tests {
    use super::*;

    fn response_end(response_id: &str) -> StreamEnvelope {
        StreamEnvelope::Message {
            cursor: 1,
            message: Box::new(FromAgentMessage::ResponseEnd {
                response_id: response_id.to_string(),
                usage: None,
                tools_summary: None,
                duration_ms: None,
                ttft_ms: None,
            }),
        }
    }

    #[test]
    fn lifecycle_done_does_not_require_a_response_start() {
        let envelopes = VecDeque::from([response_end("done")]);

        assert!(coarse_replay_has_complete_response_boundaries(
            &envelopes,
            &HashSet::new(),
        ));
    }

    #[test]
    fn unmatched_model_response_end_remains_incomplete() {
        let envelopes = VecDeque::from([response_end("response-1")]);

        assert!(!coarse_replay_has_complete_response_boundaries(
            &envelopes,
            &HashSet::new(),
        ));
    }

    #[test]
    fn matched_done_closes_its_response_boundary() {
        let envelopes = VecDeque::from([
            StreamEnvelope::Message {
                cursor: 1,
                message: Box::new(FromAgentMessage::ResponseStart {
                    response_id: "done".to_string(),
                }),
            },
            response_end("done"),
            StreamEnvelope::Message {
                cursor: 3,
                message: Box::new(FromAgentMessage::ResponseChunk {
                    response_id: "done".to_string(),
                    content: "after completion".to_string(),
                    is_thinking: false,
                }),
            },
        ]);

        assert!(!coarse_replay_has_complete_response_boundaries(
            &envelopes,
            &HashSet::new(),
        ));
    }
}
