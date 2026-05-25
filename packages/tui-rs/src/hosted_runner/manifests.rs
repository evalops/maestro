use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    resolve_workspace_path, HostedError, HostedResult, HostedRunnerConfig, HostedRunnerErrorCode,
    HOSTED_RUNNER_PLATFORM_EVIDENCE_VERSION, HOSTED_RUNNER_RETENTION_POLICY_VERSION,
    HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION, HOSTED_RUNNER_WORK_CONTINUITY_VERSION,
};
use crate::headless::messages::{
    active_codex_subagent_status, codex_subagent_child_runs, codex_subagent_edge_key,
    codex_subagent_operation, codex_subagent_status_is_terminal, ApprovalMode, ClientCapabilities,
    ClientInfo, CodexSubagentContinuityEdge, ConnectionRole, ConnectionState, FromAgentMessage,
    InitConfig, ThinkingLevel, UtilityCommandShellMode, UtilityCommandTerminalMode,
    CODEX_SUBAGENT_TOOL_PREFIX, CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct RuntimeSnapshot {
    #[serde(rename = "protocolVersion")]
    pub(super) protocol_version: String,
    pub(super) session_id: String,
    pub(super) cursor: u64,
    pub(super) last_init: Option<RuntimeInitSnapshot>,
    pub(super) state: RuntimeStateSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct RuntimeInitSnapshot {
    #[serde(rename = "type")]
    pub(super) message_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) append_system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) thinking_level: Option<ThinkingLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) approval_mode: Option<ApprovalMode>,
}

impl From<&InitConfig> for RuntimeInitSnapshot {
    fn from(config: &InitConfig) -> Self {
        Self {
            message_type: "init".to_string(),
            system_prompt: config.system_prompt.clone(),
            append_system_prompt: config.append_system_prompt.clone(),
            thinking_level: config.thinking_level,
            approval_mode: config.approval_mode,
        }
    }
}

impl RuntimeInitSnapshot {
    pub(super) fn to_init_config(&self) -> Option<InitConfig> {
        (self.message_type == "init").then(|| InitConfig {
            system_prompt: self.system_prompt.clone(),
            append_system_prompt: self.append_system_prompt.clone(),
            thinking_level: self.thinking_level,
            approval_mode: self.approval_mode,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct RuntimeStateSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) client_protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) client_info: Option<ClientInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) capabilities: Option<ClientCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) opt_out_notifications: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) connection_role: Option<ConnectionRole>,
    pub(super) connection_count: usize,
    pub(super) subscriber_count: usize,
    pub(super) controller_subscription_id: Option<String>,
    pub(super) controller_connection_id: Option<String>,
    pub(super) connections: Vec<ConnectionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_response: Option<serde_json::Value>,
    pub(super) pending_approvals: Vec<serde_json::Value>,
    pub(super) pending_client_tools: Vec<serde_json::Value>,
    pub(super) pending_mcp_elicitations: Vec<serde_json::Value>,
    pub(super) pending_user_inputs: Vec<serde_json::Value>,
    pub(super) pending_tool_retries: Vec<serde_json::Value>,
    pub(super) tracked_tools: Vec<serde_json::Value>,
    pub(super) active_tools: Vec<serde_json::Value>,
    #[serde(default)]
    pub(super) codex_subagent_edges: Vec<CodexSubagentContinuityEdge>,
    pub(super) active_utility_commands: Vec<ActiveUtilityCommandSnapshot>,
    pub(super) active_file_watches: Vec<ActiveFileWatchSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) last_error_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) last_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) last_response_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) last_ttft_ms: Option<u64>,
    pub(super) is_ready: bool,
    pub(super) is_responding: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct SnapshotManifest {
    pub(super) protocol_version: String,
    pub(super) runner_session_id: String,
    pub(super) workspace_id: Option<String>,
    pub(super) agent_run_id: Option<String>,
    pub(super) maestro_session_id: String,
    pub(super) reason: Option<String>,
    pub(super) requested_by: Option<String>,
    pub(super) created_at: String,
    pub(super) workspace_root: PathBuf,
    pub(super) runtime: RuntimeFlushManifest,
    pub(super) workspace_export: WorkspaceExportManifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) work_continuity: Option<WorkContinuityManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) platform_evidence: Option<PlatformEvidenceManifest>,
    pub(super) snapshot: RuntimeSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) retention_policy: Option<RetentionPolicyManifest>,
}

