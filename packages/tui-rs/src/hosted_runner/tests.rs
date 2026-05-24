use reqwest::StatusCode;
use tempfile::tempdir;

use super::*;
use crate::headless::RemoteTransportConfig;

#[test]
fn status_reason_covers_runner_error_statuses() {
    let codes = [
        HostedRunnerErrorCode::InvalidConfig,
        HostedRunnerErrorCode::InvalidSnapshotManifest,
        HostedRunnerErrorCode::BadRequest,
        HostedRunnerErrorCode::NotFound,
        HostedRunnerErrorCode::StaleSession,
        HostedRunnerErrorCode::StaleConnection,
        HostedRunnerErrorCode::AccessDenied,
        HostedRunnerErrorCode::RuntimeNotReady,
        HostedRunnerErrorCode::LeaseConflict,
        HostedRunnerErrorCode::RuntimeOwnedElsewhere,
        HostedRunnerErrorCode::WorkspaceViolation,
        HostedRunnerErrorCode::UnsupportedCapability,
        HostedRunnerErrorCode::RuntimeFailed,
        HostedRunnerErrorCode::Internal,
    ];

    for code in codes {
        assert_ne!(status_reason(code.http_status()), "OK", "{code:?}");
    }
}

#[derive(Debug)]
struct ScriptedRuntimeExecutor;

impl HostedRunnerHeadlessMessageExecutor for ScriptedRuntimeExecutor {
    fn execute(
        &self,
        context: &HostedRunnerHeadlessMessageContext,
        message: ToAgentMessage,
    ) -> Result<HostedRunnerHeadlessMessageResult, HostedRunnerError> {
        match message {
            ToAgentMessage::Prompt { content, .. } => {
                assert_eq!(context.session_id, "sess_test");
                assert_eq!(context.connection_id, "conn_exec");
                assert!(context.subscription_id.as_deref().is_some());
                Ok(HostedRunnerHeadlessMessageResult::runtime_handled(
                    vec![
                        FromAgentMessage::ResponseStart {
                            response_id: "resp-hosted-1".to_string(),
                        },
                        FromAgentMessage::ResponseChunk {
                            response_id: "resp-hosted-1".to_string(),
                            content: format!("runtime: {content}"),
                            is_thinking: false,
                        },
                        FromAgentMessage::ResponseEnd {
                            response_id: "resp-hosted-1".to_string(),
                            usage: None,
                            tools_summary: None,
                            duration_ms: Some(7),
                            ttft_ms: Some(3),
                        },
                    ],
                    "Rust hosted runner message handled by runtime executor",
                ))
            }
            _ => Ok(HostedRunnerHeadlessMessageResult::transport_only(
                Vec::new(),
                "scripted executor ignored message",
            )),
        }
    }
}

struct StatefulRuntimeExecutor {
    state: Mutex<AgentState>,
}

impl StatefulRuntimeExecutor {
    fn new(state: AgentState) -> Self {
        Self {
            state: Mutex::new(state),
        }
    }
}

impl HostedRunnerHeadlessMessageExecutor for StatefulRuntimeExecutor {
    fn execute(
        &self,
        _context: &HostedRunnerHeadlessMessageContext,
        _message: ToAgentMessage,
    ) -> Result<HostedRunnerHeadlessMessageResult, HostedRunnerError> {
        Ok(HostedRunnerHeadlessMessageResult::runtime_handled(
            Vec::new(),
            "accepted by stateful runtime",
        ))
    }

    fn state(&self) -> Result<Option<AgentState>, HostedRunnerError> {
        Ok(Some(self.state.lock().expect("state").clone()))
    }
}

fn test_config(workspace_root: PathBuf) -> HostedRunnerConfig {
    HostedRunnerConfig {
        runner_session_id: "mrs_test".to_string(),
        workspace_root,
        bind_addr: "127.0.0.1:0".parse().expect("bind addr"),
        owner_instance_id: Some("owner_test".to_string()),
        snapshot_root: None,
        restore_manifest_path: None,
        workspace_id: Some("ws_test".to_string()),
        agent_run_id: Some("run_test".to_string()),
        maestro_session_id: Some("sess_test".to_string()),
        attach_audience: None,
    }
}

#[tokio::test]
async fn route_rejects_connection_prefix_without_separator() {
    let workspace = tempdir().expect("workspace");
    let shared = SharedRunner::new(test_config(workspace.path().to_path_buf()));
    let request = HttpRequest {
        method: "POST".to_string(),
        path: "/api/headless/connections-extra".to_string(),
        query: HashMap::new(),
        headers: HashMap::new(),
        body: b"{}".to_vec(),
    };

    let error = match route_request(request, shared).await {
        Ok(_) => panic!("unexpected route match"),
        Err(error) => error,
    };

    assert_eq!(error.code, HostedRunnerErrorCode::NotFound);
}

#[test]
fn supervisor_executor_reports_runtime_not_ready_until_connected() {
    let workspace = tempdir().expect("workspace");
    let supervisor = Arc::new(Mutex::new(AgentSupervisor::new(
        crate::headless::SupervisorConfig::default(),
    )));
    let executor = AgentSupervisorHostedRunnerMessageExecutor::new(supervisor);
    let context = HostedRunnerHeadlessMessageContext {
        session_id: "sess_test".to_string(),
        connection_id: "conn_exec".to_string(),
        subscription_id: Some("sub_exec".to_string()),
        role: ConnectionRole::Controller,
        controller_connection_id: Some("conn_exec".to_string()),
        client_protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
        client_info: None,
        capabilities: None,
        opt_out_notifications: None,
        lease_expires_at: Utc::now().to_rfc3339(),
        workspace_root: workspace.path().to_path_buf(),
    };

    let error = executor
        .execute(
            &context,
            ToAgentMessage::Prompt {
                content: "hello".to_string(),
                attachments: None,
            },
        )
        .expect_err("supervisor should not be connected");
    assert_eq!(error.code, HostedRunnerErrorCode::RuntimeNotReady);
}

#[test]
fn resolves_env_config_with_hosted_runner_contract_names() {
    let workspace = tempdir().expect("workspace");
    let mut env = HashMap::new();
    env.insert(
        "MAESTRO_RUNNER_SESSION_ID".to_string(),
        "mrs_123".to_string(),
    );
    env.insert(
        "MAESTRO_REMOTE_RUNNER_OWNER_INSTANCE_ID".to_string(),
        "pod_1".to_string(),
    );
    env.insert(
        "MAESTRO_WORKSPACE_ROOT".to_string(),
        workspace.path().display().to_string(),
    );
    env.insert(
        "MAESTRO_HOSTED_RUNNER_LISTEN".to_string(),
        "127.0.0.1:9090".to_string(),
    );
    env.insert(
        "MAESTRO_REMOTE_RUNNER_WORKSPACE_ID".to_string(),
        "workspace_1".to_string(),
    );
    env.insert(
        "MAESTRO_AGENT_RUN_ID".to_string(),
        "agent_run_1".to_string(),
    );
    env.insert(
        "MAESTRO_REMOTE_RUNNER_SNAPSHOT_ROOT".to_string(),
        ".snapshots".to_string(),
    );
    env.insert(
        "MAESTRO_REMOTE_RUNNER_RESTORE_MANIFEST".to_string(),
        ".snapshots/restore.json".to_string(),
    );

    let config = HostedRunnerConfig::from_env_map(&env).expect("config");
    assert_eq!(config.runner_session_id, "mrs_123");
    assert_eq!(config.owner_instance_id.as_deref(), Some("pod_1"));
    assert_eq!(
        config.workspace_root,
        workspace.path().canonicalize().unwrap()
    );
    assert_eq!(config.bind_addr, "127.0.0.1:9090".parse().unwrap());
    assert_eq!(
        config.snapshot_root.as_deref(),
        Some(
            workspace
                .path()
                .canonicalize()
                .unwrap()
                .join(".snapshots")
                .as_path()
        )
    );
    assert_eq!(config.workspace_id.as_deref(), Some("workspace_1"));
    assert_eq!(config.agent_run_id.as_deref(), Some("agent_run_1"));
    assert_eq!(
        config.restore_manifest_path.as_deref(),
        Some(
            workspace
                .path()
                .canonicalize()
                .unwrap()
                .join(".snapshots/restore.json")
                .as_path()
        )
    );
}

