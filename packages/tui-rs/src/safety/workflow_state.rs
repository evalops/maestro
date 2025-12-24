//! Workflow state tracking for PII redaction and tool-tag egress policy.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStateSnapshot {
    pub pending_pii: Vec<PendingPiiEntry>,
    pub orphaned_redactions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPiiEntry {
    pub id: String,
    pub label: String,
    pub source_tool_call_id: String,
    pub redacted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parents: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
struct PiiArtifactRecord {
    label: String,
    source_tool_call_id: String,
    parents: Option<Vec<String>>,
}

#[derive(Debug)]
pub struct WorkflowStateError {
    pub message: String,
}

impl std::fmt::Display for WorkflowStateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for WorkflowStateError {}

#[derive(Debug, Default)]
pub struct WorkflowStateTracker {
    pending_pii: HashMap<String, PiiArtifactRecord>,
    orphaned_redactions: HashSet<String>,
}

impl WorkflowStateTracker {
    pub fn reset(&mut self) {
        self.pending_pii.clear();
        self.orphaned_redactions.clear();
    }

    pub fn snapshot(&self) -> WorkflowStateSnapshot {
        WorkflowStateSnapshot {
            pending_pii: self
                .pending_pii
                .iter()
                .map(|(id, record)| PendingPiiEntry {
                    id: id.clone(),
                    label: record.label.clone(),
                    source_tool_call_id: record.source_tool_call_id.clone(),
                    redacted: false,
                    parents: record.parents.clone(),
                })
                .collect(),
            orphaned_redactions: self.orphaned_redactions.iter().cloned().collect(),
        }
    }

    pub fn note_pii_capture(&mut self, params: PiiCaptureParams) {
        let label = if params.label.is_empty() {
            params.artifact_id.clone()
        } else {
            params.label
        };
        self.pending_pii.insert(
            params.artifact_id.clone(),
            PiiArtifactRecord {
                label,
                source_tool_call_id: params.source_tool_call_id,
                parents: params.parents,
            },
        );
        self.orphaned_redactions.remove(&params.artifact_id);
    }

    pub fn note_redaction(&mut self, params: RedactionParams) -> Result<bool, WorkflowStateError> {
        let removed = self.pending_pii.remove(&params.artifact_id).is_some();
        if !removed {
            self.orphaned_redactions.insert(params.artifact_id.clone());
            if !params.allow_missing {
                return Err(WorkflowStateError {
                    message: format!(
                        "Attempted to redact unknown artifact \"{}\". Ensure collect and redact tooling share artifact ids.",
                        params.artifact_id
                    ),
                });
            }
        }
        Ok(removed)
    }

    pub fn find_artifact_id_by_label(&self, label: &str) -> Option<String> {
        self.pending_pii
            .iter()
            .find(|(_, record)| record.label == label)
            .map(|(id, _)| id.clone())
    }

    pub fn get_singleton_pending_artifact_id(&self) -> Option<String> {
        if self.pending_pii.len() == 1 {
            return self.pending_pii.keys().next().cloned();
        }
        None
    }

    pub fn pending_summaries(&self) -> Vec<(String, String)> {
        self.pending_pii
            .iter()
            .map(|(id, record)| (id.clone(), record.label.clone()))
            .collect()
    }
}

#[derive(Debug)]
pub struct PiiCaptureParams {
    pub artifact_id: String,
    pub label: String,
    pub source_tool_call_id: String,
    pub parents: Option<Vec<String>>,
}

#[derive(Debug)]
pub struct RedactionParams {
    pub artifact_id: String,
    pub allow_missing: bool,
}

pub fn is_workflow_tracked_tool(tool_name: &str) -> bool {
    matches!(tool_name, "collect_customer_context" | "redact_transcript")
}

pub fn apply_workflow_state_hooks(
    tool_name: &str,
    tool_call_id: &str,
    args: &serde_json::Value,
    tracker: &mut WorkflowStateTracker,
    is_error: bool,
) -> Result<(), WorkflowStateError> {
    if is_error {
        return Ok(());
    }

    match tool_name {
        "collect_customer_context" => {
            let subject = args
                .get("subject")
                .and_then(|v| v.as_str())
                .unwrap_or(tool_call_id);
            let parents = args.get("parents").and_then(|v| {
                v.as_array().map(|items| {
                    items
                        .iter()
                        .filter_map(|entry| entry.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
            });
            tracker.note_pii_capture(PiiCaptureParams {
                artifact_id: tool_call_id.to_string(),
                label: subject.to_string(),
                source_tool_call_id: tool_call_id.to_string(),
                parents,
            });
        }
        "redact_transcript" => {
            let allow_missing = args
                .get("allowMissing")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let artifact_id = args
                .get("artifactId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let subject_hint = args.get("subject").and_then(|v| v.as_str()).and_then(|s| {
                if s.is_empty() {
                    None
                } else {
                    Some(s.to_string())
                }
            });

            let resolved = artifact_id
                .or_else(|| {
                    subject_hint
                        .as_deref()
                        .and_then(|label| tracker.find_artifact_id_by_label(label))
                })
                .or_else(|| tracker.get_singleton_pending_artifact_id());

            if let Some(id) = resolved {
                tracker.note_redaction(RedactionParams {
                    artifact_id: id,
                    allow_missing,
                })?;
            } else if allow_missing {
                tracker.note_redaction(RedactionParams {
                    artifact_id: "unknown".to_string(),
                    allow_missing: true,
                })?;
            } else {
                let pending = tracker
                    .pending_summaries()
                    .iter()
                    .map(|(id, label)| format!("{} ({})", label, id))
                    .collect::<Vec<_>>()
                    .join(", ");
                let message = if let Some(subject) = subject_hint {
                    format!(
                        "redact_transcript could not find an artifact for subject \"{}\". Pending artifacts: {}",
                        subject,
                        if pending.is_empty() { "none".to_string() } else { pending }
                    )
                } else {
                    format!(
                        "redact_transcript could not determine which artifact to redact; provide artifactId or subject. Pending artifacts: {}",
                        if pending.is_empty() { "none".to_string() } else { pending }
                    )
                };
                return Err(WorkflowStateError { message });
            }
        }
        _ => {}
    }

    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolEgress {
    Human,
    External,
    Internal,
}

#[derive(Debug, Clone, Copy)]
pub struct ToolTag {
    pub egress: Option<ToolEgress>,
}

pub static TOOL_TAGS: Lazy<HashMap<&'static str, ToolTag>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "handoff_to_human",
        ToolTag {
            egress: Some(ToolEgress::Human),
        },
    );
    map.insert(
        "send_email_update",
        ToolTag {
            egress: Some(ToolEgress::External),
        },
    );
    map.insert(
        "post_customer_update",
        ToolTag {
            egress: Some(ToolEgress::External),
        },
    );
    map.insert(
        "notify_account_team",
        ToolTag {
            egress: Some(ToolEgress::Human),
        },
    );
    map
});

static UNTAGGED_EGRESS_WARNINGS: Lazy<Mutex<HashSet<String>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

pub fn looks_like_egress(tool_name: &str) -> bool {
    let lower = tool_name.to_lowercase();
    lower.contains("handoff")
        || lower.contains("send_")
        || lower.contains("email")
        || lower.contains("notify")
        || lower.contains("escalate")
}

/// Check if a tool requires PII gating before execution.
/// Returns true for tools with Human or External egress, as both can leak PII.
pub fn is_human_facing_tool(tool_name: &str) -> bool {
    if let Some(tag) = TOOL_TAGS.get(tool_name) {
        // Both Human and External egress tools must be gated for PII
        return matches!(
            tag.egress,
            Some(ToolEgress::Human) | Some(ToolEgress::External)
        );
    }
    if looks_like_egress(tool_name) {
        if let Ok(mut seen) = UNTAGGED_EGRESS_WARNINGS.lock() {
            if seen.insert(tool_name.to_string()) {
                eprintln!(
                    "[safety] Untagged egress-like tool encountered; treating as human-facing: {}",
                    tool_name
                );
            }
        }
        return true;
    }
    false
}

pub fn has_tool_tags(tool_name: &str) -> bool {
    TOOL_TAGS.contains_key(tool_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_human_facing_tool_with_human_egress() {
        // Tools tagged with Human egress should be gated
        assert!(is_human_facing_tool("handoff_to_human"));
        assert!(is_human_facing_tool("notify_account_team"));
    }

    #[test]
    fn test_is_human_facing_tool_with_external_egress() {
        // Tools tagged with External egress should also be gated (PII leak risk)
        assert!(is_human_facing_tool("send_email_update"));
        assert!(is_human_facing_tool("post_customer_update"));
    }

    #[test]
    fn test_is_human_facing_tool_untagged_egress_like() {
        // Untagged tools that look like egress should be treated as human-facing
        assert!(is_human_facing_tool("send_notification"));
        assert!(is_human_facing_tool("email_customer"));
        assert!(is_human_facing_tool("escalate_issue"));
    }

    #[test]
    fn test_is_human_facing_tool_safe_tools() {
        // Regular tools should not be gated
        assert!(!is_human_facing_tool("read"));
        assert!(!is_human_facing_tool("write"));
        assert!(!is_human_facing_tool("bash"));
    }

    #[test]
    fn test_tool_egress_types_in_registry() {
        // Verify the registry has correct egress types
        let handoff = TOOL_TAGS.get("handoff_to_human").unwrap();
        assert_eq!(handoff.egress, Some(ToolEgress::Human));

        let email = TOOL_TAGS.get("send_email_update").unwrap();
        assert_eq!(email.egress, Some(ToolEgress::External));

        let post = TOOL_TAGS.get("post_customer_update").unwrap();
        assert_eq!(post.egress, Some(ToolEgress::External));
    }

    #[test]
    fn test_workflow_state_tracker_basic() {
        let mut tracker = WorkflowStateTracker::default();

        // Capture PII
        tracker.note_pii_capture(PiiCaptureParams {
            artifact_id: "artifact-1".to_string(),
            label: "customer_data".to_string(),
            source_tool_call_id: "call-1".to_string(),
            parents: None,
        });

        let snapshot = tracker.snapshot();
        assert_eq!(snapshot.pending_pii.len(), 1);
        assert_eq!(snapshot.pending_pii[0].id, "artifact-1");

        // Redact PII
        let result = tracker.note_redaction(RedactionParams {
            artifact_id: "artifact-1".to_string(),
            allow_missing: false,
        });
        assert!(result.is_ok());
        assert!(result.unwrap());

        let snapshot = tracker.snapshot();
        assert!(snapshot.pending_pii.is_empty());
    }
}
