import { describe, expect, it } from "vitest";
import { replayAgentTrajectoryReport } from "../../src/server/agent-trajectory-replay.js";
import type { AgentTrajectoryReport } from "../../src/server/agent-trajectory.js";
import { AGENT_TRAJECTORY_SCHEMA } from "../../src/server/agent-trajectory.js";

function baseReport(
	events: AgentTrajectoryReport["events"],
): AgentTrajectoryReport {
	return {
		schemaVersion: AGENT_TRAJECTORY_SCHEMA,
		run: {
			id: "run-replay-test",
			sessionId: "session-replay-test",
			source: "local",
			generatedAt: "2026-05-09T19:00:00.000Z",
			platformBacked: false,
		},
		counts: {
			events: events.length,
			evidenceAnchors: events.reduce(
				(count, event) => count + event.evidence.length,
				0,
			),
			byKind: events.reduce<Record<string, number>>((counts, event) => {
				counts[event.kind] = (counts[event.kind] ?? 0) + 1;
				return counts;
			}, {}),
			byPhase: events.reduce<Record<string, number>>((counts, event) => {
				counts[event.phase] = (counts[event.phase] ?? 0) + 1;
				return counts;
			}, {}),
			byStatus: events.reduce<Record<string, number>>((counts, event) => {
				counts[event.status] = (counts[event.status] ?? 0) + 1;
				return counts;
			}, {}),
		},
		events,
	};
}

const validToolEvents: AgentTrajectoryReport["events"] = [
	{
		id: "trajectory:session-started",
		sequence: 1,
		timestamp: "2026-05-09T19:00:00.000Z",
		kind: "session",
		phase: "setup",
		actor: "system",
		type: "session.started",
		status: "info",
		visibility: "user",
		source: "local",
		title: "Session started",
		evidence: [{ kind: "timeline_item", id: "session-started" }],
	},
	{
		id: "trajectory:tool-requested:call-read",
		sequence: 2,
		timestamp: "2026-05-09T19:00:01.000Z",
		kind: "tool",
		phase: "act",
		actor: "assistant",
		type: "tool.requested",
		status: "running",
		visibility: "user",
		source: "local",
		title: "Requested read",
		toolName: "read",
		relatedIds: ["call-read"],
		evidence: [
			{ kind: "timeline_item", id: "tool-requested:call-read" },
			{ kind: "tool_call", id: "call-read" },
		],
	},
	{
		id: "trajectory:tool-result:call-read",
		sequence: 3,
		timestamp: "2026-05-09T19:00:02.000Z",
		kind: "tool",
		phase: "verify",
		actor: "tool",
		type: "tool.completed",
		status: "completed",
		visibility: "user",
		source: "local",
		title: "read completed",
		toolName: "read",
		relatedIds: ["call-read"],
		evidence: [
			{ kind: "timeline_item", id: "tool-result:call-read" },
			{ kind: "tool_call", id: "call-read" },
		],
	},
];

describe("replayAgentTrajectoryReport", () => {
	it("replays a valid tool trajectory deterministically", () => {
		const replay = replayAgentTrajectoryReport(baseReport(validToolEvents), {
			expectedTools: {
				"call-read": { terminalStatus: "completed" },
			},
		});

		expect(replay.counts).toMatchObject({
			events: 3,
			deltas: 0,
			errors: 0,
			toolCalls: 1,
			phases: 3,
		});
		expect(replay.toolCalls).toEqual([
			expect.objectContaining({
				toolCallId: "call-read",
				toolName: "read",
				requestedSequence: 2,
				resultSequences: [3],
				terminalStatus: "completed",
			}),
		]);
	});

	it("reports validation and expectation deltas", () => {
		const report = baseReport([
			{
				...validToolEvents[2],
				sequence: 1,
			},
		]);
		const replay = replayAgentTrajectoryReport(report, {
			expectedTools: {
				"call-read": {
					terminalStatus: "failed",
					requiredArtifactIds: ["artifact-required"],
				},
			},
		});

		expect(replay.counts.errors).toBeGreaterThanOrEqual(3);
		expect(replay.deltas.map((item) => item.ruleId)).toEqual(
			expect.arrayContaining([
				"trajectory.validation",
				"tool.terminal_status_mismatch",
				"tool.required_artifact_missing",
			]),
		);
	});
});