#[test]
fn sse_lag_reset_envelope_includes_current_snapshot() {
    let workspace = tempdir().expect("workspace");
    let shared = SharedRunner::new(test_config(workspace.path().to_path_buf()));
    {
        let mut state = shared.state.lock().expect("state");
        shared.publish_message(
            &mut state,
            FromAgentMessage::Status {
                message: "ready".to_string(),
            },
        );
    }

    let envelope = shared.reset_envelope("broadcast_lag:3");
    let StreamEnvelope::Reset { reason, snapshot } = envelope else {
        panic!("expected reset envelope");
    };
    assert_eq!(reason, "broadcast_lag:3");
    assert_eq!(snapshot.cursor, 1);
}

#[tokio::test]
async fn events_negative_cursor_returns_replay_gap_reset() {
    let workspace = tempdir().expect("workspace");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let mut events_response = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/events?cursor=-999",
            handle.base_url()
        ))
        .send()
        .await
        .expect("events response");
    assert_eq!(events_response.status(), StatusCode::OK);
    let event_text = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut event_text = String::new();
        while !event_text.contains(r#""reason":"replay_gap""#) {
            let chunk = events_response
                .chunk()
                .await
                .expect("event chunk read")
                .expect("event chunk");
            event_text.push_str(&String::from_utf8_lossy(&chunk));
        }
        event_text
    })
    .await
    .expect("event chunk timeout");
    assert!(event_text.contains(r#""type":"reset""#));
    assert!(event_text.contains(r#""reason":"replay_gap""#));

    handle.shutdown().await;
}

#[test]
fn connection_headers_accept_evalops_subscription_aliases() {
    let headers = HashMap::from([
        (
            "x-evalops-headless-connection-id".to_string(),
            "conn_evalops".to_string(),
        ),
        (
            "x-evalops-headless-subscription-id".to_string(),
            "sub_evalops".to_string(),
        ),
    ]);

    let (connection_id, subscription_id) = connection_from_headers(&headers);

    assert_eq!(connection_id.as_deref(), Some("conn_evalops"));
    assert_eq!(subscription_id.as_deref(), Some("sub_evalops"));
}

#[tokio::test]
async fn identity_and_drain_follow_runner_contract() {
    let workspace = tempdir().expect("workspace");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let identity: HostedRunnerIdentity = client
        .get(format!(
            "{}/.well-known/evalops/remote-runner/identity",
            handle.base_url()
        ))
        .send()
        .await
        .expect("identity response")
        .json()
        .await
        .expect("identity json");
    assert_eq!(identity.runner_session_id, "mrs_test");
    assert_eq!(identity.owner_instance_id.as_deref(), Some("owner_test"));
    assert!(identity.ready);
    assert!(!identity.draining);

    let identity_json: serde_json::Value = client
        .get(format!(
            "{}/.well-known/evalops/remote-runner/identity",
            handle.base_url()
        ))
        .send()
        .await
        .expect("identity response")
        .json()
        .await
        .expect("identity json");
    assert!(identity_json.get("workspace_id").is_none());
    assert!(identity_json.get("agent_run_id").is_none());
    assert!(identity_json.get("maestro_session_id").is_none());

    let drain: serde_json::Value = client
        .post(format!(
            "{}/.well-known/evalops/remote-runner/drain",
            handle.base_url()
        ))
        .json(&json!({"reason": "test", "requested_by": "platform", "export_paths": ["."]}))
        .send()
        .await
        .expect("drain response")
        .json()
        .await
        .expect("drain json");
    assert_eq!(drain["status"], "drained");
    let manifest_path = drain["manifest_path"].as_str().expect("manifest path");
    assert!(Path::new(manifest_path).exists());
    let manifest_bytes = std::fs::read(manifest_path).expect("manifest contents");
    let typed_manifest =
        parse_snapshot_manifest_bytes(&manifest_bytes, workspace.path()).expect("typed manifest");
    let manifest: serde_json::Value =
        serde_json::from_slice(&manifest_bytes).expect("manifest json");
    assert_eq!(drain["manifest"], manifest);
    assert_eq!(
        typed_manifest.protocol_version,
        HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION
    );
    assert_eq!(
        manifest["protocol_version"],
        HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION
    );
    assert_eq!(manifest["workspace_export"]["mode"], "local_path_contract");
    assert_eq!(
        manifest["workspace_export"]["paths"][0]["relative_path"],
        "."
    );
    assert_eq!(
        manifest["workspace_export"]["paths"][0]["type"],
        "directory"
    );
    assert_eq!(
        manifest["work_continuity"]["protocol_version"],
        HOSTED_RUNNER_WORK_CONTINUITY_VERSION
    );
    assert_eq!(manifest["work_continuity"]["active_tool_count"], 0);
    assert_eq!(manifest["work_continuity"]["tracked_tool_count"], 0);
    assert_eq!(
        manifest["work_continuity"]["codex_subagent_tool_call_ids"],
        json!([])
    );
    assert_eq!(
        manifest["retention_policy"]["policy_version"],
        HOSTED_RUNNER_RETENTION_POLICY_VERSION
    );
    assert_eq!(
        manifest["retention_policy"]["visibility"]["runtime_snapshot"],
        "internal"
    );
    assert_eq!(
        manifest["platform_evidence"]["protocol_version"],
        HOSTED_RUNNER_PLATFORM_EVIDENCE_VERSION
    );
    assert_eq!(
        manifest["platform_evidence"]["runtime_flush_status"],
        "skipped"
    );
    assert_eq!(
        manifest["platform_evidence"]["manifest_path"],
        manifest_path
    );

    let post_drain_identity: HostedRunnerIdentity = client
        .get(format!(
            "{}/.well-known/evalops/remote-runner/identity",
            handle.base_url()
        ))
        .send()
        .await
        .expect("identity response")
        .json()
        .await
        .expect("identity json");
    assert!(!post_drain_identity.ready);
    assert!(post_drain_identity.draining);

    let post_drain_state: serde_json::Value = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/state",
            handle.base_url()
        ))
        .send()
        .await
        .expect("state response")
        .json()
        .await
        .expect("state json");
    assert_eq!(post_drain_state["state"]["is_ready"], false);
    assert_eq!(post_drain_state["state"]["last_status"], "Drained");

    let attach = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({"sessionId": "sess_test", "role": "controller"}))
        .send()
        .await
        .expect("attach response");
    assert_eq!(attach.status(), StatusCode::SERVICE_UNAVAILABLE);
    handle.shutdown().await;
}

