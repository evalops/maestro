#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CodexSubagentDispatchLane {
    pub(crate) lane_id: &'static str,
    pub(crate) skill_id: &'static str,
    pub(crate) display_name: &'static str,
    pub(crate) description: &'static str,
    pub(crate) tags: &'static [&'static str],
    #[cfg(test)]
    pub(crate) type_aliases: &'static [&'static str],
    #[cfg(test)]
    pub(crate) capability_aliases: &'static [&'static str],
}

pub(crate) const CODEX_SUBAGENT_DISPATCH_LANES: &[CodexSubagentDispatchLane] = &[
    CodexSubagentDispatchLane {
        lane_id: "code-writer",
        skill_id: "maestro.subagent.code-writer",
        display_name: "Maestro code writer subagent",
        description:
            "Delegate bounded implementation work to a target-owned Maestro coding child agent.",
        tags: &["maestro", "subagent", "code", "write"],
        #[cfg(test)]
        type_aliases: &["worker", "coder", "code", "code-writer", "default"],
        #[cfg(test)]
        capability_aliases: &[
            "code:write",
            "code-write",
            "code:edit",
            "code-edit",
            "code:implement",
            "code-implement",
        ],
    },
    CodexSubagentDispatchLane {
        lane_id: "code-review",
        skill_id: "maestro.subagent.code-review",
        display_name: "Maestro code review subagent",
        description:
            "Delegate code review and risk analysis to a target-owned Maestro review child agent.",
        tags: &["maestro", "subagent", "code", "review"],
        #[cfg(test)]
        type_aliases: &[
            "pr-review",
            "review",
            "reviewer",
            "code-review",
            "code-reviewer",
        ],
        #[cfg(test)]
        capability_aliases: &["code:review", "code-review"],
    },
    CodexSubagentDispatchLane {
        lane_id: "test-runner",
        skill_id: "maestro.subagent.test-runner",
        display_name: "Maestro test runner subagent",
        description: "Delegate test execution, failure triage, and verification evidence capture to a target-owned Maestro child agent.",
        tags: &["maestro", "subagent", "test", "ci"],
        #[cfg(test)]
        type_aliases: &["test", "qa", "ci", "ci-monitor", "test-runner"],
        #[cfg(test)]
        capability_aliases: &[
            "code:test",
            "code-test",
            "test:run",
            "test-run",
            "test-runner",
        ],
    },
    CodexSubagentDispatchLane {
        lane_id: "repo-explorer",
        skill_id: "maestro.subagent.repo-explorer",
        display_name: "Maestro repo explorer subagent",
        description: "Delegate repository inspection and context gathering to a target-owned Maestro exploration child agent.",
        tags: &["maestro", "subagent", "repo", "explore"],
        #[cfg(test)]
        type_aliases: &[
            "explore",
            "explorer",
            "repo-explorer",
            "research",
            "competitive-intel",
            "people-research",
        ],
        #[cfg(test)]
        capability_aliases: &[
            "repo:explore",
            "repo-explore",
            "repo-explorer",
            "code:search",
            "code-search",
        ],
    },
    CodexSubagentDispatchLane {
        lane_id: "release-shepherd",
        skill_id: "maestro.subagent.release-shepherd",
        display_name: "Maestro release shepherd subagent",
        description: "Delegate release, rollout, and merge-follow-through work to a target-owned Maestro child agent.",
        tags: &["maestro", "subagent", "release", "deploy"],
        #[cfg(test)]
        type_aliases: &["release", "release-shepherd"],
        #[cfg(test)]
        capability_aliases: &[
            "release:shepherd",
            "release-shepherd",
            "release:manage",
            "release-manage",
        ],
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct DispatchFixture {
        #[serde(rename = "schemaVersion")]
        schema_version: String,
        #[serde(rename = "a2aSkillLanes")]
        a2a_skill_lanes: Vec<DispatchFixtureLane>,
    }

    #[derive(Debug, Deserialize)]
    struct DispatchFixtureLane {
        #[serde(rename = "laneId")]
        lane_id: String,
        #[serde(rename = "skillId")]
        skill_id: String,
        #[serde(rename = "displayName")]
        display_name: String,
        description: String,
        tags: Vec<String>,
        #[serde(rename = "typeAliases")]
        type_aliases: Vec<String>,
        #[serde(rename = "capabilityAliases")]
        capability_aliases: Vec<String>,
    }

    #[test]
    fn codex_subagent_dispatch_lanes_match_protocol_fixture() {
        let fixture: DispatchFixture = serde_json::from_str(include_str!(
            "../../../docs/protocols/codex-subagent-dispatch-table-v1.json"
        ))
        .expect("dispatch fixture should parse");

        assert_eq!(
            fixture.schema_version,
            "evalops.maestro.codex.subagent-dispatch-table.v1"
        );
        assert_eq!(
            CODEX_SUBAGENT_DISPATCH_LANES.len(),
            fixture.a2a_skill_lanes.len()
        );

        for (lane, fixture_lane) in CODEX_SUBAGENT_DISPATCH_LANES
            .iter()
            .zip(fixture.a2a_skill_lanes.iter())
        {
            assert_eq!(lane.lane_id, fixture_lane.lane_id);
            assert_eq!(lane.skill_id, fixture_lane.skill_id);
            assert_eq!(lane.display_name, fixture_lane.display_name);
            assert_eq!(lane.description, fixture_lane.description);
            assert_eq!(lane.tags, fixture_lane.tags.as_slice());
            assert_eq!(lane.type_aliases, fixture_lane.type_aliases.as_slice());
            assert_eq!(
                lane.capability_aliases,
                fixture_lane.capability_aliases.as_slice()
            );
        }
    }
}
