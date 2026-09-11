//! Closed, content-free onboarding information. No screen or terminal capture.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A finite milestone in one walkthrough.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingStage {
    Started,
    ProfileSaved,
    ConnectionSaved,
    ChecksCompleted,
    Completed,
    Dismissed,
}
/// Optional self-reported role category.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingRole {
    Developer,
    Platform,
    Product,
    Other,
}
/// Optional first-task category.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingUseCase {
    Build,
    Fix,
    Review,
    Explore,
}
/// Intended usage surface; it does not select a runtime.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingWorkflow {
    Interactive,
    Headless,
    Hosted,
}
/// Optional fixed-choice answers; absent fields mean skipped.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OnboardingProfile {
    pub role: Option<OnboardingRole>,
    pub use_case: Option<OnboardingUseCase>,
    pub workflow: Option<OnboardingWorkflow>,
}
/// Stable identifiers for the bounded readiness checks.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingCheckId {
    Config,
    Identity,
    Provider,
    Model,
    ManagedSetup,
    Workspace,
    ModelProbe,
    ToolProbe,
}
impl OnboardingCheckId {
    /// Return the stable wire label used in local result displays.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Identity => "identity",
            Self::Provider => "provider",
            Self::Model => "model",
            Self::ManagedSetup => "managed_setup",
            Self::Workspace => "workspace",
            Self::ModelProbe => "model_probe",
            Self::ToolProbe => "tool_probe",
        }
    }
}
pub use crate::doctor::CheckStatus as OnboardingCheckStatus;
/// Content-free outcome projected from a local check.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OnboardingCheckResult {
    pub id: OnboardingCheckId,
    pub status: OnboardingCheckStatus,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
enum OnboardingEventType {
    #[serde(rename = "onboarding")]
    Onboarding,
}
/// Closed wire event sent through authenticated first-party telemetry.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OnboardingEvent {
    schema_version: u16,
    pub(super) event_id: Uuid,
    attempt_id: Uuid,
    #[serde(rename = "type")]
    event_type: OnboardingEventType,
    timestamp: String,
    stage: OnboardingStage,
    profile: OnboardingProfile,
    elapsed_ms: u64,
    checks: Vec<OnboardingCheckResult>,
    retry_count: u32,
}
impl OnboardingEvent {
    /// Create a fresh delivery event correlated to the supplied walkthrough.
    pub fn new(
        attempt_id: Uuid,
        stage: OnboardingStage,
        profile: OnboardingProfile,
        elapsed_ms: u64,
        checks: Vec<OnboardingCheckResult>,
        retry_count: u32,
    ) -> Self {
        Self {
            schema_version: 1,
            event_id: Uuid::new_v4(),
            attempt_id,
            event_type: OnboardingEventType::Onboarding,
            timestamp: chrono::Utc::now().to_rfc3339(),
            stage,
            profile,
            elapsed_ms,
            checks,
            retry_count,
        }
    }
    pub(super) fn is_server_valid(&self) -> bool {
        self.schema_version == 1
            && chrono::DateTime::parse_from_rfc3339(&self.timestamp).is_ok()
            && self.elapsed_ms <= 86_400_000
            && self.retry_count <= 1_000
            && self.checks.len() <= 8
            && self.checks.iter().enumerate().all(|(index, check)| {
                !self.checks[..index]
                    .iter()
                    .any(|prior| prior.id == check.id)
            })
    }
}
/// Queued means durably retained for delivery, not accepted by Platform yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnboardingCollectionStatus {
    Queued,
    Disabled,
    Unavailable,
    Failed,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn onboarding_fixture_matches_ingress_contract() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tui-rs/src/telemetry/onboarding_fixture.json"
        ))
        .unwrap();
        let event: OnboardingEvent = serde_json::from_value(fixture.clone()).unwrap();
        assert!(event.is_server_valid());
        assert_eq!(serde_json::to_value(event).unwrap(), fixture);
    }
    #[test]
    fn onboarding_rejects_content_and_unbounded_metrics() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tui-rs/src/telemetry/onboarding_fixture.json"
        ))
        .unwrap();
        for pointer in ["/profile/role", "/checks/0/id", "/checks/0/status"] {
            let mut value = fixture.clone();
            *value.pointer_mut(pointer).unwrap() = serde_json::json!("private text");
            assert!(serde_json::from_value::<OnboardingEvent>(value).is_err());
        }
        let mut value = fixture.clone();
        value["profile"]["email"] = serde_json::json!("private text");
        assert!(serde_json::from_value::<OnboardingEvent>(value).is_err());
        let mut event: OnboardingEvent = serde_json::from_value(fixture).unwrap();
        event.elapsed_ms = 86_400_001;
        assert!(!event.is_server_valid());
        event.elapsed_ms = 1;
        event.checks[1].id = event.checks[0].id;
        assert!(!event.is_server_valid());
    }
}
