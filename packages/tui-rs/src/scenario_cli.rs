//! Native `maestro scenario` validate/run for scripted + agent-trajectory fixtures.
//!
//! Supports:
//! - `evalops.maestro.scripted-scenario.v1` validate + run
//! - `evalops.maestro.scenario.v1` full validate + offline run (trajectory/replay/
//!   score/workspace assertions, result schema, junit)
//!
//! Residual: remote http(s)/gs:// scenario sources are not loaded natively.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const SCRIPTED_SCHEMA: &str = "evalops.maestro.scripted-scenario.v1";
const TRAJECTORY_SCHEMA: &str = "evalops.maestro.scenario.v1";
const WORKSPACE_MANIFEST_SCHEMA: &str = "evalops.maestro.scenario-workspace-manifest.v1";
const SCRIPTED_RESULT_SCHEMA: &str = "evalops.maestro.scripted-scenario-result.v1";
const TRAJECTORY_RESULT_SCHEMA: &str = "evalops.maestro.agent-trajectory-scenario-result.v1";
const AGENT_TRAJECTORY_SCHEMA: &str = "evalops.maestro.agent-trajectory.v1";
const AGENT_TRAJECTORY_REPLAY_SCHEMA: &str = "evalops.maestro.agent-trajectory-replay.v1";
const AGENT_TRAJECTORY_SCORE_SCHEMA: &str = "evalops.maestro.agent-trajectory-score.v1";
const AGENT_TRAJECTORY_INSPECTION_SCHEMA: &str = "evalops.maestro.agent-trajectory-inspection.v1";

