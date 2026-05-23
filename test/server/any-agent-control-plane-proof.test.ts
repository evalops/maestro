import type { ComposerRunTimelineResponse } from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import { summarizeA2ACockpit } from "../../src/platform/a2a-cockpit.js";
import type { A2AFleetSummary } from "../../src/platform/a2a-fleet.js";
import type { A2ATaskLedgerFile } from "../../src/platform/a2a-task-ledger.js";
import { buildAgentTrajectoryReplayLab } from "../../src/server/agent-trajectory-replay-lab.js";
import { buildAnyAgentControlPlaneProof } from "../../src/server/any-agent-control-plane-proof.js";
import { buildRunHealthSnapshot } from "../../src/server/handlers/status.js";
import { IntelligentRouterService } from "../../src/services/intelligent-router/service.js";
import type { RoutingModelCandidate } from "../../src/services/intelligent-router/types.js";

const ROUTING_MODELS: RoutingModelCandidate[] = [
	{
		provider: "openai",
		model: "gpt-4o-mini",
		cost: { input: 0.15, output: 0.6 },
	},
	{
		provider: "anthropic",
		model: "claude-sonnet",
		cost: { input: 3, output: 15 },
	},
];

describe("buildAnyAgentControlPlaneProof", () => {
	it("passes when discovery, delegation, routing, evals, health, and replay are all evidenced", () => {
		const router = new IntelligentRouterService(
			() => ROUTING_MODELS,
			() => new Date("2026-05-22T13:00:00.000Z"),
		);
		for (const qualityScore of [0.94, 0.96]) {
			router.recordPerformanceMetric({
				taskType: "code_review",
				provider: "anthropic",
				model: "claude-sonnet",
				source: "eval",
				evalSuite: "trajectory-replay",
				latencyMs: 1400,
				success: true,
				qualityScore,
			});
		}
		for (const qualityScore of [0.6, 0.62]) {
			router.recordPerformanceMetric({
				taskType: "code_review",
				provider: "openai",
				model: "gpt-4o-mini",
				source: "eval",
				evalSuite: "trajectory-replay",
				latencyMs: 500,
				success: true,
				qualityScore,
			});
		}
		const decision = router.routeRequest({
			taskType: "code_review",
			strategy: "quality",
		});

		const proof = buildAnyAgentControlPlaneProof({
			generatedAt: "2026-05-22T13:00:05.000Z",
			a2a: summarizeA2ACockpit({
				fleet: fleetSummary(),
				ledger: emptyLedger(),
				generatedAt: "2026-05-22T13:00:01.000Z",
			}),
			routeMetrics: router.listMetrics("code_review"),
			routingDecisions: [decision],
			replayLab: buildAgentTrajectoryReplayLab(timeline(), {
				generatedAt: "2026-05-22T13:00:02.000Z",
			}),
			runHealth: buildRunHealthSnapshot({
				apiLatencyMs: 64,
				backgroundTasks: { running: 0, failed: 0, restarting: 0 },
				database: { configured: false, connected: false },
				hooks: {
					asyncInFlight: 0,
					concurrency: { max: 4, active: 0, queued: 0 },
				},
				generatedAt: Date.parse("2026-05-22T13:00:03.000Z"),
			}),
		});

		expect(proof).toMatchObject({
			schemaVersion: "evalops.maestro.any-agent-control-plane-proof.v1",
			generatedAt: "2026-05-22T13:00:05.000Z",
			status: "passed",
			summary: {
				capabilities: 7,
				passed: 7,
				failed: 0,
				agentsObserved: 1,
				routingDecisions: 1,
				evalBackedRoutes: 2,
			},
			blockers: [],
		});
		expect(proof.capabilities.map((entry) => entry.id)).toEqual([
			"a2a_discovery",
			"a2a_delegation",
			"model_routing",
			"eval_backed_routing",
			"runtime_observability",
			"trajectory_replay",
			"operator_handoff",
		]);
		expect(proof.operatorNextActions).toEqual([
			"maestro a2a delegate mac-mini <objective> --wait --work-graph",
		]);
	});

	it("returns blockers when the proof surface is incomplete", () => {
		const proof = buildAnyAgentControlPlaneProof({
			generatedAt: "2026-05-22T13:05:00.000Z",
		});

		expect(proof.status).toBe("incomplete");
		expect(proof.summary.failed).toBe(7);
		expect(proof.blockers).toEqual([
			"A2A discovery: No A2A cockpit summary was supplied.",
			"A2A delegation: No A2A cockpit summary was supplied.",
			"Model routing: No intelligent-router decision was supplied.",
			"Eval-backed routing: No routing decisions or eval metrics were supplied.",
			"Runtime observability: No run-health snapshot was supplied.",
			"Trajectory replay: No trajectory replay lab report was supplied.",
			"Operator handoff: No A2A cockpit summary was supplied.",
		]);
	});

	it("marks degraded run health as a warning instead of a pass", () => {
		const router = new IntelligentRouterService(
			() => ROUTING_MODELS,
			() => new Date("2026-05-22T13:07:00.000Z"),
		);
		router.recordPerformanceMetric({
			taskType: "code_review",
			provider: "anthropic",
			model: "claude-sonnet",
			source: "eval",
			evalSuite: "trajectory-replay",
			latencyMs: 1400,
			success: true,
			qualityScore: 0.95,
		});
		const decision = router.routeRequest({
			taskType: "code_review",
			strategy: "quality",
		});

		const proof = buildAnyAgentControlPlaneProof({
			generatedAt: "2026-05-22T13:07:05.000Z",
			a2a: summarizeA2ACockpit({
				fleet: fleetSummary(),
				ledger: emptyLedger(),
				generatedAt: "2026-05-22T13:07:01.000Z",
			}),
			routeMetrics: router.listMetrics("code_review"),
			routingDecisions: [decision],
			replayLab: buildAgentTrajectoryReplayLab(timeline(), {
				generatedAt: "2026-05-22T13:07:02.000Z",
			}),
			runHealth: buildRunHealthSnapshot({
				apiLatencyMs: 1500,
				backgroundTasks: { running: 0, failed: 0, restarting: 0 },
				database: { configured: false, connected: false },
				hooks: {
					asyncInFlight: 0,
					concurrency: { max: 4, active: 0, queued: 0 },
				},
				generatedAt: Date.parse("2026-05-22T13:07:03.000Z"),
			}),
		});

		const observability = proof.capabilities.find(
			(entry) => entry.id === "runtime_observability",
		);
		expect(proof.status).toBe("needs_attention");
		expect(proof.summary.warnings).toBe(1);
		expect(observability).toMatchObject({
			status: "warning",
			evidence: ["runHealth degraded", "4 SLO lanes"],
			blocker: "API latency: 1500ms",
		});
	});

	it("does not count mixed production/eval samples as eval-backed routes", () => {
		const router = new IntelligentRouterService(
			() => ROUTING_MODELS,
			() => new Date("2026-05-22T13:10:00.000Z"),
		);
		router.recordPerformanceMetric({
			taskType: "incident_triage",
			provider: "anthropic",
			model: "claude-sonnet",
			source: "production",
			latencyMs: 1600,
			success: true,
			qualityScore: 0.9,
		});
		router.recordPerformanceMetric({
			taskType: "incident_triage",
			provider: "anthropic",
			model: "claude-sonnet",
			source: "eval",
			evalSuite: "trajectory-replay",
			latencyMs: 1400,
			success: true,
			qualityScore: 0.94,
		});
		const decision = router.routeRequest({
			taskType: "incident_triage",
			strategy: "quality",
		});

		const proof = buildAnyAgentControlPlaneProof({
			generatedAt: "2026-05-22T13:10:05.000Z",
			routeMetrics: router.listMetrics("incident_triage"),
			routingDecisions: [decision],
		});

		const evalCapability = proof.capabilities.find(
			(entry) => entry.id === "eval_backed_routing",
		);
		expect(proof.summary.evalBackedRoutes).toBe(0);
		expect(evalCapability).toMatchObject({
			status: "warning",
			blocker: "No route candidate includes eval-backed samples yet.",
		});
	});

	it("deduplicates repeated eval-backed decisions by route candidate", () => {
		const router = new IntelligentRouterService(
			() => ROUTING_MODELS,
			() => new Date("2026-05-22T13:15:00.000Z"),
		);
		router.recordPerformanceMetric({
			taskType: "code_review",
			provider: "anthropic",
			model: "claude-sonnet",
			source: "eval",
			evalSuite: "trajectory-replay",
			latencyMs: 1500,
			success: true,
			qualityScore: 0.95,
		});
		const firstDecision = router.routeRequest({
			taskType: "code_review",
			strategy: "quality",
		});
		const secondDecision = router.routeRequest({
			taskType: "code_review",
			strategy: "quality",
		});

		const proof = buildAnyAgentControlPlaneProof({
			generatedAt: "2026-05-22T13:15:05.000Z",
			routingDecisions: [firstDecision, secondDecision],
		});

		expect(proof.summary.evalBackedRoutes).toBe(1);
		expect(
			proof.capabilities.find((entry) => entry.id === "eval_backed_routing"),
		).toMatchObject({ status: "passed" });
	});
});

