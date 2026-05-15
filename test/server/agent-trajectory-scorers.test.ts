import { describe, expect, it } from "vitest";
import {
	type AgentTrajectoryScorerRule,
	scoreAgentTrajectoryReport,
} from "../../src/server/agent-trajectory-scorers.js";
import type { AgentTrajectoryReport } from "../../src/server/agent-trajectory.js";
import { AGENT_TRAJECTORY_SCHEMA } from "../../src/server/agent-trajectory.js";

function report(
	events: AgentTrajectoryReport["events"],
): AgentTrajectoryReport {
	return {
		schemaVersion: AGENT_TRAJECTORY_SCHEMA,
		run: {
			id: "score-run",
			sessionId: "score-session",
			source: "platform",
			generatedAt: "2026-05-09T20:00:00.000Z",
			platformBacked: true,
		},
		counts: {
			events: events.length,
			evidenceAnchors: events.reduce(
				(count, event) => count + event.evidence.length,
				0,
			),
			byKind: {},
			byPhase: {},
			byStatus: {},
		},
		events,
	};
}

const events: AgentTrajectoryReport["events"] = [
	{
		id: "trajectory:tool-requested",
		sequence: 1,
		timestamp: "2026-05-09T20:00:01.000Z",
		kind: "tool",
		phase: "act",
		actor: "assistant",
		type: "tool.requested",
		status: "running",
		visibility: "user",
		source: "platform",
		title: "Requested restart_worker",
		toolName: "restart_worker",
		evidence: [
			{ kind: "timeline_item", id: "tool-requested" },
			{ kind: "tool_call", id: "call-restart" },
		],
	},
	{
		id: "trajectory:approval-wait",
		sequence: 2,
		timestamp: "2026-05-09T20:00:02.000Z",
		kind: "wait",
		phase: "wait",
		actor: "platform",
		type: "wait.pending",
		status: "pending",
		visibility: "user",
		source: "platform",
		title: "Waiting for approval",
		toolName: "restart_worker",
		evidence: [
			{ kind: "timeline_item", id: "approval-wait" },
			{ kind: "tool_call", id: "call-restart" },
			{ kind: "approval_request", id: "approval-1" },
		],
	},
	{
		id: "trajectory:tool-failed",
		sequence: 3,
		timestamp: "2026-05-09T20:00:03.000Z",
		kind: "tool",
		phase: "verify",
		actor: "tool",
		type: "tool.failed",
		status: "failed",
		visibility: "user",
		source: "platform",
		title: "restart_worker failed",
		toolName: "restart_worker",
		evidence: [
			{ kind: "timeline_item", id: "tool-failed" },
			{ kind: "tool_call", id: "call-restart" },
		],
	},
	{
		id: "trajectory:recovery",
		sequence: 4,
		timestamp: "2026-05-09T20:00:04.000Z",
		kind: "runtime",
		phase: "recover",
		actor: "platform",
		type: "runtime.recovery",
		status: "failed",
		visibility: "admin",
		source: "platform",
		title: "Runtime scheduled recovery",
		toolName: "restart_worker",
		evidence: [
			{ kind: "timeline_item", id: "recovery" },
			{ kind: "tool_call", id: "call-restart" },
		],
	},
	{
		id: "trajectory:artifact",
		sequence: 5,
		timestamp: "2026-05-09T20:00:05.000Z",
		kind: "artifact",
		phase: "verify",
		actor: "runtime",
		type: "artifact.linked",
		status: "completed",
		visibility: "admin",
		source: "platform",
		title: "Artifact linked",
		toolName: "restart_worker",
		evidence: [
			{ kind: "timeline_item", id: "artifact-linked" },
			{ kind: "tool_call", id: "call-restart" },
			{ kind: "artifact", id: "artifact-1" },
		],
	},
	{
		id: "trajectory:finish",
		sequence: 6,
		timestamp: "2026-05-09T20:00:06.000Z",
		kind: "runtime",
		phase: "finish",
		actor: "platform",
		type: "runtime.finished",
		status: "completed",
		visibility: "admin",
		source: "platform",
		title: "Runtime finished",
		evidence: [{ kind: "timeline_item", id: "finish" }],
	},
	{
		id: "trajectory:agent-started",
		sequence: 7,
		timestamp: "2026-05-09T20:00:07.000Z",
		kind: "agent",
		phase: "act",
		actor: "agent",
		type: "agent.run.started",
		status: "running",
		visibility: "admin",
		source: "platform",
		title: "Codex child agent started",
		toolName: "codex.subagent.spawnAgent",
		evidence: [
			{ kind: "timeline_item", id: "agent-started" },
			{ kind: "agent_run", id: "agent-child-1" },
			{ kind: "parent_agent_run", id: "agent-parent-1" },
			{ kind: "child_agent_run", id: "agent-child-1" },
		],
	},
	{
		id: "trajectory:agent-completed",
		sequence: 8,
		timestamp: "2026-05-09T20:00:08.000Z",
		kind: "agent",
		phase: "verify",
		actor: "agent",
		type: "agent.run.completed",
		status: "completed",
		visibility: "admin",
		source: "platform",
		title: "Codex child agent completed",
		toolName: "codex.subagent.wait",
		evidence: [
			{ kind: "timeline_item", id: "agent-completed" },
			{ kind: "agent_run", id: "agent-child-1" },
			{ kind: "parent_agent_run", id: "agent-parent-1" },
			{ kind: "child_agent_run", id: "agent-child-1" },
		],
	},
];

