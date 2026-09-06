//! Surface-neutral projections for work delegated through Maestro.
//!
//! The delegated owner remains authoritative for lifecycle and control
//! availability.  This module only carries the bounded, secret-free values
//! that native, headless, and web consumers may render consistently.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Version of the shared delegation projection.
pub const DELEGATION_PROJECTION_SCHEMA_VERSION: &str = "evalops.maestro.delegation-projection.v1";
/// Namespaced metadata key owners may use to supply a delegation projection.
pub const DELEGATION_OWNER_PROJECTION_METADATA_KEY: &str = "evalops.delegationProjection";

const MAX_EVENT_ID_CHARS: usize = 256;
const MAX_SUMMARY_CHARS: usize = 512;
const MAX_REASON_CODE_CHARS: usize = 128;
const MAX_URL_CHARS: usize = 2_048;
const MAX_AVAILABLE_CONTROLS: usize = 16;

/// The user-visible reason a delegation event was emitted.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegationEventKind {
    Progress,
    NeedsAttention,
    ApprovalRequired,
    Control,
    Completion,
    Unavailable,
}

impl DelegationEventKind {
    fn parse(value: &str) -> Option<Self> {
        match normalized(value).as_str() {
            "progress" => Some(Self::Progress),
            "needs_attention" | "attention" => Some(Self::NeedsAttention),
            "approval_required" | "approval" => Some(Self::ApprovalRequired),
            "control" => Some(Self::Control),
            "completion" | "completed" => Some(Self::Completion),
            "unavailable" | "offline" => Some(Self::Unavailable),
            _ => None,
        }
    }
}

/// Owner-authoritative lifecycle state for delegated work.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegationLifecycleState {
    Queued,
    Active,
    NeedsAttention,
    ApprovalRequired,
    Paused,
    Resumed,
    Cancelled,
    Completed,
    Failed,
    Unavailable,
}

impl DelegationLifecycleState {
    /// Stable wire spelling used by native text rendering and tests.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Active => "active",
            Self::NeedsAttention => "needs_attention",
            Self::ApprovalRequired => "approval_required",
            Self::Paused => "paused",
            Self::Resumed => "resumed",
            Self::Cancelled => "cancelled",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Unavailable => "unavailable",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match normalized(value).as_str() {
            "queued" | "pending" | "submitted" => Some(Self::Queued),
            "active" | "running" | "working" | "processing" => Some(Self::Active),
            "needs_attention" | "attention" => Some(Self::NeedsAttention),
            "approval_required" | "approval" | "waiting_for_approval" => {
                Some(Self::ApprovalRequired)
            }
            "paused" => Some(Self::Paused),
            "resumed" => Some(Self::Resumed),
            "cancelled" | "canceled" => Some(Self::Cancelled),
            "completed" | "succeeded" | "success" => Some(Self::Completed),
            "failed" | "rejected" | "timed_out" | "interrupted" => Some(Self::Failed),
            "unavailable" | "offline" => Some(Self::Unavailable),
            _ => None,
        }
    }
}

/// Control operation a delegated owner may advertise or acknowledge.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegationControlAction {
    Approve,
    Steer,
    Followup,
    Collect,
    Interrupt,
    Pause,
    Resume,
    Cancel,
    Retry,
    RequestReview,
    RerunChecks,
}

impl DelegationControlAction {
    fn parse(value: &str) -> Option<Self> {
        match normalized(value).as_str() {
            "approve" | "approval" => Some(Self::Approve),
            "steer" => Some(Self::Steer),
            "followup" | "follow_up" => Some(Self::Followup),
            "collect" => Some(Self::Collect),
            "interrupt" => Some(Self::Interrupt),
            "pause" => Some(Self::Pause),
            "resume" => Some(Self::Resume),
            "cancel" | "cancelled" | "canceled" => Some(Self::Cancel),
            "retry" => Some(Self::Retry),
            "request_review" | "review" => Some(Self::RequestReview),
            "rerun_checks" | "rerun_check" => Some(Self::RerunChecks),
            _ => None,
        }
    }
}

/// State of one owner-authoritative control operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegationControlState {
    Requested,
    Accepted,
    Applied,
    Rejected,
    Unavailable,
}

