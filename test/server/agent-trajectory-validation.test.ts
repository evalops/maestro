import { describe, expect, it } from "vitest";
import { validateAgentTrajectoryReport } from "../../src/server/agent-trajectory-validation.js";
import type { AgentTrajectoryReport } from "../../src/server/agent-trajectory.js";

function baseReport(
	events: AgentTrajectoryReport["events"],
): AgentTrajectoryReport {
	const byKind: Record<string, number> = {};
	const byPhase: Record<string, number> = {};
	const byStatus: Record<string, number> = {};
	let evidenceAnchors = 0;
	for (const event of events) {
		byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
		byPhase[event.phase] = (byPhase[event.phase] ?? 0) + 1;
		byStatus[event.status] = (byStatus[event.status] ?? 0) + 1;
		evidenceAnchors += event.evidence.length;
	}
	return {
		schemaVersion: "evalops.maestro.agent-trajectory.v1",
		run: {
			id: "run-1",
			sessionId: "session-1",
			source: "local",
			generatedAt: "2026-05-10T00:00:00.000Z",
			platformBacked: false,
		},
		counts: {
			events: events.length,
			evidenceAnchors,
			byKind,
			byPhase,
			byStatus,
		},
		events,
	};
}

describe("validateAgentTrajectoryReport", () => {
	it("accepts a valid tool trajectory with evidence anchors", () => {
		const report = baseReport([
			{
				id: "trajectory:tool-requested:assistant-1:call-1",
				sequence: 1,
				timestamp: "2026-05-10T00:00:00.000Z",
				kind: "tool",
				phase: "act",
				actor: "assistant",
				type: "tool.requested",
				status: "running",
				visibility: "user",
				source: "local",
				title: "Requested edit",
				toolName: "edit",
				relatedIds: ["call-1"],
				evidence: [
					{ kind: "timeline_item", id: "tool-requested:assistant-1:call-1" },
					{ kind: "tool_call", id: "call-1" },
				],
			},
			{
				id: "trajectory:tool-result:tool-1:call-1",
				sequence: 2,
				timestamp: "2026-05-10T00:00:01.000Z",
				kind: "tool",
				phase: "verify",
				actor: "tool",
				type: "tool.completed",
				status: "completed",
				visibility: "user",
				source: "local",
				title: "edit completed",
				toolName: "edit",
				relatedIds: ["call-1"],
				evidence: [
					{ kind: "timeline_item", id: "tool-result:tool-1:call-1" },
					{ kind: "tool_call", id: "call-1" },
				],
			},
		]);

		expect(validateAgentTrajectoryReport(report)).toEqual({
			valid: true,
			failures: [],
		});
	});

	it("rejects mismatched counts and missing timeline evidence", () => {
		const report = baseReport([
			{
				id: "trajectory:message:user-1",
				sequence: 2,
				timestamp: "2026-05-10T00:00:00.000Z",
				kind: "message",
				phase: "observe",
				actor: "user",
				type: "message.user",
				status: "completed",
				visibility: "user",
				source: "local",
				title: "User message",
				evidence: [],
			},
		]);
		report.counts.events = 2;

		const result = validateAgentTrajectoryReport(report);

		expect(result.valid).toBe(false);
		expect(result.failures).toEqual(
			expect.arrayContaining([
				"counts.events=2 does not match events.length=1",
				"trajectory:message:user-1 has sequence=2; expected 1",
				"trajectory:message:user-1 is missing timeline_item evidence",
			]),
		);
	});

	it("rejects tool results that appear before their request", () => {
		const report = baseReport([
			{
				id: "trajectory:tool-result:tool-1:call-1",
				sequence: 1,
				timestamp: "2026-05-10T00:00:00.000Z",
				kind: "tool",
				phase: "verify",
				actor: "tool",
				type: "tool.completed",
				status: "completed",
				visibility: "user",
				source: "local",
				title: "edit completed",
				toolName: "edit",
				relatedIds: ["call-1"],
				evidence: [
					{ kind: "timeline_item", id: "tool-result:tool-1:call-1" },
					{ kind: "tool_call", id: "call-1" },
				],
			},
		]);

		const result = validateAgentTrajectoryReport(report);

		expect(result.valid).toBe(false);
		expect(result.failures).toContain(
			"trajectory:tool-result:tool-1:call-1 references tool_call call-1 before a matching tool.requested event",
		);
	});
});
