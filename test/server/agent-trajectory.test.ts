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
});
