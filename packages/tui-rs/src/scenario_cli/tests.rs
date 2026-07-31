//! Tests for `maestro scenario`'s assertion evaluation and JUnit reporting.
//!
//! This harness is what the team trusts to say "did the product regress",
//! so these tests deliberately lead with the negative paths: does a
//! scenario that *should* fail actually get reported as failing, both at
//! the individual-assertion level and in the JUnit output consumed by CI.

use super::*;
use serde_json::json;
use std::fs;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

fn merge(base: &mut Value, patch: Value) {
    if let (Value::Object(base_map), Value::Object(patch_map)) = (base, patch) {
        base_map.extend(patch_map);
    }
}

fn base_scenario_json() -> Value {
    json!({
        "schemaVersion": SCRIPTED_SCHEMA,
        "id": "scenario-1",
        "description": "fixture scenario",
        "metadata": {
            "recordedAt": "2026-07-21T00:00:00.000Z",
            "toolsExpected": [],
            "auditEvents": [],
        },
        "frames": [],
        "assertions": [],
    })
}

/// Build a `ScriptedScenario` from a shallow JSON patch merged onto a
/// minimal valid baseline, matching the real wire format
/// (`evaluate.maestro.scripted-scenario.v1`, camelCase).
fn scenario_from(patch: Value) -> ScriptedScenario {
    let mut value = base_scenario_json();
    merge(&mut value, patch);
    serde_json::from_value(value).expect("scripted scenario fixture")
}

fn scripted_assertion(value: Value) -> ScriptedAssertion {
    serde_json::from_value(value).expect("scripted assertion fixture")
}

// ---------------------------------------------------------------------------
// Pre-existing coverage (moved from the inline `mod tests` block).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// tool_call_statements: execution ordering
// ---------------------------------------------------------------------------

#[test]
fn tool_call_statements_preserves_execution_order_and_skips_non_tool_statements() {
    let scenario = scenario_from(json!({
        "frames": [
            {"index": 0, "statements": [
                {"kind": "assistant_message", "text": "thinking"},
                {"kind": "tool_call", "tool": "read_file", "id": "call-a"},
            ]},
            {"index": 1, "statements": [
                {"kind": "tool_call", "tool": "write_file", "id": "call-b"},
            ]},
        ],
    }));
    let calls = tool_call_statements(&scenario);
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].tool, "read_file");
    assert_eq!(calls[0].id.as_deref(), Some("call-a"));
    assert_eq!(calls[0].frame_index, 0);
    assert_eq!(calls[0].statement_index, 1);
    assert_eq!(calls[1].tool, "write_file");
    assert_eq!(calls[1].frame_index, 1);
    assert_eq!(calls[1].statement_index, 0);
}

// ---------------------------------------------------------------------------
// evaluate_assertion: tool_called / tool_not_called
// ---------------------------------------------------------------------------

#[test]
fn tool_called_passes_when_tool_was_invoked() {
    let scenario = scenario_from(json!({
        "frames": [{"index": 0, "statements": [
            {"kind": "tool_call", "tool": "read_file", "id": "call-1"},
        ]}],
    }));
    let assertion =
        scripted_assertion(json!({"id": "a1", "kind": "tool_called", "tool": "read_file"}));
    let result = evaluate_assertion(&assertion, &scenario, Path::new("."), None);
    assert_eq!(result.status, "pass");
}

#[test]
fn tool_called_fails_when_tool_was_never_invoked() {
    let scenario = scenario_from(json!({"frames": []}));
    let assertion =
        scripted_assertion(json!({"id": "a1", "kind": "tool_called", "tool": "read_file"}));
    let result = evaluate_assertion(&assertion, &scenario, Path::new("."), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("No scripted tool call matched"));
}

#[test]
fn tool_called_fails_when_neither_tool_nor_id_supplied() {
    let scenario = scenario_from(json!({"frames": []}));
    let assertion = scripted_assertion(json!({"id": "a1", "kind": "tool_called"}));
    let result = evaluate_assertion(&assertion, &scenario, Path::new("."), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("requires tool or toolCallId"));
}

#[test]
fn tool_not_called_passes_when_tool_absent() {
    let scenario = scenario_from(json!({"frames": []}));
    let assertion =
        scripted_assertion(json!({"id": "a1", "kind": "tool_not_called", "tool": "delete_file"}));
    let result = evaluate_assertion(&assertion, &scenario, Path::new("."), None);
    assert_eq!(result.status, "pass");
}