#[tokio::test]
async fn drain_manifest_records_runtime_cursor_after_activity() {
    let workspace = tempdir().expect("workspace");
    std::fs::write(workspace.path().join("notes.md"), "notes").expect("workspace file");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let connection: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({
            "sessionId": "sess_test",
            "connectionId": "conn_drain",
            "role": "controller"
        }))
        .send()
        .await
        .expect("connection response")
        .json()
        .await
        .expect("connection json");
    assert_eq!(connection["connection_id"], "conn_drain");

    let message: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/messages",
            handle.base_url()
        ))
        .header("x-maestro-headless-connection-id", "conn_drain")
        .json(&json!({"type": "prompt", "content": "before drain"}))
        .send()
        .await
        .expect("message response")
        .json()
        .await
        .expect("message json");
    assert!(message["cursor"].as_u64().unwrap_or_default() > 0);

    let drain: serde_json::Value = client
        .post(format!(
            "{}/.well-known/evalops/remote-runner/drain",
            handle.base_url()
        ))
        .json(&json!({"reason": "cursor-check", "export_paths": ["notes.md"]}))
        .send()
        .await
        .expect("drain response")
        .json()
        .await
        .expect("drain json");
    let manifest_path = drain["manifest_path"].as_str().expect("manifest path");
    let manifest_bytes = std::fs::read(manifest_path).expect("manifest contents");
    let typed_manifest =
        parse_snapshot_manifest_bytes(&manifest_bytes, workspace.path()).expect("typed manifest");
    let manifest: serde_json::Value =
        serde_json::from_slice(&manifest_bytes).expect("manifest json");
    assert_eq!(manifest["runtime"]["flush_status"], "completed");
    assert_eq!(
        typed_manifest.runtime.flush_status,
        RuntimeFlushStatus::Completed
    );
    assert_eq!(
        manifest["runtime"]["protocol_version"],
        HEADLESS_PROTOCOL_VERSION
    );
    assert!(manifest["runtime"]["cursor"].as_u64().unwrap_or_default() >= 2);
    assert_eq!(drain["manifest"], manifest);
    assert_eq!(
        manifest["workspace_export"]["paths"][0]["input"],
        "notes.md"
    );
    assert_eq!(
        manifest["workspace_export"]["paths"][0]["relative_path"],
        "notes.md"
    );
    assert_eq!(manifest["workspace_export"]["paths"][0]["type"], "file");
    assert_eq!(
        manifest["retention_policy"]["redaction"]["required_before_external_persistence"],
        json!(["runtime_snapshot", "runtime_logs"])
    );
    let mut escaped_manifest = manifest.clone();
    escaped_manifest["workspace_export"]["paths"][0]["relative_path"] = json!("../secret.txt");
    let escaped_bytes = serde_json::to_vec(&escaped_manifest).expect("escaped manifest json");
    let error =
        parse_snapshot_manifest_bytes(&escaped_bytes, workspace.path()).expect_err("escape");
    assert_eq!(error.code, HostedRunnerErrorCode::WorkspaceViolation);

    handle.shutdown().await;
}

