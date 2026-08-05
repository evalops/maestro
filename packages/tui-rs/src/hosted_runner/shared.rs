use super::manifests::*;
use super::*;

const MAX_UNVERIFIED_PENDING_CONTROLLER_EVENTS: usize = 1024;

impl SharedRunner {
    #[cfg(test)]
    pub(super) fn new(config: HostedRunnerConfig) -> Self {
        Self::new_with_message_executor_and_restore(
            config,
            Arc::new(TransportOnlyHostedRunnerMessageExecutor),
            None,
        )
    }

    #[cfg(test)]
    pub(super) fn new_with_message_executor_and_restore(
        config: HostedRunnerConfig,
        message_executor: Arc<dyn HostedRunnerHeadlessMessageExecutor>,
        restore_manifest: Option<SnapshotManifest>,
    ) -> Self {
        Self::try_new_with_message_executor_and_restore(config, message_executor, restore_manifest)
            .expect("hosted runner fixture should load its durable thread journal")
    }

    pub(super) fn try_new_with_message_executor_and_restore(
        config: HostedRunnerConfig,
        message_executor: Arc<dyn HostedRunnerHeadlessMessageExecutor>,
        restore_manifest: Option<SnapshotManifest>,
    ) -> io::Result<Self> {
        let binding = HostedRunnerBinding::from_config(&config, restore_manifest.as_ref());
        let loaded_thread = ThreadJournal::load(
            &config.workspace_root,
            binding.maestro_session_id.as_str(),
            config.runtime_generation,
        )?;
        let (events, _) = broadcast::channel(MAX_EVENTS);
        let (controller_events, _) = broadcast::channel(MAX_EVENTS);
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
        let restore_runtime_failed = restored_snapshot
            .as_ref()
            .is_some_and(runtime_snapshot_is_failed);
        let restore_ready = restore_status
            .map(RuntimeFlushStatus::is_completed)
            .unwrap_or(true)
            && !restore_runtime_failed;
        let restore_last_error = restore_manifest.as_ref().and_then(|manifest| {
            manifest
                .runtime
                .flush_status
                .restore_last_error(manifest.runtime.error.as_deref())
        });
        let restore_last_error_type = restore_last_error.as_ref().map(|_| "protocol".to_string());
        let shared = Self {
            binding: binding.clone(),
            config: Arc::new(config),
            state: Arc::new(Mutex::new(RunnerState {
                ready: restore_ready,
                draining: false,
                runtime_failed: restore_runtime_failed,
                session_id: binding.maestro_session_id.as_str().to_string(),
                cursor: restored_cursor.unwrap_or(0).max(loaded_thread.cursor),
                last_init,
                last_status: Some(
                    restore_status
                        .map(RuntimeFlushStatus::restore_last_status)
                        .unwrap_or("Ready")
                        .to_string(),
                ),
                last_error: restore_last_error,
                last_error_type: restore_last_error_type,
                identity_binding_failures: loaded_thread.identity_binding_failures,
                restored_snapshot,
                controller_connection_id: None,
                controller_stream_cancellation: CancellationToken::new(),
                connections: HashMap::new(),
                subscriptions: HashMap::new(),
                active_utility_commands: HashMap::new(),
                active_file_watches: HashMap::new(),
                active_response_ids: HashSet::new(),
                response_idempotency_keys: loaded_thread.response_idempotency_keys,
                response_idempotency_digests: loaded_thread.response_idempotency_digests,
                response_request_owners: loaded_thread.response_request_owners,
                pending_response_idempotency: loaded_thread.pending_response_idempotency,
                response_idempotency_order: loaded_thread.response_idempotency_order,
                pending_response_idempotency_order: loaded_thread
                    .pending_response_idempotency_order,
                envelopes: loaded_thread.events.clone(),
                controller_envelopes: loaded_thread.events,
                pending_controller_events: VecDeque::new(),
                thread: loaded_thread.state,
            })),
            events,
            controller_events,
            message_executor,
            thread_journal: Arc::new(loaded_thread.journal),
            mutation_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            thread_persistence_retry_pending: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            thread_persistence_failures: Arc::new(Mutex::new(0)),
            event_pump_cancellation: CancellationToken::new(),
            event_pump_task: Arc::new(tokio::sync::Mutex::new(None)),
        };
        if restore_manifest.is_some() {
            let envelope = shared.reset_envelope("restored_from_snapshot");
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.envelopes.push_back(envelope.clone());
            state.controller_envelopes.push_back(envelope);
        }
        {
            let state = shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Startup: failing construction is the correct response to an
            // unwritable journal, so the raw call is intentional here.
            #[allow(clippy::disallowed_methods)]
            shared.persist_thread(&state)?;
        }
        Ok(shared)
    }

