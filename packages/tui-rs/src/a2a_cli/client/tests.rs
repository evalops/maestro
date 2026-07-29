//! Tests for A2A task wire-format parsing and terminal-state classification.
//!
//! `A2ATask` is deserialized directly from a remote peer's HTTP response, so
//! coverage here favors malformed/adversarial shapes (missing required
//! fields, wrong types, unexpected response envelopes) over the happy path.

use super::*;
use serde_json::json;

fn sample_task_json() -> Value {
    json!({
        "id": "task-1",
        "contextId": "ctx-1",
        "status": {
            "state": "TASK_STATE_COMPLETED",
            "message": {
                "messageId": "msg-1",
                "role": "agent",
                "parts": [{"text": "done", "mediaType": "text/plain"}],
            },
            "timestamp": "2026-07-21T00:00:00.000Z",
        },
        "artifacts": [
            {"artifactId": "artifact-1", "parts": [{"text": "artifact text"}]},
        ],
        "history": [
            {"role": "user", "parts": [{"text": "please do the thing"}]},
            {"role": "agent", "parts": [{"text": "history reply"}]},
        ],
        "metadata": {"workGraph": {"nodes": []}},
    })
}

#[test]
fn a2a_task_round_trips_full_shape() {
    let task: A2ATask = serde_json::from_value(sample_task_json()).expect("deserialize task");
    assert_eq!(task.id, "task-1");
    assert_eq!(task.context_id.as_deref(), Some("ctx-1"));
    assert_eq!(task.status.state, "TASK_STATE_COMPLETED");
    assert_eq!(task.artifacts.as_ref().map(Vec::len), Some(1));
    assert_eq!(task.history.as_ref().map(Vec::len), Some(2));
    assert!(task.metadata.is_some());
}

#[test]
fn a2a_task_deserializes_with_only_required_fields() {
    let value = json!({"id": "task-2", "status": {"state": "TASK_STATE_WORKING"}});
    let task: A2ATask = serde_json::from_value(value).expect("minimal task must deserialize");
    assert_eq!(task.id, "task-2");
    assert_eq!(task.status.state, "TASK_STATE_WORKING");
    assert!(task.context_id.is_none());
    assert!(task.artifacts.is_none());
    assert!(task.history.is_none());
    assert!(task.metadata.is_none());
    assert!(task.status.message.is_none());
    assert!(task.status.timestamp.is_none());
}

#[test]
fn a2a_task_rejects_missing_id() {
    let value = json!({"status": {"state": "TASK_STATE_WORKING"}});
    let err = serde_json::from_value::<A2ATask>(value)
        .expect_err("task without an id must fail to parse");
    assert!(err.to_string().contains("id"), "{err}");
}

#[test]
fn a2a_task_rejects_missing_status() {
    let value = json!({"id": "task-3"});
    let err = serde_json::from_value::<A2ATask>(value)
        .expect_err("task without a status must fail to parse");
    assert!(err.to_string().contains("status"), "{err}");
}

#[test]
fn a2a_task_rejects_wrong_type_for_state() {
    let value = json!({"id": "task-4", "status": {"state": 42}});
    let err = serde_json::from_value::<A2ATask>(value)
        .expect_err("numeric state must fail to parse (state is a String)");
    assert!(
        err.to_string().contains("invalid type") && err.to_string().contains("expected a string"),
        "{err}"
    );
}

#[test]
fn extract_task_text_prefers_status_message() {
    let task: A2ATask = serde_json::from_value(sample_task_json()).expect("task");
    assert_eq!(extract_task_text(&task).as_deref(), Some("done"));
}

#[test]
fn extract_task_text_falls_back_to_artifacts() {
    let mut value = sample_task_json();
    value["status"]["message"] = Value::Null;
    let task: A2ATask = serde_json::from_value(value).expect("task");
    assert_eq!(extract_task_text(&task).as_deref(), Some("artifact text"));
}