#[tokio::test]
async fn restore_manifest_seeds_runtime_state_and_replay_marker() {
    let workspace = tempdir().expect("workspace");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let connection: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({
            "sessionId": "sess_test",
            "connectionId": "conn_restore",
            "role": "controller"
        }))
        .send()
        .await
        .expect("connection response")
        .json()
        .await
        .expect("connection json");
    assert_eq!(connection["connection_id"], "conn_restore");

    let message: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/messages",
            handle.base_url()
        ))
        .header("x-maestro-headless-connection-id", "conn_restore")
        .json(&json!({"type": "prompt", "content": "before restore"}))
        .send()
        .await
        .expect("message response")
        .json()
        .await
        .expect("message json");
    assert!(message["cursor"].as_u64().unwrap_or_default() > 0);

    let drain: serde_json::Value = client
        .post(format!(
            "{}/.well-known/evalops/remote-runner/drain",
            handle.base_url()
        ))
        .json(&json!({"reason": "restore-check"}))
        .send()
        .await
        .expect("drain response")
        .json()
        .await
        .expect("drain json");
    let manifest_path = PathBuf::from(drain["manifest_path"].as_str().expect("manifest path"));
    let restored_cursor = drain["manifest"]["runtime"]["cursor"]
        .as_u64()
        .expect("manifest cursor");
    handle.shutdown().await;

    let mut restore_config = test_config(workspace.path().to_path_buf());
    restore_config.runner_session_id = "mrs_restored".to_string();
    restore_config.maestro_session_id = None;
    restore_config.restore_manifest_path = Some(manifest_path);
    let restored = start_hosted_runner(restore_config)
        .await
        .expect("start restored hosted runner");

    let identity: HostedRunnerIdentity = client
        .get(format!(
            "{}/.well-known/evalops/remote-runner/identity",
            restored.base_url()
        ))
        .send()
        .await
        .expect("identity response")
        .json()
        .await
        .expect("identity json");
    assert_eq!(identity.runner_session_id, "mrs_restored");
    assert!(identity.ready);
    assert!(!identity.draining);

    let state: serde_json::Value = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/state",
            restored.base_url()
        ))
        .send()
        .await
        .expect("state response")
        .json()
        .await
        .expect("state json");
    assert_eq!(state["session_id"], "sess_test");
    assert_eq!(state["cursor"], restored_cursor);
    assert_eq!(state["state"]["last_status"], "Restored from snapshot");
    assert_eq!(state["state"]["is_ready"], true);

    let mut events_response = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/events?cursor=0",
            restored.base_url()
        ))
        .send()
        .await
        .expect("events response");
    assert_eq!(events_response.status(), StatusCode::OK);
    let event_text = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut event_text = String::new();
        while !event_text.contains(r#""reason":"restored_from_snapshot""#) {
            let chunk = events_response
                .chunk()
                .await
                .expect("event chunk read")
                .expect("event chunk");
            event_text.push_str(&String::from_utf8_lossy(&chunk));
        }
        event_text
    })
    .await
    .expect("event chunk timeout");
    assert!(event_text.contains(r#""type":"reset""#));
    assert!(event_text.contains(r#""reason":"restored_from_snapshot""#));
    assert!(event_text.contains("Restored from snapshot"));

    let subscription: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/subscribe",
            restored.base_url()
        ))
        .json(&json!({"role": "controller"}))
        .send()
        .await
        .expect("subscribe response")
        .json()
        .await
        .expect("subscribe json");
    assert_eq!(subscription["controller_lease_granted"], true);
    assert_eq!(subscription["snapshot"]["session_id"], "sess_test");

    restored.shutdown().await;
}

#[test]
fn snapshot_manifest_parser_accepts_typescript_hosted_shape() {
    let workspace = tempdir().expect("workspace");
    let readme_path = workspace.path().join("README.md");
    std::fs::write(&readme_path, "# workspace\n").expect("workspace file");
    let manifest = json!({
        "protocol_version": HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
        "runner_session_id": "mrs_ts",
        "workspace_id": "ws_ts",
        "agent_run_id": "run_ts",
        "maestro_session_id": "session_ts",
        "reason": "ttl_expired",
        "requested_by": "platform",
        "created_at": "2026-04-23T00:00:00.000Z",
        "workspace_root": workspace.path(),
        "runtime": {
            "flush_status": "completed",
            "session_id": "session_ts",
            "session_file": workspace.path().join(".maestro/sessions/session.jsonl"),
            "protocol_version": HEADLESS_PROTOCOL_VERSION,
            "cursor": 7
        },
        "workspace_export": {
            "mode": "local_path_contract",
            "paths": [{
                "input": "README.md",
                "path": readme_path,
                "relative_path": "README.md",
                "type": "file"
            }]
        },
        "work_continuity": {
            "protocol_version": HOSTED_RUNNER_WORK_CONTINUITY_VERSION,
            "active_tool_count": 1,
            "tracked_tool_count": 1,
            "pending_request_count": 0,
            "codex_subagent_tool_call_ids": ["collab-spawn-ts"],
            "codex_subagent_child_run_ids": ["agent-run-child-ts"],
            "codex_subagent_thread_ids": ["child-thread-ts"]
        },
        "platform_evidence": {
            "protocol_version": HOSTED_RUNNER_PLATFORM_EVIDENCE_VERSION,
            "event_type": "hosted_runner_drain_manifest_recorded",
            "runner_session_id": "mrs_ts",
            "workspace_id": "ws_ts",
            "agent_run_id": "run_ts",
            "maestro_session_id": "session_ts",
            "status": "drained",
            "runtime_flush_status": "completed",
            "manifest_path": workspace.path().join(".maestro/runner-snapshots/mrs_ts.json"),
            "manifest_protocol_version": HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
            "created_at": "2026-04-23T00:00:00.000Z",
            "reason": "ttl_expired",
            "requested_by": "platform",
            "work_continuity": {
                "protocol_version": HOSTED_RUNNER_WORK_CONTINUITY_VERSION,
                "active_tool_count": 1,
                "tracked_tool_count": 1,
                "pending_request_count": 0,
                "codex_subagent_tool_call_count": 1,
                "codex_subagent_child_run_count": 1,
                "codex_subagent_thread_count": 1,
                "codex_subagent_edge_count": 0,
                "codex_subagent_tool_call_ids": ["collab-spawn-ts"],
                "codex_subagent_child_run_ids": ["agent-run-child-ts"],
                "codex_subagent_thread_ids": ["child-thread-ts"]
            },
            "retention": {
                "policy_version": HOSTED_RUNNER_RETENTION_POLICY_VERSION,
                "control_plane_metadata_visibility": "operator",
                "runtime_snapshot_visibility": "internal",
                "redaction_required_before_external_persistence": [
                    "runtime_snapshot",
                    "runtime_logs"
                ]
            },
            "evidence_refs": [
                "remote-runner://sessions/mrs_ts/drain#manifest",
                "maestro://headless/sessions/session_ts#drain",
                "platform-agent-run:run_ts"
            ]
        },
        "retention_policy": {
            "policy_version": HOSTED_RUNNER_RETENTION_POLICY_VERSION,
            "managed_by": "platform",
            "visibility": {
                "control_plane_metadata": "operator",
                "workspace_export": "tenant",
                "runtime_snapshot": "internal",
                "runtime_logs": "operator"
            },
            "redaction": {
                "required_before_external_persistence": [
                    "runtime_snapshot",
                    "runtime_logs"
                ],
                "forbidden_plaintext": [
                    "provider_credentials",
                    "tool_secrets",
                    "attach_tokens",
                    "artifact_access_tokens",
                    "raw_environment"
                ]
            }
        },
        "snapshot": {
            "protocolVersion": HEADLESS_PROTOCOL_VERSION,
            "session_id": "session_ts",
            "cursor": 7,
            "last_init": null,
            "state": {
                "protocol_version": HEADLESS_PROTOCOL_VERSION,
                "connection_count": 0,
                "subscriber_count": 0,
                "connections": [],
                "model": "gpt-5.4",
                "provider": "openai",
                "session_id": "session_ts",
                "cwd": workspace.path(),
                "pending_approvals": [],
                "pending_client_tools": [],
                "pending_mcp_elicitations": [],
                "pending_user_inputs": [],
                "pending_tool_retries": [],
                "tracked_tools": [],
                "active_tools": [],
                "active_utility_commands": [],
                "active_file_watches": [],
                "last_status": "Ready",
                "is_ready": true,
                "is_responding": false
            }
        }
    });
    let bytes = serde_json::to_vec(&manifest).expect("manifest json");
    let parsed = parse_snapshot_manifest_bytes(&bytes, workspace.path()).expect("typed manifest");

    assert_eq!(
        parsed.protocol_version,
        HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION
    );
    assert_eq!(parsed.runtime.flush_status, RuntimeFlushStatus::Completed);
    assert_eq!(
        parsed
            .retention_policy
            .as_ref()
            .expect("retention policy")
            .policy_version,
        HOSTED_RUNNER_RETENTION_POLICY_VERSION
    );
    let work_continuity = parsed.work_continuity.as_ref().expect("work continuity");
    assert_eq!(
        work_continuity.protocol_version,
        HOSTED_RUNNER_WORK_CONTINUITY_VERSION
    );
    assert_eq!(
        work_continuity.codex_subagent_child_run_ids,
        vec!["agent-run-child-ts".to_string()]
    );
    assert_eq!(
        parsed
            .platform_evidence
            .as_ref()
            .expect("platform evidence")
            .protocol_version,
        HOSTED_RUNNER_PLATFORM_EVIDENCE_VERSION
    );
    assert_eq!(parsed.snapshot.session_id, "session_ts");
    assert_eq!(parsed.snapshot.cursor, 7);
    assert_eq!(parsed.workspace_export.paths[0].relative_path, "README.md");
}

#[test]
fn runtime_state_snapshot_serializes_empty_codex_subagent_edges() {
    let snapshot = RuntimeSnapshot {
        protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
        session_id: "session_empty_edges".to_string(),
        cursor: 0,
        last_init: None,
        state: RuntimeStateSnapshot {
            protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
            client_protocol_version: None,
            client_info: None,
            capabilities: None,
            opt_out_notifications: None,
            connection_role: None,
            connection_count: 0,
            subscriber_count: 0,
            controller_subscription_id: None,
            controller_connection_id: None,
            connections: Vec::new(),
            model: Some("gpt-5.4".to_string()),
            provider: Some("rust".to_string()),
            session_id: Some("session_empty_edges".to_string()),
            cwd: None,
            git_branch: None,
            current_response: None,
            pending_approvals: Vec::new(),
            pending_client_tools: Vec::new(),
            pending_mcp_elicitations: Vec::new(),
            pending_user_inputs: Vec::new(),
            pending_tool_retries: Vec::new(),
            tracked_tools: Vec::new(),
            active_tools: Vec::new(),
            codex_subagent_edges: Vec::new(),
            active_utility_commands: Vec::new(),
            active_file_watches: Vec::new(),
            last_error: None,
            last_error_type: None,
            last_status: Some("Ready".to_string()),
            last_response_duration_ms: None,
            last_ttft_ms: None,
            is_ready: true,
            is_responding: false,
        },
    };

    let value = serde_json::to_value(&snapshot).expect("snapshot json");
    let empty_edges = json!([]);

    assert_eq!(
        value.pointer("/state/codex_subagent_edges"),
        Some(&empty_edges)
    );
}

#[test]
fn work_continuity_manifest_extracts_codex_subagent_ids() {
    let snapshot: RuntimeSnapshot = serde_json::from_value(json!({
        "protocolVersion": HEADLESS_PROTOCOL_VERSION,
        "session_id": "session_rust",
        "cursor": 9,
        "last_init": null,
        "state": {
            "protocol_version": HEADLESS_PROTOCOL_VERSION,
            "connection_count": 0,
            "subscriber_count": 0,
            "connections": [],
            "model": "gpt-5.4",
            "provider": "rust",
            "session_id": "session_rust",
            "pending_approvals": [{
                "id": "approval-rust",
                "call_id": "approval-call-rust",
                "tool": "shell"
            }],
            "pending_client_tools": [],
            "pending_mcp_elicitations": [],
            "pending_user_inputs": [{
                "id": "input-rust",
                "prompt": "continue?"
            }],
            "pending_tool_retries": [],
                "tracked_tools": [{
                    "call_id": "collab-spawn-rust",
                    "tool_execution_id": "texec-collab-spawn-rust",
                    "tool": "codex.subagent.spawnAgent",
                "args": {
                    "prompt": "Sensitive Rust subagent prompt",
                    "codex_work_graph": {
                        "schema_version": "evalops.maestro.codex.subagent-workgraph.v1",
                        "child_runs": [{
                            "edge_id": "collab-spawn-rust:0:spawnAgent:agent-run-child-rust",
                            "target_index": 0,
                            "thread_id": "child-thread-rust",
                            "child_run_id": "agent-run-child-rust",
                            "status": "running"
                        }]
                    }
                }
            }],
            "active_tools": [{
                "call_id": "collab-spawn-rust",
                "tool": "codex.subagent.spawnAgent",
                "output": "starting child"
            }],
            "active_utility_commands": [],
            "active_file_watches": [],
            "is_ready": true,
            "is_responding": false
        }
    }))
    .expect("runtime snapshot");

    let continuity = default_work_continuity_manifest(&snapshot);

    assert_eq!(
        continuity.protocol_version,
        HOSTED_RUNNER_WORK_CONTINUITY_VERSION
    );
    assert_eq!(continuity.active_tool_count, 1);
    assert_eq!(continuity.tracked_tool_count, 1);
    assert_eq!(continuity.pending_request_count, 2);
    assert_eq!(
        continuity.codex_subagent_tool_call_ids,
        vec!["collab-spawn-rust".to_string()]
    );
    assert_eq!(
        continuity.codex_subagent_child_run_ids,
        vec!["agent-run-child-rust".to_string()]
    );
    assert_eq!(
        continuity.codex_subagent_thread_ids,
        vec!["child-thread-rust".to_string()]
    );
    assert_eq!(
        continuity.codex_subagent_edges,
        vec![CodexSubagentContinuityEdge {
            spawn_tool_call_id: Some("collab-spawn-rust".to_string()),
            spawn_tool_execution_id: Some("texec-collab-spawn-rust".to_string()),
            wait_tool_call_id: None,
            wait_tool_execution_id: None,
            child_run_id: Some("agent-run-child-rust".to_string()),
            thread_id: Some("child-thread-rust".to_string()),
            operation: "spawn_agent".to_string(),
            status: "running".to_string(),
        }]
    );
    let continuity_json = serde_json::to_string(&continuity).expect("continuity json");
    assert!(!continuity_json.contains("Sensitive Rust subagent prompt"));
}

#[test]
fn work_continuity_manifest_preserves_restored_codex_subagent_edges() {
    let snapshot: RuntimeSnapshot = serde_json::from_value(json!({
        "protocolVersion": HEADLESS_PROTOCOL_VERSION,
        "session_id": "session_rust_restored",
        "cursor": 10,
        "last_init": null,
        "state": {
            "protocol_version": HEADLESS_PROTOCOL_VERSION,
            "connection_count": 0,
            "subscriber_count": 0,
            "connections": [],
            "model": "gpt-5.4",
            "provider": "rust",
            "session_id": "session_rust_restored",
            "pending_approvals": [],
            "pending_client_tools": [],
            "pending_mcp_elicitations": [],
            "pending_user_inputs": [],
            "pending_tool_retries": [],
            "tracked_tools": [],
            "active_tools": [],
            "codex_subagent_edges": [
                {
                    "spawn_tool_call_id": "collab-spawn-rust-restored",
                    "child_run_id": "agent-run-child-rust-restored",
                    "thread_id": "child-thread-rust-restored",
                    "operation": "spawn_agent",
                    "status": "completed"
                },
                {
                    "wait_tool_call_id": "collab-close-rust-restored",
                    "child_run_id": "agent-run-child-rust-restored",
                    "thread_id": "child-thread-rust-restored",
                    "operation": "close_agent",
                    "status": "closed"
                }
            ],
            "active_utility_commands": [],
            "active_file_watches": [],
            "is_ready": true,
            "is_responding": false
        }
    }))
    .expect("runtime snapshot");

    let continuity = default_work_continuity_manifest(&snapshot);

    assert_eq!(continuity.active_tool_count, 0);
    assert_eq!(continuity.tracked_tool_count, 2);
    assert_eq!(continuity.pending_request_count, 0);
    assert_eq!(
        continuity.codex_subagent_tool_call_ids,
        vec![
            "collab-close-rust-restored".to_string(),
            "collab-spawn-rust-restored".to_string(),
        ]
    );
    assert_eq!(
        continuity.codex_subagent_child_run_ids,
        vec!["agent-run-child-rust-restored".to_string()]
    );
    assert_eq!(
        continuity.codex_subagent_thread_ids,
        vec!["child-thread-rust-restored".to_string()]
    );
    assert_eq!(
        continuity.codex_subagent_edges,
        vec![
            CodexSubagentContinuityEdge {
                spawn_tool_call_id: None,
                spawn_tool_execution_id: None,
                wait_tool_call_id: Some("collab-close-rust-restored".to_string()),
                wait_tool_execution_id: None,
                child_run_id: Some("agent-run-child-rust-restored".to_string()),
                thread_id: Some("child-thread-rust-restored".to_string()),
                operation: "close_agent".to_string(),
                status: "closed".to_string(),
            },
            CodexSubagentContinuityEdge {
                spawn_tool_call_id: Some("collab-spawn-rust-restored".to_string()),
                spawn_tool_execution_id: None,
                wait_tool_call_id: None,
                wait_tool_execution_id: None,
                child_run_id: Some("agent-run-child-rust-restored".to_string()),
                thread_id: Some("child-thread-rust-restored".to_string()),
                operation: "spawn_agent".to_string(),
                status: "completed".to_string(),
            },
        ]
    );
}

#[test]
fn work_continuity_manifest_counts_mixed_codex_and_regular_tools() {
    let snapshot: RuntimeSnapshot = serde_json::from_value(json!({
        "protocolVersion": HEADLESS_PROTOCOL_VERSION,
        "session_id": "session_rust_mixed",
        "cursor": 11,
        "last_init": null,
        "state": {
            "protocol_version": HEADLESS_PROTOCOL_VERSION,
            "connection_count": 0,
            "subscriber_count": 0,
            "connections": [],
            "model": "gpt-5.4",
            "provider": "rust",
            "session_id": "session_rust_mixed",
            "pending_approvals": [],
            "pending_client_tools": [],
            "pending_mcp_elicitations": [],
            "pending_user_inputs": [],
            "pending_tool_retries": [],
            "tracked_tools": [{
                "call_id": "regular-tracked-rust",
                "tool": "shell.exec",
                "args": {
                    "command": "pwd"
                }
            }],
            "active_tools": [{
                "call_id": "regular-active-rust",
                "tool": "shell.exec",
                "output": "running"
            }],
            "codex_subagent_edges": [
                {
                    "spawn_tool_call_id": "collab-spawn-mixed",
                    "child_run_id": "agent-run-child-mixed",
                    "thread_id": "child-thread-mixed",
                    "operation": "spawn_agent",
                    "status": "completed"
                },
                {
                    "wait_tool_call_id": "collab-wait-mixed",
                    "child_run_id": "agent-run-child-mixed",
                    "thread_id": "child-thread-mixed",
                    "operation": "wait_agent",
                    "status": "wait_pending"
                }
            ],
            "active_utility_commands": [],
            "active_file_watches": [],
            "is_ready": true,
            "is_responding": false
        }
    }))
    .expect("runtime snapshot");

    let continuity = default_work_continuity_manifest(&snapshot);

    assert_eq!(continuity.active_tool_count, 2);
    assert_eq!(continuity.tracked_tool_count, 3);
    assert_eq!(
        continuity.codex_subagent_tool_call_ids,
        vec![
            "collab-spawn-mixed".to_string(),
            "collab-wait-mixed".to_string()
        ]
    );
}

#[test]
fn work_continuity_manifest_keeps_spawned_and_resumed_codex_subagents_active() {
    let snapshot: RuntimeSnapshot = serde_json::from_value(json!({
        "protocolVersion": HEADLESS_PROTOCOL_VERSION,
        "session_id": "session_rust_active_subagents",
        "cursor": 12,
        "last_init": null,
        "state": {
            "protocol_version": HEADLESS_PROTOCOL_VERSION,
            "connection_count": 0,
            "subscriber_count": 0,
            "connections": [],
            "model": "gpt-5.4",
            "provider": "rust",
            "session_id": "session_rust_active_subagents",
            "pending_approvals": [],
            "pending_client_tools": [],
            "pending_mcp_elicitations": [],
            "pending_user_inputs": [],
            "pending_tool_retries": [],
            "tracked_tools": [],
            "active_tools": [],
            "codex_subagent_edges": [
                {
                    "spawn_tool_call_id": "collab-spawn-active",
                    "child_run_id": "agent-run-child-spawned",
                    "thread_id": "child-thread-spawned",
                    "operation": "spawn_agent",
                    "status": "spawned"
                },
                {
                    "wait_tool_call_id": "collab-send-ack",
                    "child_run_id": "agent-run-child-ack",
                    "thread_id": "child-thread-ack",
                    "operation": "send_input",
                    "status": "acknowledged"
                },
                {
                    "wait_tool_call_id": "collab-resume-active",
                    "child_run_id": "agent-run-child-resumed",
                    "thread_id": "child-thread-resumed",
                    "operation": "resume_agent",
                    "status": "resumed"
                }
            ],
            "active_utility_commands": [],
            "active_file_watches": [],
            "is_ready": true,
            "is_responding": false
        }
    }))
    .expect("runtime snapshot");

    let continuity = default_work_continuity_manifest(&snapshot);

    assert_eq!(continuity.active_tool_count, 2);
    assert_eq!(continuity.tracked_tool_count, 3);
    assert_eq!(
        continuity.codex_subagent_tool_call_ids,
        vec![
            "collab-resume-active".to_string(),
            "collab-send-ack".to_string(),
            "collab-spawn-active".to_string()
        ]
    );
}

#[tokio::test]
async fn failed_restore_manifest_stays_not_ready_and_rejects_attach() {
    let workspace = tempdir().expect("workspace");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let connection: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({
            "sessionId": "sess_test",
            "connectionId": "conn_partial_restore",
            "role": "controller"
        }))
        .send()
        .await
        .expect("connection response")
        .json()
        .await
        .expect("connection json");
    assert_eq!(connection["connection_id"], "conn_partial_restore");

    let message: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/messages",
            handle.base_url()
        ))
        .header("x-maestro-headless-connection-id", "conn_partial_restore")
        .json(&json!({"type": "prompt", "content": "before interrupted restore"}))
        .send()
        .await
        .expect("message response")
        .json()
        .await
        .expect("message json");
    assert!(message["cursor"].as_u64().unwrap_or_default() > 0);

    let drain: serde_json::Value = client
        .post(format!(
            "{}/.well-known/evalops/remote-runner/drain",
            handle.base_url()
        ))
        .json(&json!({"reason": "preempted"}))
        .send()
        .await
        .expect("drain response")
        .json()
        .await
        .expect("drain json");
    let manifest_path = PathBuf::from(drain["manifest_path"].as_str().expect("manifest path"));
    let restored_cursor = drain["manifest"]["runtime"]["cursor"]
        .as_u64()
        .expect("manifest cursor");
    let mut partial_manifest = drain["manifest"].clone();
    partial_manifest["runtime"]["flush_status"] = json!("failed");
    partial_manifest["runtime"]["error"] = json!("flush timed out");
    tokio::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&partial_manifest).expect("manifest json"),
    )
    .await
    .expect("write partial manifest");
    handle.shutdown().await;

    let mut restore_config = test_config(workspace.path().to_path_buf());
    restore_config.runner_session_id = "mrs_partial_restored".to_string();
    restore_config.maestro_session_id = None;
    restore_config.restore_manifest_path = Some(manifest_path);
    let restored = start_hosted_runner(restore_config)
        .await
        .expect("start restored hosted runner");

    let identity: HostedRunnerIdentity = client
        .get(format!(
            "{}/.well-known/evalops/remote-runner/identity",
            restored.base_url()
        ))
        .send()
        .await
        .expect("identity response")
        .json()
        .await
        .expect("identity json");
    assert_eq!(identity.runner_session_id, "mrs_partial_restored");
    assert!(!identity.ready);
    assert!(!identity.draining);

    let state: serde_json::Value = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/state",
            restored.base_url()
        ))
        .send()
        .await
        .expect("state response")
        .json()
        .await
        .expect("state json");
    assert_eq!(state["session_id"], "sess_test");
    assert_eq!(state["cursor"], restored_cursor);
    assert_eq!(
        state["state"]["last_status"],
        "Restore interrupted before runtime flush completed"
    );
    assert_eq!(state["state"]["last_error"], "flush timed out");
    assert_eq!(state["state"]["last_error_type"], "protocol");
    assert_eq!(state["state"]["is_ready"], false);

    let ready = client
        .get(format!("{}/readyz", restored.base_url()))
        .send()
        .await
        .expect("ready response");
    assert_eq!(ready.status(), StatusCode::SERVICE_UNAVAILABLE);

    let attach = client
        .post(format!("{}/api/headless/connections", restored.base_url()))
        .json(&json!({"sessionId": "sess_test", "role": "controller"}))
        .send()
        .await
        .expect("attach response");
    assert_eq!(attach.status(), StatusCode::SERVICE_UNAVAILABLE);

    let mut events_response = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/events?cursor=0",
            restored.base_url()
        ))
        .send()
        .await
        .expect("events response");
    assert_eq!(events_response.status(), StatusCode::OK);
    let event_text = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut event_text = String::new();
        while !event_text.contains(r#""reason":"restored_from_snapshot""#) {
            let chunk = events_response
                .chunk()
                .await
                .expect("event chunk read")
                .expect("event chunk");
            event_text.push_str(&String::from_utf8_lossy(&chunk));
        }
        event_text
    })
    .await
    .expect("event chunk timeout");
    assert!(event_text.contains(r#""type":"reset""#));
    assert!(event_text.contains("Restore interrupted before runtime flush completed"));

    restored.shutdown().await;
}

#[tokio::test]
async fn skipped_restore_manifest_stays_not_ready() {
    let workspace = tempdir().expect("workspace");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let drain: serde_json::Value = client
        .post(format!(
            "{}/.well-known/evalops/remote-runner/drain",
            handle.base_url()
        ))
        .json(&json!({"reason": "empty-runtime"}))
        .send()
        .await
        .expect("drain response")
        .json()
        .await
        .expect("drain json");
    assert_eq!(drain["manifest"]["runtime"]["flush_status"], "skipped");
    let manifest_path = PathBuf::from(drain["manifest_path"].as_str().expect("manifest path"));
    handle.shutdown().await;

    let mut restore_config = test_config(workspace.path().to_path_buf());
    restore_config.runner_session_id = "mrs_skipped_restored".to_string();
    restore_config.maestro_session_id = None;
    restore_config.restore_manifest_path = Some(manifest_path);
    let restored = start_hosted_runner(restore_config)
        .await
        .expect("start restored hosted runner");

    let identity: HostedRunnerIdentity = client
        .get(format!(
            "{}/.well-known/evalops/remote-runner/identity",
            restored.base_url()
        ))
        .send()
        .await
        .expect("identity response")
        .json()
        .await
        .expect("identity json");
    assert!(!identity.ready);

    let state: serde_json::Value = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/state",
            restored.base_url()
        ))
        .send()
        .await
        .expect("state response")
        .json()
        .await
        .expect("state json");
    assert_eq!(
        state["state"]["last_status"],
        "Restore incomplete: runtime flush skipped"
    );
    assert_eq!(
        state["state"]["last_error"],
        "runtime flush was skipped; no runtime activity was persisted"
    );
    assert_eq!(state["state"]["last_error_type"], "protocol");
    assert_eq!(state["state"]["is_ready"], false);

    restored.shutdown().await;
}