impl DelegationControlState {
    fn parse(value: &str) -> Option<Self> {
        match normalized(value).as_str() {
            "requested" | "queued" => Some(Self::Requested),
            "accepted" | "acknowledged" => Some(Self::Accepted),
            "applied" | "completed" | "succeeded" => Some(Self::Applied),
            "rejected" | "failed" | "denied" => Some(Self::Rejected),
            "unavailable" | "offline" => Some(Self::Unavailable),
            _ => None,
        }
    }
}

/// One acknowledged or requested delegated control operation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationControlProjection {
    pub action: DelegationControlAction,
    pub state: DelegationControlState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

/// Bounded, surface-neutral projection of delegated work.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationEvent {
    pub schema_version: String,
    pub event_id: String,
    pub delegation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    pub kind: DelegationEventKind,
    pub lifecycle_state: DelegationLifecycleState,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_controls: Vec<DelegationControlAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<DelegationControlProjection>,
    /// Owner-provided deep link.  Maestro does not construct a replacement
    /// terminal, file, preview, or Orb workspace surface.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
}

impl DelegationEvent {
    /// Build the shared projection used by native subagent lifecycle notices.
    #[must_use]
    pub fn from_subagent_lifecycle(
        event_id: impl AsRef<str>,
        delegation_id: impl AsRef<str>,
        attempt: u32,
        status: &str,
        summary: Option<&str>,
        error: Option<&str>,
    ) -> Self {
        let status = normalized(status);
        let (kind, lifecycle_state, control) = match status.as_str() {
            "queued" | "pending" => (
                DelegationEventKind::Progress,
                DelegationLifecycleState::Queued,
                None,
            ),
            "running" | "active" | "working" => (
                DelegationEventKind::Progress,
                DelegationLifecycleState::Active,
                None,
            ),
            "paused" => (
                DelegationEventKind::Control,
                DelegationLifecycleState::Paused,
                Some(applied_control(DelegationControlAction::Pause)),
            ),
            "resumed" => (
                DelegationEventKind::Control,
                DelegationLifecycleState::Resumed,
                Some(applied_control(DelegationControlAction::Resume)),
            ),
            "completed" | "succeeded" | "success" => (
                DelegationEventKind::Completion,
                DelegationLifecycleState::Completed,
                None,
            ),
            "cancelled" | "canceled" => (
                DelegationEventKind::Control,
                DelegationLifecycleState::Cancelled,
                Some(applied_control(DelegationControlAction::Cancel)),
            ),
            "approval_required" | "waiting_for_approval" => (
                DelegationEventKind::ApprovalRequired,
                DelegationLifecycleState::ApprovalRequired,
                None,
            ),
            "unavailable" | "offline" => (
                DelegationEventKind::Unavailable,
                DelegationLifecycleState::Unavailable,
                None,
            ),
            _ => (
                DelegationEventKind::NeedsAttention,
                DelegationLifecycleState::Failed,
                None,
            ),
        };
        let fallback = match lifecycle_state {
            DelegationLifecycleState::Queued => "Delegated work is queued.",
            DelegationLifecycleState::Active | DelegationLifecycleState::Resumed => {
                "Delegated work is in progress."
            }
            DelegationLifecycleState::Paused => "Delegated work is paused.",
            DelegationLifecycleState::NeedsAttention | DelegationLifecycleState::Failed => {
                "Delegated work needs attention."
            }
            DelegationLifecycleState::ApprovalRequired => "Delegated work needs approval.",
            DelegationLifecycleState::Cancelled => "Delegated work was cancelled.",
            DelegationLifecycleState::Completed => "Delegated work completed.",
            DelegationLifecycleState::Unavailable => "Delegated work is unavailable.",
        };
        let summary = bounded_text(error.or(summary).unwrap_or(fallback), MAX_SUMMARY_CHARS);
        let delegation_id = bounded_text(delegation_id.as_ref(), MAX_EVENT_ID_CHARS);
        Self {
            schema_version: DELEGATION_PROJECTION_SCHEMA_VERSION.to_string(),
            event_id: bounded_text(event_id.as_ref(), MAX_EVENT_ID_CHARS),
            task_id: Some(delegation_id.clone()),
            delegation_id,
            attempt: Some(attempt),
            kind,
            lifecycle_state,
            summary,
            reason_code: None,
            available_controls: Vec::new(),
            control,
            open_url: None,
            occurred_at: None,
        }
    }