#[test]
fn tool_not_called_fails_when_forbidden_tool_was_invoked() {
    let scenario = scenario_from(json!({
        "frames": [{"index": 0, "statements": [
            {"kind": "tool_call", "tool": "delete_file", "id": "call-1"},
        ]}],
    }));
    let assertion =
        scripted_assertion(json!({"id": "a1", "kind": "tool_not_called", "tool": "delete_file"}));
    let result = evaluate_assertion(&assertion, &scenario, Path::new("."), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("was called"));
}

#[test]
fn tool_not_called_fails_when_tool_arg_missing() {
    let scenario = scenario_from(json!({"frames": []}));
    let assertion = scripted_assertion(json!({"id": "a1", "kind": "tool_not_called"}));
    let result = evaluate_assertion(&assertion, &scenario, Path::new("."), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("requires tool"));
}

// ---------------------------------------------------------------------------
// evaluate_assertion: file_exists / file_contents
// ---------------------------------------------------------------------------

#[test]
fn file_exists_passes_when_file_present() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::write(dir.path().join("out.txt"), "hi").expect("write fixture");
    let scenario = scenario_from(json!({}));
    let assertion =
        scripted_assertion(json!({"id": "a1", "kind": "file_exists", "path": "out.txt"}));
    let result = evaluate_assertion(&assertion, &scenario, dir.path(), None);
    assert_eq!(result.status, "pass");
}

#[test]
fn file_exists_fails_when_file_missing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let scenario = scenario_from(json!({}));
    let assertion =
        scripted_assertion(json!({"id": "a1", "kind": "file_exists", "path": "missing.txt"}));
    let result = evaluate_assertion(&assertion, &scenario, dir.path(), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("does not exist"));
}

#[test]
fn file_exists_fails_when_path_arg_missing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let scenario = scenario_from(json!({}));
    let assertion = scripted_assertion(json!({"id": "a1", "kind": "file_exists"}));
    let result = evaluate_assertion(&assertion, &scenario, dir.path(), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("requires path"));
}

#[test]
fn file_contents_passes_on_contains_match() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::write(dir.path().join("out.txt"), "hello world").expect("write fixture");
    let scenario = scenario_from(json!({}));
    let assertion = scripted_assertion(
        json!({"id": "a1", "kind": "file_contents", "path": "out.txt", "contains": "world"}),
    );
    let result = evaluate_assertion(&assertion, &scenario, dir.path(), None);
    assert_eq!(result.status, "pass");
}

#[test]
fn file_contents_passes_on_exact_equals_match() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::write(dir.path().join("out.txt"), "exact").expect("write fixture");
    let scenario = scenario_from(json!({}));
    let assertion = scripted_assertion(
        json!({"id": "a1", "kind": "file_contents", "path": "out.txt", "equals": "exact"}),
    );
    let result = evaluate_assertion(&assertion, &scenario, dir.path(), None);
    assert_eq!(result.status, "pass");
}

#[test]
fn file_contents_fails_on_mismatch() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::write(dir.path().join("out.txt"), "hello world").expect("write fixture");
    let scenario = scenario_from(json!({}));
    let assertion = scripted_assertion(
        json!({"id": "a1", "kind": "file_contents", "path": "out.txt", "contains": "goodbye"}),
    );
    let result = evaluate_assertion(&assertion, &scenario, dir.path(), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("did not match"));
}

#[test]
fn file_contents_fails_when_file_missing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let scenario = scenario_from(json!({}));
    let assertion = scripted_assertion(
        json!({"id": "a1", "kind": "file_contents", "path": "missing.txt", "contains": "x"}),
    );
    let result = evaluate_assertion(&assertion, &scenario, dir.path(), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("does not exist"));
}

#[test]
fn file_contents_fails_when_contains_and_equals_both_missing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let scenario = scenario_from(json!({}));
    let assertion =
        scripted_assertion(json!({"id": "a1", "kind": "file_contents", "path": "out.txt"}));
    let result = evaluate_assertion(&assertion, &scenario, dir.path(), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("requires contains or equals"));
}

// ---------------------------------------------------------------------------
// evaluate_assertion: audit_event_emitted / unsupported kind
// ---------------------------------------------------------------------------

