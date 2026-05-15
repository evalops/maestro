import type { ComposerRunTimelineResponse } from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import { buildAgentTrajectoryReport } from "../../src/server/agent-trajectory.js";

describe("buildAgentTrajectoryReport", () => {
	it("preserves assistant ownership for platform-sourced tool requests", () => {
		const timeline: ComposerRunTimelineResponse = {
			sessionId: "hosted-session-1",
			source: "platform",
			generatedAt: "2026-05-10T00:00:00.000Z",
			platformBacked: true,
			pendingRequestCount: 0,
			items: [
				{
					id: "tool-requested:hosted-assistant-1:call-hosted-read",
					sessionId: "hosted-session-1",
					timestamp: "2026-05-10T00:00:01.000Z",
					type: "tool.requested",
					title: "Requested read_file",
					visibility: "user",
					source: "platform",
					status: "running",
					toolCallId: "call-hosted-read",
					toolName: "read_file",
				},
			],
		};

		const report = buildAgentTrajectoryReport(timeline);

		expect(report.events[0]).toMatchObject({
			id: "trajectory:tool-requested:hosted-assistant-1:call-hosted-read",
			kind: "tool",
			phase: "act",
			actor: "assistant",
			type: "tool.requested",
			source: "platform",
			toolName: "read_file",
		});
	});

	it("anchors Codex child-run lifecycle events for trajectory scoring", () => {
		const timeline: ComposerRunTimelineResponse = {
			sessionId: "codex-subagent-session",
			source: "platform",
			generatedAt: "2026-05-15T21:45:00.000Z",
			platformBacked: true,
			pendingRequestCount: 0,
			items: [
				{
					id: "agent-run:child-1-started",
					sessionId: "codex-subagent-session",
					timestamp: "2026-05-15T21:45:01.000Z",
					type: "agent.run.started",
					title: "Codex child agent started",
					visibility: "admin",
					source: "platform",
					status: "running",
					agentRunId: "agent-run-child-1",
					parentAgentRunId: "agent-run-parent-1",
					childAgentRunId: "agent-run-child-1",
					toolCallId: "collab-spawn-1",
					toolName: "codex.subagent.spawnAgent",
				},
				{
					id: "agent-run:child-1-completed",
					sessionId: "codex-subagent-session",
					timestamp: "2026-05-15T21:45:02.000Z",
					type: "agent.run.completed",
					title: "Codex child agent completed",
					visibility: "admin",
					source: "platform",
					status: "completed",
					agentRunId: "agent-run-child-1",
					parentAgentRunId: "agent-run-parent-1",
					childAgentRunId: "agent-run-child-1",
					toolCallId: "collab-wait-1",
					toolName: "codex.subagent.wait",
				},
			],
		};

		const report = buildAgentTrajectoryReport(timeline);

		expect(report.counts.byKind.agent).toBe(2);
		expect(report.events[0]).toMatchObject({
			kind: "agent",
			phase: "act",
			actor: "agent",
			type: "agent.run.started",
			relatedIds: ["agent-run-child-1", "agent-run-parent-1", "collab-spawn-1"],
			evidence: expect.arrayContaining([
				{ kind: "agent_run", id: "agent-run-child-1" },
				{ kind: "parent_agent_run", id: "agent-run-parent-1" },
				{ kind: "child_agent_run", id: "agent-run-child-1" },
			]),
		});
		expect(report.events[1]).toMatchObject({
			kind: "agent",
			phase: "verify",
			type: "agent.run.completed",
		});
	});
});