#[tokio::test]
async fn message_executor_publishes_runtime_handled_events() {
    let workspace = tempdir().expect("workspace");
    let handle = start_hosted_runner_with_message_executor(
        test_config(workspace.path().to_path_buf()),
        Arc::new(ScriptedRuntimeExecutor),
    )
    .await
    .expect("start hosted runner");
    let client = reqwest::Client::new();

    let connection: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({
            "sessionId": "sess_test",
            "connectionId": "conn_exec",
            "role": "controller"
        }))
        .send()
        .await
        .expect("connection response")
        .json()
        .await
        .expect("connection json");
    assert_eq!(connection["connection_id"], "conn_exec");

    let subscription: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/subscribe",
            handle.base_url()
        ))
        .json(&json!({
            "connectionId": "conn_exec",
            "subscriptionId": "sub_exec",
            "role": "controller"
        }))
        .send()
        .await
        .expect("subscription response")
        .json()
        .await
        .expect("subscription json");
    let subscription_id = subscription["subscription_id"]
        .as_str()
        .expect("subscription id")
        .to_string();

    let message: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/messages",
            handle.base_url()
        ))
        .header("x-maestro-headless-connection-id", "conn_exec")
        .header("x-maestro-headless-subscriber-id", subscription_id)
        .json(&json!({"type": "prompt", "content": "hello"}))
        .send()
        .await
        .expect("message response")
        .json()
        .await
        .expect("message json");
    assert_eq!(message["success"], true);
    assert_eq!(message["execution"], "runtime_handled");
    assert_eq!(message["published_messages"], 3);

    let mut events_response = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/events?cursor=0",
            handle.base_url()
        ))
        .send()
        .await
        .expect("events response");
    assert_eq!(events_response.status(), StatusCode::OK);
    let mut event_text = String::new();
    for _ in 0..8 {
        let chunk =
            tokio::time::timeout(std::time::Duration::from_secs(1), events_response.chunk())
                .await
                .expect("event chunk timeout")
                .expect("event chunk read");
        let Some(chunk) = chunk else {
            break;
        };
        event_text.push_str(&String::from_utf8_lossy(&chunk));
        if event_text.contains("\"type\":\"response_end\"") {
            break;
        }
    }
    assert!(event_text.contains("\"type\":\"response_start\""));
    assert!(event_text.contains("\"type\":\"response_chunk\""));
    assert!(event_text.contains("\"content\":\"runtime: hello\""));
    assert!(event_text.contains("\"type\":\"response_end\""));

    handle.shutdown().await;
}