#[test]
fn audit_event_emitted_passes_when_event_present() {
    let scenario = scenario_from(json!({
        "metadata": {
            "recordedAt": "2026-07-21T00:00:00.000Z",
            "toolsExpected": [],
            "auditEvents": ["patch.applied"],
        },
    }));
    let assertion = scripted_assertion(
        json!({"id": "a1", "kind": "audit_event_emitted", "eventType": "patch.applied"}),
    );
    let result = evaluate_assertion(&assertion, &scenario, Path::new("."), None);
    assert_eq!(result.status, "pass");
}

#[test]
fn audit_event_emitted_fails_when_event_missing() {
    let scenario = scenario_from(json!({}));
    let assertion = scripted_assertion(
        json!({"id": "a1", "kind": "audit_event_emitted", "eventType": "patch.applied"}),
    );
    let result = evaluate_assertion(&assertion, &scenario, Path::new("."), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("Audit event missing"));
}

#[test]
fn audit_event_emitted_fails_when_event_type_arg_missing() {
    let scenario = scenario_from(json!({}));
    let assertion = scripted_assertion(json!({"id": "a1", "kind": "audit_event_emitted"}));
    let result = evaluate_assertion(&assertion, &scenario, Path::new("."), None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("requires eventType"));
}

#[test]
fn unsupported_assertion_kind_fails_rather_than_silently_passing() {
    let scenario = scenario_from(json!({}));
    let assertion = scripted_assertion(json!({"id": "a1", "kind": "made_up_kind"}));
    let result = evaluate_assertion(&assertion, &scenario, Path::new("."), None);
    assert_eq!(result.status, "fail");
    assert!(result
        .message
        .contains("Unsupported scripted assertion kind"));
}

// ---------------------------------------------------------------------------
// evaluate_scripted_scenario: overall pass/fail semantics
// ---------------------------------------------------------------------------

#[test]
fn scenario_passes_when_every_assertion_passes() {
    let scenario = scenario_from(json!({
        "frames": [{"index": 0, "statements": [
            {"kind": "tool_call", "tool": "read_file", "id": "call-1"},
        ]}],
        "assertions": [
            {"id": "a1", "kind": "tool_called", "tool": "read_file"},
        ],
    }));
    let result = evaluate_scripted_scenario(&scenario, Path::new(".")).expect("evaluate");
    assert_eq!(result.scenario.observed_outcome, "pass");
    assert_eq!(result.counts.failed, 0);
    assert_eq!(result.counts.passed, 1);
}

/// The core negative-path invariant: one failing assertion must flip the
/// whole scenario's observed outcome to "fail", not just be recorded and
/// ignored at the aggregate level.
#[test]
fn scenario_fails_when_any_assertion_fails() {
    let scenario = scenario_from(json!({
        "frames": [{"index": 0, "statements": [
            {"kind": "tool_call", "tool": "read_file", "id": "call-1"},
        ]}],
        "assertions": [
            {"id": "a1", "kind": "tool_called", "tool": "read_file"},
            {"id": "a2", "kind": "tool_called", "tool": "never_called"},
        ],
    }));
    let result = evaluate_scripted_scenario(&scenario, Path::new(".")).expect("evaluate");
    assert_eq!(result.scenario.observed_outcome, "fail");
    assert_eq!(result.counts.passed, 1);
    assert_eq!(result.counts.failed, 1);
}

/// A release-blocking gate that isn't satisfied must fail the scenario even
/// when every individual assertion passed (here: zero assertions at all).
#[test]
fn scenario_fails_from_unsatisfied_release_gate_even_with_no_failing_assertions() {
    let scenario = scenario_from(json!({
        "releaseGate": {
            "releaseBlocking": true,
            "tier": "smoke",
            "requiredArtifacts": ["workspace_manifest"],
        },
        "assertions": [],
    }));
    let result = evaluate_scripted_scenario(&scenario, Path::new(".")).expect("evaluate");
    assert_eq!(result.counts.failed, 0, "no assertion itself failed");
    assert_eq!(
        result.scenario.observed_outcome, "fail",
        "an unsatisfied release-blocking gate must still fail the scenario"
    );
    let gate = result.release_gate.expect("release gate summary present");
    assert!(!gate.satisfied);
    assert_eq!(
        gate.missing_artifacts,
        vec!["workspace_manifest".to_string()]
    );
}