function fleetSummary(): A2AFleetSummary {
	return {
		generatedAt: "2026-05-22T13:00:00.000Z",
		registryPath: "/tmp/peers.json",
		tasksPath: "/tmp/tasks.json",
		peers: [
			{
				name: "mac-mini",
				displayName: "Mac Mini",
				url: "http://127.0.0.1:4111",
				status: "online",
			},
		],
	};
}

function emptyLedger(): A2ATaskLedgerFile {
	return { tasks: [] };
}

function timeline(): ComposerRunTimelineResponse {
	return {
		sessionId: "proof-session-1",
		source: "local",
		generatedAt: "2026-05-22T13:00:00.000Z",
		platformBacked: false,
		pendingRequestCount: 0,
		items: [
			{
				id: "message:user-1",
				sessionId: "proof-session-1",
				timestamp: "2026-05-22T13:00:00.000Z",
				type: "message.user",
				title: "User message",
				status: "completed",
				visibility: "user",
				source: "local",
				role: "user",
				summary: "Check the handoff.",
			},
			{
				id: "message:assistant-final",
				sessionId: "proof-session-1",
				timestamp: "2026-05-22T13:00:01.000Z",
				type: "message.assistant",
				title: "Assistant response",
				status: "completed",
				visibility: "user",
				source: "local",
				role: "assistant",
				summary: "Handoff checked.",
			},
		],
	};
}