    /// Derive a public projection from an A2A task without exposing its raw
    /// status message or arbitrary metadata.
    #[must_use]
    pub fn from_a2a_task(task: &Value) -> Option<Self> {
        let task_id = bounded_text(task.get("id")?.as_str()?, MAX_EVENT_ID_CHARS);
        let status = task.get("status")?.as_object()?;
        let raw_state = status.get("state")?.as_str()?;
        let state_token = normalized(raw_state)
            .trim_start_matches("task_state_")
            .to_string();
        let metadata = task.get("metadata").and_then(Value::as_object);
        let owner = delegation_owner_projection(metadata);
        let fallback = a2a_fallback_projection(&state_token);
        let lifecycle_state = owner
            .and_then(|value| value.get("lifecycleState"))
            .and_then(Value::as_str)
            .and_then(DelegationLifecycleState::parse)
            .unwrap_or(fallback.1);
        let kind = owner
            .and_then(|value| value.get("kind"))
            .and_then(Value::as_str)
            .and_then(DelegationEventKind::parse)
            .or_else(|| {
                owner
                    .and_then(|value| value.get("approvalRequired"))
                    .and_then(Value::as_bool)
                    .filter(|required| *required)
                    .map(|_| DelegationEventKind::ApprovalRequired)
            })
            .unwrap_or(fallback.0);
        let delegation_id = owner
            .and_then(|value| value.get("delegationId"))
            .and_then(Value::as_str)
            .or_else(|| {
                metadata
                    .and_then(|value| value.get("delegationId"))
                    .and_then(Value::as_str)
            })
            .or_else(|| task.get("contextId").and_then(Value::as_str))
            .unwrap_or(&task_id);
        let delegation_id = bounded_text(delegation_id, MAX_EVENT_ID_CHARS);
        let timestamp = status.get("timestamp").and_then(Value::as_str);
        let event_id = owner
            .and_then(|value| value.get("eventId"))
            .and_then(Value::as_str)
            .map(|value| bounded_text(value, MAX_EVENT_ID_CHARS))
            .unwrap_or_else(|| {
                let timestamp = timestamp.unwrap_or("state");
                bounded_text(
                    &format!("{task_id}:{state_token}:{timestamp}"),
                    MAX_EVENT_ID_CHARS,
                )
            });
        let fallback_summary = match lifecycle_state {
            DelegationLifecycleState::Queued => "Delegated work is queued.",
            DelegationLifecycleState::Active | DelegationLifecycleState::Resumed => {
                "Delegated work is in progress."
            }
            DelegationLifecycleState::Paused => "Delegated work is paused.",
            DelegationLifecycleState::NeedsAttention | DelegationLifecycleState::Failed => {
                "Delegated work needs attention."
            }
            DelegationLifecycleState::ApprovalRequired => "Delegated work needs approval.",
            DelegationLifecycleState::Cancelled => "Delegated work was cancelled.",
            DelegationLifecycleState::Completed => "Delegated work completed.",
            DelegationLifecycleState::Unavailable => "Delegated work is unavailable.",
        };
        let summary = owner
            .and_then(|value| value.get("summary"))
            .and_then(Value::as_str)
            .map(|value| bounded_text(value, MAX_SUMMARY_CHARS))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback_summary.to_string());
        let reason_code = owner
            .and_then(|value| string_field(value, &["reasonCode", "reason_code"]))
            .map(|value| bounded_text(value, MAX_REASON_CODE_CHARS))
            .filter(|value| !value.is_empty());
        let available_controls = owner
            .map(|value| parse_controls(value, &["availableControls", "availableCommands"]))
            .unwrap_or_default();
        let control = owner.and_then(parse_control);
        let open_url = owner
            .and_then(|value| string_field(value, &["openUrl", "open_url"]))
            .and_then(safe_open_url);
        let attempt = owner
            .and_then(|value| value.get("attempt"))
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok());
        Some(Self {
            schema_version: DELEGATION_PROJECTION_SCHEMA_VERSION.to_string(),
            event_id,
            delegation_id,
            task_id: Some(task_id),
            attempt,
            kind,
            lifecycle_state,
            summary,
            reason_code,
            available_controls,
            control,
            open_url,
            occurred_at: timestamp.map(|value| bounded_text(value, MAX_EVENT_ID_CHARS)),
        })
    }

    /// Preserve the existing concise native lifecycle notice while deriving
    /// it from this same typed projection.
    #[must_use]
    pub fn native_summary(&self, subject: &str) -> String {
        let attempt = self
            .attempt
            .map(|value| format!(" attempt {value}"))
            .unwrap_or_default();
        format!(
            "{subject} {}{attempt} **{}**: {}",
            self.delegation_id,
            self.lifecycle_state.as_str(),
            self.summary
        )
    }

    /// Concise note injected back into the parent agent's normal context.
    #[must_use]
    pub fn native_agent_note(&self, subject: &str) -> String {
        format!(
            "{subject} {}{} finished with status {}. {}",
            self.delegation_id,
            self.attempt
                .map(|value| format!(" attempt {value}"))
                .unwrap_or_default(),
            self.lifecycle_state.as_str(),
            self.summary
        )
    }
}

