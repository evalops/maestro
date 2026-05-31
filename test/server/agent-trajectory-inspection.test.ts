import { describe, expect, it } from "vitest";
import { buildAgentTrajectoryInspectionReport } from "../../src/server/agent-trajectory-inspection.js";
import {
	AGENT_TRAJECTORY_REPLAY_SCHEMA,
	type AgentTrajectoryReplayReport,
} from "../../src/server/agent-trajectory-replay.js";
import {
	AGENT_TRAJECTORY_SCORE_SCHEMA,
	type AgentTrajectoryScoreReport,
} from "../../src/server/agent-trajectory-scorers.js";
import { AGENT_TRAJECTORY_SCHEMA } from "../../src/server/agent-trajectory.js";
import type { AgentTrajectoryReport } from "../../src/server/agent-trajectory.js";

const trajectory: AgentTrajectoryReport = {
	schemaVersion: AGENT_TRAJECTORY_SCHEMA,
	run: {
		id: "run-inspect-1",
		sessionId: "session-inspect-1",
		source: "local",
		generatedAt: "2026-05-10T00:00:00.000Z",
		platformBacked: false,
	},
	counts: {
		events: 2,
		evidenceAnchors: 4,
		byKind: { tool: 1, message: 1 },
		byPhase: { verify: 1, think: 1 },
		byStatus: { failed: 1, completed: 1 },
	},
	events: [
		{
			id: "trajectory:tool-result:call-1",
			sequence: 1,
			timestamp: "2026-05-10T00:00:01.000Z",
			kind: "tool",
			phase: "verify",
			actor: "tool",
			type: "tool.failed",
			status: "failed",
			visibility: "user",
			source: "local",
			title: "shell failed",
			toolName: "shell",
			relatedIds: ["call-1"],
			evidence: [
				{ kind: "timeline_item", id: "tool-result:call-1" },
				{ kind: "tool_call", id: "call-1" },
			],
		},
		{
			id: "trajectory:message:assistant-2",
			sequence: 2,
			timestamp: "2026-05-10T00:00:02.000Z",
			kind: "message",
			phase: "think",
			actor: "assistant",
			type: "message.assistant",
			status: "completed",
			visibility: "user",
			source: "local",
			title: "Assistant response",
			summary: "Fixed with a safer command.",
			evidence: [{ kind: "timeline_item", id: "message:assistant-2" }],
		},
	],
};

const replay: AgentTrajectoryReplayReport = {
	schemaVersion: AGENT_TRAJECTORY_REPLAY_SCHEMA,
	trajectorySchemaVersion: AGENT_TRAJECTORY_SCHEMA,
	run: trajectory.run,
	deterministic: true,
	counts: {
		events: 2,
		deltas: 1,
		errors: 1,
		warnings: 0,
		toolCalls: 1,
		phases: 2,
	},
	phases: [],
	toolCalls: [],
	deltas: [
		{
			id: "delta:001",
			severity: "error",
			ruleId: "tool.expected_missing",
			eventId: "trajectory:tool-result:call-1",
			message: "Expected tool evidence was missing.",
			evidence: [{ kind: "timeline_item", id: "tool-result:call-1" }],
		},
	],
};

const score: AgentTrajectoryScoreReport = {
	schemaVersion: AGENT_TRAJECTORY_SCORE_SCHEMA,
	trajectorySchemaVersion: AGENT_TRAJECTORY_SCHEMA,
	run: trajectory.run,
	counts: {
		rules: 1,
		passed: 0,
		failed: 1,
		warnings: 0,
	},
	findings: [
		{
			ruleId: "tool-recovered",
			status: "fail",
			severity: "error",
			message: "Tool did not recover.",
			eventIds: ["trajectory:tool-result:call-1"],
			evidence: [
				{ kind: "timeline_item", id: "tool-result:call-1" },
				{ kind: "tool_call", id: "call-1" },
			],
			remediation: "Add a recovery event.",
		},
	],
};