const SCRIPTED_ASSERTION_KINDS: &[&str] = &[
    "tool_called",
    "tool_not_called",
    "file_exists",
    "file_contents",
    "workspace_manifest",
    "audit_event_emitted",
];
const TRAJECTORY_ASSERTION_KINDS: &[&str] = &[
    "event.exists",
    "event.forbidden",
    "replay.deltas",
    "score.finding",
    "inspection.redaction",
    "workspace.manifest",
    "efficiency.budget",
    "provenance.chain",
    "human.review",
    "external.refs",
    "trajectory.diff",
];
const EXTERNAL_REF_FIELDS: &[&str] = &[
    "platformSlackEventIds",
    "platformTraceIds",
    "platformWorkEnvelopeIds",
    "slackThreadRefs",
    "evidenceArtifactIds",
];
const LEGACY_EXTERNAL_REF_FIELDS: &[&str] = &["ensembleTranscriptIds"];
const RELEASE_GATE_TIERS: &[&str] = &["smoke", "regression", "gauntlet"];
const REQUIRED_ARTIFACTS: &[&str] = &[
    "trajectory",
    "replay",
    "score",
    "inspection",
    "workspace_manifest",
];
const HYDRATION_MODES: &[&str] = &["manifest_only", "fixture_workspace", "frozen_archive"];
const WORKSPACE_SOURCES: &[&str] = &["production", "canary", "fixture", "synthetic"];
const TOOL_ADAPTER_MODES: &[&str] = &["recorded", "mocked", "sandboxed", "disabled"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptedScenario {
    schema_version: String,
    id: String,
    description: String,
    #[serde(default)]
    expected_outcome: Option<String>,
    #[serde(default)]
    release_gate: Option<ReleaseGate>,
    #[serde(default)]
    workspace_manifest_path: Option<String>,
    metadata: ScriptedMetadata,
    frames: Vec<ScriptedFrame>,
    #[serde(default)]
    assertions: Vec<ScriptedAssertion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptedMetadata {
    #[serde(default)]
    recorded_from: Option<String>,
    recorded_at: String,
    #[serde(default)]
    model_original: Option<String>,
    tools_expected: Vec<String>,
    #[serde(default)]
    audit_events: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScriptedFrame {
    index: usize,
    statements: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptedAssertion {
    id: String,
    kind: String,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    contains: Option<String>,
    #[serde(default)]
    equals: Option<String>,
    #[serde(default)]
    event_type: Option<String>,
    #[serde(default)]
    required_workspace_files: Vec<String>,
    #[serde(default)]
    required_tool_adapters: Vec<String>,
    #[serde(default)]
    required_hydration_modes: Vec<String>,
    #[serde(default)]
    required_release_gate_tier: Option<String>,
    #[serde(default)]
    min_workspace_files: Option<usize>,
    #[serde(default)]
    min_tool_adapters: Option<usize>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseGate {
    release_blocking: bool,
    tier: String,
    required_artifacts: Vec<String>,
    #[serde(default)]
    max_events: Option<usize>,
    #[serde(default)]
    max_tool_calls: Option<usize>,
    #[serde(default)]
    max_replay_deltas: Option<usize>,
    #[serde(default)]
    max_score_failures: Option<usize>,
    #[serde(default)]
    max_score_warnings: Option<usize>,
    #[serde(default)]
    rationale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceManifest {
    schema_version: String,
    id: String,
    recorded_at: String,
    source: String,
    #[serde(default)]
    workspace_root: Option<String>,
    hydration: WorkspaceHydration,
    files: Vec<WorkspaceFile>,
    tool_adapters: Vec<ToolAdapter>,
    redaction: WorkspaceRedaction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceHydration {
    mode: String,
    #[serde(default)]
    archive_uri: Option<String>,
    #[serde(default)]
    root_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    path: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    size_bytes: Option<u64>,
    #[serde(default)]
    purpose: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolAdapter {
    tool: String,
    mode: String,
    #[serde(default)]
    fixture_path: Option<String>,
    #[serde(default)]
    rationale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRedaction {
    secrets_removed: bool,
    raw_prompts_included: bool,
    #[serde(default)]
    notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssertionEvidence {
    kind: String,
    id: String,
    source: String,
    label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssertionResult {
    id: String,
    kind: String,
    status: String,
    severity: String,
    message: String,
    evidence: Vec<AssertionEvidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseGateSummary {
    release_blocking: bool,
    tier: String,
    required_artifacts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_events: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tool_calls: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_replay_deltas: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_score_failures: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_score_warnings: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rationale: Option<String>,
    satisfied: bool,
    missing_artifacts: Vec<String>,
    budget_violations: Vec<String>,
    policy_violations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSummary {
    manifest_id: String,
    source: String,
    recorded_at: String,
    hydration_mode: String,
    files: usize,
    tool_adapters: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptedRunResult {
    schema_version: &'static str,
    scenario_schema_version: String,
    scenario: ScenarioOutcome,
    run: RunMeta,
    counts: RunCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_gate: Option<ReleaseGateSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<WorkspaceSummary>,
    assertions: Vec<AssertionResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioOutcome {
    id: String,
    description: String,
    expected_outcome: String,
    observed_outcome: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunMeta {
    scenario_id: String,
    replay: bool,
    frames: usize,
    tool_calls: usize,
    audit_events: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunCounts {
    assertions: usize,
    passed: usize,
    failed: usize,
    warnings: usize,
    workspace_files: usize,
    tool_adapters: usize,
}

struct ToolCallRef {
    tool: String,
    id: Option<String>,
    frame_index: usize,
    statement_index: usize,
}

// --- Agent-trajectory scenario types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrajectoryScenario {
    schema_version: String,
    id: String,
    title: String,
    description: String,
    #[serde(default)]
    expected_outcome: Option<String>,
    #[serde(default)]
    release_gate: Option<ReleaseGate>,
    source: TrajectorySource,
    #[serde(default)]
    review_labels: Vec<String>,
    platform: TrajectoryPlatform,
    #[serde(default)]
    external_refs: Option<Map<String, Value>>,
    assumptions: TrajectoryAssumptions,
    assertions: Vec<TrajectoryAssertion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrajectorySource {
    trajectory_path: String,
    replay_path: String,
    score_path: String,
    #[serde(default)]
    inspection_path: Option<String>,
    #[serde(default)]
    workspace_manifest_path: Option<String>,
    #[serde(default)]
    baseline_trajectory_path: Option<String>,
    #[serde(default)]
    candidate_trajectory_path: Option<String>,
    #[serde(default)]
    baseline_score_path: Option<String>,
    #[serde(default)]
    candidate_score_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrajectoryPlatform {
    primitive: String,
    #[serde(default)]
    event_type: Option<String>,
    trace_join_keys: Vec<String>,
    #[serde(default)]
    rationale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrajectoryAssumptions {
    workflow: String,
    correctness_model: String,
    threat_model: String,
    research_basis: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrajectoryAssertion {
    id: String,
    kind: String,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    selector: Option<EventSelector>,
    #[serde(default)]
    rule_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    forbidden_terms: Vec<String>,
    #[serde(default)]
    max_events: Option<usize>,
    #[serde(default)]
    max_tool_calls: Option<usize>,
    #[serde(default)]
    max_replay_deltas: Option<usize>,
    #[serde(default)]
    max_replay_errors: Option<usize>,
    #[serde(default)]
    max_score_failures: Option<usize>,
    #[serde(default)]
    max_score_warnings: Option<usize>,
    #[serde(default)]
    max_added_events: Option<usize>,
    #[serde(default)]
    max_added_tool_calls: Option<usize>,
    #[serde(default)]
    max_added_score_failures: Option<usize>,
    #[serde(default)]
    event_id: Option<String>,
    #[serde(default)]
    required_evidence_kinds: Vec<String>,
    #[serde(default)]
    required_workspace_files: Vec<String>,
    #[serde(default)]
    required_tool_adapters: Vec<String>,
    #[serde(default)]
    required_hydration_modes: Vec<String>,
    #[serde(default)]
    required_release_gate_tier: Option<String>,
    #[serde(default)]
    min_workspace_files: Option<usize>,
    #[serde(default)]
    min_tool_adapters: Option<usize>,
    #[serde(default)]
    required_labels: Vec<String>,
    #[serde(default)]
    required_external_ref_kinds: Vec<String>,
    #[serde(default)]
    required_external_refs: Vec<String>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EventSelector {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default, rename = "type")]
    event_type: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    actor: Option<String>,
}

#[derive(Debug, Clone)]
struct TrajectoryEvent {
    id: String,
    kind: Option<String>,
    phase: Option<String>,
    event_type: String,
    status: Option<String>,
    tool_name: Option<String>,
    source: Option<String>,
    actor: Option<String>,
    evidence: Vec<EvidenceAnchor>,
}

#[derive(Debug, Clone)]
struct EvidenceAnchor {
    kind: String,
    id: String,
}

#[derive(Debug, Clone)]
struct TrajectoryInputs {
    events: Vec<TrajectoryEvent>,
    trajectory_event_count: usize,
    trajectory_run: Value,
    replay_deltas: usize,
    replay_errors: usize,
    replay_delta_evidence: Vec<AssertionEvidence>,
    score_findings: Vec<ScoreFinding>,
    inspection: Option<Value>,
    workspace_manifest: Option<WorkspaceManifest>,
    baseline_trajectory: Option<Value>,
    candidate_trajectory: Option<Value>,
    baseline_score: Option<Value>,
    candidate_score: Option<Value>,
}

#[derive(Debug, Clone)]
struct ScoreFinding {
    rule_id: String,
    status: String,
    event_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrajectoryDiff {
    baseline_run_id: String,
    candidate_run_id: String,
    events_delta: i64,
    tool_calls_delta: i64,
    score_failures_delta: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvenanceStep {
    event_id: String,
    event_type: String,
    phase: String,
    actor: String,
    evidence: Vec<AssertionEvidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrajectoryScenarioOutcome {
    id: String,
    title: String,
    expected_outcome: String,
    observed_outcome: String,
    review_labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrajectoryRunCounts {
    assertions: usize,
    passed: usize,
    failed: usize,
    warnings: usize,
    events: usize,
    tool_calls: usize,
    replay_deltas: usize,
    score_failures: usize,
    score_warnings: usize,
    workspace_files: usize,
    tool_adapters: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrajectoryRunResult {
    schema_version: &'static str,
    scenario_schema_version: String,
    scenario: TrajectoryScenarioOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    external_refs: Option<Map<String, Value>>,
    run: Value,
    counts: TrajectoryRunCounts,
    platform: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_gate: Option<ReleaseGateSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<WorkspaceSummary>,
    assumptions: TrajectoryAssumptions,
    assertions: Vec<AssertionResult>,
    provenance: Vec<ProvenanceStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diff: Option<TrajectoryDiff>,
}

/// Run `maestro scenario` with argv after the command name.
pub async fn run_scenario(args: &[String]) -> Result<i32> {
    let Some(subcommand) = args.first().map(String::as_str) else {
        eprintln!("{}", scenario_help());
        return Ok(1);
    };
    if matches!(subcommand, "help" | "--help" | "-h") {
        println!("{}", scenario_help());
        return Ok(0);
    }

    let rest = &args[1..];
    let json = rest.iter().any(|a| a == "--json");
    let junit_path = value_after(rest, "--junit");
    let positional = positional_args(rest);
    let Some(scenario_path) = positional.first() else {
        eprintln!("{}", scenario_help());
        return Ok(1);
    };

    if is_remote_source(scenario_path) {
        eprintln!(
            "Remote scenario sources (http/https/gs) are not yet supported in the native scenario CLI.\n\
             Residual: use the TypeScript library path or a local fixture file.\n\
             Source: {scenario_path}"
        );
        return Ok(1);
    }

    let source = PathBuf::from(scenario_path);
    let label = source.display().to_string();
    let raw = read_json_file(&source).with_context(|| format!("read scenario {label}"))?;
    let schema_version = raw
        .get("schemaVersion")
        .and_then(Value::as_str)
        .unwrap_or("");

    match subcommand {
        "validate" => match schema_version {
            SCRIPTED_SCHEMA => {
                let scenario = parse_scripted_scenario(&raw, &label)?;
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "status": "pass",
                            "schemaVersion": scenario.schema_version,
                            "scenarioId": scenario.id,
                            "frames": scenario.frames.len(),
                        }))?
                    );
                } else {
                    println!(
                        "Validated scripted replay {} ({} frame(s)).",
                        scenario.id,
                        scenario.frames.len()
                    );
                }
                Ok(0)
            }
            TRAJECTORY_SCHEMA => {
                let scenario = parse_trajectory_scenario(&raw, &label)?;
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&json!({
                            "status": "pass",
                            "schemaVersion": scenario.schema_version,
                            "scenarioId": scenario.id,
                            "assertions": scenario.assertions.len(),
                        }))?
                    );
                } else {
                    println!(
                        "Validated scenario {} ({} assertion(s)).",
                        scenario.id,
                        scenario.assertions.len()
                    );
                }
                Ok(0)
            }
            other => {
                eprintln!(
                    "Unsupported scenario schemaVersion for native CLI: {other:?}\n\
                     Supported: {SCRIPTED_SCHEMA}, {TRAJECTORY_SCHEMA}\n\
                     Residual: remote http(s)/gs:// sources are not loaded natively."
                );
                Ok(1)
            }
        },
        "run" => match schema_version {
            SCRIPTED_SCHEMA => {
                let scenario = parse_scripted_scenario(&raw, &label)?;
                let base_dir = source
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from("."));
                let result = evaluate_scripted_scenario(&scenario, &base_dir)?;
                if let Some(path) = junit_path {
                    write_junit_file(path, &scripted_result_to_junit(&result))?;
                }
                let matched = result.scenario.expected_outcome == result.scenario.observed_outcome;
                if json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    let summary = format!(
                        "{}/{} passed, {} failed, {} warning(s)",
                        result.counts.passed,
                        result.counts.assertions,
                        result.counts.failed,
                        result.counts.warnings
                    );
                    println!("Scripted scenario {}: {summary}", result.scenario.id);
                    for assertion in &result.assertions {
                        let marker = match assertion.status.as_str() {
                            "pass" => "PASS",
                            "warn" => "WARN",
                            _ => "FAIL",
                        };
                        println!("  {marker} {}: {}", assertion.id, assertion.message);
                    }
                }
                Ok(i32::from(!matched))
            }
            TRAJECTORY_SCHEMA => {
                let scenario = parse_trajectory_scenario(&raw, &label)?;
                let base_dir = source
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from("."));
                let result = evaluate_trajectory_scenario_file(&scenario, &base_dir)?;
                if let Some(path) = junit_path {
                    write_junit_file(path, &trajectory_result_to_junit(&result))?;
                }
                let matched = result.scenario.expected_outcome == result.scenario.observed_outcome;
                if json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    let summary = format!(
                        "{}/{} passed, {} failed, {} warning(s)",
                        result.counts.passed,
                        result.counts.assertions,
                        result.counts.failed,
                        result.counts.warnings
                    );
                    println!("Scenario {}: {summary}", result.scenario.id);
                    for assertion in &result.assertions {
                        let marker = match assertion.status.as_str() {
                            "pass" => "PASS",
                            "warn" => "WARN",
                            _ => "FAIL",
                        };
                        println!("  {marker} {}: {}", assertion.id, assertion.message);
                    }
                }
                Ok(i32::from(!matched))
            }
            other => {
                eprintln!(
                    "Unsupported scenario schemaVersion for native run: {other:?}\n\
                     Supported: {SCRIPTED_SCHEMA}, {TRAJECTORY_SCHEMA}\n\
                     Residual: remote http(s)/gs:// sources are not loaded natively."
                );
                Ok(1)
            }
        },
        other => {
            eprintln!("Unknown scenario subcommand: {other}");
            eprintln!("{}", scenario_help());
            Ok(1)
        }
    }
}

fn write_junit_file(path: &str, xml: &str) -> Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(path, xml).with_context(|| format!("write junit to {path}"))
}

fn scenario_help() -> &'static str {
    "Usage: maestro scenario <validate|run> <path> [--json] [--junit <path>]\n\n\
     Native support:\n\
       evalops.maestro.scripted-scenario.v1  validate + run (assertions, workspace, junit)\n\
       evalops.maestro.scenario.v1           full validate + offline run (trajectory artifacts)\n\n\
     Residual:\n\
       Remote http(s)/gs:// sources are not loaded natively yet."
}

fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn positional_args(args: &[String]) -> Vec<&str> {
    let mut result = Vec::new();
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--json" {
            i += 1;
            continue;
        }
        if arg == "--junit" {
            i += 2;
            continue;
        }
        if arg.starts_with('-') {
            i += 1;
            continue;
        }
        result.push(arg);
        i += 1;
    }
    result
}

fn is_remote_source(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://") || source.starts_with("gs://")
}

fn read_json_file(path: &Path) -> Result<Value> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse JSON {}", path.display()))
}

fn require_non_empty_str(value: Option<&str>, label: &str) -> Result<String> {
    match value {
        Some(s) if !s.trim().is_empty() => Ok(s.to_string()),
        _ => bail!("{label} must be a non-empty string"),
    }
}

fn parse_scripted_scenario(value: &Value, label: &str) -> Result<ScriptedScenario> {
    let obj = value
        .as_object()
        .with_context(|| format!("Replay scenario {label} must be a JSON object"))?;
    if obj.get("schemaVersion").and_then(Value::as_str) != Some(SCRIPTED_SCHEMA) {
        bail!("Replay scenario {label} must use schemaVersion {SCRIPTED_SCHEMA}");
    }
    require_non_empty_str(
        obj.get("id").and_then(Value::as_str),
        &format!("Replay scenario {label} id"),
    )?;
    require_non_empty_str(
        obj.get("description").and_then(Value::as_str),
        &format!("Replay scenario {label} description"),
    )?;
    if let Some(outcome) = obj.get("expectedOutcome").and_then(Value::as_str) {
        if outcome != "pass" && outcome != "fail" {
            bail!("Replay scenario {label} expectedOutcome must be pass or fail");
        }
    }
    let metadata = obj
        .get("metadata")
        .and_then(Value::as_object)
        .with_context(|| format!("Replay scenario {label} must contain metadata"))?;
    require_non_empty_str(
        metadata.get("recordedAt").and_then(Value::as_str),
        &format!("Replay scenario {label} metadata.recordedAt"),
    )?;
    let tools = metadata
        .get("toolsExpected")
        .and_then(Value::as_array)
        .with_context(|| {
            format!("Replay scenario {label} metadata.toolsExpected must be an array")
        })?;
    for (i, tool) in tools.iter().enumerate() {
        require_non_empty_str(
            tool.as_str(),
            &format!("Replay scenario {label} metadata.toolsExpected[{i}]"),
        )?;
    }
    if let Some(events) = metadata.get("auditEvents") {
        let arr = events.as_array().with_context(|| {
            format!("Replay scenario {label} metadata.auditEvents must be an array")
        })?;
        for (i, event) in arr.iter().enumerate() {
            require_non_empty_str(
                event.as_str(),
                &format!("Replay scenario {label} metadata.auditEvents[{i}]"),
            )?;
        }
    }

    if let Some(release_gate) = obj.get("releaseGate") {
        validate_scripted_release_gate(release_gate, obj, label)?;
    }

    let frames = obj
        .get("frames")
        .and_then(Value::as_array)
        .with_context(|| format!("Replay scenario {label} must contain frames"))?;
    for (frame_offset, frame) in frames.iter().enumerate() {
        let frame_obj = frame.as_object().with_context(|| {
            format!(
                "Replay scenario {label} frame {frame_offset} must contain index and statements"
            )
        })?;
        let index = frame_obj
            .get("index")
            .and_then(Value::as_u64)
            .with_context(|| {
                format!(
                    "Replay scenario {label} frame {frame_offset} must contain index and statements"
                )
            })? as usize;
        if index != frame_offset {
            bail!(
                "Replay scenario {label} frame indexes must be contiguous, unique, and start at 0; frame {frame_offset} has index {index}"
            );
        }
        let statements = frame_obj
            .get("statements")
            .and_then(Value::as_array)
            .with_context(|| {
                format!(
                    "Replay scenario {label} frame {frame_offset} must contain index and statements"
                )
            })?;
        for (statement_offset, statement) in statements.iter().enumerate() {
            validate_statement(statement, label, index, statement_offset)?;
        }
    }

    let mut has_workspace_manifest_assertion = false;
    let mut has_warning_workspace_manifest_assertion = false;
    if let Some(assertions) = obj.get("assertions") {
        let arr = assertions
            .as_array()
            .with_context(|| format!("Replay scenario {label} assertions must be an array"))?;
        for (assertion_offset, assertion) in arr.iter().enumerate() {
            let a = assertion.as_object().with_context(|| {
                format!(
                    "Replay scenario {label} assertion {assertion_offset} must contain id and kind"
                )
            })?;
            let assertion_id = a.get("id").and_then(Value::as_str).with_context(|| {
                format!(
                    "Replay scenario {label} assertion {assertion_offset} must contain id and kind"
                )
            })?;
            let kind = a.get("kind").and_then(Value::as_str).with_context(|| {
                format!(
                    "Replay scenario {label} assertion {assertion_offset} must contain id and kind"
                )
            })?;
            if !SCRIPTED_ASSERTION_KINDS.contains(&kind) {
                bail!("Replay scenario {label} assertion {assertion_id} has unknown kind {kind}");
            }
            if kind == "workspace_manifest" {
                has_workspace_manifest_assertion = true;
                if a.get("severity").and_then(Value::as_str) == Some("warning") {
                    has_warning_workspace_manifest_assertion = true;
                }
                if obj
                    .get("workspaceManifestPath")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    bail!(
                        "Replay scenario {label} assertion {assertion_id} workspace_manifest requires workspaceManifestPath"
                    );
                }
            }
        }
    }

    if let Some(release_gate) = obj.get("releaseGate").and_then(Value::as_object) {
        if release_gate.get("releaseBlocking") == Some(&Value::Bool(true)) {
            let artifacts = release_gate
                .get("requiredArtifacts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let requires_workspace = artifacts
                .iter()
                .any(|a| a.as_str() == Some("workspace_manifest"));
            if requires_workspace && !has_workspace_manifest_assertion {
                bail!(
                    "Replay scenario {label} releaseGate release-blocking workspace_manifest gates must include a workspace_manifest assertion"
                );
            }
            if requires_workspace && has_warning_workspace_manifest_assertion {
                bail!(
                    "Replay scenario {label} releaseGate release-blocking workspace_manifest assertions must use error severity"
                );
            }
        }
    }

    serde_json::from_value(value.clone())
        .with_context(|| format!("deserialize scripted scenario {label}"))
}

fn validate_scripted_release_gate(
    release_gate: &Value,
    root: &serde_json::Map<String, Value>,
    label: &str,
) -> Result<()> {
    let gate = release_gate
        .as_object()
        .with_context(|| format!("Replay scenario {label} releaseGate must be an object"))?;
    if !gate
        .get("releaseBlocking")
        .map(Value::is_boolean)
        .unwrap_or(false)
    {
        bail!("Replay scenario {label} releaseGate.releaseBlocking must be a boolean");
    }
    let tier = gate
        .get("tier")
        .and_then(Value::as_str)
        .with_context(|| format!("Replay scenario {label} releaseGate.tier must be a string"))?;
    if !RELEASE_GATE_TIERS.contains(&tier) {
        bail!(
            "Replay scenario {label} releaseGate.tier must be one of: {}",
            RELEASE_GATE_TIERS.join(", ")
        );
    }
    let artifacts = gate
        .get("requiredArtifacts")
        .and_then(Value::as_array)
        .with_context(|| {
            format!("Replay scenario {label} releaseGate.requiredArtifacts must not be empty")
        })?;
    if artifacts.is_empty() {
        bail!("Replay scenario {label} releaseGate.requiredArtifacts must not be empty");
    }
    let unknown: Vec<_> = artifacts
        .iter()
        .filter_map(Value::as_str)
        .filter(|a| !REQUIRED_ARTIFACTS.contains(a))
        .collect();
    if !unknown.is_empty() {
        bail!(
            "Replay scenario {label} releaseGate.requiredArtifacts contains unknown artifact(s): {}",
            unknown.join(", ")
        );
    }
    if gate.get("releaseBlocking") == Some(&Value::Bool(true))
        && !artifacts
            .iter()
            .any(|a| a.as_str() == Some("workspace_manifest"))
    {
        bail!(
            "Replay scenario {label} releaseGate release-blocking scripted scenarios must require workspace_manifest"
        );
    }
    if artifacts
        .iter()
        .any(|a| a.as_str() == Some("workspace_manifest"))
        && root
            .get("workspaceManifestPath")
            .and_then(Value::as_str)
            .is_none()
    {
        bail!(
            "Replay scenario {label} releaseGate requires workspace_manifest but workspaceManifestPath is missing"
        );
    }
    Ok(())
}

fn validate_statement(
    statement: &Value,
    label: &str,
    frame_index: usize,
    statement_offset: usize,
) -> Result<()> {
    let obj = statement.as_object().with_context(|| {
        format!(
            "Replay scenario {label} frame {frame_index} statement {statement_offset} must contain kind"
        )
    })?;
    let kind = obj.get("kind").and_then(Value::as_str).with_context(|| {
        format!(
            "Replay scenario {label} frame {frame_index} statement {statement_offset} must contain kind"
        )
    })?;
    match kind {
        "text" => {
            if !obj.get("text").map(Value::is_string).unwrap_or(false) {
                bail!(
                    "Replay scenario {label} frame {frame_index} statement {statement_offset} text must be a string"
                );
            }
        }
        "delay" => {
            let ms = obj.get("ms").and_then(Value::as_f64);
            if ms.is_none_or(|v| !v.is_finite() || v < 0.0) {
                bail!(
                    "Replay scenario {label} frame {frame_index} statement {statement_offset} delay ms must be non-negative"
                );
            }
        }
        "tool_call" => {
            require_non_empty_str(
                obj.get("tool").and_then(Value::as_str),
                &format!(
                    "Replay scenario {label} frame {frame_index} statement {statement_offset} tool_call tool"
                ),
            )?;
            if let Some(expected) = obj.get("expectedResult").and_then(Value::as_str) {
                if !matches!(expected, "success" | "error" | "any") {
                    bail!(
                        "Replay scenario {label} frame {frame_index} statement {statement_offset} expectedResult must be success, error, or any"
                    );
                }
            }
        }
        "error" => {
            let ty = obj.get("type").and_then(Value::as_str);
            if !matches!(ty, Some("transient" | "fatal")) {
                bail!(
                    "Replay scenario {label} frame {frame_index} statement {statement_offset} error type must be transient or fatal"
                );
            }
            if !obj.get("message").map(Value::is_string).unwrap_or(false) {
                bail!(
                    "Replay scenario {label} frame {frame_index} statement {statement_offset} error message must be a string"
                );
            }
        }
        "wait_for_user" => {}
        "end" => {
            let reason = obj.get("reason").and_then(Value::as_str);
            if !matches!(
                reason,
                Some("complete" | "aborted" | "limit_exceeded")
            ) {
                bail!(
                    "Replay scenario {label} frame {frame_index} statement {statement_offset} end reason is invalid"
                );
            }
        }
        other => bail!(
            "Replay scenario {label} frame {frame_index} statement {statement_offset} has unknown kind {other}"
        ),
    }
    Ok(())
}

fn tool_call_statements(scenario: &ScriptedScenario) -> Vec<ToolCallRef> {
    let mut calls = Vec::new();
    for frame in &scenario.frames {
        for (statement_index, statement) in frame.statements.iter().enumerate() {
            if statement.get("kind").and_then(Value::as_str) != Some("tool_call") {
                continue;
            }
            let tool = statement
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let id = statement
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string);
            calls.push(ToolCallRef {
                tool,
                id,
                frame_index: frame.index,
                statement_index,
            });
        }
    }
    calls
}

fn load_workspace_manifest(path: &Path) -> Result<WorkspaceManifest> {
    let raw = read_json_file(path)?;
    if raw.get("schemaVersion").and_then(Value::as_str) != Some(WORKSPACE_MANIFEST_SCHEMA) {
        bail!(
            "workspace manifest at {} must use schemaVersion {WORKSPACE_MANIFEST_SCHEMA}",
            path.display()
        );
    }
    let manifest: WorkspaceManifest = serde_json::from_value(raw)
        .with_context(|| format!("deserialize workspace manifest {}", path.display()))?;
    validate_workspace_manifest(
        &manifest,
        &format!("workspace manifest at {}", path.display()),
    )?;
    Ok(manifest)
}

fn validate_workspace_manifest(manifest: &WorkspaceManifest, label: &str) -> Result<()> {
    if manifest.id.trim().is_empty() {
        bail!("{label}.id must be a non-empty string");
    }
    if manifest.recorded_at.trim().is_empty() {
        bail!("{label}.recordedAt must be a non-empty string");
    }
    if !WORKSPACE_SOURCES.contains(&manifest.source.as_str()) {
        bail!(
            "{label}.source must be one of: {}",
            WORKSPACE_SOURCES.join(", ")
        );
    }
    if !HYDRATION_MODES.contains(&manifest.hydration.mode.as_str()) {
        bail!(
            "{label}.hydration.mode must be one of: {}",
            HYDRATION_MODES.join(", ")
        );
    }
    for adapter in &manifest.tool_adapters {
        if !TOOL_ADAPTER_MODES.contains(&adapter.mode.as_str()) {
            bail!(
                "{label} tool adapter {} mode must be one of: {}",
                adapter.tool,
                TOOL_ADAPTER_MODES.join(", ")
            );
        }
    }
    Ok(())
}

fn pass(
    assertion: &ScriptedAssertion,
    message: impl Into<String>,
    evidence: Vec<AssertionEvidence>,
) -> AssertionResult {
    AssertionResult {
        id: assertion.id.clone(),
        kind: assertion.kind.clone(),
        status: "pass".to_string(),
        severity: assertion
            .severity
            .clone()
            .unwrap_or_else(|| "error".to_string()),
        message: message.into(),
        evidence,
    }
}

fn fail(
    assertion: &ScriptedAssertion,
    message: impl Into<String>,
    evidence: Vec<AssertionEvidence>,
) -> AssertionResult {
    let severity = assertion
        .severity
        .clone()
        .unwrap_or_else(|| "error".to_string());
    let status = if severity == "warning" {
        "warn"
    } else {
        "fail"
    };
    AssertionResult {
        id: assertion.id.clone(),
        kind: assertion.kind.clone(),
        status: status.to_string(),
        severity,
        message: message.into(),
        evidence,
    }
}

fn evidence(kind: &str, id: &str, source: &str) -> Vec<AssertionEvidence> {
    vec![AssertionEvidence {
        kind: kind.to_string(),
        id: id.to_string(),
        source: source.to_string(),
        label: format!("{kind}:{id}"),
    }]
}

fn evaluate_assertion(
    assertion: &ScriptedAssertion,
    scenario: &ScriptedScenario,
    base_dir: &Path,
    workspace_manifest: Option<&WorkspaceManifest>,
) -> AssertionResult {
    let tool_calls = tool_call_statements(scenario);
    match assertion.kind.as_str() {
        "tool_called" => {
            if assertion.tool.is_none() && assertion.tool_call_id.is_none() {
                return fail(
                    assertion,
                    "tool_called requires tool or toolCallId.",
                    vec![],
                );
            }
            let matches: Vec<_> = tool_calls
                .iter()
                .filter(|call| {
                    assertion
                        .tool
                        .as_ref()
                        .is_none_or(|tool| &call.tool == tool)
                        && assertion
                            .tool_call_id
                            .as_ref()
                            .is_none_or(|id| call.id.as_ref() == Some(id))
                })
                .collect();
            if matches.is_empty() {
                fail(assertion, "No scripted tool call matched.", vec![])
            } else {
                pass(
                    assertion,
                    format!("Matched {} scripted tool call(s).", matches.len()),
                    matches
                        .iter()
                        .map(|call| AssertionEvidence {
                            kind: "tool_call".to_string(),
                            id: call.id.clone().unwrap_or_else(|| {
                                format!(
                                    "{}:{}:{}",
                                    scenario.id, call.frame_index, call.statement_index
                                )
                            }),
                            source: "scenario".to_string(),
                            label: format!(
                                "{}:{}.{}",
                                call.tool, call.frame_index, call.statement_index
                            ),
                        })
                        .collect(),
                )
            }
        }
        "tool_not_called" => {
            let Some(tool) = assertion.tool.as_ref() else {
                return fail(assertion, "tool_not_called requires tool.", vec![]);
            };
            let matches: Vec<_> = tool_calls
                .iter()
                .filter(|call| &call.tool == tool)
                .collect();
            if matches.is_empty() {
                pass(assertion, format!("Tool {tool} was not called."), vec![])
            } else {
                fail(
                    assertion,
                    format!("Tool {tool} was called {} time(s).", matches.len()),
                    matches
                        .iter()
                        .map(|call| AssertionEvidence {
                            kind: "tool_call".to_string(),
                            id: call.id.clone().unwrap_or_else(|| {
                                format!(
                                    "{}:{}:{}",
                                    scenario.id, call.frame_index, call.statement_index
                                )
                            }),
                            source: "scenario".to_string(),
                            label: format!(
                                "{}:{}.{}",
                                call.tool, call.frame_index, call.statement_index
                            ),
                        })
                        .collect(),
                )
            }
        }
        "file_exists" => {
            let Some(path) = assertion.path.as_ref() else {
                return fail(assertion, "file_exists requires path.", vec![]);
            };
            let full = base_dir.join(path);
            if full.is_file() {
                pass(
                    assertion,
                    format!("File exists: {path}."),
                    evidence("file", path, "workspace"),
                )
            } else {
                fail(assertion, format!("File does not exist: {path}."), vec![])
            }
        }
        "file_contents" => {
            let Some(path) = assertion.path.as_ref() else {
                return fail(assertion, "file_contents requires path.", vec![]);
            };
            if assertion.contains.is_none() && assertion.equals.is_none() {
                return fail(
                    assertion,
                    "file_contents requires contains or equals.",
                    vec![],
                );
            }
            let full = base_dir.join(path);
            if !full.is_file() {
                return fail(assertion, format!("File does not exist: {path}."), vec![]);
            }
            let content = fs::read_to_string(&full).unwrap_or_default();
            let matched = assertion
                .contains
                .as_ref()
                .is_some_and(|c| content.contains(c))
                || assertion.equals.as_ref().is_some_and(|e| content == *e);
            if matched {
                pass(
                    assertion,
                    format!("File contents matched: {path}."),
                    evidence("file", path, "workspace"),
                )
            } else {
                fail(
                    assertion,
                    format!("File contents did not match: {path}."),
                    vec![],
                )
            }
        }
        "workspace_manifest" => {
            evaluate_workspace_manifest_assertion(assertion, scenario, base_dir, workspace_manifest)
        }
        "audit_event_emitted" => {
            let Some(event_type) = assertion.event_type.as_ref() else {
                return fail(assertion, "audit_event_emitted requires eventType.", vec![]);
            };
            if scenario.metadata.audit_events.contains(event_type) {
                pass(
                    assertion,
                    format!("Audit event present: {event_type}."),
                    evidence("audit_event", event_type, "audit"),
                )
            } else {
                fail(
                    assertion,
                    format!("Audit event missing: {event_type}."),
                    vec![],
                )
            }
        }
        other => fail(
            assertion,
            format!("Unsupported scripted assertion kind: {other}"),
            vec![],
        ),
    }
}

fn manifest_workspace_file_exists(
    manifest: &WorkspaceManifest,
    base_dir: &Path,
    relative_path: &str,
) -> bool {
    if manifest.hydration.mode == "manifest_only" {
        return true;
    }
    let Some(root_path) = manifest.hydration.root_path.as_ref() else {
        return false;
    };
    if Path::new(relative_path).is_absolute() {
        return false;
    }
    let root_dir = base_dir.join(root_path);
    let full = root_dir.join(relative_path);
    match dunce::canonicalize(&full) {
        Ok(canon) => {
            let Ok(root_canon) = dunce::canonicalize(&root_dir) else {
                return false;
            };
            canon.starts_with(&root_canon) && canon.is_file()
        }
        Err(_) => full.is_file(),
    }
}

fn workspace_evidence(manifest: &WorkspaceManifest) -> Vec<AssertionEvidence> {
    let mut out = vec![AssertionEvidence {
        kind: "workspace_manifest".to_string(),
        id: manifest.id.clone(),
        source: "scenario".to_string(),
        label: format!("workspace_manifest:{}", manifest.id),
    }];
    for adapter in &manifest.tool_adapters {
        out.push(AssertionEvidence {
            kind: "tool_adapter".to_string(),
            id: adapter.tool.clone(),
            source: "scenario".to_string(),
            label: format!("tool_adapter:{}:{}", adapter.tool, adapter.mode),
        });
    }
    out
}

fn evaluate_workspace_manifest_assertion(
    assertion: &ScriptedAssertion,
    scenario: &ScriptedScenario,
    base_dir: &Path,
    workspace_manifest: Option<&WorkspaceManifest>,
) -> AssertionResult {
    let Some(manifest) = workspace_manifest else {
        return fail(
            assertion,
            "workspace_manifest requires workspaceManifestPath.",
            vec![],
        );
    };
    let manifest_files: HashSet<_> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    let missing_files: Vec<_> = assertion
        .required_workspace_files
        .iter()
        .filter(|path| {
            !manifest_files.contains(path.as_str())
                || !manifest_workspace_file_exists(manifest, base_dir, path)
        })
        .cloned()
        .collect();
    let manifest_adapters: HashSet<_> = manifest
        .tool_adapters
        .iter()
        .map(|a| a.tool.as_str())
        .collect();
    let missing_adapters: Vec<_> = assertion
        .required_tool_adapters
        .iter()
        .filter(|tool| !manifest_adapters.contains(tool.as_str()))
        .cloned()
        .collect();
    let hydration_mismatch = !assertion.required_hydration_modes.is_empty()
        && !assertion
            .required_hydration_modes
            .iter()
            .any(|mode| mode == &manifest.hydration.mode);
    let tier_mismatch = assertion
        .required_release_gate_tier
        .as_ref()
        .is_some_and(|tier| scenario.release_gate.as_ref().map(|g| &g.tier) != Some(tier));
    let workspace_file_budget_missed = assertion
        .min_workspace_files
        .is_some_and(|min| manifest.files.len() < min);
    let tool_adapter_budget_missed = assertion
        .min_tool_adapters
        .is_some_and(|min| manifest.tool_adapters.len() < min);

    let mut failures = Vec::new();
    if !missing_files.is_empty() {
        failures.push(format!(
            "missing workspace file(s): {}",
            missing_files.join(", ")
        ));
    }
    if !missing_adapters.is_empty() {
        failures.push(format!(
            "missing tool adapter(s): {}",
            missing_adapters.join(", ")
        ));
    }
    if hydration_mismatch {
        failures.push(format!(
            "hydration mode {} not allowed",
            manifest.hydration.mode
        ));
    }
    if tier_mismatch {
        failures.push(format!(
            "release gate tier {} did not match {}",
            scenario
                .release_gate
                .as_ref()
                .map(|g| g.tier.as_str())
                .unwrap_or("missing"),
            assertion
                .required_release_gate_tier
                .as_deref()
                .unwrap_or("")
        ));
    }
    if workspace_file_budget_missed {
        failures.push(format!(
            "workspace files {}/{}",
            manifest.files.len(),
            assertion.min_workspace_files.unwrap_or(0)
        ));
    }
    if tool_adapter_budget_missed {
        failures.push(format!(
            "tool adapters {}/{}",
            manifest.tool_adapters.len(),
            assertion.min_tool_adapters.unwrap_or(0)
        ));
    }

    if failures.is_empty() {
        pass(
            assertion,
            format!(
                "Workspace manifest {} matched replay requirements.",
                manifest.id
            ),
            workspace_evidence(manifest),
        )
    } else {
        fail(
            assertion,
            format!("Workspace manifest check failed: {}.", failures.join("; ")),
            workspace_evidence(manifest),
        )
    }
}

fn build_release_gate_summary(
    scenario: &ScriptedScenario,
    assertions: &[AssertionResult],
    tool_calls: usize,
    workspace_manifest: Option<&WorkspaceManifest>,
) -> Option<ReleaseGateSummary> {
    let gate = scenario.release_gate.as_ref()?;
    let mut missing_artifacts = Vec::new();
    for artifact in &gate.required_artifacts {
        let present = match artifact.as_str() {
            "replay" => true,
            "workspace_manifest" => workspace_manifest.is_some(),
            "trajectory" | "score" | "inspection" => false,
            _ => false,
        };
        if !present {
            missing_artifacts.push(artifact.clone());
        }
    }

    let mut budget_violations = Vec::new();
    if let Some(max) = gate.max_events {
        if scenario.frames.len() > max {
            budget_violations.push(format!("events {}/{max}", scenario.frames.len()));
        }
    }
    if let Some(max) = gate.max_tool_calls {
        if tool_calls > max {
            budget_violations.push(format!("toolCalls {tool_calls}/{max}"));
        }
    }

    let mut policy_violations = Vec::new();
    if gate
        .required_artifacts
        .iter()
        .any(|a| a == "workspace_manifest")
    {
        if let Some(manifest) = workspace_manifest {
            if !manifest.redaction.secrets_removed {
                policy_violations
                    .push("workspace manifest did not confirm secret redaction".to_string());
            }
            if manifest.redaction.raw_prompts_included {
                policy_violations.push(
                    "workspace manifest did not confirm raw prompts were excluded".to_string(),
                );
            }
        }
        for assertion in assertions {
            if assertion.kind == "workspace_manifest" && assertion.status == "fail" {
                policy_violations.push(format!(
                    "workspace manifest assertion {} failed",
                    assertion.id
                ));
            }
        }
    }

    let satisfied = missing_artifacts.is_empty()
        && budget_violations.is_empty()
        && policy_violations.is_empty();

    Some(ReleaseGateSummary {
        release_blocking: gate.release_blocking,
        tier: gate.tier.clone(),
        required_artifacts: gate.required_artifacts.clone(),
        max_events: gate.max_events,
        max_tool_calls: gate.max_tool_calls,
        max_replay_deltas: gate.max_replay_deltas,
        max_score_failures: gate.max_score_failures,
        max_score_warnings: gate.max_score_warnings,
        rationale: gate.rationale.clone(),
        satisfied,
        missing_artifacts,
        budget_violations,
        policy_violations,
    })
}

fn evaluate_scripted_scenario(
    scenario: &ScriptedScenario,
    base_dir: &Path,
) -> Result<ScriptedRunResult> {
    let workspace_manifest = match scenario.workspace_manifest_path.as_ref() {
        Some(path) => Some(load_workspace_manifest(&base_dir.join(path))?),
        None => None,
    };
    let assertions: Vec<_> = scenario
        .assertions
        .iter()
        .map(|assertion| {
            evaluate_assertion(assertion, scenario, base_dir, workspace_manifest.as_ref())
        })
        .collect();
    let failed = assertions.iter().filter(|a| a.status == "fail").count();
    let warnings = assertions.iter().filter(|a| a.status == "warn").count();
    let passed = assertions.iter().filter(|a| a.status == "pass").count();
    let tool_calls = tool_call_statements(scenario).len();
    let release_gate = build_release_gate_summary(
        scenario,
        &assertions,
        tool_calls,
        workspace_manifest.as_ref(),
    );
    let release_gate_fails = release_gate
        .as_ref()
        .is_some_and(|g| g.release_blocking && !g.satisfied);
    let observed_outcome = if failed > 0 || release_gate_fails {
        "fail"
    } else {
        "pass"
    };
    let workspace = workspace_manifest.as_ref().map(|m| WorkspaceSummary {
        manifest_id: m.id.clone(),
        source: m.source.clone(),
        recorded_at: m.recorded_at.clone(),
        hydration_mode: m.hydration.mode.clone(),
        files: m.files.len(),
        tool_adapters: m.tool_adapters.len(),
    });

    Ok(ScriptedRunResult {
        schema_version: SCRIPTED_RESULT_SCHEMA,
        scenario_schema_version: scenario.schema_version.clone(),
        scenario: ScenarioOutcome {
            id: scenario.id.clone(),
            description: scenario.description.clone(),
            expected_outcome: scenario
                .expected_outcome
                .clone()
                .unwrap_or_else(|| "pass".to_string()),
            observed_outcome: observed_outcome.to_string(),
        },
        run: RunMeta {
            scenario_id: scenario.id.clone(),
            replay: true,
            frames: scenario.frames.len(),
            tool_calls,
            audit_events: scenario.metadata.audit_events.clone(),
        },
        counts: RunCounts {
            assertions: assertions.len(),
            passed,
            failed,
            warnings,
            workspace_files: workspace_manifest
                .as_ref()
                .map(|m| m.files.len())
                .unwrap_or(0),
            tool_adapters: workspace_manifest
                .as_ref()
                .map(|m| m.tool_adapters.len())
                .unwrap_or(0),
        },
        release_gate,
        workspace,
        assertions,
    })
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn scripted_result_to_junit(result: &ScriptedRunResult) -> String {
    result_to_junit(
        &result.scenario.id,
        &result.scenario.expected_outcome,
        &result.scenario.observed_outcome,
        result.counts.assertions,
        result.counts.warnings,
        &result.assertions,
    )
}

fn trajectory_result_to_junit(result: &TrajectoryRunResult) -> String {
    result_to_junit(
        &result.scenario.id,
        &result.scenario.expected_outcome,
        &result.scenario.observed_outcome,
        result.counts.assertions,
        result.counts.warnings,
        &result.assertions,
    )
}

fn result_to_junit(
    scenario_id: &str,
    expected_outcome: &str,
    observed_outcome: &str,
    assertion_count: usize,
    warnings: usize,
    assertions: &[AssertionResult],
) -> String {
    let outcome_matches = observed_outcome == expected_outcome;
    let failures: Vec<_> = assertions.iter().filter(|a| a.status == "fail").collect();
    let mut testcases = String::new();
    for assertion in assertions {
        let failure = if !outcome_matches && assertion.status == "fail" {
            let evidence = serde_json::to_string(&assertion.evidence).unwrap_or_default();
            format!(
                "\n\t\t<failure message=\"{}\">{}</failure>\n\t",
                escape_xml(&assertion.message),
                escape_xml(&evidence)
            )
        } else {
            String::new()
        };
        let expected_failure_output = if outcome_matches && assertion.status == "fail" {
            let evidence = serde_json::to_string(&assertion.evidence).unwrap_or_default();
            format!(
                "\n\t\t<system-out>{}</system-out>\n\t",
                escape_xml(&format!(
                    "Expected failing assertion observed: {}\n{evidence}",
                    assertion.message
                ))
            )
        } else {
            String::new()
        };
        testcases.push_str(&format!(
            "\t<testcase classname=\"{}\" name=\"{}\">{failure}{expected_failure_output}</testcase>\n",
            escape_xml(scenario_id),
            escape_xml(&assertion.id)
        ));
    }
    let outcome_failure = if !outcome_matches && failures.is_empty() {
        format!(
            "\t<testcase classname=\"{}\" name=\"scenario-outcome\">\n\t\t<failure message=\"{}\"></failure>\n\t</testcase>\n",
            escape_xml(scenario_id),
            escape_xml(&format!(
                "Observed outcome {observed_outcome}; expected {expected_outcome}."
            ))
        )
    } else {
        String::new()
    };
    let failure_count = if outcome_matches {
        0
    } else {
        failures.len().max(1)
    };
    let test_count = assertion_count + usize::from(!outcome_failure.is_empty());
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <testsuite name=\"{}\" tests=\"{test_count}\" failures=\"{failure_count}\" warnings=\"{warnings}\">\n\
         {outcome_failure}{testcases}\
         </testsuite>\n",
        escape_xml(scenario_id),
    )
}

// --- Agent-trajectory scenario validate / run ---

fn require_non_empty_string_array(value: Option<&Value>, label: &str) -> Result<()> {
    let Some(arr) = value.and_then(Value::as_array) else {
        bail!("{label} must contain non-empty strings");
    };
    for (i, item) in arr.iter().enumerate() {
        require_non_empty_str(item.as_str(), &format!("{label}[{i}]"))?;
    }
    Ok(())
}

fn require_optional_non_empty_string_array(value: Option<&Value>, label: &str) -> Result<()> {
    if value.is_some() {
        require_non_empty_string_array(value, label)?;
    }
    Ok(())
}

fn require_optional_non_negative_integer(value: Option<&Value>, label: &str) -> Result<()> {
    if let Some(v) = value {
        let Some(n) = v.as_u64() else {
            bail!("{label} must be a non-negative integer");
        };
        let _ = n;
    }
    Ok(())
}

fn is_known_external_ref_field(field: &str) -> bool {
    EXTERNAL_REF_FIELDS.contains(&field) || LEGACY_EXTERNAL_REF_FIELDS.contains(&field)
}

fn parse_trajectory_scenario(value: &Value, label: &str) -> Result<TrajectoryScenario> {
    let obj = value
        .as_object()
        .with_context(|| format!("Scenario {label} must be a JSON object"))?;
    if obj.get("schemaVersion").and_then(Value::as_str) != Some(TRAJECTORY_SCHEMA) {
        bail!("Scenario {label} must use schemaVersion {TRAJECTORY_SCHEMA}");
    }
    require_non_empty_str(
        obj.get("id").and_then(Value::as_str),
        &format!("{label}.id"),
    )?;
    require_non_empty_str(
        obj.get("title").and_then(Value::as_str),
        &format!("{label}.title"),
    )?;
    require_non_empty_str(
        obj.get("description").and_then(Value::as_str),
        &format!("{label}.description"),
    )?;
    if let Some(outcome) = obj.get("expectedOutcome").and_then(Value::as_str) {
        if outcome != "pass" && outcome != "fail" {
            bail!("{label}.expectedOutcome must be pass or fail");
        }
    }

    let source = obj
        .get("source")
        .and_then(Value::as_object)
        .with_context(|| format!("{label}.source must be an object"))?;
    require_non_empty_str(
        source.get("trajectoryPath").and_then(Value::as_str),
        &format!("{label}.source.trajectoryPath"),
    )?;
    require_non_empty_str(
        source.get("replayPath").and_then(Value::as_str),
        &format!("{label}.source.replayPath"),
    )?;
    require_non_empty_str(
        source.get("scorePath").and_then(Value::as_str),
        &format!("{label}.source.scorePath"),
    )?;
    if source.get("workspaceManifestPath").is_some() {
        require_non_empty_str(
            source.get("workspaceManifestPath").and_then(Value::as_str),
            &format!("{label}.source.workspaceManifestPath"),
        )?;
    }
    let has_baseline_traj = source
        .get("baselineTrajectoryPath")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    let has_candidate_traj = source
        .get("candidateTrajectoryPath")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    if has_baseline_traj != has_candidate_traj {
        bail!(
            "{label}.source baselineTrajectoryPath and candidateTrajectoryPath must be provided together"
        );
    }
    let has_baseline_score = source
        .get("baselineScorePath")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    let has_candidate_score = source
        .get("candidateScorePath")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    if has_baseline_score != has_candidate_score {
        bail!("{label}.source baselineScorePath and candidateScorePath must be provided together");
    }

    let assertions = obj
        .get("assertions")
        .and_then(Value::as_array)
        .with_context(|| format!("{label}.assertions must contain at least one assertion"))?;
    if assertions.is_empty() {
        bail!("{label}.assertions must contain at least one assertion");
    }
    if !obj
        .get("reviewLabels")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        bail!("{label}.reviewLabels must be an array");
    }

    if let Some(release_gate) = obj.get("releaseGate") {
        validate_trajectory_release_gate(release_gate, source, label)?;
    }

    let platform = obj
        .get("platform")
        .and_then(Value::as_object)
        .with_context(|| format!("{label}.platform must be an object"))?;
    let join_keys = platform
        .get("traceJoinKeys")
        .and_then(Value::as_array)
        .with_context(|| format!("{label}.platform.traceJoinKeys must not be empty"))?;
    if join_keys.is_empty() {
        bail!("{label}.platform.traceJoinKeys must not be empty");
    }

    if let Some(external_refs) = obj.get("externalRefs") {
        let refs_obj = external_refs
            .as_object()
            .with_context(|| format!("{label}.externalRefs must be an object"))?;
        let mut refs = 0usize;
        for field in EXTERNAL_REF_FIELDS
            .iter()
            .chain(LEGACY_EXTERNAL_REF_FIELDS.iter())
        {
            if let Some(values) = refs_obj.get(*field) {
                require_non_empty_string_array(
                    Some(values),
                    &format!("{label}.externalRefs.{field}"),
                )?;
                refs += values.as_array().map(|a| a.len()).unwrap_or(0);
            }
        }
        if refs == 0 {
            bail!("{label}.externalRefs must contain at least one ref");
        }
    }

    let assumptions = obj
        .get("assumptions")
        .and_then(Value::as_object)
        .with_context(|| format!("{label}.assumptions must be an object"))?;
    require_non_empty_str(
        assumptions.get("workflow").and_then(Value::as_str),
        &format!("{label}.assumptions.workflow"),
    )?;
    require_non_empty_str(
        assumptions.get("correctnessModel").and_then(Value::as_str),
        &format!("{label}.assumptions.correctnessModel"),
    )?;
    require_non_empty_str(
        assumptions.get("threatModel").and_then(Value::as_str),
        &format!("{label}.assumptions.threatModel"),
    )?;
    let research = assumptions
        .get("researchBasis")
        .and_then(Value::as_array)
        .with_context(|| format!("{label}.assumptions.researchBasis must not be empty"))?;
    if research.is_empty() {
        bail!("{label}.assumptions.researchBasis must not be empty");
    }

    let mut has_workspace_manifest_assertion = false;
    let mut has_warning_workspace_manifest_assertion = false;
    for assertion in assertions {
        let a = assertion
            .as_object()
            .with_context(|| format!("{label}.assertions[] must be objects"))?;
        require_non_empty_str(
            a.get("id").and_then(Value::as_str),
            &format!("{label}.assertions[].id"),
        )?;
        let kind = require_non_empty_str(
            a.get("kind").and_then(Value::as_str),
            &format!("{label}.assertions[].kind"),
        )?;
        if !TRAJECTORY_ASSERTION_KINDS.contains(&kind.as_str()) {
            bail!(
                "{label}.assertions[].kind must be one of: {}",
                TRAJECTORY_ASSERTION_KINDS.join(", ")
            );
        }
        if kind == "trajectory.diff"
            && a.get("maxAddedScoreFailures").is_some()
            && (source
                .get("baselineScorePath")
                .and_then(Value::as_str)
                .is_none()
                || source
                    .get("candidateScorePath")
                    .and_then(Value::as_str)
                    .is_none())
        {
            bail!(
                "{label}.assertions[].maxAddedScoreFailures requires baselineScorePath and candidateScorePath"
            );
        }
        if kind == "workspace.manifest" {
            has_workspace_manifest_assertion = true;
            if a.get("severity").and_then(Value::as_str) == Some("warning") {
                has_warning_workspace_manifest_assertion = true;
            }
            if source
                .get("workspaceManifestPath")
                .and_then(Value::as_str)
                .is_none()
            {
                bail!(
                    "{label}.assertions[].kind workspace.manifest requires source.workspaceManifestPath"
                );
            }
            require_optional_non_empty_string_array(
                a.get("requiredWorkspaceFiles"),
                &format!("{label}.assertions[].requiredWorkspaceFiles"),
            )?;
            require_optional_non_empty_string_array(
                a.get("requiredToolAdapters"),
                &format!("{label}.assertions[].requiredToolAdapters"),
            )?;
            if let Some(modes) = a.get("requiredHydrationModes") {
                let arr = modes.as_array().with_context(|| {
                    format!(
                        "{label}.assertions[].requiredHydrationModes must contain known hydration modes"
                    )
                })?;
                if arr
                    .iter()
                    .any(|mode| !mode.as_str().is_some_and(|m| HYDRATION_MODES.contains(&m)))
                {
                    bail!(
                        "{label}.assertions[].requiredHydrationModes must contain known hydration modes"
                    );
                }
            }
            if let Some(tier) = a.get("requiredReleaseGateTier").and_then(Value::as_str) {
                if !RELEASE_GATE_TIERS.contains(&tier) {
                    bail!(
                        "{label}.assertions[].requiredReleaseGateTier must be one of: {}",
                        RELEASE_GATE_TIERS.join(", ")
                    );
                }
            }
            require_optional_non_negative_integer(
                a.get("minWorkspaceFiles"),
                &format!("{label}.assertions[].minWorkspaceFiles"),
            )?;
            require_optional_non_negative_integer(
                a.get("minToolAdapters"),
                &format!("{label}.assertions[].minToolAdapters"),
            )?;
        }
        if kind == "external.refs" {
            let kinds = a
                .get("requiredExternalRefKinds")
                .and_then(Value::as_array)
                .with_context(|| {
                    format!(
                        "{label}.assertions[].requiredExternalRefKinds must not be empty for external.refs"
                    )
                })?;
            if kinds.is_empty() {
                bail!(
                    "{label}.assertions[].requiredExternalRefKinds must not be empty for external.refs"
                );
            }
            let unknown: Vec<_> = kinds
                .iter()
                .filter_map(Value::as_str)
                .filter(|k| !is_known_external_ref_field(k))
                .collect();
            // also catch non-strings
            let bad_types = kinds.iter().any(|k| !k.is_string());
            if !unknown.is_empty() || bad_types {
                let joined = if unknown.is_empty() {
                    kinds
                        .iter()
                        .filter(|k| !k.is_string())
                        .map(|_| "<non-string>")
                        .collect::<Vec<_>>()
                        .join(", ")
                } else {
                    unknown.join(", ")
                };
                bail!(
                    "{label}.assertions[].requiredExternalRefKinds contains unknown external ref kind(s): {joined}"
                );
            }
            if a.get("requiredExternalRefs").is_some() {
                require_non_empty_string_array(
                    a.get("requiredExternalRefs"),
                    &format!(
                        "{label}.assertions[].requiredExternalRefs must contain non-empty strings for external.refs"
                    ),
                )
                .map_err(|_| {
                    anyhow::anyhow!(
                        "{label}.assertions[].requiredExternalRefs must contain non-empty strings for external.refs"
                    )
                })?;
            }
        }
    }

    if let Some(release_gate) = obj.get("releaseGate").and_then(Value::as_object) {
        if release_gate.get("releaseBlocking") == Some(&Value::Bool(true)) {
            let artifacts = release_gate
                .get("requiredArtifacts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let requires_workspace = artifacts
                .iter()
                .any(|a| a.as_str() == Some("workspace_manifest"));
            if requires_workspace && !has_workspace_manifest_assertion {
                bail!(
                    "{label}.releaseGate release-blocking workspace_manifest gates must include a workspace.manifest assertion"
                );
            }
            if requires_workspace && has_warning_workspace_manifest_assertion {
                bail!(
                    "{label}.releaseGate release-blocking workspace_manifest assertions must use error severity"
                );
            }
        }
    }

    serde_json::from_value(value.clone())
        .with_context(|| format!("deserialize trajectory scenario {label}"))
}

fn validate_trajectory_release_gate(
    release_gate: &Value,
    source: &Map<String, Value>,
    label: &str,
) -> Result<()> {
    let gate = release_gate
        .as_object()
        .with_context(|| format!("{label}.releaseGate must be an object"))?;
    if !gate
        .get("releaseBlocking")
        .map(Value::is_boolean)
        .unwrap_or(false)
    {
        bail!("{label}.releaseGate.releaseBlocking must be a boolean");
    }
    let tier = gate
        .get("tier")
        .and_then(Value::as_str)
        .with_context(|| format!("{label}.releaseGate.tier must be a string"))?;
    if !RELEASE_GATE_TIERS.contains(&tier) {
        bail!(
            "{label}.releaseGate.tier must be one of: {}",
            RELEASE_GATE_TIERS.join(", ")
        );
    }
    let artifacts = gate
        .get("requiredArtifacts")
        .and_then(Value::as_array)
        .with_context(|| format!("{label}.releaseGate.requiredArtifacts must not be empty"))?;
    if artifacts.is_empty() {
        bail!("{label}.releaseGate.requiredArtifacts must not be empty");
    }
    let unknown: Vec<_> = artifacts
        .iter()
        .filter_map(Value::as_str)
        .filter(|a| !REQUIRED_ARTIFACTS.contains(a))
        .collect();
    if !unknown.is_empty() {
        bail!(
            "{label}.releaseGate.requiredArtifacts contains unknown artifact(s): {}",
            unknown.join(", ")
        );
    }
    if gate.get("releaseBlocking") == Some(&Value::Bool(true))
        && !artifacts
            .iter()
            .any(|a| a.as_str() == Some("workspace_manifest"))
    {
        bail!("{label}.releaseGate release-blocking scenarios must require workspace_manifest");
    }
    if artifacts.iter().any(|a| a.as_str() == Some("inspection"))
        && source
            .get("inspectionPath")
            .and_then(Value::as_str)
            .is_none()
    {
        bail!("{label}.releaseGate requires inspection but source.inspectionPath is missing");
    }
    if artifacts
        .iter()
        .any(|a| a.as_str() == Some("workspace_manifest"))
        && source
            .get("workspaceManifestPath")
            .and_then(Value::as_str)
            .is_none()
    {
        bail!(
            "{label}.releaseGate requires workspace_manifest but source.workspaceManifestPath is missing"
        );
    }
    require_optional_non_negative_integer(
        gate.get("maxEvents"),
        &format!("{label}.releaseGate.maxEvents"),
    )?;
    require_optional_non_negative_integer(
        gate.get("maxToolCalls"),
        &format!("{label}.releaseGate.maxToolCalls"),
    )?;
    require_optional_non_negative_integer(
        gate.get("maxReplayDeltas"),
        &format!("{label}.releaseGate.maxReplayDeltas"),
    )?;
    require_optional_non_negative_integer(
        gate.get("maxScoreFailures"),
        &format!("{label}.releaseGate.maxScoreFailures"),
    )?;
    require_optional_non_negative_integer(
        gate.get("maxScoreWarnings"),
        &format!("{label}.releaseGate.maxScoreWarnings"),
    )?;
    Ok(())
}

fn load_typed_json(path: &Path, schema_version: &str, name: &str) -> Result<Value> {
    let value = read_json_file(path)?;
    let schema_matches = ["schemaVersion", "trajectorySchemaVersion"]
        .into_iter()
        .filter_map(|field| value.get(field).and_then(Value::as_str))
        .any(|schema| schema == schema_version);
    if !schema_matches {
        bail!(
            "{name} at {} must use schemaVersion {schema_version}",
            path.display()
        );
    }
    Ok(value)
}

fn parse_trajectory_events(trajectory: &Value) -> Result<Vec<TrajectoryEvent>> {
    let events = trajectory
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::with_capacity(events.len());
    for event in events {
        let id = event
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut evidence = Vec::new();
        if let Some(arr) = event.get("evidence").and_then(Value::as_array) {
            for anchor in arr {
                if let (Some(kind), Some(aid)) = (
                    anchor.get("kind").and_then(Value::as_str),
                    anchor.get("id").and_then(Value::as_str),
                ) {
                    evidence.push(EvidenceAnchor {
                        kind: kind.to_string(),
                        id: aid.to_string(),
                    });
                }
            }
        }
        out.push(TrajectoryEvent {
            id,
            kind: event
                .get("kind")
                .and_then(Value::as_str)
                .map(str::to_string),
            phase: event
                .get("phase")
                .and_then(Value::as_str)
                .map(str::to_string),
            event_type,
            status: event
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_name: event
                .get("toolName")
                .and_then(Value::as_str)
                .map(str::to_string),
            source: event
                .get("source")
                .and_then(Value::as_str)
                .map(str::to_string),
            actor: event
                .get("actor")
                .and_then(Value::as_str)
                .map(str::to_string),
            evidence,
        });
    }
    Ok(out)
}

fn parse_score_findings(score: &Value) -> Vec<ScoreFinding> {
    score
        .get("findings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|finding| {
            let rule_id = finding.get("ruleId").and_then(Value::as_str)?.to_string();
            let status = finding
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let event_ids = finding
                .get("eventIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            Some(ScoreFinding {
                rule_id,
                status,
                event_ids,
            })
        })
        .collect()
}

fn load_trajectory_inputs(
    scenario: &TrajectoryScenario,
    base_dir: &Path,
) -> Result<TrajectoryInputs> {
    let resolve = |rel: &str| base_dir.join(rel);
    let trajectory = load_typed_json(
        &resolve(&scenario.source.trajectory_path),
        AGENT_TRAJECTORY_SCHEMA,
        "trajectory",
    )?;
    let events = parse_trajectory_events(&trajectory)?;
    let trajectory_event_count = trajectory
        .get("counts")
        .and_then(|c| c.get("events"))
        .and_then(Value::as_u64)
        .unwrap_or(events.len() as u64) as usize;
    let trajectory_run = trajectory.get("run").cloned().unwrap_or_else(|| json!({}));

    let replay = load_typed_json(
        &resolve(&scenario.source.replay_path),
        AGENT_TRAJECTORY_REPLAY_SCHEMA,
        "trajectory replay",
    )?;
    let replay_deltas = replay
        .get("counts")
        .and_then(|c| c.get("deltas"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let replay_errors = replay
        .get("counts")
        .and_then(|c| c.get("errors"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let replay_delta_evidence = replay
        .get("deltas")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|delta| {
            let id = delta.get("id").and_then(Value::as_str)?;
            let rule_id = delta.get("ruleId").and_then(Value::as_str).unwrap_or("");
            Some(AssertionEvidence {
                kind: "replay_delta".to_string(),
                id: id.to_string(),
                source: "replay".to_string(),
                label: format!("{rule_id}:{id}"),
            })
        })
        .collect();

    let score = load_typed_json(
        &resolve(&scenario.source.score_path),
        AGENT_TRAJECTORY_SCORE_SCHEMA,
        "trajectory score",
    )?;
    let score_findings = parse_score_findings(&score);

    let inspection = match scenario.source.inspection_path.as_ref() {
        Some(path) => Some(load_typed_json(
            &resolve(path),
            AGENT_TRAJECTORY_INSPECTION_SCHEMA,
            "trajectory inspection",
        )?),
        None => None,
    };

    let workspace_manifest = match scenario.source.workspace_manifest_path.as_ref() {
        Some(path) => Some(load_workspace_manifest(&resolve(path))?),
        None => None,
    };

    let baseline_trajectory = match scenario.source.baseline_trajectory_path.as_ref() {
        Some(path) => Some(load_typed_json(
            &resolve(path),
            AGENT_TRAJECTORY_SCHEMA,
            "baseline trajectory",
        )?),
        None => None,
    };
    let candidate_trajectory = match scenario.source.candidate_trajectory_path.as_ref() {
        Some(path) => Some(load_typed_json(
            &resolve(path),
            AGENT_TRAJECTORY_SCHEMA,
            "candidate trajectory",
        )?),
        None => None,
    };
    let baseline_score = match scenario.source.baseline_score_path.as_ref() {
        Some(path) => Some(load_typed_json(
            &resolve(path),
            AGENT_TRAJECTORY_SCORE_SCHEMA,
            "baseline score",
        )?),
        None => None,
    };
    let candidate_score = match scenario.source.candidate_score_path.as_ref() {
        Some(path) => Some(load_typed_json(
            &resolve(path),
            AGENT_TRAJECTORY_SCORE_SCHEMA,
            "candidate score",
        )?),
        None => None,
    };

    let _ = (trajectory, replay, score);
    Ok(TrajectoryInputs {
        events,
        trajectory_event_count,
        trajectory_run,
        replay_deltas,
        replay_errors,
        replay_delta_evidence,
        score_findings,
        inspection,
        workspace_manifest,
        baseline_trajectory,
        candidate_trajectory,
        baseline_score,
        candidate_score,
    })
}

fn event_matches(event: &TrajectoryEvent, selector: &EventSelector) -> bool {
    selector
        .kind
        .as_ref()
        .is_none_or(|k| event.kind.as_ref() == Some(k))
        && selector
            .phase
            .as_ref()
            .is_none_or(|p| event.phase.as_ref() == Some(p))
        && selector
            .event_type
            .as_ref()
            .is_none_or(|t| &event.event_type == t)
        && selector
            .status
            .as_ref()
            .is_none_or(|s| event.status.as_ref() == Some(s))
        && selector
            .tool_name
            .as_ref()
            .is_none_or(|t| event.tool_name.as_ref() == Some(t))
        && selector
            .source
            .as_ref()
            .is_none_or(|s| event.source.as_ref() == Some(s))
        && selector
            .actor
            .as_ref()
            .is_none_or(|a| event.actor.as_ref() == Some(a))
}

fn evidence_from_events(events: &[&TrajectoryEvent]) -> Vec<AssertionEvidence> {
    let mut seen = HashSet::new();
    let mut evidence = Vec::new();
    for event in events {
        let event_key = format!("trajectory:event:{}", event.id);
        if seen.insert(event_key) {
            evidence.push(AssertionEvidence {
                kind: "trajectory_event".to_string(),
                id: event.id.clone(),
                source: "trajectory".to_string(),
                label: format!("{}:{}", event.event_type, event.id),
            });
        }
        for anchor in &event.evidence {
            let key = format!("trajectory:{}:{}", anchor.kind, anchor.id);
            if seen.insert(key) {
                evidence.push(AssertionEvidence {
                    kind: anchor.kind.clone(),
                    id: anchor.id.clone(),
                    source: "trajectory".to_string(),
                    label: format!("{}:{}", anchor.kind, anchor.id),
                });
            }
        }
    }
    evidence.sort_by(|a, b| a.label.cmp(&b.label));
    evidence
}

fn scenario_evidence(id: &str, label: &str) -> Vec<AssertionEvidence> {
    vec![AssertionEvidence {
        kind: "scenario".to_string(),
        id: id.to_string(),
        source: "scenario".to_string(),
        label: label.to_string(),
    }]
}

fn traj_pass(
    assertion: &TrajectoryAssertion,
    message: impl Into<String>,
    evidence: Vec<AssertionEvidence>,
) -> AssertionResult {
    AssertionResult {
        id: assertion.id.clone(),
        kind: assertion.kind.clone(),
        status: "pass".to_string(),
        severity: assertion
            .severity
            .clone()
            .unwrap_or_else(|| "error".to_string()),
        message: message.into(),
        evidence,
    }
}

fn traj_fail(
    assertion: &TrajectoryAssertion,
    message: impl Into<String>,
    evidence: Vec<AssertionEvidence>,
) -> AssertionResult {
    let severity = assertion
        .severity
        .clone()
        .unwrap_or_else(|| "error".to_string());
    let status = if severity == "warning" {
        "warn"
    } else {
        "fail"
    };
    AssertionResult {
        id: assertion.id.clone(),
        kind: assertion.kind.clone(),
        status: status.to_string(),
        severity,
        message: message.into(),
        evidence,
    }
}

fn count_tool_calls(events: &[TrajectoryEvent]) -> usize {
    events
        .iter()
        .filter(|e| e.event_type == "tool.requested")
        .count()
}

fn score_failures(findings: &[ScoreFinding]) -> usize {
    findings.iter().filter(|f| f.status == "fail").count()
}

fn score_warnings(findings: &[ScoreFinding]) -> usize {
    findings.iter().filter(|f| f.status == "warn").count()
}

fn build_trajectory_diff(inputs: &TrajectoryInputs) -> Option<TrajectoryDiff> {
    let baseline = inputs.baseline_trajectory.as_ref()?;
    let candidate = inputs.candidate_trajectory.as_ref()?;
    let baseline_events = parse_trajectory_events(baseline).ok()?;
    let candidate_events = parse_trajectory_events(candidate).ok()?;
    let baseline_count = baseline
        .get("counts")
        .and_then(|c| c.get("events"))
        .and_then(Value::as_u64)
        .unwrap_or(baseline_events.len() as u64) as i64;
    let candidate_count = candidate
        .get("counts")
        .and_then(|c| c.get("events"))
        .and_then(Value::as_u64)
        .unwrap_or(candidate_events.len() as u64) as i64;
    let score_failures_delta = match (
        inputs.baseline_score.as_ref(),
        inputs.candidate_score.as_ref(),
    ) {
        (Some(base), Some(cand)) => {
            let base_findings = parse_score_findings(base);
            let cand_findings = parse_score_findings(cand);
            score_failures(&cand_findings) as i64 - score_failures(&base_findings) as i64
        }
        _ => 0,
    };
    Some(TrajectoryDiff {
        baseline_run_id: baseline
            .get("run")
            .and_then(|r| r.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        candidate_run_id: candidate
            .get("run")
            .and_then(|r| r.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        events_delta: candidate_count - baseline_count,
        tool_calls_delta: count_tool_calls(&candidate_events) as i64
            - count_tool_calls(&baseline_events) as i64,
        score_failures_delta,
    })
}

fn traj_workspace_evidence(manifest: &WorkspaceManifest) -> Vec<AssertionEvidence> {
    workspace_evidence(manifest)
}

fn build_trajectory_release_gate(
    scenario: &TrajectoryScenario,
    inputs: &TrajectoryInputs,
) -> Option<ReleaseGateSummary> {
    let gate = scenario.release_gate.as_ref()?;
    let observed_tool_calls = count_tool_calls(&inputs.events);
    let observed_failures = score_failures(&inputs.score_findings);
    let observed_warnings = score_warnings(&inputs.score_findings);
    let mut missing_artifacts = Vec::new();
    for artifact in &gate.required_artifacts {
        let present = match artifact.as_str() {
            "trajectory" | "replay" | "score" => true,
            "inspection" => inputs.inspection.is_some(),
            "workspace_manifest" => inputs.workspace_manifest.is_some(),
            _ => false,
        };
        if !present {
            missing_artifacts.push(artifact.clone());
        }
    }
    let mut budget_violations = Vec::new();
    if let Some(max) = gate.max_events {
        if inputs.trajectory_event_count > max {
            budget_violations.push(format!("events {}/{max}", inputs.trajectory_event_count));
        }
    }
    if let Some(max) = gate.max_tool_calls {
        if observed_tool_calls > max {
            budget_violations.push(format!("toolCalls {observed_tool_calls}/{max}"));
        }
    }
    if let Some(max) = gate.max_replay_deltas {
        if inputs.replay_deltas > max {
            budget_violations.push(format!("replayDeltas {}/{max}", inputs.replay_deltas));
        }
    }
    if let Some(max) = gate.max_score_failures {
        if observed_failures > max {
            budget_violations.push(format!("scoreFailures {observed_failures}/{max}"));
        }
    }
    if let Some(max) = gate.max_score_warnings {
        if observed_warnings > max {
            budget_violations.push(format!("scoreWarnings {observed_warnings}/{max}"));
        }
    }
    let mut policy_violations = Vec::new();
    if gate
        .required_artifacts
        .iter()
        .any(|a| a == "workspace_manifest")
    {
        if let Some(manifest) = inputs.workspace_manifest.as_ref() {
            if !manifest.redaction.secrets_removed {
                policy_violations
                    .push("workspace manifest did not confirm secret redaction".to_string());
            }
            if manifest.redaction.raw_prompts_included {
                policy_violations.push(
                    "workspace manifest did not confirm raw prompts were excluded".to_string(),
                );
            }
        }
    }
    let satisfied = missing_artifacts.is_empty()
        && budget_violations.is_empty()
        && policy_violations.is_empty();
    Some(ReleaseGateSummary {
        release_blocking: gate.release_blocking,
        tier: gate.tier.clone(),
        required_artifacts: gate.required_artifacts.clone(),
        max_events: gate.max_events,
        max_tool_calls: gate.max_tool_calls,
        max_replay_deltas: gate.max_replay_deltas,
        max_score_failures: gate.max_score_failures,
        max_score_warnings: gate.max_score_warnings,
        rationale: gate.rationale.clone(),
        satisfied,
        missing_artifacts,
        budget_violations,
        policy_violations,
    })
}

fn evaluate_trajectory_assertion(
    assertion: &TrajectoryAssertion,
    scenario: &TrajectoryScenario,
    inputs: &TrajectoryInputs,
    diff: Option<&TrajectoryDiff>,
) -> AssertionResult {
    match assertion.kind.as_str() {
        "event.exists" => {
            let Some(selector) = assertion.selector.as_ref() else {
                return traj_fail(assertion, "event.exists requires a selector.", vec![]);
            };
            let matches: Vec<_> = inputs
                .events
                .iter()
                .filter(|event| event_matches(event, selector))
                .collect();
            if matches.is_empty() {
                traj_fail(
                    assertion,
                    "No trajectory event matched the selector.",
                    vec![],
                )
            } else {
                traj_pass(
                    assertion,
                    format!("Matched {} trajectory event(s).", matches.len()),
                    evidence_from_events(&matches),
                )
            }
        }
        "event.forbidden" => {
            let Some(selector) = assertion.selector.as_ref() else {
                return traj_fail(assertion, "event.forbidden requires a selector.", vec![]);
            };
            let matches: Vec<_> = inputs
                .events
                .iter()
                .filter(|event| event_matches(event, selector))
                .collect();
            if matches.is_empty() {
                traj_pass(assertion, "No forbidden trajectory event matched.", vec![])
            } else {
                traj_fail(
                    assertion,
                    format!(
                        "Forbidden selector matched {} trajectory event(s).",
                        matches.len()
                    ),
                    evidence_from_events(&matches),
                )
            }
        }
        "replay.deltas" => {
            let max_deltas = assertion.max_replay_deltas.unwrap_or(usize::MAX);
            let max_errors = assertion.max_replay_errors.unwrap_or(usize::MAX);
            let failed = inputs.replay_deltas > max_deltas || inputs.replay_errors > max_errors;
            if failed {
                traj_fail(
                    assertion,
                    format!(
                        "Replay deltas exceeded budget: {}/{max_deltas}, errors {}/{max_errors}.",
                        inputs.replay_deltas, inputs.replay_errors
                    ),
                    inputs.replay_delta_evidence.clone(),
                )
            } else {
                traj_pass(
                    assertion,
                    format!(
                        "Replay stayed within delta and error budgets ({} deltas, {} errors).",
                        inputs.replay_deltas, inputs.replay_errors
                    ),
                    vec![],
                )
            }
        }
        "score.finding" => {
            let Some(rule_id) = assertion.rule_id.as_ref() else {
                return traj_fail(assertion, "score.finding requires ruleId.", vec![]);
            };
            let Some(finding) = inputs.score_findings.iter().find(|f| &f.rule_id == rule_id) else {
                return traj_fail(
                    assertion,
                    format!("Missing score finding {rule_id}."),
                    vec![],
                );
            };
            let matched_events: Vec<_> = inputs
                .events
                .iter()
                .filter(|event| finding.event_ids.iter().any(|id| id == &event.id))
                .collect();
            if let Some(expected) = assertion.status.as_ref() {
                if &finding.status != expected {
                    return traj_fail(
                        assertion,
                        format!(
                            "Score finding {rule_id} was {}; expected {expected}.",
                            finding.status
                        ),
                        evidence_from_events(&matched_events),
                    );
                }
            }
            traj_pass(
                assertion,
                format!("Score finding {rule_id} matched {}.", finding.status),
                evidence_from_events(&matched_events),
            )
        }
        "inspection.redaction" => {
            let Some(inspection) = inputs.inspection.as_ref() else {
                return traj_fail(
                    assertion,
                    "inspection.redaction requires inspectionPath.",
                    vec![],
                );
            };
            let inspection_json = inspection.to_string();
            let leaked: Vec<_> = assertion
                .forbidden_terms
                .iter()
                .filter(|term| inspection_json.contains(term.as_str()))
                .collect();
            let unredacted_item = inspection
                .get("timelineItems")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|item| item.get("redacted") != Some(&Value::Bool(true)));
            let run_id = inspection
                .get("run")
                .and_then(|r| r.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("inspection");
            if !leaked.is_empty() || unredacted_item.is_some() {
                let unredacted_id = unredacted_item
                    .and_then(|item| item.get("id").and_then(Value::as_str))
                    .unwrap_or("none");
                traj_fail(
                    assertion,
                    format!(
                        "Inspection output was not fail-closed: {} forbidden term(s), unredacted item {unredacted_id}.",
                        leaked.len()
                    ),
                    scenario_evidence(run_id, "inspection:redaction"),
                )
            } else {
                traj_pass(
                    assertion,
                    "Inspection artifact stayed redacted and omitted forbidden terms.",
                    scenario_evidence(run_id, "inspection:redaction"),
                )
            }
        }
        "workspace.manifest" => {
            let Some(manifest) = inputs.workspace_manifest.as_ref() else {
                return traj_fail(
                    assertion,
                    "workspace.manifest requires source.workspaceManifestPath.",
                    vec![],
                );
            };
            let missing_files: Vec<_> = assertion
                .required_workspace_files
                .iter()
                .filter(|path| !manifest.files.iter().any(|f| &f.path == *path))
                .cloned()
                .collect();
            let missing_adapters: Vec<_> = assertion
                .required_tool_adapters
                .iter()
                .filter(|tool| !manifest.tool_adapters.iter().any(|a| &a.tool == *tool))
                .cloned()
                .collect();
            let hydration_rejected = !assertion.required_hydration_modes.is_empty()
                && !assertion
                    .required_hydration_modes
                    .iter()
                    .any(|mode| mode == &manifest.hydration.mode);
            let release_gate_rejected = assertion
                .required_release_gate_tier
                .as_ref()
                .is_some_and(|tier| scenario.release_gate.as_ref().map(|g| &g.tier) != Some(tier));
            let file_floor = assertion.min_workspace_files.unwrap_or(0);
            let adapter_floor = assertion.min_tool_adapters.unwrap_or(0);
            let mut failures = Vec::new();
            for path in &missing_files {
                failures.push(format!("missing file {path}"));
            }
            for tool in &missing_adapters {
                failures.push(format!("missing tool adapter {tool}"));
            }
            if hydration_rejected {
                failures.push(format!(
                    "hydration mode {} not allowed",
                    manifest.hydration.mode
                ));
            }
            if release_gate_rejected {
                failures.push(format!(
                    "release tier {} did not match {}",
                    scenario
                        .release_gate
                        .as_ref()
                        .map(|g| g.tier.as_str())
                        .unwrap_or("none"),
                    assertion
                        .required_release_gate_tier
                        .as_deref()
                        .unwrap_or("")
                ));
            }
            if manifest.files.len() < file_floor {
                failures.push(format!(
                    "workspace files {}/{file_floor}",
                    manifest.files.len()
                ));
            }
            if manifest.tool_adapters.len() < adapter_floor {
                failures.push(format!(
                    "tool adapters {}/{adapter_floor}",
                    manifest.tool_adapters.len()
                ));
            }
            if !manifest.redaction.secrets_removed {
                failures.push("workspace manifest did not confirm secret redaction".to_string());
            }
            if manifest.redaction.raw_prompts_included {
                failures.push(
                    "workspace manifest did not confirm raw prompts were excluded".to_string(),
                );
            }
            if failures.is_empty() {
                traj_pass(
                    assertion,
                    format!(
                        "Workspace manifest {} is release-gate ready ({} file(s), {} tool adapter(s), {}).",
                        manifest.id,
                        manifest.files.len(),
                        manifest.tool_adapters.len(),
                        manifest.hydration.mode
                    ),
                    traj_workspace_evidence(manifest),
                )
            } else {
                traj_fail(
                    assertion,
                    format!(
                        "Workspace manifest is not release-gate ready: {}.",
                        failures.join("; ")
                    ),
                    traj_workspace_evidence(manifest),
                )
            }
        }
        "efficiency.budget" => {
            let max_events = assertion.max_events.unwrap_or(usize::MAX);
            let max_tool_calls = assertion.max_tool_calls.unwrap_or(usize::MAX);
            let max_deltas = assertion.max_replay_deltas.unwrap_or(usize::MAX);
            let max_failures = assertion.max_score_failures.unwrap_or(usize::MAX);
            let max_warnings = assertion.max_score_warnings.unwrap_or(usize::MAX);
            let observed_tool_calls = count_tool_calls(&inputs.events);
            let observed_failures = score_failures(&inputs.score_findings);
            let observed_warnings = score_warnings(&inputs.score_findings);
            let exceeded = inputs.trajectory_event_count > max_events
                || observed_tool_calls > max_tool_calls
                || inputs.replay_deltas > max_deltas
                || observed_failures > max_failures
                || observed_warnings > max_warnings;
            let message = format!(
                "Observed events={}, toolCalls={observed_tool_calls}, replayDeltas={}, scoreFailures={observed_failures}, scoreWarnings={observed_warnings}.",
                inputs.trajectory_event_count, inputs.replay_deltas
            );
            if exceeded {
                traj_fail(
                    assertion,
                    format!("Efficiency budget exceeded. {message}"),
                    vec![],
                )
            } else {
                traj_pass(
                    assertion,
                    format!("Efficiency budget satisfied. {message}"),
                    vec![],
                )
            }
        }
        "provenance.chain" => {
            let Some(event_id) = assertion.event_id.as_ref() else {
                return traj_fail(assertion, "provenance.chain requires eventId.", vec![]);
            };
            let Some(event) = inputs.events.iter().find(|e| &e.id == event_id) else {
                return traj_fail(
                    assertion,
                    format!("Missing provenance event {event_id}."),
                    vec![],
                );
            };
            let kinds: HashSet<_> = event.evidence.iter().map(|a| a.kind.as_str()).collect();
            let missing: Vec<_> = assertion
                .required_evidence_kinds
                .iter()
                .filter(|kind| !kinds.contains(kind.as_str()))
                .cloned()
                .collect();
            if missing.is_empty() {
                traj_pass(
                    assertion,
                    format!("Event {event_id} includes required provenance anchors."),
                    evidence_from_events(&[event]),
                )
            } else {
                traj_fail(
                    assertion,
                    format!(
                        "Event {event_id} is missing provenance anchors: {}.",
                        missing.join(", ")
                    ),
                    evidence_from_events(&[event]),
                )
            }
        }
        "human.review" => {
            let missing: Vec<_> = assertion
                .required_labels
                .iter()
                .filter(|label| !scenario.review_labels.iter().any(|l| l == *label))
                .cloned()
                .collect();
            if missing.is_empty() {
                traj_pass(
                    assertion,
                    format!(
                        "Human review labels present: {}.",
                        assertion.required_labels.join(", ")
                    ),
                    scenario_evidence(&scenario.id, "human-review:labels"),
                )
            } else {
                traj_fail(
                    assertion,
                    format!("Missing human review labels: {}.", missing.join(", ")),
                    scenario_evidence(&scenario.id, "human-review:labels"),
                )
            }
        }
        "external.refs" => {
            let Some(external_refs) = scenario.external_refs.as_ref() else {
                return traj_fail(
                    assertion,
                    "external.refs requires scenario.externalRefs.",
                    vec![],
                );
            };
            let missing_kinds: Vec<_> = assertion
                .required_external_ref_kinds
                .iter()
                .filter(|kind| {
                    external_refs
                        .get(kind.as_str())
                        .and_then(Value::as_array)
                        .is_none_or(|arr| arr.is_empty())
                })
                .cloned()
                .collect();
            let flattened: HashSet<String> = EXTERNAL_REF_FIELDS
                .iter()
                .chain(LEGACY_EXTERNAL_REF_FIELDS.iter())
                .filter_map(|field| external_refs.get(*field))
                .filter_map(Value::as_array)
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            let missing_refs: Vec<_> = assertion
                .required_external_refs
                .iter()
                .filter(|r| !flattened.contains(r.as_str()))
                .cloned()
                .collect();
            let mut missing = missing_kinds;
            missing.extend(missing_refs);
            if missing.is_empty() {
                traj_pass(
                    assertion,
                    format!(
                        "External refs present for {}.",
                        assertion.required_external_ref_kinds.join(", ")
                    ),
                    scenario_evidence(&scenario.id, "external-refs"),
                )
            } else {
                traj_fail(
                    assertion,
                    format!("Missing external refs: {}.", missing.join(", ")),
                    scenario_evidence(&scenario.id, "external-refs"),
                )
            }
        }
        "trajectory.diff" => {
            let Some(diff) = diff else {
                return traj_fail(
                    assertion,
                    "trajectory.diff requires baselineTrajectoryPath and candidateTrajectoryPath.",
                    vec![],
                );
            };
            let max_events = assertion.max_added_events.unwrap_or(i64::MAX as usize) as i64;
            let max_tools = assertion.max_added_tool_calls.unwrap_or(i64::MAX as usize) as i64;
            let max_failures = assertion
                .max_added_score_failures
                .unwrap_or(i64::MAX as usize) as i64;
            let exceeded = diff.events_delta > max_events
                || diff.tool_calls_delta > max_tools
                || diff.score_failures_delta > max_failures;
            let message = format!(
                "Diff eventsDelta={}, toolCallsDelta={}, scoreFailuresDelta={}.",
                diff.events_delta, diff.tool_calls_delta, diff.score_failures_delta
            );
            if exceeded {
                traj_fail(
                    assertion,
                    format!("Trajectory diff budget exceeded. {message}"),
                    vec![],
                )
            } else {
                traj_pass(
                    assertion,
                    format!("Trajectory diff budget satisfied. {message}"),
                    vec![],
                )
            }
        }
        other => traj_fail(
            assertion,
            format!("Unsupported scenario assertion kind: {other}"),
            vec![],
        ),
    }
}

fn build_provenance(events: &[TrajectoryEvent]) -> Vec<ProvenanceStep> {
    events
        .iter()
        .filter(|event| !event.evidence.is_empty())
        .map(|event| ProvenanceStep {
            event_id: event.id.clone(),
            event_type: event.event_type.clone(),
            phase: event.phase.clone().unwrap_or_default(),
            actor: event.actor.clone().unwrap_or_default(),
            evidence: evidence_from_events(&[event]),
        })
        .collect()
}

fn evaluate_trajectory_scenario_file(
    scenario: &TrajectoryScenario,
    base_dir: &Path,
) -> Result<TrajectoryRunResult> {
    let inputs = load_trajectory_inputs(scenario, base_dir)?;
    let diff = build_trajectory_diff(&inputs);
    let release_gate = build_trajectory_release_gate(scenario, &inputs);
    let workspace = inputs
        .workspace_manifest
        .as_ref()
        .map(|m| WorkspaceSummary {
            manifest_id: m.id.clone(),
            source: m.source.clone(),
            recorded_at: m.recorded_at.clone(),
            hydration_mode: m.hydration.mode.clone(),
            files: m.files.len(),
            tool_adapters: m.tool_adapters.len(),
        });
    let assertions: Vec<_> = scenario
        .assertions
        .iter()
        .map(|assertion| evaluate_trajectory_assertion(assertion, scenario, &inputs, diff.as_ref()))
        .collect();
    let failed = assertions.iter().filter(|a| a.status == "fail").count();
    let warnings = assertions.iter().filter(|a| a.status == "warn").count();
    let passed = assertions.iter().filter(|a| a.status == "pass").count();
    let observed_outcome = if failed > 0 { "fail" } else { "pass" };

    let mut run = inputs.trajectory_run.clone();
    if let Some(obj) = run.as_object_mut() {
        obj.insert("scenarioId".to_string(), json!(scenario.id));
        obj.insert("replay".to_string(), json!(true));
    }

    let mut platform = serde_json::to_value(&scenario.platform).unwrap_or_else(|_| json!({}));
    if let Some(obj) = platform.as_object_mut() {
        obj.insert(
            "evidenceEventType".to_string(),
            json!("maestro.events.eval.scored"),
        );
    }

    Ok(TrajectoryRunResult {
        schema_version: TRAJECTORY_RESULT_SCHEMA,
        scenario_schema_version: scenario.schema_version.clone(),
        scenario: TrajectoryScenarioOutcome {
            id: scenario.id.clone(),
            title: scenario.title.clone(),
            expected_outcome: scenario
                .expected_outcome
                .clone()
                .unwrap_or_else(|| "pass".to_string()),
            observed_outcome: observed_outcome.to_string(),
            review_labels: scenario.review_labels.clone(),
        },
        external_refs: scenario.external_refs.clone(),
        run,
        counts: TrajectoryRunCounts {
            assertions: assertions.len(),
            passed,
            failed,
            warnings,
            events: inputs.trajectory_event_count,
            tool_calls: count_tool_calls(&inputs.events),
            replay_deltas: inputs.replay_deltas,
            score_failures: score_failures(&inputs.score_findings),
            score_warnings: score_warnings(&inputs.score_findings),
            workspace_files: inputs
                .workspace_manifest
                .as_ref()
                .map(|m| m.files.len())
                .unwrap_or(0),
            tool_adapters: inputs
                .workspace_manifest
                .as_ref()
                .map(|m| m.tool_adapters.len())
                .unwrap_or(0),
        },
        platform,
        release_gate,
        workspace,
        assumptions: scenario.assumptions.clone(),
        assertions,
        provenance: build_provenance(&inputs.events),
        diff,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positional_skips_flags() {
        let args = ["--json", "path.json", "--junit", "out.xml"]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();
        assert_eq!(positional_args(&args), vec!["path.json"]);
    }

    #[test]
    fn escape_xml_encodes_entities() {
        assert_eq!(escape_xml("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&apos;");
    }
}