#[tokio::test]
async fn state_snapshot_merges_supervisor_agent_state_with_hosted_connections() {
    let workspace = tempdir().expect("workspace");
    let mut current_response = crate::headless::StreamingResponse::new("resp-state-1".to_string());
    current_response.append("working on hosted state", false);
    let supervisor_state = AgentState {
        model: Some("gpt-5.4".to_string()),
        provider: Some("openai".to_string()),
        session_id: Some("supervisor-session-1".to_string()),
        cwd: Some("/runtime/workspace".to_string()),
        git_branch: Some("feature/runtime-state".to_string()),
        current_response: Some(current_response),
        pending_approvals: vec![crate::headless::PendingApproval {
            call_id: "call-1".to_string(),
            tool_execution_id: None,
            request_id: Some("approval-1".to_string()),
            tool: "bash".to_string(),
            args: json!({"cmd": "cargo test"}),
            started_at_ms: Some(1_771_000_000_000),
        }],
        last_status: Some("thinking".to_string()),
        is_ready: true,
        is_responding: true,
        ..AgentState::default()
    };
    let handle = start_hosted_runner_with_message_executor(
        test_config(workspace.path().to_path_buf()),
        Arc::new(StatefulRuntimeExecutor::new(supervisor_state)),
    )
    .await
    .expect("start hosted runner");
    let client = reqwest::Client::new();

    let controller: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({
            "sessionId": "sess_test",
            "connectionId": "conn_state",
            "role": "controller"
        }))
        .send()
        .await
        .expect("controller response")
        .json()
        .await
        .expect("controller json");
    assert_eq!(controller["snapshot"]["state"]["model"], "gpt-5.4");
    assert_eq!(controller["snapshot"]["state"]["connection_count"], 1);

    let subscribe: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/subscribe",
            handle.base_url()
        ))
        .json(&json!({"connectionId": "conn_state", "role": "controller"}))
        .send()
        .await
        .expect("subscribe response")
        .json()
        .await
        .expect("subscribe json");
    assert_eq!(
        subscribe["snapshot"]["state"]["controller_connection_id"],
        "conn_state"
    );
    assert!(subscribe["snapshot"]["state"]["controller_subscription_id"]
        .as_str()
        .is_some());

    let state: serde_json::Value = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/state",
            handle.base_url()
        ))
        .send()
        .await
        .expect("state response")
        .json()
        .await
        .expect("state json");
    assert_eq!(state["state"]["model"], "gpt-5.4");
    assert_eq!(state["state"]["provider"], "openai");
    assert_eq!(state["state"]["session_id"], "supervisor-session-1");
    assert_eq!(state["state"]["cwd"], "/runtime/workspace");
    assert_eq!(state["state"]["git_branch"], "feature/runtime-state");
    assert_eq!(
        state["state"]["current_response"]["response_id"],
        "resp-state-1"
    );
    assert_eq!(state["state"]["pending_approvals"][0]["call_id"], "call-1");
    assert_eq!(state["state"]["last_status"], "thinking");
    assert_eq!(state["state"]["is_ready"], true);
    assert_eq!(state["state"]["is_responding"], true);
    assert_eq!(state["state"]["connection_count"], 1);
    assert_eq!(state["state"]["subscriber_count"], 1);
    assert_eq!(state["state"]["controller_connection_id"], "conn_state");
    assert_eq!(
        state["state"]["connections"][0]["controller_lease_granted"],
        true
    );

    handle.shutdown().await;
}