// ---------------------------------------------------------------------------
// result_to_junit: the JUnit output CI actually reads
// ---------------------------------------------------------------------------

fn assertion_result(id: &str, status: &str, message: &str) -> AssertionResult {
    AssertionResult {
        id: id.to_string(),
        kind: "tool_called".to_string(),
        status: status.to_string(),
        severity: "error".to_string(),
        message: message.to_string(),
        evidence: vec![],
    }
}

/// A genuine regression (expected pass, observed fail) must surface as a
/// JUnit `<failure>` so CI actually goes red.
#[test]
fn junit_reports_failure_for_unexpected_regression() {
    let assertions = vec![assertion_result("a1", "fail", "tool was not called")];
    let xml = result_to_junit("scenario-1", "pass", "fail", 1, 0, &assertions);
    assert!(xml.contains("failures=\"1\""));
    assert!(xml.contains("<failure message=\"tool was not called\">"));
    assert!(!xml.contains("<system-out>"));
}

/// The critical negative-first invariant: a scenario that is *designed* to
/// fail (expectedOutcome = "fail") and that correctly fails must NOT be
/// reported as a JUnit failure -- otherwise every intentional negative
/// fixture would show up as a false-red regression in CI.
#[test]
fn junit_does_not_report_failure_for_expected_negative_scenario() {
    let assertions = vec![assertion_result(
        "a1",
        "fail",
        "forbidden action was correctly rejected",
    )];
    let xml = result_to_junit("scenario-1", "fail", "fail", 1, 0, &assertions);
    assert!(
        xml.contains("failures=\"0\""),
        "an intentionally-failing scenario that failed as expected must not raise a JUnit failure: {xml}"
    );
    assert!(!xml.contains("<failure"), "{xml}");
    assert!(
        xml.contains("<system-out>"),
        "the expected failure should still be visible as informational output: {xml}"
    );
}

/// The mirror-image regression: a scenario that is supposed to demonstrate
/// a failure mode (expectedOutcome = "fail") silently starts passing. This
/// means whatever bug the fixture existed to catch is no longer being
/// caught, so it must still raise a JUnit failure even though no individual
/// assertion failed.
#[test]
fn junit_reports_failure_when_expected_negative_scenario_starts_passing() {
    let assertions = vec![assertion_result(
        "a1",
        "pass",
        "forbidden action was not attempted",
    )];
    let xml = result_to_junit("scenario-1", "fail", "pass", 1, 0, &assertions);
    assert!(xml.contains("failures=\"1\""), "{xml}");
    assert!(
        xml.contains("scenario-outcome") && xml.contains("<failure"),
        "an expected-to-fail scenario that unexpectedly passed must raise a failure: {xml}"
    );
}

/// A release-gate-driven failure (no individual assertion failed) must
/// still synthesize a JUnit failure testcase, not silently report a clean
/// suite.
#[test]
fn junit_reports_synthetic_failure_for_outcome_mismatch_without_assertion_failures() {
    let assertions = vec![assertion_result("a1", "pass", "everything checked out")];
    let xml = result_to_junit("scenario-1", "pass", "fail", 1, 0, &assertions);
    assert!(xml.contains("failures=\"1\""), "{xml}");
    assert!(xml.contains("tests=\"2\""), "{xml}");
    assert!(xml.contains("scenario-outcome"), "{xml}");
}

#[test]
fn junit_escapes_assertion_message_and_scenario_id() {
    let assertions = vec![assertion_result(
        "a<1>",
        "fail",
        "message with <tags> & \"quotes\"",
    )];
    let xml = result_to_junit("scenario & <1>", "pass", "fail", 1, 0, &assertions);
    assert!(xml.contains("scenario &amp; &lt;1&gt;"), "{xml}");
    assert!(xml.contains("name=\"a&lt;1&gt;\""), "{xml}");
    assert!(
        xml.contains("message with &lt;tags&gt; &amp; &quot;quotes&quot;"),
        "{xml}"
    );
}