describe("buildAgentTrajectoryInspectionReport", () => {
	it("links replay and scorer findings to redacted trajectory and timeline items", () => {
		const inspection = buildAgentTrajectoryInspectionReport({
			timelineItems: [
				{
					id: "tool-result:call-1",
					sessionId: "session-inspect-1",
					timestamp: "2026-05-10T00:00:01.000Z",
					type: "tool.failed",
					title: "shell failed",
					status: "failed",
					visibility: "user",
					source: "local",
					role: "tool",
					toolName: "shell",
					metadata: {
						rawSecret: "sk-test-raw-secret",
						diff: "full raw diff",
					},
				},
				{
					id: "message:assistant-2",
					sessionId: "session-inspect-1",
					timestamp: "2026-05-10T00:00:02.000Z",
					type: "message.assistant",
					title: "Assistant response",
					summary: "Fixed with a safer command.",
					status: "completed",
					visibility: "user",
					source: "local",
					role: "assistant",
				},
			],
			trajectory,
			replay,
			score,
		});

		expect(inspection).toMatchObject({
			schemaVersion: "evalops.maestro.agent-trajectory-inspection.v1",
			counts: {
				timelineItems: 2,
				events: 2,
				replayDeltas: 1,
				scoreFindings: 1,
				scoreFailures: 1,
			},
			finalAnswer: {
				eventId: "trajectory:message:assistant-2",
				timelineItemIds: ["message:assistant-2"],
				redacted: true,
			},
		});
		expect(inspection.replayDeltas[0]).toMatchObject({
			id: "delta:001",
			eventId: "trajectory:tool-result:call-1",
			timelineItemIds: ["tool-result:call-1"],
			evidence: [
				{
					kind: "timeline_item",
					id: "tool-result:call-1",
					redacted: true,
				},
			],
		});
		expect(inspection.scoreFindings[0]).toMatchObject({
			ruleId: "tool-recovered",
			eventIds: ["trajectory:tool-result:call-1"],
			timelineItemIds: ["tool-result:call-1"],
		});
		expect(inspection.timelineItems[0]).toMatchObject({
			id: "tool-result:call-1",
			metadataKeys: ["diff", "rawSecret"],
			redacted: true,
		});
		const serialized = JSON.stringify(inspection);
		expect(serialized).not.toContain("sk-test-raw-secret");
		expect(serialized).not.toContain("full raw diff");
	});

	it("does not treat assistant-authored tool requests as the final answer", () => {
		const inspection = buildAgentTrajectoryInspectionReport({
			timelineItems: [
				{
					id: "message:assistant-1",
					sessionId: "session-inspect-1",
					timestamp: "2026-05-10T00:00:01.000Z",
					type: "message.assistant",
					title: "Assistant response",
					summary: "I will inspect the worker.",
					status: "completed",
					visibility: "user",
					source: "local",
					role: "assistant",
				},
				{
					id: "tool-requested:assistant-1:call-1",
					sessionId: "session-inspect-1",
					timestamp: "2026-05-10T00:00:02.000Z",
					type: "tool.requested",
					title: "Requested shell",
					status: "running",
					visibility: "user",
					source: "local",
					toolName: "shell",
				},
			],
			trajectory: {
				...trajectory,
				counts: {
					events: 2,
					evidenceAnchors: 3,
					byKind: { message: 1, tool: 1 },
					byPhase: { think: 1, act: 1 },
					byStatus: { completed: 1, running: 1 },
				},
				events: [
					{
						id: "trajectory:message:assistant-1",
						sequence: 1,
						timestamp: "2026-05-10T00:00:01.000Z",
						kind: "message",
						phase: "think",
						actor: "assistant",
						type: "message.assistant",
						status: "completed",
						visibility: "user",
						source: "local",
						title: "Assistant response",
						summary: "I will inspect the worker.",
						evidence: [{ kind: "timeline_item", id: "message:assistant-1" }],
					},
					{
						id: "trajectory:tool-requested:assistant-1:call-1",
						sequence: 2,
						timestamp: "2026-05-10T00:00:02.000Z",
						kind: "tool",
						phase: "act",
						actor: "assistant",
						type: "tool.requested",
						status: "running",
						visibility: "user",
						source: "local",
						title: "Requested shell",
						toolName: "shell",
						relatedIds: ["call-1"],
						evidence: [
							{
								kind: "timeline_item",
								id: "tool-requested:assistant-1:call-1",
							},
							{ kind: "tool_call", id: "call-1" },
						],
					},
				],
			},
			replay: {
				...replay,
				counts: { ...replay.counts, events: 2, deltas: 0, errors: 0 },
				deltas: [],
			},
			score: {
				...score,
				counts: { rules: 0, passed: 0, failed: 0, warnings: 0 },
				findings: [],
			},
		});

		expect(inspection.finalAnswer).toMatchObject({
			eventId: "trajectory:message:assistant-1",
			timelineItemIds: ["message:assistant-1"],
		});
	});
});