#[tokio::test]
async fn remote_transport_attaches_and_receives_workspace_events() {
    let workspace = tempdir().expect("workspace");
    tokio::fs::write(workspace.path().join("notes.md"), "alpha\nbeta\n")
        .await
        .expect("write fixture");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let mut transport = crate::headless::RemoteAgentTransport::connect(RemoteTransportConfig {
        base_url: handle.base_url(),
        session_id: Some("sess_test".to_string()),
        role: Some("controller".to_string()),
        client_name: "rust-hosted-runner-test".to_string(),
        opt_out_notifications: vec!["heartbeat".to_string()],
        ..RemoteTransportConfig::default()
    })
    .await
    .expect("connect");

    assert_eq!(transport.session_id(), "sess_test");
    transport
        .read_file(
            "read_notes".to_string(),
            "notes.md".to_string(),
            None,
            None,
            None,
        )
        .expect("send read request");

    let mut saw_read = false;
    for _ in 0..8 {
        let incoming =
            tokio::time::timeout(std::time::Duration::from_secs(1), transport.recv_incoming())
                .await
                .expect("incoming timeout")
                .expect("incoming event");
        if let crate::headless::RemoteIncoming::Message(FromAgentMessage::UtilityFileReadResult {
            content,
            ..
        }) = incoming
        {
            saw_read = content.contains("alpha");
            break;
        }
    }
    assert!(saw_read, "expected hosted runner file read event");

    transport
        .shutdown_and_wait()
        .await
        .expect("shutdown transport");
    handle.shutdown().await;
}

#[tokio::test]
async fn hosted_messages_reject_workspace_escape_before_file_work() {
    let workspace = tempdir().expect("workspace");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let connection: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({"sessionId": "sess_test", "role": "controller"}))
        .send()
        .await
        .expect("connection response")
        .json()
        .await
        .expect("connection json");
    let connection_id = connection["connection_id"]
        .as_str()
        .expect("connection id")
        .to_string();
    let subscription: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/subscribe",
            handle.base_url()
        ))
        .json(&json!({"connectionId": connection_id, "role": "controller"}))
        .send()
        .await
        .expect("subscription response")
        .json()
        .await
        .expect("subscription json");
    let subscription_id = subscription["subscription_id"]
        .as_str()
        .expect("subscription id")
        .to_string();

    let response = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/messages",
            handle.base_url()
        ))
        .header("x-maestro-headless-connection-id", connection_id)
        .header("x-maestro-headless-subscriber-id", subscription_id)
        .json(&json!({
            "type": "utility_file_read",
            "read_id": "escape",
            "path": "../secret.txt"
        }))
        .send()
        .await
        .expect("message response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body: serde_json::Value = response.json().await.expect("error body");
    assert_eq!(body["error_type"], "workspace_violation");

    handle.shutdown().await;
}

#[tokio::test]
async fn hosted_messages_reject_symlink_escape_for_missing_child() {
    let workspace = tempdir().expect("workspace");
    let outside = tempdir().expect("outside");
    std::os::unix::fs::symlink(outside.path(), workspace.path().join("outside-link"))
        .expect("symlink fixture");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let connection: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({"sessionId": "sess_test", "role": "controller"}))
        .send()
        .await
        .expect("connection response")
        .json()
        .await
        .expect("connection json");
    let connection_id = connection["connection_id"]
        .as_str()
        .expect("connection id")
        .to_string();
    let subscription: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/subscribe",
            handle.base_url()
        ))
        .json(&json!({"connectionId": connection_id, "role": "controller"}))
        .send()
        .await
        .expect("subscription response")
        .json()
        .await
        .expect("subscription json");
    let subscription_id = subscription["subscription_id"]
        .as_str()
        .expect("subscription id")
        .to_string();

    let response = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/messages",
            handle.base_url()
        ))
        .header("x-maestro-headless-connection-id", connection_id)
        .header("x-maestro-headless-subscriber-id", subscription_id)
        .json(&json!({
            "type": "utility_file_read",
            "read_id": "symlink-escape",
            "path": "outside-link/missing.txt"
        }))
        .send()
        .await
        .expect("message response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body: serde_json::Value = response.json().await.expect("error body");
    assert_eq!(body["error_type"], "workspace_violation");

    handle.shutdown().await;
}