#[test]
fn scripted_result_to_junit_matches_result_to_junit_for_a_passing_scenario() {
    let scenario = scenario_from(json!({
        "frames": [{"index": 0, "statements": [
            {"kind": "tool_call", "tool": "read_file", "id": "call-1"},
        ]}],
        "assertions": [
            {"id": "a1", "kind": "tool_called", "tool": "read_file"},
        ],
    }));
    let result = evaluate_scripted_scenario(&scenario, Path::new(".")).expect("evaluate");
    let xml = scripted_result_to_junit(&result);
    assert!(xml.contains("tests=\"1\""));
    assert!(xml.contains("failures=\"0\""));
    assert!(xml.contains("name=\"a1\""));
    assert!(!xml.contains("<failure"));
}

// ---------------------------------------------------------------------------
// evaluate_trajectory_assertion: representative negative-path coverage for
// the agent-trajectory replay assertion kinds.
// ---------------------------------------------------------------------------

fn trajectory_scenario() -> TrajectoryScenario {
    let value = json!({
        "schemaVersion": TRAJECTORY_SCHEMA,
        "id": "traj-1",
        "title": "fixture",
        "description": "fixture trajectory scenario",
        "source": {
            "trajectoryPath": "trajectory.json",
            "replayPath": "replay.json",
            "scorePath": "score.json",
        },
        "platform": {
            "primitive": "agent_run",
            "traceJoinKeys": ["runId"],
        },
        "assumptions": {
            "workflow": "test",
            "correctnessModel": "test",
            "threatModel": "test",
            "researchBasis": [],
        },
        "assertions": [],
    });
    serde_json::from_value(value).expect("trajectory scenario fixture")
}

fn trajectory_assertion(value: Value) -> TrajectoryAssertion {
    serde_json::from_value(value).expect("trajectory assertion fixture")
}

fn trajectory_event(id: &str, event_type: &str, tool_name: Option<&str>) -> TrajectoryEvent {
    TrajectoryEvent {
        id: id.to_string(),
        kind: None,
        phase: None,
        event_type: event_type.to_string(),
        status: None,
        tool_name: tool_name.map(str::to_string),
        source: None,
        actor: None,
        evidence: vec![],
    }
}

fn trajectory_inputs(events: Vec<TrajectoryEvent>) -> TrajectoryInputs {
    TrajectoryInputs {
        trajectory_event_count: events.len(),
        events,
        trajectory_run: json!({}),
        replay_deltas: 0,
        replay_errors: 0,
        replay_delta_evidence: vec![],
        score_findings: vec![],
        inspection: None,
        workspace_manifest: None,
        baseline_trajectory: None,
        candidate_trajectory: None,
        baseline_score: None,
        candidate_score: None,
    }
}

#[test]
fn event_exists_fails_when_no_event_matches_the_selector() {
    let scenario = trajectory_scenario();
    let inputs = trajectory_inputs(vec![trajectory_event(
        "evt-1",
        "tool.requested",
        Some("read_file"),
    )]);
    let assertion = trajectory_assertion(json!({
        "id": "t1",
        "kind": "event.exists",
        "selector": {"toolName": "write_file"},
    }));
    let result = evaluate_trajectory_assertion(&assertion, &scenario, &inputs, None);
    assert_eq!(result.status, "fail");
    assert!(result.message.contains("No trajectory event matched"));
}

#[test]
fn event_exists_passes_when_selector_matches() {
    let scenario = trajectory_scenario();
    let inputs = trajectory_inputs(vec![trajectory_event(
        "evt-1",
        "tool.requested",
        Some("read_file"),
    )]);
    let assertion = trajectory_assertion(json!({
        "id": "t1",
        "kind": "event.exists",
        "selector": {"toolName": "read_file"},
    }));
    let result = evaluate_trajectory_assertion(&assertion, &scenario, &inputs, None);
    assert_eq!(result.status, "pass");
}

/// `event.forbidden` inverts `event.exists`: a *match* is the failure case.
/// This is the assertion kind most directly responsible for catching a
/// regression (e.g. a forbidden tool call slipping through), so it is the
/// highest-value negative path in this function to pin.
#[test]
fn event_forbidden_fails_when_the_forbidden_event_occurred() {
    let scenario = trajectory_scenario();
    let inputs = trajectory_inputs(vec![trajectory_event(
        "evt-1",
        "tool.requested",
        Some("delete_repository"),
    )]);
    let assertion = trajectory_assertion(json!({
        "id": "t1",
        "kind": "event.forbidden",
        "selector": {"toolName": "delete_repository"},
    }));
    let result = evaluate_trajectory_assertion(&assertion, &scenario, &inputs, None);
    assert_eq!(
        result.status, "fail",
        "a forbidden tool call must be reported as a failure, not silently accepted"
    );
}