impl SnapshotManifest {
    pub(super) fn validate_for_workspace(&self, workspace_root: &Path) -> HostedResult<()> {
        if self.protocol_version != HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION {
            return Err(HostedError::new(
                HostedRunnerErrorCode::InvalidSnapshotManifest,
                format!(
                    "unsupported snapshot manifest protocol version: {}",
                    self.protocol_version
                ),
            ));
        }
        if self.workspace_export.mode != "local_path_contract" {
            return Err(HostedError::new(
                HostedRunnerErrorCode::InvalidSnapshotManifest,
                format!(
                    "unsupported workspace export mode: {}",
                    self.workspace_export.mode
                ),
            ));
        }
        for path in &self.workspace_export.paths {
            let _ =
                resolve_workspace_path(workspace_root, None, Some(path.relative_path.as_str()))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct WorkContinuityManifest {
    pub(super) protocol_version: String,
    pub(super) active_tool_count: usize,
    pub(super) tracked_tool_count: usize,
    pub(super) pending_request_count: usize,
    pub(super) codex_subagent_tool_call_ids: Vec<String>,
    pub(super) codex_subagent_child_run_ids: Vec<String>,
    pub(super) codex_subagent_thread_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) codex_subagent_edges: Vec<CodexSubagentContinuityEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PlatformEvidenceManifest {
    pub(super) protocol_version: String,
    pub(super) event_type: String,
    pub(super) runner_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) agent_run_id: Option<String>,
    pub(super) maestro_session_id: String,
    pub(super) status: String,
    pub(super) runtime_flush_status: String,
    pub(super) manifest_path: String,
    pub(super) manifest_protocol_version: String,
    pub(super) created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) requested_by: Option<String>,
    pub(super) work_continuity: PlatformEvidenceWorkContinuityManifest,
    pub(super) retention: PlatformEvidenceRetentionManifest,
    pub(super) evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PlatformEvidenceWorkContinuityManifest {
    pub(super) protocol_version: String,
    pub(super) active_tool_count: usize,
    pub(super) tracked_tool_count: usize,
    pub(super) pending_request_count: usize,
    pub(super) codex_subagent_tool_call_count: usize,
    pub(super) codex_subagent_child_run_count: usize,
    pub(super) codex_subagent_thread_count: usize,
    pub(super) codex_subagent_edge_count: usize,
    pub(super) codex_subagent_tool_call_ids: Vec<String>,
    pub(super) codex_subagent_child_run_ids: Vec<String>,
    pub(super) codex_subagent_thread_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) codex_subagent_edges: Vec<CodexSubagentContinuityEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PlatformEvidenceRetentionManifest {
    pub(super) policy_version: String,
    pub(super) control_plane_metadata_visibility: String,
    pub(super) runtime_snapshot_visibility: String,
    pub(super) redaction_required_before_external_persistence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct RetentionPolicyManifest {
    pub(super) policy_version: String,
    pub(super) managed_by: String,
    pub(super) visibility: RetentionPolicyVisibility,
    pub(super) redaction: RetentionPolicyRedaction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct RetentionPolicyVisibility {
    pub(super) control_plane_metadata: String,
    pub(super) workspace_export: String,
    pub(super) runtime_snapshot: String,
    pub(super) runtime_logs: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct RetentionPolicyRedaction {
    pub(super) required_before_external_persistence: Vec<String>,
    pub(super) forbidden_plaintext: Vec<String>,
}

pub(super) fn default_retention_policy_manifest() -> RetentionPolicyManifest {
    RetentionPolicyManifest {
        policy_version: HOSTED_RUNNER_RETENTION_POLICY_VERSION.to_string(),
        managed_by: "platform".to_string(),
        visibility: RetentionPolicyVisibility {
            control_plane_metadata: "operator".to_string(),
            workspace_export: "tenant".to_string(),
            runtime_snapshot: "internal".to_string(),
            runtime_logs: "operator".to_string(),
        },
        redaction: RetentionPolicyRedaction {
            required_before_external_persistence: vec![
                "runtime_snapshot".to_string(),
                "runtime_logs".to_string(),
            ],
            forbidden_plaintext: vec![
                "provider_credentials".to_string(),
                "tool_secrets".to_string(),
                "attach_tokens".to_string(),
                "artifact_access_tokens".to_string(),
                "raw_environment".to_string(),
            ],
        },
    }
}

pub(super) fn runtime_flush_status_label(status: RuntimeFlushStatus) -> &'static str {
    match status {
        RuntimeFlushStatus::Completed => "completed",
        RuntimeFlushStatus::Failed => "failed",
        RuntimeFlushStatus::Skipped => "skipped",
    }
}

pub(super) struct PlatformEvidenceManifestInput<'a> {
    pub(super) config: &'a HostedRunnerConfig,
    pub(super) maestro_session_id: &'a str,
    pub(super) created_at: &'a str,
    pub(super) manifest_path: &'a Path,
    pub(super) runtime: &'a RuntimeFlushManifest,
    pub(super) work_continuity: &'a WorkContinuityManifest,
    pub(super) retention_policy: &'a RetentionPolicyManifest,
    pub(super) reason: Option<&'a str>,
    pub(super) requested_by: Option<&'a str>,
}

pub(super) fn default_platform_evidence_manifest(
    input: PlatformEvidenceManifestInput<'_>,
) -> PlatformEvidenceManifest {
    PlatformEvidenceManifest {
        protocol_version: HOSTED_RUNNER_PLATFORM_EVIDENCE_VERSION.to_string(),
        event_type: "hosted_runner_drain_manifest_recorded".to_string(),
        runner_session_id: input.config.runner_session_id.clone(),
        workspace_id: input.config.workspace_id.clone(),
        agent_run_id: input.config.agent_run_id.clone(),
        maestro_session_id: input.maestro_session_id.to_string(),
        status: "drained".to_string(),
        runtime_flush_status: runtime_flush_status_label(input.runtime.flush_status).to_string(),
        manifest_path: input.manifest_path.to_string_lossy().to_string(),
        manifest_protocol_version: HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION.to_string(),
        created_at: input.created_at.to_string(),
        reason: input.reason.map(ToOwned::to_owned),
        requested_by: input.requested_by.map(ToOwned::to_owned),
        work_continuity: PlatformEvidenceWorkContinuityManifest {
            protocol_version: input.work_continuity.protocol_version.clone(),
            active_tool_count: input.work_continuity.active_tool_count,
            tracked_tool_count: input.work_continuity.tracked_tool_count,
            pending_request_count: input.work_continuity.pending_request_count,
            codex_subagent_tool_call_count: input
                .work_continuity
                .codex_subagent_tool_call_ids
                .len(),
            codex_subagent_child_run_count: input
                .work_continuity
                .codex_subagent_child_run_ids
                .len(),
            codex_subagent_thread_count: input.work_continuity.codex_subagent_thread_ids.len(),
            codex_subagent_edge_count: input.work_continuity.codex_subagent_edges.len(),
            codex_subagent_tool_call_ids: input
                .work_continuity
                .codex_subagent_tool_call_ids
                .clone(),
            codex_subagent_child_run_ids: input
                .work_continuity
                .codex_subagent_child_run_ids
                .clone(),
            codex_subagent_thread_ids: input.work_continuity.codex_subagent_thread_ids.clone(),
            codex_subagent_edges: input.work_continuity.codex_subagent_edges.clone(),
        },
        retention: PlatformEvidenceRetentionManifest {
            policy_version: input.retention_policy.policy_version.clone(),
            control_plane_metadata_visibility: input
                .retention_policy
                .visibility
                .control_plane_metadata
                .clone(),
            runtime_snapshot_visibility: input.retention_policy.visibility.runtime_snapshot.clone(),
            redaction_required_before_external_persistence: input
                .retention_policy
                .redaction
                .required_before_external_persistence
                .clone(),
        },
        evidence_refs: {
            let mut refs = vec![
                format!(
                    "remote-runner://sessions/{}/drain#manifest",
                    input.config.runner_session_id
                ),
                format!(
                    "maestro://headless/sessions/{}#drain",
                    input.maestro_session_id
                ),
            ];
            if let Some(agent_run_id) = input.config.agent_run_id.as_ref() {
                refs.push(format!("platform-agent-run:{agent_run_id}"));
            }
            refs
        },
    }
}

pub(super) fn add_codex_subagent_edge(
    edges: &mut BTreeSet<CodexSubagentContinuityEdge>,
    edge: CodexSubagentContinuityEdge,
) {
    let key = codex_subagent_edge_key(&edge);
    edges.retain(|existing| codex_subagent_edge_key(existing) != key);
    edges.insert(edge);
}

pub(super) fn collect_codex_subagent_edges_from_source(
    source: &serde_json::Value,
    edges: &mut BTreeSet<CodexSubagentContinuityEdge>,
) {
    let tool = json_string_field(source, &["tool"]).unwrap_or_default();
    let Some(operation) = codex_subagent_operation(&tool) else {
        return;
    };
    let call_id = json_string_field(source, &["call_id", "callId", "tool_call_id", "toolCallId"])
        .unwrap_or_default();
    if call_id.is_empty() {
        return;
    }
    let tool_execution_id = json_string_field(source, &["tool_execution_id", "toolExecutionId"]);
    let child_runs = codex_subagent_child_runs(source.get("args"));
    if child_runs.is_empty() {
        add_codex_subagent_edge(
            edges,
            CodexSubagentContinuityEdge {
                spawn_tool_call_id: (operation == "spawn_agent").then(|| call_id.clone()),
                spawn_tool_execution_id: if operation == "spawn_agent" {
                    tool_execution_id.clone()
                } else {
                    None
                },
                wait_tool_call_id: (operation != "spawn_agent").then(|| call_id.clone()),
                wait_tool_execution_id: if operation != "spawn_agent" {
                    tool_execution_id.clone()
                } else {
                    None
                },
                child_run_id: None,
                thread_id: None,
                operation: operation.to_string(),
                status: active_codex_subagent_status(operation).to_string(),
            },
        );
        return;
    }
    for child_run in child_runs {
        let edge_status = child_run
            .status
            .unwrap_or_else(|| active_codex_subagent_status(operation).to_string());
        add_codex_subagent_edge(
            edges,
            CodexSubagentContinuityEdge {
                spawn_tool_call_id: (operation == "spawn_agent").then(|| call_id.clone()),
                spawn_tool_execution_id: if operation == "spawn_agent" {
                    tool_execution_id.clone()
                } else {
                    None
                },
                wait_tool_call_id: (operation != "spawn_agent").then(|| call_id.clone()),
                wait_tool_execution_id: if operation != "spawn_agent" {
                    tool_execution_id.clone()
                } else {
                    None
                },
                child_run_id: child_run.child_run_id,
                thread_id: child_run.thread_id,
                operation: operation.to_string(),
                status: edge_status,
            },
        );
    }
}

pub(super) fn default_work_continuity_manifest(
    snapshot: &RuntimeSnapshot,
) -> WorkContinuityManifest {
    let state = &snapshot.state;
    let mut tool_call_ids = BTreeSet::new();
    let mut child_run_ids = BTreeSet::new();
    let mut thread_ids = BTreeSet::new();
    let mut codex_subagent_edges = BTreeSet::new();
    let mut codex_tracked_source_call_ids = BTreeSet::new();
    let pending_request_count = state.pending_approvals.len()
        + state.pending_client_tools.len()
        + state.pending_mcp_elicitations.len()
        + state.pending_user_inputs.len()
        + state.pending_tool_retries.len();
    for edge in &state.codex_subagent_edges {
        if let Some(call_id) = edge.spawn_tool_call_id.as_ref() {
            tool_call_ids.insert(call_id.clone());
        }
        if let Some(call_id) = edge.wait_tool_call_id.as_ref() {
            tool_call_ids.insert(call_id.clone());
        }
        if let Some(child_run_id) = edge.child_run_id.as_ref() {
            child_run_ids.insert(child_run_id.clone());
        }
        if let Some(thread_id) = edge.thread_id.as_ref() {
            thread_ids.insert(thread_id.clone());
        }
        add_codex_subagent_edge(&mut codex_subagent_edges, edge.clone());
    }
    for source in state
        .tracked_tools
        .iter()
        .chain(state.pending_approvals.iter())
        .chain(state.pending_client_tools.iter())
        .chain(state.pending_mcp_elicitations.iter())
        .chain(state.pending_user_inputs.iter())
        .chain(state.pending_tool_retries.iter())
    {
        let tool = json_string_field(source, &["tool"]).unwrap_or_default();
        let is_codex_subagent_tool = tool.starts_with(CODEX_SUBAGENT_TOOL_PREFIX);
        let has_codex_work_args = collect_codex_work_args(
            source.get("args"),
            &mut child_run_ids,
            &mut thread_ids,
            is_codex_subagent_tool,
        );
        if is_codex_subagent_tool || has_codex_work_args {
            if let Some(call_id) =
                json_string_field(source, &["call_id", "callId", "tool_call_id", "toolCallId"])
            {
                codex_tracked_source_call_ids.insert(call_id.clone());
                tool_call_ids.insert(call_id);
            }
            collect_codex_subagent_edges_from_source(source, &mut codex_subagent_edges);
        }
    }
    for active_tool in &state.active_tools {
        let tool = json_string_field(active_tool, &["tool"]).unwrap_or_default();
        if tool.starts_with(CODEX_SUBAGENT_TOOL_PREFIX) {
            if let Some(call_id) = json_string_field(
                active_tool,
                &["call_id", "callId", "tool_call_id", "toolCallId"],
            ) {
                let has_tracked_source = tool_call_ids.contains(&call_id);
                tool_call_ids.insert(call_id);
                if !has_tracked_source {
                    collect_codex_subagent_edges_from_source(
                        active_tool,
                        &mut codex_subagent_edges,
                    );
                }
            }
        }
    }
    let codex_subagent_edges = codex_subagent_edges.into_iter().collect::<Vec<_>>();
    let active_codex_subagent_edge_count = codex_subagent_edges
        .iter()
        .filter(|edge| !codex_subagent_status_is_terminal(&edge.status))
        .count();
    let non_codex_active_tool_count = state
        .active_tools
        .iter()
        .filter(|tool| {
            !json_string_field(tool, &["tool"])
                .unwrap_or_default()
                .starts_with(CODEX_SUBAGENT_TOOL_PREFIX)
        })
        .count();
    let non_codex_tracked_tool_count = state
        .tracked_tools
        .iter()
        .filter(|tool| {
            !json_string_field(tool, &["call_id", "callId", "tool_call_id", "toolCallId"])
                .is_some_and(|call_id| codex_tracked_source_call_ids.contains(&call_id))
        })
        .count();
    let tracked_codex_subagent_count = tool_call_ids.len().max(codex_subagent_edges.len());
    let active_tool_count = if codex_subagent_edges.is_empty() {
        state.active_tools.len()
    } else {
        non_codex_active_tool_count + active_codex_subagent_edge_count
    };
    let tracked_tool_count = if codex_subagent_edges.is_empty() {
        state.tracked_tools.len()
    } else {
        non_codex_tracked_tool_count + tracked_codex_subagent_count
    };
    WorkContinuityManifest {
        protocol_version: HOSTED_RUNNER_WORK_CONTINUITY_VERSION.to_string(),
        active_tool_count,
        tracked_tool_count,
        pending_request_count,
        codex_subagent_tool_call_ids: tool_call_ids.into_iter().collect(),
        codex_subagent_child_run_ids: child_run_ids.into_iter().collect(),
        codex_subagent_thread_ids: thread_ids.into_iter().collect(),
        codex_subagent_edges,
    }
}

pub(super) fn collect_codex_work_args(
    args: Option<&serde_json::Value>,
    child_run_ids: &mut BTreeSet<String>,
    thread_ids: &mut BTreeSet<String>,
    include_loose_args: bool,
) -> bool {
    let Some(args) = args.and_then(serde_json::Value::as_object) else {
        return false;
    };
    let graph = args
        .get("codexWorkGraph")
        .or_else(|| args.get("codex_work_graph"));
    let has_codex_graph = graph
        .and_then(serde_json::Value::as_object)
        .is_some_and(|graph| {
            json_string_field_from_object(graph, &["schemaVersion", "schema_version"]).as_deref()
                == Some(CODEX_SUBAGENT_WORK_GRAPH_SCHEMA)
        });
    if !include_loose_args && !has_codex_graph {
        return false;
    }
    collect_json_string_array_from_object(args, &["childRunIds", "child_run_ids"], child_run_ids);
    collect_json_string_array_from_object(
        args,
        &["receiverThreadIds", "receiver_thread_ids"],
        thread_ids,
    );
    if let Some(graph) = graph.and_then(serde_json::Value::as_object) {
        let child_runs = graph
            .get("childRuns")
            .or_else(|| graph.get("child_runs"))
            .and_then(serde_json::Value::as_array);
        if let Some(child_runs) = child_runs {
            for child_run in child_runs {
                if let Some(child_run) = child_run.as_object() {
                    if let Some(child_run_id) =
                        json_string_field_from_object(child_run, &["childRunId", "child_run_id"])
                    {
                        child_run_ids.insert(child_run_id);
                    }
                    if let Some(thread_id) =
                        json_string_field_from_object(child_run, &["threadId", "thread_id"])
                    {
                        thread_ids.insert(thread_id);
                    }
                }
            }
        }
    }
    include_loose_args || has_codex_graph
}

pub(super) fn collect_json_string_array_from_object(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
    values: &mut BTreeSet<String>,
) {
    for key in keys {
        let Some(items) = object.get(*key).and_then(serde_json::Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some(item) = item.as_str().map(str::trim).filter(|item| !item.is_empty()) {
                values.insert(item.to_string());
            }
        }
        return;
    }
}

pub(super) fn json_string_field(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    value
        .as_object()
        .and_then(|object| json_string_field_from_object(object, keys))
}

pub(super) fn json_string_field_from_object(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RuntimeFlushStatus {
    Completed,
    #[serde(alias = "interrupted")]
    Failed,
    Skipped,
}

impl RuntimeFlushStatus {
    pub(super) fn is_completed(self) -> bool {
        matches!(self, Self::Completed)
    }

    pub(super) fn restore_last_status(self) -> &'static str {
        match self {
            Self::Completed => "Restored from snapshot",
            Self::Failed => "Restore interrupted before runtime flush completed",
            Self::Skipped => "Restore incomplete: runtime flush skipped",
        }
    }

    pub(super) fn restore_last_error(self, error: Option<&str>) -> Option<String> {
        if self.is_completed() {
            return None;
        }
        error
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| {
                Some(match self {
                    Self::Completed => unreachable!("completed restore has no restore error"),
                    Self::Failed => "runtime flush failed before restore".to_string(),
                    Self::Skipped => {
                        "runtime flush was skipped; no runtime activity was persisted".to_string()
                    }
                })
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct RuntimeFlushManifest {
    pub(super) flush_status: RuntimeFlushStatus,
    pub(super) error: Option<String>,
    pub(super) session_id: String,
    pub(super) session_file: Option<PathBuf>,
    pub(super) protocol_version: Option<String>,
    pub(super) cursor: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct WorkspaceExportManifest {
    pub(super) mode: String,
    pub(super) paths: Vec<WorkspaceExportPathManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct WorkspaceExportPathManifest {
    pub(super) input: String,
    pub(super) path: PathBuf,
    pub(super) relative_path: String,
    #[serde(rename = "type")]
    pub(super) path_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ActiveUtilityCommandSnapshot {
    pub(super) command_id: String,
    pub(super) command: String,
    pub(super) cwd: Option<String>,
    pub(super) shell_mode: UtilityCommandShellMode,
    pub(super) terminal_mode: UtilityCommandTerminalMode,
    pub(super) pid: Option<u32>,
    pub(super) columns: Option<u32>,
    pub(super) rows: Option<u32>,
    pub(super) owner_connection_id: Option<String>,
    pub(super) output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ActiveFileWatchSnapshot {
    pub(super) watch_id: String,
    pub(super) root_dir: String,
    pub(super) include_patterns: Option<Vec<String>>,
    pub(super) exclude_patterns: Option<Vec<String>>,
    pub(super) debounce_ms: u32,
    pub(super) owner_connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum StreamEnvelope {
    Snapshot {
        snapshot: RuntimeSnapshot,
    },
    Reset {
        reason: String,
        snapshot: RuntimeSnapshot,
    },
    Message {
        cursor: u64,
        message: Box<FromAgentMessage>,
    },
    Heartbeat {
        cursor: u64,
    },
}