const rules: AgentTrajectoryScorerRule[] = [
	{
		id: "required-platform-tool",
		severity: "error",
		description: "restart_worker must be requested on platform",
		anyEvent: {
			type: "tool.requested",
			toolName: "restart_worker",
			source: "platform",
		},
	},
	{
		id: "forbid-local-source",
		severity: "error",
		description: "hosted scenario must not use local source events",
		forbidEvent: { source: "local" },
	},
	{
		id: "terminal-failed",
		severity: "error",
		description: "restart is expected to fail before recovery",
		toolTerminalStatus: { toolCallId: "call-restart", status: "failed" },
	},
	{
		id: "requires-artifact",
		severity: "error",
		description: "restart flow should link recovery artifact",
		requireArtifact: {
			toolCallId: "call-restart",
			artifactId: "artifact-1",
		},
	},
	{
		id: "approval-before-result",
		severity: "error",
		description: "approval wait must precede terminal result",
		approvalBeforeToolResult: { toolCallId: "call-restart" },
	},
	{
		id: "recovery-after-failure",
		severity: "warning",
		description: "recovery should follow failed restart",
		recoveryAfterFailedTool: { toolCallId: "call-restart" },
	},
	{
		id: "final-evidence",
		severity: "error",
		description: "final event should have evidence",
		finalEvidenceCoverage: true,
	},
	{
		id: "child-agent-completed",
		severity: "error",
		description: "Codex child agent run must complete under the parent.",
		childRunCompleted: {
			parentAgentRunId: "agent-parent-1",
			childAgentRunId: "agent-child-1",
		},
	},
];