#[test]
fn event_forbidden_passes_when_the_forbidden_event_never_happened() {
    let scenario = trajectory_scenario();
    let inputs = trajectory_inputs(vec![trajectory_event(
        "evt-1",
        "tool.requested",
        Some("read_file"),
    )]);
    let assertion = trajectory_assertion(json!({
        "id": "t1",
        "kind": "event.forbidden",
        "selector": {"toolName": "delete_repository"},
    }));
    let result = evaluate_trajectory_assertion(&assertion, &scenario, &inputs, None);
    assert_eq!(result.status, "pass");
}

// ---------------------------------------------------------------------------
// `scenario run --execute`: scripted provider through the real agent loop
// ---------------------------------------------------------------------------

mod execute_tests {
    use super::super::execute;
    use super::*;
    use crate::session::{sessions_dir, SessionReader};

    static ENV_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct HomeGuard {
        previous: Option<String>,
    }

    impl HomeGuard {
        fn set(path: &Path) -> Self {
            let previous = std::env::var("HOME").ok();
            std::env::set_var("HOME", path);
            Self { previous }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    fn execute_scenario_json(tool_calls: Value) -> Value {
        json!({
            "schemaVersion": SCRIPTED_SCHEMA,
            "id": "execute-test",
            "description": "execute through the real agent loop",
            "metadata": {
                "recordedAt": "2026-07-21T00:00:00.000Z",
                "toolsExpected": ["read", "write"],
                "auditEvents": ["maestro.scenario.replay.ready"],
            },
            "frames": [
                {
                    "index": 0,
                    "statements": [
                        {"kind": "text", "text": "I will inspect the manifest."},
                        tool_calls,
                    ],
                },
                {
                    "index": 1,
                    "statements": [
                        {"kind": "text", "text": "Execute replay completed."},
                        {"kind": "end", "reason": "complete"},
                    ],
                },
            ],
            "assertions": [],
        })
    }

    fn read_write_scenario() -> Value {
        let mut scenario = execute_scenario_json(json!({
            "kind": "tool_call",
            "id": "call-read-package-json",
            "tool": "read",
            "input": {"path": "package.json"},
            "expectedResult": "success",
        }));
        scenario["frames"][0]["statements"]
            .as_array_mut()
            .expect("statements")
            .push(json!({
                "kind": "tool_call",
                "id": "call-write-artifact",
                "tool": "write",
                "input": {
                    "path": "executed-artifact.json",
                    "content": "{\"executed\":true}",
                    "previewDiff": false,
                    "backup": false,
                },
                "expectedResult": "success",
            }));
        scenario
    }

    fn parse_execute_scenario(raw: Value) -> ScriptedScenario {
        parse_scripted_scenario(&raw, "execute-test").expect("parse scenario")
    }

    #[tokio::test]
    async fn execute_runs_real_tool_calls_and_records_a_real_session() {
        let _lock = ENV_MUTEX.lock().await;
        let home = tempfile::tempdir().expect("home");
        let _home_guard = HomeGuard::set(home.path());
        let workspace = tempfile::tempdir().expect("workspace");
        fs::write(
            workspace.path().join("package.json"),
            "{\"name\":\"execute-test\"}\n",
        )
        .expect("seed package.json");

        let scenario = parse_execute_scenario(read_write_scenario());
        let execution = execute::execute_scripted_scenario(&scenario, workspace.path())
            .await
            .expect("execute scenario");

        // The write tool really wrote into the workspace.
        let artifact = fs::read_to_string(execution.workspace.join("executed-artifact.json"))
            .expect("artifact written by the write tool");
        assert!(artifact.contains("\"executed\":true"));

        // Both recorded tool calls really executed, in script order.
        let executed: Vec<_> = execution
            .tool_executions
            .iter()
            .map(|call| (call.call_id.as_str(), call.tool.as_str(), call.success))
            .collect();
        assert_eq!(
            executed,
            vec![
                ("call-read-package-json", "read", true),
                ("call-write-artifact", "write", true),
            ]
        );

        // The final text comes from the scenario's last frame.
        assert_eq!(execution.final_text, "Execute replay completed.");
        assert_eq!(execution.transcript_sha256.len(), 64);

        // A real session JSONL landed in the standard session store and the
        // native session reader parses it, tool results included.
        assert!(execution.session_path.exists());
        let session_dir = sessions_dir(&execution.workspace.display().to_string());
        assert!(execution.session_path.starts_with(&session_dir));
        let parsed = SessionReader::read_file(&execution.session_path)
            .expect("session parses with the native reader");
        assert_eq!(parsed.header.id, execution.session_id);
        let rendered = fs::read_to_string(&execution.session_path).expect("session jsonl");
        assert!(rendered.contains("call-read-package-json"));
        assert!(rendered.contains("call-write-artifact"));
        assert!(rendered.contains("Execute replay completed."));
        assert!(rendered.contains("scenario_replay"));
    }

    #[tokio::test]
    async fn execute_is_deterministic_across_runs() {
        let _lock = ENV_MUTEX.lock().await;
        let home = tempfile::tempdir().expect("home");
        let _home_guard = HomeGuard::set(home.path());

        let mut hashes = Vec::new();
        for _ in 0..2 {
            let workspace = tempfile::tempdir().expect("workspace");
            fs::write(
                workspace.path().join("package.json"),
                "{\"name\":\"execute-test\"}\n",
            )
            .expect("seed package.json");
            let scenario = parse_execute_scenario(read_write_scenario());
            let execution = execute::execute_scripted_scenario(&scenario, workspace.path())
                .await
                .expect("execute scenario");
            hashes.push(execution.transcript_sha256);
        }
        assert_eq!(
            hashes[0], hashes[1],
            "same scenario must produce the same normalized transcript hash"
        );
    }

    #[tokio::test]
    async fn execute_hydrates_the_workspace_from_the_manifest() {
        let _lock = ENV_MUTEX.lock().await;
        let home = tempfile::tempdir().expect("home");
        let _home_guard = HomeGuard::set(home.path());
        let fixture_root = tempfile::tempdir().expect("fixture root");
        let hydration = fixture_root.path().join("workspaces/exec");
        fs::create_dir_all(&hydration).expect("hydration dir");
        fs::write(hydration.join("package.json"), "{\"name\":\"hydrated\"}\n")
            .expect("seed hydrated package.json");
        fs::write(
            fixture_root.path().join("workspace-manifest.json"),
            serde_json::to_string_pretty(&json!({
                "schemaVersion": WORKSPACE_MANIFEST_SCHEMA,
                "id": "workspace-execute-test",
                "recordedAt": "2026-07-21T00:00:00.000Z",
                "source": "fixture",
                "hydration": {"mode": "fixture_workspace", "rootPath": "workspaces/exec"},
                "files": [{"path": "package.json"}],
                "toolAdapters": [{"tool": "read", "mode": "sandboxed"}],
                "redaction": {"secretsRemoved": true, "rawPromptsIncluded": false},
            }))
            .expect("manifest json"),
        )
        .expect("write manifest");

        let mut raw = read_write_scenario();
        raw["workspaceManifestPath"] = json!("workspace-manifest.json");
        let scenario = parse_execute_scenario(raw);
        let execution = execute::execute_scripted_scenario(&scenario, fixture_root.path())
            .await
            .expect("execute scenario");

        // Execution ran in a hydrated temp workspace, not the fixture root.
        assert_ne!(
            dunce::canonicalize(fixture_root.path()).expect("canonical fixture root"),
            execution.workspace
        );
        assert!(execution.workspace.join("package.json").exists());
        assert!(execution.workspace.join("executed-artifact.json").exists());
        assert!(
            !fixture_root.path().join("executed-artifact.json").exists(),
            "writes must land in the hydrated workspace, never the fixture root"
        );
    }

    #[tokio::test]
    async fn execute_rejects_scenarios_without_frames() {
        let _lock = ENV_MUTEX.lock().await;
        let home = tempfile::tempdir().expect("home");
        let _home_guard = HomeGuard::set(home.path());
        let workspace = tempfile::tempdir().expect("workspace");
        let mut raw = execute_scenario_json(json!({"kind": "end", "reason": "complete"}));
        raw["frames"] = json!([]);
        let scenario = parse_execute_scenario(raw);
        let error = execute::execute_scripted_scenario(&scenario, workspace.path())
            .await
            .expect_err("frameless scenario must fail");
        assert!(error.to_string().contains("no frames to execute"));
    }
}
