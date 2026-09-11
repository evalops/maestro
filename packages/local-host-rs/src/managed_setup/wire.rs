//! Bounded native projection of proto/console/v1/console.proto, matching the
//! existing bug_report adapter. Field tags follow that authoritative contract;
//! enum conversion below rejects unknown policy values rather than widening access.
use super::ManagedSetupError;
use prost::Message;

#[derive(Clone, PartialEq, Message)]
pub(super) struct GetManagedSetupRequest {
    #[prost(string, tag = "1")]
    pub organization_id: String,
    #[prost(string, tag = "2")]
    pub workspace_id: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ManagedSetup {
    #[prost(uint64, tag = "1")]
    pub version: u64,
    #[prost(message, optional, tag = "2")]
    pub issued_at: Option<prost_types::Timestamp>,
    #[prost(message, repeated, tag = "3")]
    pub rules: Vec<ManagedRule>,
    #[prost(message, repeated, tag = "4")]
    pub skills: Vec<ManagedSkillRef>,
    #[prost(message, optional, tag = "5")]
    pub mcp: Option<McpPolicy>,
    #[prost(string, tag = "6")]
    pub sandbox_policy_toml: String,
    #[prost(string, tag = "7")]
    pub organization_id: String,
    #[prost(string, tag = "8")]
    pub workspace_id: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ManagedRule {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub title: String,
    #[prost(string, tag = "3")]
    pub body_markdown: String,
    #[prost(int32, tag = "4")]
    pub scope: i32,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ManagedSkillRef {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub source: String,
    #[prost(string, tag = "3")]
    pub version: String,
    #[prost(bool, tag = "4")]
    pub required: bool,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct McpPolicy {
    #[prost(int32, tag = "1")]
    pub mode: i32,
    #[prost(message, repeated, tag = "2")]
    pub servers: Vec<McpServerRef>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct McpServerRef {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(string, tag = "2")]
    pub url_pattern: String,
    #[prost(string, tag = "3")]
    pub transport: String,
}

impl ManagedSetup {
    pub(super) fn try_into_domain(self) -> Result<super::ManagedSetup, ManagedSetupError> {
        let issued_at = self
            .issued_at
            .map(|value| {
                if !(-62_135_596_800..=253_402_300_799).contains(&value.seconds)
                    || !(0..1_000_000_000).contains(&value.nanos)
                {
                    return Err(ManagedSetupError::Decode(
                        "invalid managed setup timestamp".to_owned(),
                    ));
                }
                Ok(super::ManagedSetupTimestamp {
                    seconds: value.seconds,
                    nanos: value.nanos,
                })
            })
            .transpose()?;
        let rules = self
            .rules
            .into_iter()
            .map(|rule| {
                let scope = match rule.scope {
                    0 | 1 => super::RuleScope::Organization,
                    2 => super::RuleScope::Workspace,
                    _ => {
                        return Err(ManagedSetupError::Decode(
                            "unknown managed rule scope".to_owned(),
                        ));
                    }
                };
                Ok(super::ManagedRule {
                    id: rule.id,
                    title: rule.title,
                    body_markdown: rule.body_markdown,
                    scope,
                })
            })
            .collect::<Result<Vec<_>, ManagedSetupError>>()?;
        let mcp = self.mcp.unwrap_or_default();
        let mode = match mcp.mode {
            0 => super::McpPolicyMode::Unspecified,
            1 => super::McpPolicyMode::Open,
            2 => super::McpPolicyMode::Allowlist,
            3 => super::McpPolicyMode::Denylist,
            _ => {
                return Err(ManagedSetupError::Decode(
                    "unknown managed MCP policy mode".to_owned(),
                ));
            }
        };
        Ok(super::ManagedSetup {
            version: self.version,
            issued_at,
            organization_id: self.organization_id,
            workspace_id: self.workspace_id,
            rules,
            skills: self
                .skills
                .into_iter()
                .map(|skill| super::ManagedSkillRef {
                    id: skill.id,
                    source: skill.source,
                    version: skill.version,
                    required: skill.required,
                })
                .collect(),
            mcp: super::McpPolicy {
                mode,
                servers: mcp
                    .servers
                    .into_iter()
                    .map(|server| super::McpServerRef {
                        name: server.name,
                        url_pattern: server.url_pattern,
                        transport: server.transport,
                    })
                    .collect(),
            },
            sandbox_policy_toml: self.sandbox_policy_toml,
        })
    }
}
