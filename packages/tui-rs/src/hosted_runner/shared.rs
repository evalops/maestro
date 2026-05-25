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
                envelopes: VecDeque::new(),
            })),
            events,
            message_executor,
        };
        if restore_manifest.is_some() {
            let envelope = shared.reset_envelope("restored_from_snapshot");
            let mut state = shared.state.lock().expect("hosted runner state poisoned");
            state.envelopes.push_back(envelope);
        }
        shared
    }

    pub(super) fn identity(&self) -> HostedRunnerIdentity {
        let state = self.state.lock().expect("hosted runner state poisoned");
        HostedRunnerIdentity {
            protocol_version: HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION.to_string(),
            runner_session_id: self.config.runner_session_id.clone(),
            owner_instance_id: self.config.owner_instance_id.clone(),
            ready: state.ready,
            draining: state.draining,
        }
    }

    pub(super) fn ensure_attachable(&self) -> HostedResult<()> {
        let state = self.state.lock().expect("hosted runner state poisoned");
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
                current_response: agent_state
                    .and_then(|state| state.current_response.as_ref())
                    .map(json_value)
                    .or_else(|| restored_state.and_then(|state| state.current_response.clone())),
                pending_approvals: agent_state
                    .map(|state| state.pending_approvals.iter().map(json_value).collect())
                    .or_else(|| restored_state.map(|state| state.pending_approvals.clone()))
                    .unwrap_or_default(),
                pending_client_tools: agent_state
                    .map(|state| state.pending_client_tools.iter().map(json_value).collect())
                    .or_else(|| restored_state.map(|state| state.pending_client_tools.clone()))
                    .unwrap_or_default(),
                pending_mcp_elicitations: restored_state
                    .map(|state| state.pending_mcp_elicitations.clone())
                    .unwrap_or_default(),
                pending_user_inputs: agent_state
                    .map(|state| state.pending_user_inputs.iter().map(json_value).collect())
                    .or_else(|| restored_state.map(|state| state.pending_user_inputs.clone()))
                    .unwrap_or_default(),
                pending_tool_retries: agent_state
                    .map(|state| state.pending_tool_retries.iter().map(json_value).collect())
                    .or_else(|| restored_state.map(|state| state.pending_tool_retries.clone()))
                    .unwrap_or_default(),
                tracked_tools: agent_state
                    .map(|state| state.tracked_tools.values().map(json_value).collect())
                    .or_else(|| restored_state.map(|state| state.tracked_tools.clone()))
                    .unwrap_or_default(),
                active_tools: agent_state
                    .map(|state| {
                        state
                            .active_tools
                            .values()
                            .map(|tool| {
                                json!({
                                    "call_id": tool.call_id,
                                    "tool": tool.tool,
                                    "output": tool.output,
                                })
                            })
                            .collect()
                    })
                    .or_else(|| restored_state.map(|state| state.active_tools.clone()))
                    .unwrap_or_default(),
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
        state.cursor += 1;
        let envelope = StreamEnvelope::Message {
            cursor: state.cursor,
            message: Box::new(message),
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
        let state = self.state.lock().expect("hosted runner state poisoned");
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
        let state = self.state.lock().expect("hosted runner state poisoned");
        let rx = self.events.subscribe();
        (vec![self.reset_envelope_from_state(&state, reason)], rx)
    }

    pub(super) fn subscribe_from(
        &self,
        cursor: u64,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        let state = self.state.lock().expect("hosted runner state poisoned");
        let rx = self.events.subscribe();
        (self.replay_from_state(&state, cursor), rx)
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
