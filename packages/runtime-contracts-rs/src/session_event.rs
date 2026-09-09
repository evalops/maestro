//! Privacy-safe, transport-neutral session lifecycle telemetry.

use serde::{Deserialize, Serialize};

/// Custom session-entry namespace used while older readers still need to
/// ignore the additive telemetry safely.
pub const SESSION_EVENT_CUSTOM_TYPE: &str = "session_event_v1";

/// Stable schema identity for the payload stored in a custom session entry.
pub const SESSION_EVENT_SCHEMA: &str = "evalops.maestro.session-event.v1";

/// A content-free lifecycle boundary suitable for persistence and display.
///
/// Raw prompts, tool arguments, and tool output never belong in this record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub schema_version: String,
    pub event_id: String,
    pub timestamp: String,
    pub session_id: String,
    pub lane: SessionEventLane,
    pub kind: String,
    pub phase: SessionEventPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automatic: Option<bool>,
}

impl SessionEvent {
    #[must_use]
    pub fn new(
        event_id: impl Into<String>,
        timestamp: impl Into<String>,
        session_id: impl Into<String>,
        lane: SessionEventLane,
        kind: impl Into<String>,
        phase: SessionEventPhase,
    ) -> Self {
        Self {
            schema_version: SESSION_EVENT_SCHEMA.to_string(),
            event_id: event_id.into(),
            timestamp: timestamp.into(),
            session_id: session_id.into(),
            lane,
            kind: kind.into(),
            phase,
            correlation_id: None,
            name: None,
            attempt: None,
            delay_ms: None,
            duration_ms: None,
            automatic: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEventLane {
    User,
    Runtime,
    Model,
    Tools,
    Worker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEventPhase {
    Requested,
    Started,
    Progress,
    Completed,
    Failed,
    Cancelled,
    Info,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_event_is_content_free_and_stable() {
        let mut event = SessionEvent::new(
            "event-1",
            "2026-09-08T00:00:00Z",
            "session-1",
            SessionEventLane::Tools,
            "tool.started",
            SessionEventPhase::Started,
        );
        event.correlation_id = Some("call-1".into());
        event.name = Some("bash".into());
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["schemaVersion"], SESSION_EVENT_SCHEMA);
        assert_eq!(json["lane"], "tools");
        assert_eq!(json["kind"], "tool.started");
        assert!(json.get("args").is_none());
        assert!(json.get("output").is_none());
    }
}