fn applied_control(action: DelegationControlAction) -> DelegationControlProjection {
    DelegationControlProjection {
        action,
        state: DelegationControlState::Applied,
        id: None,
        reason_code: None,
    }
}

fn a2a_fallback_projection(state: &str) -> (DelegationEventKind, DelegationLifecycleState) {
    match state {
        "queued" | "pending" | "submitted" => (
            DelegationEventKind::Progress,
            DelegationLifecycleState::Queued,
        ),
        "working" | "running" | "active" | "processing" => (
            DelegationEventKind::Progress,
            DelegationLifecycleState::Active,
        ),
        "paused" => (
            DelegationEventKind::Control,
            DelegationLifecycleState::Paused,
        ),
        "resumed" => (
            DelegationEventKind::Control,
            DelegationLifecycleState::Resumed,
        ),
        "input_required" | "approval_required" | "waiting_for_approval" => (
            DelegationEventKind::ApprovalRequired,
            DelegationLifecycleState::ApprovalRequired,
        ),
        "completed" | "succeeded" | "success" => (
            DelegationEventKind::Completion,
            DelegationLifecycleState::Completed,
        ),
        "canceled" | "cancelled" => (
            DelegationEventKind::Control,
            DelegationLifecycleState::Cancelled,
        ),
        "failed" | "rejected" | "timed_out" | "interrupted" => (
            DelegationEventKind::NeedsAttention,
            DelegationLifecycleState::Failed,
        ),
        "needs_attention" | "attention" => (
            DelegationEventKind::NeedsAttention,
            DelegationLifecycleState::NeedsAttention,
        ),
        _ => (
            DelegationEventKind::Unavailable,
            DelegationLifecycleState::Unavailable,
        ),
    }
}

fn delegation_owner_projection(
    metadata: Option<&Map<String, Value>>,
) -> Option<&Map<String, Value>> {
    let metadata = metadata?;
    metadata
        .get("lastPlatformStatusUpdate")
        .and_then(Value::as_object)
        .and_then(|value| value.get(DELEGATION_OWNER_PROJECTION_METADATA_KEY))
        .and_then(Value::as_object)
        .or_else(|| {
            metadata
                .get(DELEGATION_OWNER_PROJECTION_METADATA_KEY)
                .and_then(Value::as_object)
        })
}

fn parse_controls(object: &Map<String, Value>, keys: &[&str]) -> Vec<DelegationControlAction> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_array))
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(DelegationControlAction::parse)
        .take(MAX_AVAILABLE_CONTROLS)
        .fold(Vec::new(), |mut controls, control| {
            if !controls.contains(&control) {
                controls.push(control);
            }
            controls
        })
}