#[test]
fn extract_task_text_falls_back_to_last_agent_history_entry() {
    let mut value = sample_task_json();
    value["status"]["message"] = Value::Null;
    value["artifacts"] = json!([]);
    let task: A2ATask = serde_json::from_value(value).expect("task");
    assert_eq!(extract_task_text(&task).as_deref(), Some("history reply"));
}

#[test]
fn extract_task_text_returns_none_when_nothing_matches() {
    let value = json!({"id": "task-5", "status": {"state": "TASK_STATE_WORKING"}});
    let task: A2ATask = serde_json::from_value(value).expect("task");
    assert_eq!(extract_task_text(&task), None);
}

#[test]
fn parse_send_result_accepts_wrapped_task_envelope() {
    let response = json!({"task": sample_task_json()});
    let result = parse_send_result(response).expect("wrapped task must parse");
    assert_eq!(result.task.id, "task-1");
}

#[test]
fn parse_send_result_accepts_bare_task_shape() {
    let response = sample_task_json();
    let result = parse_send_result(response).expect("bare id+status shape must parse");
    assert_eq!(result.task.id, "task-1");
}

#[test]
fn parse_send_result_accepts_result_envelope() {
    let response = json!({"result": sample_task_json()});
    let result = parse_send_result(response).expect("result-wrapped task must parse");
    assert_eq!(result.task.id, "task-1");
}

#[test]
fn parse_send_result_rejects_response_without_a_task() {
    let response = json!({"unrelated": "value"});
    let err =
        parse_send_result(response).expect_err("response without a task shape must be rejected");
    assert!(err.to_string().contains("did not include a task"), "{err}");
}

#[test]
fn state_classification_recognizes_known_terminal_states() {
    assert!(is_completed_state("COMPLETED"));
    assert!(is_completed_state("completed"));
    assert!(is_completed_state("TASK_STATE_COMPLETED"));
    assert!(is_completed_state("Succeeded"));

    assert!(is_failed_state("FAILED"));
    assert!(is_failed_state("CANCELLED"));
    assert!(is_failed_state("TASK_STATE_CANCELED"));

    assert!(is_action_required_state("INPUT_REQUIRED"));
    assert!(is_action_required_state("TASK_STATE_AUTH_REQUIRED"));

    assert!(is_terminal_state("TASK_STATE_COMPLETED"));
    assert!(is_terminal_state("FAILED"));
    assert!(is_terminal_state("INPUT_REQUIRED"));
    assert!(!is_terminal_state("TASK_STATE_WORKING"));
    assert!(!is_terminal_state("SUBMITTED"));
}

#[test]
fn state_classification_does_not_confuse_working_with_terminal() {
    assert!(!is_completed_state("WORKING"));
    assert!(!is_failed_state("WORKING"));
    assert!(!is_action_required_state("WORKING"));
}

/// KNOWN BUG (do not fix here; tests-only scope): `matches_state`'s
/// bidirectional suffix check (`candidate.ends_with("_" + normalized)`)
/// means any status string ending in `_COMPLETED`/`_FAILED`/`_REJECTED`/
/// `_AUTH_REQUIRED` is treated as a match for that terminal state,
/// regardless of a negating prefix. A peer (malicious or merely using a
/// richer status vocabulary) that reports a state like `NOT_COMPLETED` is
/// classified by `is_completed_state` as COMPLETED, and `wait_for_task`
/// would stop polling and report success. This test pins the *intended*
/// (negative) behavior and is `#[ignore]`d because it currently fails
/// against the real implementation; see the task report for the
/// standalone bug writeup.
#[test]
#[ignore = "BUG: matches_state suffix check false-positives on negated states like NOT_COMPLETED (see task report)"]
fn is_completed_state_does_not_false_positive_on_negated_state() {
    assert!(
        !is_completed_state("NOT_COMPLETED"),
        "a state literally named NOT_COMPLETED must not be classified as completed"
    );
    assert!(
        !is_failed_state("NOT_FAILED"),
        "a state literally named NOT_FAILED must not be classified as failed"
    );
    assert!(
        !is_action_required_state("NO_AUTH_REQUIRED"),
        "a state literally named NO_AUTH_REQUIRED must not be classified as action-required"
    );
}