    pub(super) fn identity(&self) -> HostedRunnerIdentity {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        HostedRunnerIdentity {
            protocol_version: HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION.to_string(),
            runner_session_id: self.binding.runner_session_id.as_str().to_string(),
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
            return Err(runtime_availability_error(
                &state,
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

    pub(super) fn public_snapshot(&self, state: &RunnerState) -> RuntimeSnapshot {
        let mut snapshot = self.snapshot(state);
        snapshot.state.controller_subscription_id = None;
        snapshot
    }

    pub(super) fn record_identity_failure(
        &self,
        state: &mut RunnerState,
        operation: &'static str,
        requested_session_id: &str,
    ) -> HostedResult<IdentityBindingFailure> {
        let failure = IdentityBindingFailure::new(
            &self.binding,
            operation,
            requested_session_id,
            self.config.runtime_generation,
        );
        let evicted = if state.identity_binding_failures.len() >= MAX_IDENTITY_BINDING_FAILURES {
            state.identity_binding_failures.pop_front()
        } else {
            None
        };
        state.identity_binding_failures.push_back(failure.clone());
        if let Err(error) = self.persist_thread_for_request(state) {
            state.identity_binding_failures.pop_back();
            if let Some(evicted) = evicted {
                state.identity_binding_failures.push_front(evicted);
            }
            return Err(HostedError::new(
                HostedRunnerErrorCode::RuntimeFailed,
                format!("failed to persist identity binding failure evidence: {error}"),
            ));
        }
        Ok(failure)
    }

    /// Raw thread-journal write. Do not call this directly outside the
    /// wrappers below and the startup/publish/retry paths: raw persistence
    /// errors have repeatedly wedged the runtime (dead event pump, drains
    /// permanently rejected as "already draining", leaked ownership slots).
    /// Pick the wrapper that states the caller's failure semantics:
    /// [`Self::persist_thread_or_defer`] for runtime-event paths,
    /// [`Self::persist_thread_for_request`] for request-scoped paths, and
    /// [`Self::persist_thread_best_effort`] for error-path cleanup.
    /// Enforced by `disallowed-methods` in `clippy.toml`.
    pub(super) fn persist_thread(&self, state: &RunnerState) -> io::Result<()> {
        #[cfg(test)]
        {
            let mut failures = self
                .thread_persistence_failures
                .lock()
                .expect("thread persistence failure counter");
            if *failures > 0 {
                *failures -= 1;
                return Err(io::Error::other(
                    "injected thread journal persistence failure",
                ));
            }
        }
        self.thread_journal.persist(
            &state.thread,
            self.config.runtime_generation,
            state.cursor,
            &state.envelopes,
            ResponseIdempotencyView {
                keys: &state.response_idempotency_keys,
                digests: &state.response_idempotency_digests,
                request_owners: &state.response_request_owners,
                pending: &state.pending_response_idempotency,
                order: &state.response_idempotency_order,
                pending_order: &state.pending_response_idempotency_order,
            },
            &state.identity_binding_failures,
        )
    }

    /// Persist for a runtime-event path (event pump, executor drain, the
    /// `/drain` handler). The in-memory mutation has already happened; a
    /// journal write failure is deferred to the event pump's retry instead of
    /// propagated, because an error return on these paths wedges the runtime
    /// rather than the failing operation.
    pub(super) fn persist_thread_or_defer(&self, state: &RunnerState, site: &'static str) {
        #[allow(clippy::disallowed_methods)]
        if let Err(error) = self.persist_thread(state) {
            self.thread_persistence_retry_pending
                .store(true, std::sync::atomic::Ordering::Release);
            tracing::warn!(
                event = "thread_journal_persistence_deferred",
                site,
                error = %error,
                "thread journal write failed; keeping live-process state and retrying from the event pump",
            );
        }
    }

    /// Persist for a request-scoped path where failing the request is safe:
    /// the caller rolls back its own mutation or reports the error to the
    /// client, and nothing process-wide is left wedged.
    pub(super) fn persist_thread_for_request(&self, state: &RunnerState) -> io::Result<()> {
        #[allow(clippy::disallowed_methods)]
        self.persist_thread(state)
    }

    /// Best-effort persist on a cleanup path that is already returning an
    /// error. The failure is logged, never propagated; the next successful
    /// journal write covers the missed one because the full state is
    /// serialized on every persist.
    pub(super) fn persist_thread_best_effort(&self, state: &RunnerState, site: &'static str) {
        #[allow(clippy::disallowed_methods)]
        if let Err(error) = self.persist_thread(state) {
            tracing::warn!(
                event = "thread_journal_persistence_skipped",
                site,
                error = %error,
                "best-effort thread journal write failed on a cleanup path",
            );
        }
    }

    #[cfg(test)]
    pub(super) fn fail_next_thread_persistences(&self, count: usize) {
        *self
            .thread_persistence_failures
            .lock()
            .expect("thread persistence failure counter") = count;
    }

    pub(super) fn controller_pending_events(
        &self,
        state: &mut RunnerState,
    ) -> Vec<FromAgentMessage> {
        let Some(agent_state) = self.prune_pending_controller_events(state) else {
            return Vec::new();
        };
        agent_state
            .pending_client_tools
            .iter()
            .filter_map(|pending| {
                state
                    .pending_controller_events
                    .iter()
                    .rev()
                    .find(|message| pending_controller_event_matches(pending, message))
                    .cloned()
            })
            .collect()
    }

    pub(super) fn prune_pending_controller_events(
        &self,
        state: &mut RunnerState,
    ) -> Option<AgentState> {
        let agent_state = self.message_executor.state().ok().flatten()?;
        let live_pending = agent_state
            .pending_client_tools
            .iter()
            .map(|pending| {
                (
                    (pending.call_id.as_str(), pending.request_id.as_deref()),
                    pending,
                )
            })
            .collect::<HashMap<_, _>>();
        state.pending_controller_events.retain(|message| {
            pending_controller_event_identity(message)
                .and_then(|identity| live_pending.get(&identity))
                .is_some_and(|pending| pending_controller_event_matches(pending, message))
        });
        Some(agent_state)
    }

    pub(super) fn controller_stream_is_authorized(
        &self,
        authorization: &ControllerStreamAuthorization,
    ) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.controller_connection_id.as_deref() != Some(authorization.connection_id.as_str()) {
            return false;
        }
        if authorization.cancellation.is_cancelled() {
            return false;
        }
        if !state
            .connections
            .get(&authorization.connection_id)
            .is_some_and(|connection| connection.role == ConnectionRole::Controller)
        {
            return false;
        }
        state
            .subscriptions
            .get(&authorization.subscription_id)
            .is_some_and(|subscription| {
                subscription.attached
                    && subscription.role == ConnectionRole::Controller
                    && subscription.connection_id == authorization.connection_id
            })
    }

    pub(super) fn publish_message(&self, state: &mut RunnerState, message: FromAgentMessage) {
        // Stream chunks stay in the bounded in-memory replay buffer. Persist
        // only lifecycle boundaries so token streaming does not serialize and
        // fsync the entire journal for every chunk. A crash mid-response is
        // restored as interrupted; every terminal/waiting boundary is durable.
        let persist_lifecycle_boundary = matches!(
            &message,
            FromAgentMessage::ResponseEnd { .. }
                | FromAgentMessage::ServerRequest { .. }
                | FromAgentMessage::ServerRequestResolved { .. }
                | FromAgentMessage::Error { .. }
        );
        let agent_state = self.prune_pending_controller_events(state);
        let matching_pending = agent_state.as_ref().and_then(|agent_state| {
            agent_state
                .pending_client_tools
                .iter()
                .find(|pending| pending_controller_event_matches(pending, &message))
        });
        if let Some(pending) = matching_pending {
            state
                .pending_controller_events
                .retain(|existing| !pending_controller_event_matches(pending, existing));
            // Authoritative pending state is the bound: every live request keeps
            // exactly one raw event, regardless of the generic replay limit.
            state.pending_controller_events.push_back(message.clone());
        } else if agent_state.is_none() && pending_controller_event_key(&message).is_some() {
            // If authoritative state is temporarily unavailable, retain a
            // bounded best-effort copy until a later publish or attach can
            // reconcile it against the live pending set.
            state.pending_controller_events.retain(|existing| {
                pending_controller_event_key(existing) != pending_controller_event_key(&message)
            });
            if state.pending_controller_events.len() >= MAX_UNVERIFIED_PENDING_CONTROLLER_EVENTS {
                state.pending_controller_events.pop_front();
            }
            state.pending_controller_events.push_back(message.clone());
        }

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
        if let FromAgentMessage::Error {
            message,
            fatal: true,
            ..
        } = &message
        {
            state.runtime_failed = true;
            state.ready = false;
            state.last_status = Some("Runtime failed".to_string());
            state.last_error = Some(message.clone());
            state.last_error_type = Some("fatal".to_string());
        }
        state.thread.apply_agent_message(&message, state.cursor);
        let controller_envelope = StreamEnvelope::Message {
            cursor: state.cursor,
            message: Box::new(crate::transcript::agent_message_for_controller(
                message.clone(),
            )),
        };
        let envelope = StreamEnvelope::Message {
            cursor: state.cursor,
            message: Box::new(crate::transcript::redact_agent_message(message)),
        };
        state.envelopes.push_back(envelope.clone());
        state
            .controller_envelopes
            .push_back(controller_envelope.clone());
        while state.envelopes.len() > MAX_EVENTS {
            state.envelopes.pop_front();
        }
        while state.controller_envelopes.len() > MAX_EVENTS {
            state.controller_envelopes.pop_front();
        }
        let _ = self.events.send(envelope);
        let _ = self.controller_events.send(controller_envelope);
        if persist_lifecycle_boundary {
            // Publish path: a failed boundary write deliberately degrades the
            // runner to not-ready instead of deferring, so controllers stop
            // sending work against a journal that is not durable.
            #[allow(clippy::disallowed_methods)]
            if let Err(error) = self.persist_thread(state) {
                state.runtime_failed = true;
                state.ready = false;
                state.last_error = Some(format!("durable thread journal write failed: {error}"));
                state.last_status = Some("Runtime failed".to_string());
                state.last_error_type = Some("internal".to_string());
            }
        }
    }

    pub(super) fn publish_snapshot(&self, state: &mut RunnerState) {
        let envelope = StreamEnvelope::Snapshot {
            snapshot: self.public_snapshot(state),
        };
        state.envelopes.push_back(envelope.clone());
        state.controller_envelopes.push_back(envelope.clone());
        while state.envelopes.len() > MAX_EVENTS {
            state.envelopes.pop_front();
        }
        while state.controller_envelopes.len() > MAX_EVENTS {
            state.controller_envelopes.pop_front();
        }
        let _ = self.events.send(envelope.clone());
        let _ = self.controller_events.send(envelope);
        // Snapshot publish: same deliberate not-ready degradation as
        // publish_message above.
        #[allow(clippy::disallowed_methods)]
        if let Err(error) = self.persist_thread(state) {
            state.runtime_failed = true;
            state.ready = false;
            state.last_error = Some(format!("durable thread journal write failed: {error}"));
            state.last_status = Some("Runtime failed".to_string());
            state.last_error_type = Some("internal".to_string());
        }
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
            snapshot: self.public_snapshot(state),
        }
    }

    pub(super) fn reset_and_subscribe(
        &self,
        reason: impl Into<String>,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        self.reset_and_subscribe_with(reason, false)
    }

    pub(super) fn reset_and_subscribe_controller(
        &self,
        reason: impl Into<String>,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        self.reset_and_subscribe_with(reason, true)
    }

    fn reset_and_subscribe_with(
        &self,
        reason: impl Into<String>,
        controller: bool,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let rx = if controller {
            self.controller_events.subscribe()
        } else {
            self.events.subscribe()
        };
        (vec![self.reset_envelope_from_state(&state, reason)], rx)
    }

    pub(super) fn subscribe_from(
        &self,
        cursor: u64,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        self.subscribe_from_with(cursor, false)
    }

    pub(super) fn subscribe_controller_from(
        &self,
        cursor: u64,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        self.subscribe_from_with(cursor, true)
    }

    fn subscribe_from_with(
        &self,
        cursor: u64,
        controller: bool,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (envelopes, rx) = if controller {
            (
                &state.controller_envelopes,
                self.controller_events.subscribe(),
            )
        } else {
            (&state.envelopes, self.events.subscribe())
        };
        (self.replay_from_state(&state, envelopes, cursor), rx)
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
        self.subscribe_coarse_from_with(cursor, false)
    }

    pub(super) fn subscribe_controller_coarse_from(
        &self,
        cursor: u64,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        self.subscribe_coarse_from_with(cursor, true)
    }

    fn subscribe_coarse_from_with(
        &self,
        cursor: u64,
        controller: bool,
    ) -> (Vec<StreamEnvelope>, broadcast::Receiver<StreamEnvelope>) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (envelopes, rx) = if controller {
            (
                &state.controller_envelopes,
                self.controller_events.subscribe(),
            )
        } else {
            (&state.envelopes, self.events.subscribe())
        };
        let requested = self.replay_from_state(&state, envelopes, cursor);
        if requested
            .iter()
            .any(|envelope| matches!(envelope, StreamEnvelope::Reset { .. }))
        {
            return (requested, rx);
        }
        if !coarse_replay_has_complete_response_boundaries(envelopes, &state.active_response_ids) {
            return (
                vec![self.reset_envelope_from_state(&state, "coarse_replay_incomplete")],
                rx,
            );
        }
        (envelopes.iter().cloned().collect(), rx)
    }

    fn replay_from_state(
        &self,
        state: &RunnerState,
        envelopes: &VecDeque<StreamEnvelope>,
        cursor: u64,
    ) -> Vec<StreamEnvelope> {
        let first_cursor = envelopes.iter().find_map(|envelope| match envelope {
            StreamEnvelope::Message { cursor, .. } | StreamEnvelope::Heartbeat { cursor } => {
                Some(*cursor)
            }
            StreamEnvelope::Snapshot { .. } | StreamEnvelope::Reset { .. } => None,
        });
        if let Some(first_cursor) = first_cursor {
            if cursor > 0 && cursor < first_cursor.saturating_sub(1) {
                return vec![StreamEnvelope::Reset {
                    reason: "replay_gap".to_string(),
                    snapshot: self.public_snapshot(state),
                }];
            }
        }
        envelopes
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

fn pending_controller_event_identity(message: &FromAgentMessage) -> Option<(&str, Option<&str>)> {
    match message {
        FromAgentMessage::ClientToolRequest { call_id, .. } => Some((call_id, None)),
        FromAgentMessage::ServerRequest {
            request_id,
            request_type: ServerRequestType::ClientTool,
            call_id,
            ..
        } => Some((
            call_id,
            (request_id != call_id).then_some(request_id.as_str()),
        )),
        _ => None,
    }
}

fn pending_controller_event_key(
    message: &FromAgentMessage,
) -> Option<(&str, Option<&str>, Option<&str>)> {
    match message {
        FromAgentMessage::ClientToolRequest {
            call_id,
            tool_execution_id,
            ..
        } => Some((call_id, None, tool_execution_id.as_deref())),
        FromAgentMessage::ServerRequest {
            request_id,
            request_type: ServerRequestType::ClientTool,
            call_id,
            tool_execution_id,
            ..
        } => Some((
            call_id,
            (request_id != call_id).then_some(request_id.as_str()),
            tool_execution_id.as_deref(),
        )),
        _ => None,
    }
}

fn pending_controller_event_matches(
    pending: &crate::headless::PendingApproval,
    message: &FromAgentMessage,
) -> bool {
    match message {
        FromAgentMessage::ClientToolRequest {
            call_id,
            tool_execution_id,
            ..
        } => {
            pending.request_id.is_none()
                && pending.call_id == *call_id
                && pending.tool_execution_id == *tool_execution_id
        }
        FromAgentMessage::ServerRequest {
            request_id,
            request_type: ServerRequestType::ClientTool,
            call_id,
            tool_execution_id,
            ..
        } => {
            let request_id = (request_id != call_id).then_some(request_id.as_str());
            pending.call_id == *call_id
                && pending.request_id.as_deref() == request_id
                && tool_execution_id.as_ref().is_none_or(|raw_execution_id| {
                    pending.tool_execution_id.as_ref() == Some(raw_execution_id)
                })
        }
        _ => false,
    }
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