describe("scoreAgentTrajectoryReport", () => {
	it("passes deterministic trajectory rules", () => {
		const score = scoreAgentTrajectoryReport(report(events), rules);

		expect(score.counts).toEqual({
			rules: 8,
			passed: 8,
			failed: 0,
			warnings: 0,
		});
		expect(score.findings.map((finding) => finding.ruleId)).toEqual(
			rules.map((rule) => rule.id),
		);
	});

	it("returns structured failures with evidence and remediation", () => {
		const score = scoreAgentTrajectoryReport(report(events), [
			{
				id: "missing-artifact",
				severity: "error",
				description: "missing artifact should fail",
				requireArtifact: {
					toolCallId: "call-restart",
					artifactId: "artifact-missing",
				},
			},
		]);

		expect(score.counts.failed).toBe(1);
		expect(score.findings[0]).toMatchObject({
			ruleId: "missing-artifact",
			status: "fail",
			severity: "error",
			eventIds: expect.arrayContaining(["trajectory:tool-requested"]),
			remediation: expect.stringContaining("required artifact"),
		});
		expect(score.findings[0]?.evidence.length).toBeGreaterThan(0);
	});

	it("does not satisfy targeted recovery with an unrelated recovery event", () => {
		const unrelatedRecoveryEvents = events.map((event) =>
			event.id === "trajectory:recovery"
				? {
						...event,
						evidence: event.evidence.filter(
							(anchor) => anchor.kind !== "tool_call",
						),
					}
				: event,
		);
		const score = scoreAgentTrajectoryReport(report(unrelatedRecoveryEvents), [
			{
				id: "unrelated-recovery",
				severity: "warning",
				description: "unrelated recovery must not satisfy target",
				recoveryAfterFailedTool: { toolCallId: "call-restart" },
			},
		]);

		expect(score.findings[0]).toMatchObject({
			ruleId: "unrelated-recovery",
			status: "warn",
			eventIds: expect.arrayContaining(["trajectory:tool-failed"]),
		});
	});

	it("scores production child-run lifecycle events from agent_run evidence", () => {
		const productionShapeEvents = events.map((event) =>
			event.type.startsWith("agent.run.")
				? {
						...event,
						evidence: event.evidence.filter(
							(anchor) =>
								anchor.kind !== "parent_agent_run" &&
								anchor.kind !== "child_agent_run",
						),
						relatedIds: ["agent-child-1"],
					}
				: event,
		);
		const score = scoreAgentTrajectoryReport(report(productionShapeEvents), [
			{
				id: "child-run-agent-run-only",
				severity: "error",
				description:
					"production child run events may only carry the child agent_run id",
				childRunCompleted: {
					parentAgentRunId: "agent-parent-1",
					childAgentRunId: "agent-child-1",
				},
			},
		]);

		expect(score.findings[0]).toMatchObject({
			ruleId: "child-run-agent-run-only",
			status: "pass",
			eventIds: ["trajectory:agent-started", "trajectory:agent-completed"],
		});
	});

	it("does not satisfy child-run lifecycle scoring from relatedIds alone", () => {
		const relatedOnlyEvents = events.map((event) =>
			event.type.startsWith("agent.run.")
				? {
						...event,
						evidence: event.evidence.filter(
							(anchor) =>
								anchor.kind !== "agent_run" &&
								anchor.kind !== "parent_agent_run" &&
								anchor.kind !== "child_agent_run",
						),
						relatedIds: ["agent-child-1"],
					}
				: event,
		);
		const score = scoreAgentTrajectoryReport(report(relatedOnlyEvents), [
			{
				id: "child-run-related-ids-ignored",
				severity: "error",
				description: "heterogeneous related IDs must not satisfy child runs",
				childRunCompleted: {
					parentAgentRunId: "agent-parent-1",
					childAgentRunId: "agent-child-1",
				},
			},
		]);

		expect(score.findings[0]).toMatchObject({
			ruleId: "child-run-related-ids-ignored",
			status: "fail",
			eventIds: [],
		});
	});

	it("scores the terminal failed runtime event for final evidence", () => {
		const failedTerminal = {
			...events[3],
			id: "trajectory:terminal-recovery",
			sequence: 9,
			evidence: [],
		};
		const score = scoreAgentTrajectoryReport(
			report([...events, failedTerminal]),
			[
				{
					id: "terminal-evidence",
					severity: "error",
					description: "terminal event must carry evidence",
					finalEvidenceCoverage: true,
				},
			],
		);

		expect(score.findings[0]).toMatchObject({
			ruleId: "terminal-evidence",
			status: "fail",
			eventIds: ["trajectory:terminal-recovery"],
		});
	});

	it("fails child-run scoring when the completion event loses child evidence", () => {
		const missingCompletionEvidence = events.map((event) =>
			event.id === "trajectory:agent-completed"
				? {
						...event,
						evidence: event.evidence.filter(
							(anchor) =>
								anchor.kind !== "agent_run" &&
								anchor.kind !== "child_agent_run",
						),
					}
				: event,
		);
		const score = scoreAgentTrajectoryReport(
			report(missingCompletionEvidence),
			[
				{
					id: "child-run-must-complete",
					severity: "error",
					description: "child run completion should be explicit",
					childRunCompleted: {
						parentAgentRunId: "agent-parent-1",
						childAgentRunId: "agent-child-1",
					},
				},
			],
		);

		expect(score.findings[0]).toMatchObject({
			ruleId: "child-run-must-complete",
			status: "fail",
			eventIds: ["trajectory:agent-started"],
			remediation: expect.stringContaining("child-run start and completion"),
		});
	});
});