#[tokio::test]
async fn duplicate_subscribe_preserves_disconnect_cleanup() {
    let workspace = tempdir().expect("workspace");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let connection: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({
            "sessionId": "sess_test",
            "connectionId": "conn_multi",
            "role": "controller",
            "protocolVersion": "2026-03-30",
            "clientInfo": {"name": "lease-test", "version": "1.0.0"},
            "capabilities": {
                "serverRequests": ["approval"],
                "utilityOperations": ["file_read"],
                "rawAgentEvents": true
            }
        }))
        .send()
        .await
        .expect("connection response")
        .json()
        .await
        .expect("connection json");
    assert_eq!(connection["connection_id"], "conn_multi");
    assert!(connection["lease_expires_at"].as_str().is_some());

    let mut subscription_ids = Vec::new();
    for _ in 0..2 {
        let subscription = client
            .post(format!(
                "{}/api/headless/sessions/sess_test/subscribe",
                handle.base_url()
            ))
            .json(&json!({
                "connectionId": "conn_multi",
                "role": "controller"
            }))
            .send()
            .await
            .expect("subscription response");
        assert_eq!(subscription.status(), StatusCode::OK);
        let subscription: serde_json::Value = subscription.json().await.expect("subscription json");
        subscription_ids.push(
            subscription["subscription_id"]
                .as_str()
                .expect("subscription id")
                .to_string(),
        );
    }
    subscription_ids.sort();

    let state: serde_json::Value = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/state",
            handle.base_url()
        ))
        .send()
        .await
        .expect("state response")
        .json()
        .await
        .expect("state json");
    assert_eq!(state["state"]["subscriber_count"], 2);
    assert_eq!(
        state["state"]["controller_subscription_id"],
        subscription_ids[0]
    );
    let connection_state = state["state"]["connections"]
        .as_array()
        .expect("connections")
        .iter()
        .find(|connection| connection["connection_id"] == "conn_multi")
        .expect("conn_multi state");
    assert_eq!(connection_state["subscription_count"], 2);
    assert_eq!(connection_state["client_protocol_version"], "2026-03-30");
    assert_eq!(connection_state["client_info"]["name"], "lease-test");
    assert_eq!(connection_state["capabilities"]["raw_agent_events"], true);
    assert!(connection_state["lease_expires_at"].as_str().is_some());

    let heartbeat: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/heartbeat",
            handle.base_url()
        ))
        .json(&json!({"connectionId": "conn_multi"}))
        .send()
        .await
        .expect("heartbeat response")
        .json()
        .await
        .expect("heartbeat json");
    assert_eq!(heartbeat["controller_lease_granted"], true);
    assert!(heartbeat["lease_expires_at"].as_str().is_some());

    let disconnected: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/disconnect",
            handle.base_url()
        ))
        .json(&json!({"connectionId": "conn_multi"}))
        .send()
        .await
        .expect("disconnect response")
        .json()
        .await
        .expect("disconnect json");
    assert_eq!(
        disconnected["disconnected_subscription_ids"]
            .as_array()
            .expect("disconnected subscriptions")
            .len(),
        2
    );

    let state_after_disconnect: serde_json::Value = client
        .get(format!(
            "{}/api/headless/sessions/sess_test/state",
            handle.base_url()
        ))
        .send()
        .await
        .expect("state response")
        .json()
        .await
        .expect("state json");
    assert_eq!(state_after_disconnect["state"]["subscriber_count"], 0);
    assert!(state_after_disconnect["state"]["controller_connection_id"].is_null());
    assert!(state_after_disconnect["state"]["controller_subscription_id"].is_null());

    handle.shutdown().await;
}

#[tokio::test]
async fn drain_manifest_filename_stays_inside_snapshot_root() {
    let workspace = tempdir().expect("workspace");
    let snapshot_root = workspace.path().join("snapshots");
    let mut config = test_config(workspace.path().to_path_buf());
    config.runner_session_id = "../evil/session.v1".to_string();
    config.snapshot_root = Some(snapshot_root.clone());
    let handle = start_hosted_runner(config)
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let drain: serde_json::Value = client
        .post(format!(
            "{}/.well-known/evalops/remote-runner/drain",
            handle.base_url()
        ))
        .json(&json!({"reason": "sanitize-session"}))
        .send()
        .await
        .expect("drain response")
        .json()
        .await
        .expect("drain json");
    let manifest_path = PathBuf::from(drain["manifest_path"].as_str().expect("manifest path"));
    assert_eq!(manifest_path.parent(), Some(snapshot_root.as_path()));
    assert!(manifest_path.exists());
    assert!(manifest_path
        .file_name()
        .expect("manifest filename")
        .to_string_lossy()
        .starts_with("___evil_session_v1-"));

    handle.shutdown().await;
}

#[tokio::test]
async fn controller_takeover_is_explicit_and_viewers_cannot_mutate() {
    let workspace = tempdir().expect("workspace");
    let handle = start_hosted_runner(test_config(workspace.path().to_path_buf()))
        .await
        .expect("start hosted runner");
    let client = reqwest::Client::new();

    let first_controller: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({
            "sessionId": "sess_test",
            "connectionId": "conn_first",
            "role": "controller"
        }))
        .send()
        .await
        .expect("first controller response")
        .json()
        .await
        .expect("first controller json");
    assert_eq!(first_controller["controller_connection_id"], "conn_first");

    let rejected_takeover = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({
            "sessionId": "sess_test",
            "connectionId": "conn_second",
            "role": "controller"
        }))
        .send()
        .await
        .expect("rejected takeover response");
    assert_eq!(rejected_takeover.status(), StatusCode::CONFLICT);

    let accepted_takeover: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({
            "sessionId": "sess_test",
            "connectionId": "conn_second",
            "role": "controller",
            "takeControl": true
        }))
        .send()
        .await
        .expect("accepted takeover response")
        .json()
        .await
        .expect("accepted takeover json");
    assert_eq!(accepted_takeover["controller_connection_id"], "conn_second");

    let controller_message: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/messages",
            handle.base_url()
        ))
        .header("x-maestro-headless-connection-id", "conn_second")
        .json(&json!({"type": "prompt", "content": "cursor please"}))
        .send()
        .await
        .expect("controller message response")
        .json()
        .await
        .expect("controller message json");
    assert_eq!(controller_message["ok"], true);
    assert!(controller_message["cursor"].as_u64().unwrap_or_default() > 0);

    let viewer: serde_json::Value = client
        .post(format!("{}/api/headless/connections", handle.base_url()))
        .json(&json!({
            "sessionId": "sess_test",
            "connectionId": "conn_viewer",
            "role": "viewer"
        }))
        .send()
        .await
        .expect("viewer response")
        .json()
        .await
        .expect("viewer json");
    assert_eq!(viewer["role"], "viewer");
    let viewer_subscription: serde_json::Value = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/subscribe",
            handle.base_url()
        ))
        .json(&json!({
            "connectionId": "conn_viewer",
            "role": "viewer"
        }))
        .send()
        .await
        .expect("viewer subscription response")
        .json()
        .await
        .expect("viewer subscription json");
    let viewer_subscription_id = viewer_subscription["subscription_id"]
        .as_str()
        .expect("viewer subscription id");
    let viewer_message = client
        .post(format!(
            "{}/api/headless/sessions/sess_test/messages",
            handle.base_url()
        ))
        .header("x-maestro-headless-connection-id", "conn_viewer")
        .header("x-maestro-headless-subscriber-id", viewer_subscription_id)
        .json(&json!({"type": "prompt", "content": "nope"}))
        .send()
        .await
        .expect("viewer message response");
    assert_eq!(viewer_message.status(), StatusCode::FORBIDDEN);

    handle.shutdown().await;
}
