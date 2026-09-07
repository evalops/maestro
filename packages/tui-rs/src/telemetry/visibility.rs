//! Content-free configuration acceptance and explicitly submitted categorical feedback.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationOrigin {
    Unmanaged,
    Fetched,
    FreshCache,
    StaleCache,
    FailedClosed,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisibilityMcpPolicy {
    Open,
    Allowlist,
    Denylist,
    Unspecified,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpUnavailableReason {
    None,
    Policy,
    ConfigurationMissing,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationReceipt {
    pub revision: Option<u64>,
    pub origin: ConfigurationOrigin,
    pub age_seconds: Option<u64>,
    pub fallback_used: bool,
    pub mcp_policy: VisibilityMcpPolicy,
    /// True only when the accepted policy refuses every MCP server.
    /// False does not certify that any server is configured or healthy.
    pub mcp_unavailable: bool,
    pub mcp_unavailable_reason: McpUnavailableReason,
}
impl ConfigurationReceipt {
    pub fn from_managed_setup(client: &crate::managed_setup::ManagedSetupClient, now: i64) -> Self {
        use crate::managed_setup::{ManagedSetupOrigin as O, McpPolicyMode as M};
        let origin = match client.origin() {
            O::Unmanaged => ConfigurationOrigin::Unmanaged,
            O::Fetched if client.served_from_cache() => ConfigurationOrigin::FreshCache,
            O::Fetched => ConfigurationOrigin::Fetched,
            O::Cache => ConfigurationOrigin::StaleCache,
            O::FailedClosed => ConfigurationOrigin::FailedClosed,
        };
        let mcp_policy = match client.mcp_policy().mode {
            M::Open => VisibilityMcpPolicy::Open,
            M::Allowlist => VisibilityMcpPolicy::Allowlist,
            M::Denylist => VisibilityMcpPolicy::Denylist,
            M::Unspecified => VisibilityMcpPolicy::Unspecified,
        };
        let unavailable = matches!(
            mcp_policy,
            VisibilityMcpPolicy::Allowlist | VisibilityMcpPolicy::Unspecified
        ) && client.mcp_policy().servers.is_empty();
        Self {
            revision: (!matches!(
                origin,
                ConfigurationOrigin::Unmanaged | ConfigurationOrigin::FailedClosed
            ))
            .then(|| client.version()),
            origin,
            age_seconds: client.age_seconds(now),
            fallback_used: origin == ConfigurationOrigin::StaleCache,
            mcp_policy,
            mcp_unavailable: unavailable,
            mcp_unavailable_reason: if origin == ConfigurationOrigin::FailedClosed {
                McpUnavailableReason::ConfigurationMissing
            } else if unavailable {
                McpUnavailableReason::Policy
            } else {
                McpUnavailableReason::None
            },
        }
    }
    fn valid(&self) -> bool {
        let document = !matches!(
            self.origin,
            ConfigurationOrigin::Unmanaged | ConfigurationOrigin::FailedClosed
        );
        self.revision
            .is_none_or(|value| i64::try_from(value).is_ok())
            && self
                .age_seconds
                .is_none_or(|value| u32::try_from(value).is_ok())
            && document == self.revision.is_some()
            && (document || self.age_seconds.is_none())
            && self.fallback_used == (self.origin == ConfigurationOrigin::StaleCache)
            && self.mcp_unavailable == (self.mcp_unavailable_reason != McpUnavailableReason::None)
            && (self.origin != ConfigurationOrigin::FailedClosed
                || self.mcp_unavailable_reason == McpUnavailableReason::ConfigurationMissing)
            && (self.mcp_unavailable_reason != McpUnavailableReason::ConfigurationMissing
                || self.origin == ConfigurationOrigin::FailedClosed)
            && (!self.mcp_unavailable
                || matches!(
                    self.mcp_policy,
                    VisibilityMcpPolicy::Allowlist | VisibilityMcpPolicy::Unspecified
                ))
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackRating {
    Useful,
    PartlyUseful,
    NotUseful,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FeedbackReceipt {
    pub rating: FeedbackRating,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum VisibilityKind {
    Configuration,
    Feedback,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
enum VisibilityEventType {
    #[serde(rename = "visibility")]
    Visibility,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisibilityEvent {
    schema_version: u16,
    pub(super) event_id: Uuid,
    #[serde(rename = "type")]
    event_type: VisibilityEventType,
    timestamp: String,
    kind: VisibilityKind,
    configuration: Option<ConfigurationReceipt>,
    feedback: Option<FeedbackReceipt>,
}
impl VisibilityEvent {
    pub fn configuration(receipt: ConfigurationReceipt) -> Self {
        Self::new(VisibilityKind::Configuration, Some(receipt), None)
    }
    pub fn feedback(rating: FeedbackRating) -> Self {
        Self::new(
            VisibilityKind::Feedback,
            None,
            Some(FeedbackReceipt { rating }),
        )
    }
    fn new(
        kind: VisibilityKind,
        configuration: Option<ConfigurationReceipt>,
        feedback: Option<FeedbackReceipt>,
    ) -> Self {
        Self {
            schema_version: 1,
            event_id: Uuid::new_v4(),
            event_type: VisibilityEventType::Visibility,
            timestamp: chrono::Utc::now().to_rfc3339(),
            kind,
            configuration,
            feedback,
        }
    }
    pub(crate) fn is_feedback(&self) -> bool {
        self.kind == VisibilityKind::Feedback
    }

    pub fn is_server_valid(&self) -> bool {
        self.schema_version == 1
            && !self.event_id.is_nil()
            && self.timestamp.len() <= 64
            && chrono::DateTime::parse_from_rfc3339(&self.timestamp).is_ok()
            && match self.kind {
                VisibilityKind::Configuration => {
                    self.feedback.is_none()
                        && self
                            .configuration
                            .as_ref()
                            .is_some_and(ConfigurationReceipt::valid)
                }
                VisibilityKind::Feedback => self.configuration.is_none() && self.feedback.is_some(),
            }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixture_and_closed_schema() {
        let value: serde_json::Value =
            serde_json::from_str(include_str!("visibility_fixture.json")).unwrap();
        let event: VisibilityEvent = serde_json::from_value(value.clone()).unwrap();
        assert!(event.is_server_valid());
        assert_eq!(serde_json::to_value(event).unwrap(), value);
        let mut extra = value.clone();
        extra["prompt"] = "private".into();
        assert!(serde_json::from_value::<VisibilityEvent>(extra).is_err());
        let mut mixed = value;
        mixed["feedback"] = serde_json::json!({"rating":"useful"});
        assert!(
            !serde_json::from_value::<VisibilityEvent>(mixed)
                .unwrap()
                .is_server_valid()
        );
        assert!(VisibilityEvent::feedback(FeedbackRating::Useful).is_server_valid());
    }
    #[test]
    fn unmanaged_has_no_fabricated_revision_or_age() {
        let receipt = ConfigurationReceipt::from_managed_setup(
            &crate::managed_setup::ManagedSetupClient::unmanaged(),
            100,
        );
        assert!(receipt.revision.is_none());
        assert!(receipt.age_seconds.is_none());
        assert!(!receipt.mcp_unavailable);
        assert!(receipt.valid());
    }
    #[test]
    fn receipts_follow_actual_resolution_and_fail_closed_policy() {
        use crate::managed_setup::{
            ManagedSetup, ManagedSetupClient, ManagedSetupError, McpPolicy,
        };
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("setup.json");
        let session = crate::credential_mode::PlatformSession {
            access_token: "fixture".into(),
            organization_id: "org".into(),
            workspace_id: Some("workspace".into()),
            provider_ref: serde_json::Value::Null,
            email: None,
            user_id: None,
        };
        let resolve = |now, fail| {
            ManagedSetupClient::resolve_with(
                Some(&session),
                Some(&cache),
                now,
                std::time::Duration::from_mins(1),
                |_| {
                    if fail {
                        Err(ManagedSetupError::NotConfigured)
                    } else {
                        Ok(ManagedSetup {
                            organization_id: "org".into(),
                            workspace_id: "workspace".into(),
                            version: 7,
                            mcp: McpPolicy::deny_all(),
                            ..Default::default()
                        })
                    }
                },
            )
        };
        let closed = ConfigurationReceipt::from_managed_setup(&resolve(1000, true), 1000);
        assert_eq!(closed.origin, ConfigurationOrigin::FailedClosed);
        assert_eq!(
            closed.mcp_unavailable_reason,
            McpUnavailableReason::ConfigurationMissing
        );
        assert!(closed.revision.is_none());
        assert!(closed.valid());
        let fetched = ConfigurationReceipt::from_managed_setup(&resolve(1000, false), 1000);
        assert_eq!(fetched.origin, ConfigurationOrigin::Fetched);
        assert_eq!(fetched.age_seconds, Some(0));
        assert_eq!(fetched.revision, Some(7));
        let fresh = ConfigurationReceipt::from_managed_setup(&resolve(1010, true), 1010);
        assert_eq!(fresh.origin, ConfigurationOrigin::FreshCache);
        assert_eq!(fresh.age_seconds, Some(10));
        assert!(!fresh.fallback_used);
        let stale = ConfigurationReceipt::from_managed_setup(&resolve(1100, true), 1100);
        assert_eq!(stale.origin, ConfigurationOrigin::StaleCache);
        assert_eq!(stale.age_seconds, Some(100));
        assert!(stale.fallback_used);
        assert_eq!(stale.mcp_unavailable_reason, McpUnavailableReason::Policy);
        assert!(stale.valid());
        let mut oversized = stale;
        oversized.revision = Some(u64::MAX);
        assert!(!oversized.valid());
        oversized.revision = Some(7);
        oversized.age_seconds = Some(u64::MAX);
        assert!(!oversized.valid());
    }
}
