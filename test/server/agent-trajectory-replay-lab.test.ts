import type { ComposerRunTimelineResponse } from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import { buildAgentTrajectoryReplayLab } from "../../src/server/agent-trajectory-replay-lab.js";

describe("buildAgentTrajectoryReplayLab", () => {
	it("builds trajectory, replay, score, and inspection artifacts from a timeline", () => {
		const lab = buildAgentTrajectoryReplayLab(timeline(), {
			generatedAt: "2026-05-18T00:00:05.000Z",
		});

		expect(lab).toMatchObject({
			schemaVersion: "evalops.maestro.agent-trajectory-replay-lab.v1",
			generatedAt: "2026-05-18T00:00:05.000Z",
			run: {
				id: "session-lab-1",
				sessionId: "session-lab-1",
			},
			summary: {
				timelineItems: 4,
				trajectoryEvents: 4,
				replayDeltas: 0,
				replayErrors: 0,
				scoreFailures: 0,
				scoreRules: 1,
				toolCalls: 1,
			},
		});
		expect(lab.replay.toolCalls).toEqual([
			expect.objectContaining({
				toolCallId: "call-read",
				toolName: "read",
				requestedSequence: 2,
				resultSequences: [3],
				terminalStatus: "completed",
			}),
		]);
		expect(lab.score.findings[0]).toMatchObject({
			ruleId: "final-event-has-evidence",
			status: "pass",
		});
		expect(lab.inspection.finalAnswer).toMatchObject({
			eventId: "trajectory:message:assistant-final",
			timelineItemIds: ["message:assistant-final"],
		});
	});
});

function timeline(): ComposerRunTimelineResponse {
	return {
		sessionId: "session-lab-1",
		source: "local",
		generatedAt: "2026-05-18T00:00:04.000Z",
		platformBacked: false,
		pendingRequestCount: 0,
		items: [
			{
				id: "message:user-1",
				sessionId: "session-lab-1",
				timestamp: "2026-05-18T00:00:00.000Z",
				type: "message.user",
				title: "User message",
				status: "completed",
				visibility: "user",
				source: "local",
				role: "user",
				summary: "Inspect the repo.",
			},
			{
				id: "tool-requested:call-read",
				sessionId: "session-lab-1",
				timestamp: "2026-05-18T00:00:01.000Z",
				type: "tool.requested",
				title: "Requested read",
				status: "running",
				visibility: "user",
				source: "local",
				toolName: "read",
				toolCallId: "call-read",
			},
			{
				id: "tool-result:call-read",
				sessionId: "session-lab-1",
				timestamp: "2026-05-18T00:00:02.000Z",
				type: "tool.completed",
				title: "read completed",
				status: "completed",
				visibility: "user",
				source: "local",
				role: "tool",
				toolName: "read",
				toolCallId: "call-read",
				toolExecutionId: "tool_exec_read_1",
			},
			{
				id: "message:assistant-final",
				sessionId: "session-lab-1",
				timestamp: "2026-05-18T00:00:03.000Z",
				type: "message.assistant",
				title: "Assistant response",
				status: "completed",
				visibility: "user",
				source: "local",
				role: "assistant",
				summary: "Repo inspection complete.",
			},
		],
	};
}