fn parse_control(object: &Map<String, Value>) -> Option<DelegationControlProjection> {
    let control = object
        .get("control")
        .or_else(|| object.get("controlProjection"))
        .and_then(Value::as_object)?;
    Some(DelegationControlProjection {
        action: string_field(control, &["action", "mode"])
            .and_then(DelegationControlAction::parse)?,
        state: string_field(control, &["state", "status"])
            .and_then(DelegationControlState::parse)?,
        id: string_field(control, &["id", "controlId", "control_id"])
            .map(|value| bounded_text(value, MAX_EVENT_ID_CHARS))
            .filter(|value| !value.is_empty()),
        reason_code: string_field(control, &["reasonCode", "reason_code", "reason"])
            .map(|value| bounded_text(value, MAX_REASON_CODE_CHARS))
            .filter(|value| !value.is_empty()),
    })
}

fn string_field<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn safe_open_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.chars().count() > MAX_URL_CHARS
        || value.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
    {
        return None;
    }
    let remainder = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("orb://"))?;
    let authority = remainder.split('/').next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some(value.to_string())
}

fn normalized(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("TASK_STATE_")
        .chars()
        .map(|value| {
            if value == '-' || value.is_ascii_whitespace() {
                '_'
            } else {
                value.to_ascii_lowercase()
            }
        })
        .collect()
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value
        .trim()
        .replace(['\r', '\n'], " ")
        .chars()
        .take(max_chars)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subagent_lifecycle_uses_one_typed_projection_for_native_rendering() {
        let event = DelegationEvent::from_subagent_lifecycle(
            "mailbox-1",
            "child-1",
            2,
            "completed",
            Some("done"),
            None,
        );

        assert_eq!(event.kind, DelegationEventKind::Completion);
        assert_eq!(event.lifecycle_state, DelegationLifecycleState::Completed);
        assert_eq!(
            event.native_summary("Subagent"),
            "Subagent child-1 attempt 2 **completed**: done"
        );
        assert_eq!(
            event.native_agent_note("Subagent"),
            "Subagent child-1 attempt 2 finished with status completed. done"
        );
    }

    #[test]
    fn a2a_projection_preserves_owner_controls_and_excludes_untrusted_metadata() {
        let task = serde_json::json!({
            "id": "task-1",
            "contextId": "delegation-1",
            "status": {
                "state": "TASK_STATE_INPUT_REQUIRED",
                "timestamp": "2026-08-20T00:00:00Z",
                "message": {"parts": [{"text": "do not expose"}]}
            },
            "metadata": {
                "lastPlatformStatusUpdate": {
                    "unrelated": "owner-metadata",
                    "evalops.delegationProjection": {
                        "eventId": "event-1",
                        "delegationId": "delegation-1",
                        "kind": "approval_required",
                        "lifecycleState": "needs_attention",
                        "summary": "Approval is needed.",
                        "reasonCode": "approval_required",
                        "availableControls": ["steer", "pause", "pause", "cancel", "unknown"],
                        "control": {"action": "pause", "state": "accepted", "controlId": "control-1"},
                        "openUrl": "https://orb.example/tasks/task-1"
                    }
                }
            }
        });

        let event = DelegationEvent::from_a2a_task(&task).expect("task projection");
        assert_eq!(
            event.lifecycle_state,
            DelegationLifecycleState::NeedsAttention
        );
        assert_eq!(event.available_controls.len(), 3);
        assert_eq!(
            event
                .control
                .as_ref()
                .and_then(|control| control.id.as_deref()),
            Some("control-1")
        );
        assert_eq!(
            event.open_url.as_deref(),
            Some("https://orb.example/tasks/task-1")
        );
        let encoded = serde_json::to_string(&event).expect("projection serializes");
        assert!(!encoded.contains("owner-metadata"));
        assert!(!encoded.contains("do not expose"));
    }

    #[test]
    fn a2a_projection_makes_unavailable_and_cancelled_states_explicit() {
        for (state, expected_kind, expected_lifecycle) in [
            (
                "TASK_STATE_CANCELED",
                DelegationEventKind::Control,
                DelegationLifecycleState::Cancelled,
            ),
            (
                "TASK_STATE_OFFLINE",
                DelegationEventKind::Unavailable,
                DelegationLifecycleState::Unavailable,
            ),
        ] {
            let task = serde_json::json!({
                "id": "task-1",
                "status": {"state": state},
            });
            let event = DelegationEvent::from_a2a_task(&task).expect("task projection");
            assert_eq!(event.kind, expected_kind);
            assert_eq!(event.lifecycle_state, expected_lifecycle);
        }
    }
}
