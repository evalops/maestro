use crate::codex_subagent_dispatch::{CodexSubagentDispatchLane, CODEX_SUBAGENT_DISPATCH_LANES};
use serde_json::Value;

pub(crate) const A2A_SUBAGENT_KIND: &str = "maestro-subagent";
pub(crate) const A2A_SUBAGENT_REQUEST_METADATA_PATH: &str = "evalops.subagentRequest";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct A2ASubagentSkillContract {
    pub(crate) lane_id: &'static str,
    pub(crate) required_context_grants: &'static [&'static str],
    pub(crate) required_artifact_kinds: &'static [&'static str],
    pub(crate) optional_artifact_kinds: &'static [&'static str],
    pub(crate) allowed_task_classes: &'static [&'static str],
    pub(crate) denied_task_classes: &'static [&'static str],
}

const DENIED_TARGET_TASK_CLASSES: &[&str] = &[
    "credential.materialization",
    "secret.exfiltration",
    "unbounded.repository.write",
];

pub(crate) fn a2a_subagent_skill_contract(lane_id: &str) -> A2ASubagentSkillContract {
    match lane_id {
        "code-writer" => A2ASubagentSkillContract {
            lane_id: "code-writer",
            required_context_grants: &["repo:read", "repo:write-scoped", "tool:execute-tests"],
            required_artifact_kinds: &["patch.summary"],
            optional_artifact_kinds: &["test.report", "review.summary"],
            allowed_task_classes: &["code.implementation", "code.refactor"],
            denied_task_classes: DENIED_TARGET_TASK_CLASSES,
        },
        "code-review" => A2ASubagentSkillContract {
            lane_id: "code-review",
            required_context_grants: &["repo:read", "pull-request:read", "evidence:read"],
            required_artifact_kinds: &["review.summary"],
            optional_artifact_kinds: &["risk.finding", "test.plan"],
            allowed_task_classes: &["code.review", "risk.analysis"],
            denied_task_classes: DENIED_TARGET_TASK_CLASSES,
        },
        "test-runner" => A2ASubagentSkillContract {
            lane_id: "test-runner",
            required_context_grants: &["repo:read", "tool:execute-tests", "evidence:write"],
            required_artifact_kinds: &["test.report"],
            optional_artifact_kinds: &["failure.triage", "coverage.summary"],
            allowed_task_classes: &["test.execution", "ci.triage"],
            denied_task_classes: DENIED_TARGET_TASK_CLASSES,
        },
        "repo-explorer" => A2ASubagentSkillContract {
            lane_id: "repo-explorer",
            required_context_grants: &["repo:read", "evidence:write"],
            required_artifact_kinds: &["repo.map"],
            optional_artifact_kinds: &["evidence.index"],
            allowed_task_classes: &["repo.inspect", "context.gathering"],
            denied_task_classes: DENIED_TARGET_TASK_CLASSES,
        },
        "release-shepherd" => A2ASubagentSkillContract {
            lane_id: "release-shepherd",
            required_context_grants: &[
                "repo:read",
                "pull-request:write",
                "deploy:read",
                "evidence:write",
            ],
            required_artifact_kinds: &["release.evidence"],
            optional_artifact_kinds: &["ci.summary", "deploy.status"],
            allowed_task_classes: &["release.follow-through", "deployment.smoke"],
            denied_task_classes: DENIED_TARGET_TASK_CLASSES,
        },
        _ => A2ASubagentSkillContract {
            lane_id: "default",
            required_context_grants: &["repo:read"],
            required_artifact_kinds: &["subagent.summary"],
            optional_artifact_kinds: &["evidence.index"],
            allowed_task_classes: &["agent.delegation"],
            denied_task_classes: DENIED_TARGET_TASK_CLASSES,
        },
    }
}

pub(crate) fn a2a_subagent_skills(operating_plane_extension_uri: &str) -> Vec<Value> {
    CODEX_SUBAGENT_DISPATCH_LANES
        .iter()
        .map(|lane| a2a_subagent_skill(lane, operating_plane_extension_uri))
        .collect()
}

fn a2a_subagent_skill(
    lane: &CodexSubagentDispatchLane,
    operating_plane_extension_uri: &str,
) -> Value {
    let contract = a2a_subagent_skill_contract(lane.lane_id);
    serde_json::json!({
        "id": lane.skill_id,
        "name": lane.display_name,
        "description": lane.description,
        "tags": lane.tags,
        "inputModes": ["text/plain", "application/json"],
        "outputModes": ["text/plain", "application/json"],
        "requiredContextGrants": contract.required_context_grants,
        "approvalPolicyRef": format!("maestro.subagent.{}.target-policy", lane.lane_id),
        "maxAutonomy": "bounded",
        "requiredArtifactKinds": contract.required_artifact_kinds,
        "optionalArtifactKinds": contract.optional_artifact_kinds,
        "allowedTaskClasses": contract.allowed_task_classes,
        "deniedTaskClasses": contract.denied_task_classes,
        "attributes": {
            "evalopsSkillKind": A2A_SUBAGENT_KIND,
            "subagentLaneId": lane.lane_id,
            "requestMetadataPath": A2A_SUBAGENT_REQUEST_METADATA_PATH,
            "operatingPlaneExtension": operating_plane_extension_uri
        },
        "metadata": {
            "evalopsSkillKind": A2A_SUBAGENT_KIND,
            "subagentLaneId": lane.lane_id,
            "operatingPlaneExtension": operating_plane_extension_uri,
            "requestMetadataPath": A2A_SUBAGENT_REQUEST_METADATA_PATH,
            "approvalPolicy": "target-maestro-policy",
            "contextGrantPolicy": "bounded-policy-grants",
            "resultPolicy": "summary-and-artifacts",
            "workGraph": "target AgentRun child-agent work items"
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a2a_subagent_skills_cover_dispatch_lanes() {
        let skills = a2a_subagent_skills("urn:test:operating-plane");
        let skill_ids = skills
            .iter()
            .filter_map(|skill| skill.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert_eq!(skill_ids.len(), CODEX_SUBAGENT_DISPATCH_LANES.len());
        for lane in CODEX_SUBAGENT_DISPATCH_LANES {
            assert!(skill_ids.contains(&lane.skill_id));
        }
    }

    #[test]
    fn a2a_subagent_skill_contracts_include_governed_review_requirements() {
        let skills = a2a_subagent_skills("urn:test:operating-plane");
        let review = skills
            .iter()
            .find(|skill| skill["id"] == "maestro.subagent.code-review")
            .expect("review skill should exist");

        assert_eq!(
            review["requiredContextGrants"],
            serde_json::json!(["repo:read", "pull-request:read", "evidence:read"])
        );
        assert_eq!(
            review["requiredArtifactKinds"],
            serde_json::json!(["review.summary"])
        );
        assert_eq!(
            review["allowedTaskClasses"],
            serde_json::json!(["code.review", "risk.analysis"])
        );
        assert_eq!(
            review["deniedTaskClasses"],
            serde_json::json!([
                "credential.materialization",
                "secret.exfiltration",
                "unbounded.repository.write"
            ])
        );
        assert_eq!(
            review["metadata"]["requestMetadataPath"],
            A2A_SUBAGENT_REQUEST_METADATA_PATH
        );
        assert_eq!(
            review["attributes"]["operatingPlaneExtension"],
            "urn:test:operating-plane"
        );
    }
}
