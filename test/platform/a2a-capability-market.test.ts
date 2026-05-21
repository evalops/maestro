import { describe, expect, it } from "vitest";
import {
	A2A_CAPABILITY_MARKET_VERSION,
	rankA2ACapabilityPeers,
	selectA2ACapabilityPeer,
} from "../../src/platform/a2a-capability-market.js";
import {
	type PlatformAgentA2ASkill,
	type PlatformAgentRegistryA2APeerCandidate,
	PlatformAgentStatusValue,
} from "../../src/platform/agent-registry-client.js";

const NOW = new Date("2026-05-20T12:00:00.000Z");

function candidate(
	id: string,
	overrides: Partial<PlatformAgentRegistryA2APeerCandidate> = {},
): PlatformAgentRegistryA2APeerCandidate {
	const skills = overrides.skills ?? [
		skill("maestro.subagent.code-review", {
			allowedTaskClasses: ["review"],
			requiredArtifactKinds: ["review.summary"],
			requiredContextGrants: ["repo:read"],
		}),
	];
	return {
		agent: {
			id,
			name: id,
			status: PlatformAgentStatusValue.Idle,
			lastHeartbeatAt: "2026-05-20T11:59:45.000Z",
			...overrides.agent,
		},
		endpointUrl: `https://${id}.example/a2a`,
		endpointKind: "public",
		skills,
		...overrides,
	};
}

function skill(
	id: string,
	overrides: Partial<PlatformAgentA2ASkill> = {},
): PlatformAgentA2ASkill {
	return {
		id,
		name: id,
		...overrides,
	};
}

describe("A2A capability market", () => {
	it("ranks peers by skill fit, readiness, endpoint preference, and contracts", () => {
		const staleBusyPeer = candidate("agent-busy", {
			agent: {
				status: PlatformAgentStatusValue.Busy,
				lastHeartbeatAt: "2026-05-20T11:40:00.000Z",
			},
			pushNotifications: false,
		});
		const readyInternalPeer = candidate("agent-ready", {
			agent: {
				status: PlatformAgentStatusValue.Idle,
				lastHeartbeatAt: "2026-05-20T11:59:55.000Z",
			},
			endpointKind: "internal",
			endpointUrl: "http://agent-ready.mesh/a2a",
			pushNotifications: true,
			skills: [
				skill("maestro.subagent.code-review", {
					allowedTaskClasses: ["review"],
					approvalPolicyRef: "policy:code-review",
					requiredArtifactKinds: ["review.summary"],
					requiredContextGrants: ["repo:read"],
				}),
			],
		});

		const ranks = rankA2ACapabilityPeers([staleBusyPeer, readyInternalPeer], {
			skillId: "maestro.subagent.code-review",
			taskClass: "review",
			requiredArtifactKinds: ["review.summary"],
			requiredContextGrants: ["repo:read"],
			preferInternalEndpoint: true,
			now: NOW,
		});

		expect(ranks[0]).toEqual(
			expect.objectContaining({
				version: A2A_CAPABILITY_MARKET_VERSION,
				candidate: readyInternalPeer,
				selectedSkill: expect.objectContaining({
					id: "maestro.subagent.code-review",
				}),
				score: expect.any(Number),
				reasons: expect.arrayContaining([
					"skill:maestro.subagent.code-review",
					"status_idle",
					"heartbeat_fresh",
					"internal_endpoint",
					"push_notifications",
					"approval_policy",
					"artifact_contract",
				]),
			}),
		);
		expect(ranks[0]!.score).toBeGreaterThan(ranks[1]!.score);
	});

	it("filters peers that deny the requested task class", () => {
		const denied = candidate("agent-denied", {
			skills: [
				skill("maestro.subagent.code-review", {
					deniedTaskClasses: ["review"],
				}),
			],
		});

		expect(
			selectA2ACapabilityPeer([denied], {
				skillId: "maestro.subagent.code-review",
				taskClass: "review",
				now: NOW,
			}),
		).toBeUndefined();
	});

	it("filters peers when allowed task classes omit the requested class", () => {
		const wrongClass = candidate("agent-wrong-class", {
			agent: {
				status: PlatformAgentStatusValue.Idle,
				lastHeartbeatAt: "2026-05-20T11:59:59.000Z",
			},
			endpointKind: "internal",
			pushNotifications: true,
			skills: [
				skill("maestro.subagent.code-review", {
					allowedTaskClasses: ["code.refactor"],
				}),
			],
		});
		const compatible = candidate("agent-compatible", {
			agent: {
				status: PlatformAgentStatusValue.Busy,
				lastHeartbeatAt: "2026-05-20T11:45:00.000Z",
			},
			skills: [
				skill("maestro.subagent.code-review", {
					allowedTaskClasses: ["code.review"],
				}),
			],
		});

		const ranks = rankA2ACapabilityPeers([wrongClass, compatible], {
			skillId: "maestro.subagent.code-review",
			taskClass: "code.review",
			preferInternalEndpoint: true,
			now: NOW,
		});

		expect(ranks).toHaveLength(1);
		expect(ranks[0]).toEqual(
			expect.objectContaining({
				candidate: compatible,
				reasons: expect.arrayContaining(["task_class:code.review"]),
			}),
		);
	});

	it("treats Platform active status as online for scoring", () => {
		const active = candidate("agent-active", {
			agent: {
				status: PlatformAgentStatusValue.Active,
			},
		});
		const busy = candidate("agent-busy", {
			agent: {
				status: PlatformAgentStatusValue.Busy,
			},
		});

		const ranks = rankA2ACapabilityPeers([busy, active], {
			skillId: "maestro.subagent.code-review",
			taskClass: "review",
			now: NOW,
		});

		expect(ranks[0]).toEqual(
			expect.objectContaining({
				candidate: active,
				reasons: expect.arrayContaining(["status_online"]),
			}),
		);
	});

	it("filters peers missing requested context grants or artifacts", () => {
		const missingGrant = candidate("agent-missing-grant", {
			skills: [
				skill("maestro.subagent.code-review", {
					requiredContextGrants: ["repo:read"],
					requiredArtifactKinds: ["review.summary"],
				}),
			],
		});
		const missingArtifact = candidate("agent-missing-artifact", {
			skills: [
				skill("maestro.subagent.code-review", {
					requiredContextGrants: ["repo:read", "issue:read"],
					requiredArtifactKinds: ["diff.patch"],
				}),
			],
		});

		expect(
			rankA2ACapabilityPeers([missingGrant, missingArtifact], {
				skillId: "maestro.subagent.code-review",
				requiredContextGrants: ["repo:read", "issue:read"],
				requiredArtifactKinds: ["review.summary"],
				now: NOW,
			}),
		).toEqual([]);
	});
});
