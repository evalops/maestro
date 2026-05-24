import { describe, expect, it } from "vitest";
import type { SwarmState } from "../../src/agent/swarm/types.js";
import {
	a2aDelegationLaneId,
	a2aPushEvidenceKey,
	buildA2ACompletionAudit,
} from "../../src/platform/a2a-completion-audit.js";
import type { A2ATaskLedgerFile } from "../../src/platform/a2a-task-ledger.js";

describe("A2A completion audit", () => {
	it("requires status, artifact, ledger task, work graph, push, and correlation proof for every completed remote lane", () => {
		const swarm = {
			id: "swarm_1",
			status: "completed",
			config: {
				teammateCount: 1,
				planFile: "/tmp/plan.md",
				tasks: [],
				cwd: "/tmp",
			},
			teammates: [
				{
					id: "lane_alpha",
					name: "Alpha",
					status: "completed",
					completedTasks: ["task_parent"],
					a2a: {
						peer: "alpha",
						source: "platform-agent-registry",
						taskId: "a2a_task_1",
						messageId: "a2a_message_1",
						contextId: "ctx_1",
						skillId: "maestro.subagent.code-review",
					},
				},
			],
			pendingTasks: [],
			activeTasks: new Map(),
			completedTasks: new Set(["task_parent"]),
			failedTasks: new Set(),
			startedAt: Date.now(),
		} satisfies SwarmState;
		const ledger = {
			tasks: [
				{
					id: "ledger_1",
					kind: "delegation",
					peer: "alpha",
					taskId: "a2a_task_1",
					contextId: "ctx_1",
					messageId: "a2a_message_1",
					text: "review it",
					state: "TASK_STATE_COMPLETED",
					responseText: "done",
					workGraph: {
						state: "completed",
						childRunIds: [],
						toolExecutionIds: [],
						waitIds: [],
					},
					metadata: {
						swarmId: "swarm_1",
						taskId: "task_parent",
						transport: "a2a",
					},
					transcript: [],
					createdAt: "2026-05-23T18:00:00.000Z",
					updatedAt: "2026-05-23T18:00:01.000Z",
					completedAt: "2026-05-23T18:00:01.000Z",
				},
			],
		} satisfies A2ATaskLedgerFile;

		const audit = buildA2ACompletionAudit({
			swarm,
			ledger,
			pushTaskIds: new Set(["a2a_task_1"]),
			generatedAt: "2026-05-23T18:00:02.000Z",
		});

		expect(audit).toMatchObject({
			schema: "evalops.maestro.a2a-completion-audit.v1",
			swarmId: "swarm_1",
			complete: true,
			counts: {
				remoteLanes: 1,
				completeLanes: 1,
				incompleteLanes: 0,
			},
			lanes: [
				{
					laneId: a2aDelegationLaneId("alpha", "task_parent"),
					parentTaskId: "task_parent",
					a2aTaskId: "a2a_task_1",
					a2aMessageId: "a2a_message_1",
					contextId: "ctx_1",
					peer: "alpha",
					status: "TASK_STATE_COMPLETED",
					terminal: true,
					evidence: {
						status: true,
						artifact: true,
						task: true,
						workGraph: true,
						push: true,
						correlation: true,
					},
					missingEvidence: [],
				},
			],
		});
	});

	it("does not share push evidence across peers that reuse the same remote task id", () => {
		const swarm = {
			id: "swarm_collision",
			status: "completed",
			config: {
				teammateCount: 2,
				planFile: "/tmp/plan.md",
				tasks: [],
				cwd: "/tmp",
			},
			teammates: [
				remoteLane("lane_alpha", "alpha", "shared-task", "alpha_parent"),
				remoteLane("lane_beta", "beta", "shared-task", "beta_parent"),
			],
			pendingTasks: [],
			activeTasks: new Map(),
			completedTasks: new Set(["alpha_parent", "beta_parent"]),
			failedTasks: new Set(),
			startedAt: Date.now(),
		} satisfies SwarmState;
		const ledger = {
			tasks: [
				ledgerTask("alpha", "shared-task", "alpha_parent"),
				ledgerTask("beta", "shared-task", "beta_parent"),
			],
		} satisfies A2ATaskLedgerFile;

		const taskIdOnlyAudit = buildA2ACompletionAudit({
			swarm,
			ledger,
			pushTaskIds: new Set(["shared-task"]),
		});
		expect(taskIdOnlyAudit.complete).toBe(false);
		expect(taskIdOnlyAudit.counts.pushCoveredLanes).toBe(0);
		expect(taskIdOnlyAudit.lanes.map((lane) => lane.evidence.push)).toEqual([
			false,
			false,
		]);

		const peerScopedAudit = buildA2ACompletionAudit({
			swarm,
			ledger,
			pushEvidenceKeys: new Set([a2aPushEvidenceKey("alpha", "shared-task")]),
		});
		expect(peerScopedAudit.complete).toBe(false);
		expect(peerScopedAudit.counts.pushCoveredLanes).toBe(1);
		expect(peerScopedAudit.lanes.map((lane) => lane.evidence.push)).toEqual([
			true,
			false,
		]);
		expect(peerScopedAudit.lanes[1]?.missingEvidence).toContain("push");
	});

	it("rejects correlation evidence when ledger metadata points at a different parent task", () => {
		const swarm = {
			id: "swarm_mismatch",
			status: "completed",
			config: {
				teammateCount: 1,
				planFile: "/tmp/plan.md",
				tasks: [],
				cwd: "/tmp",
			},
			teammates: [
				remoteLane("lane_alpha", "alpha", "remote-task-1", "alpha_parent"),
			],
			pendingTasks: [],
			activeTasks: new Map(),
			completedTasks: new Set(["alpha_parent"]),
			failedTasks: new Set(),
			startedAt: Date.now(),
		} satisfies SwarmState;
		const ledgerEntry = ledgerTask("alpha", "remote-task-1", "stale_parent");
		ledgerEntry.metadata = {
			...ledgerEntry.metadata,
			swarmId: "swarm_mismatch",
		};
		const ledger = {
			tasks: [ledgerEntry],
		} satisfies A2ATaskLedgerFile;

		const audit = buildA2ACompletionAudit({
			swarm,
			ledger,
			pushEvidenceKeys: new Set([a2aPushEvidenceKey("alpha", "remote-task-1")]),
		});

		expect(audit.complete).toBe(false);
		expect(audit.counts.completeLanes).toBe(0);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				parentTaskId: "alpha_parent",
				laneId: a2aDelegationLaneId("alpha", "alpha_parent"),
				evidence: expect.objectContaining({
					status: true,
					artifact: true,
					task: true,
					workGraph: true,
					push: true,
					correlation: false,
				}),
				missingEvidence: ["correlation"],
			}),
		);
	});

	it("uses ledger parent metadata for failed remote lanes without completed task markers", () => {
		const lane = remoteLane("lane_failed", "alpha", "remote-task-1", "unused");
		lane.status = "failed";
		lane.completedTasks = [];
		const swarm = {
			id: "swarm_failed",
			status: "completed",
			config: {
				teammateCount: 1,
				planFile: "/tmp/plan.md",
				tasks: [],
				cwd: "/tmp",
			},
			teammates: [lane],
			pendingTasks: [],
			activeTasks: new Map(),
			completedTasks: new Set(),
			failedTasks: new Set(["failed_parent"]),
			startedAt: Date.now(),
		} satisfies SwarmState;
		const ledgerEntry = ledgerTask("alpha", "remote-task-1", "failed_parent");
		ledgerEntry.state = "TASK_STATE_FAILED";
		ledgerEntry.metadata = {
			...ledgerEntry.metadata,
			swarmId: "swarm_failed",
		};

		const audit = buildA2ACompletionAudit({
			swarm,
			ledger: { tasks: [ledgerEntry] },
			pushEvidenceKeys: new Set([a2aPushEvidenceKey("alpha", "remote-task-1")]),
		});

		expect(audit.complete).toBe(true);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				laneId: a2aDelegationLaneId("alpha", "failed_parent"),
				parentTaskId: "failed_parent",
				evidence: expect.objectContaining({
					correlation: true,
				}),
				missingEvidence: [],
			}),
		);
	});

	it("includes ledger-backed remote lanes even when swarm state lost A2A correlation", () => {
		const ledgerEntry = ledgerTask("alpha", "remote-task-1", "failed_parent");
		ledgerEntry.state = "TASK_STATE_FAILED";
		ledgerEntry.metadata = {
			...ledgerEntry.metadata,
			swarmId: "swarm_ledger_only",
		};
		const audit = buildA2ACompletionAudit({
			swarm: {
				id: "swarm_ledger_only",
				status: "completed",
				config: {
					teammateCount: 1,
					planFile: "/tmp/plan.md",
					tasks: [],
					cwd: "/tmp",
				},
				teammates: [
					{
						id: "lane_failed",
						name: "Alpha",
						status: "failed",
						completedTasks: [],
					},
				],
				pendingTasks: [],
				activeTasks: new Map(),
				completedTasks: new Set(),
				failedTasks: new Set(["failed_parent"]),
				startedAt: Date.now(),
			},
			ledger: { tasks: [ledgerEntry] },
			pushEvidenceKeys: new Set([a2aPushEvidenceKey("alpha", "remote-task-1")]),
		});

		expect(audit.complete).toBe(true);
		expect(audit.counts.remoteLanes).toBe(1);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				laneId: a2aDelegationLaneId("alpha", "failed_parent"),
				parentTaskId: "failed_parent",
				peer: "alpha",
				a2aTaskId: "remote-task-1",
				missingEvidence: [],
			}),
		);
	});

	it("uses the current parent instead of the oldest completed task", () => {
		const swarm = {
			id: "swarm_multi_task",
			status: "completed",
			config: {
				teammateCount: 1,
				planFile: "/tmp/plan.md",
				tasks: [],
				cwd: "/tmp",
			},
			teammates: [
				{
					...remoteLane(
						"lane_alpha",
						"alpha",
						"remote-task-current",
						"old_parent",
					),
					completedTasks: ["old_parent", "current_parent"],
				},
			],
			pendingTasks: [],
			activeTasks: new Map(),
			completedTasks: new Set(["old_parent", "current_parent"]),
			failedTasks: new Set(),
			startedAt: Date.now(),
		} satisfies SwarmState;
		const ledgerEntry = ledgerTask(
			"alpha",
			"remote-task-current",
			"current_parent",
		);
		ledgerEntry.metadata = {
			...ledgerEntry.metadata,
			swarmId: "swarm_multi_task",
		};

		const audit = buildA2ACompletionAudit({
			swarm,
			ledger: { tasks: [ledgerEntry] },
			pushEvidenceKeys: new Set([
				a2aPushEvidenceKey("alpha", "remote-task-current"),
			]),
		});

		expect(audit.complete).toBe(true);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				laneId: a2aDelegationLaneId("alpha", "current_parent"),
				parentTaskId: "current_parent",
				missingEvidence: [],
				evidence: expect.objectContaining({
					correlation: true,
				}),
			}),
		);
	});

	it("uses the ledger parent for a failed current task after prior completed work", () => {
		const swarm = {
			id: "swarm_failed_after_completed",
			status: "failed",
			config: {
				teammateCount: 1,
				planFile: "/tmp/plan.md",
				tasks: [],
				cwd: "/tmp",
			},
			teammates: [
				{
					...remoteLane(
						"lane_alpha",
						"alpha",
						"remote-task-current",
						"old_parent",
					),
					status: "failed",
					completedTasks: ["old_parent"],
				},
			],
			pendingTasks: [],
			activeTasks: new Map(),
			completedTasks: new Set(["old_parent"]),
			failedTasks: new Set(["current_parent"]),
			startedAt: Date.now(),
		} satisfies SwarmState;
		const ledgerEntry = ledgerTask(
			"alpha",
			"remote-task-current",
			"current_parent",
		);
		ledgerEntry.state = "TASK_STATE_FAILED";
		ledgerEntry.workGraph = {
			state: "failed",
			childRunIds: [],
			toolExecutionIds: [],
			waitIds: [],
		};
		ledgerEntry.metadata = {
			...ledgerEntry.metadata,
			swarmId: "swarm_failed_after_completed",
		};

		const audit = buildA2ACompletionAudit({
			swarm,
			ledger: { tasks: [ledgerEntry] },
			pushEvidenceKeys: new Set([
				a2aPushEvidenceKey("alpha", "remote-task-current"),
			]),
		});

		expect(audit.complete).toBe(true);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				laneId: a2aDelegationLaneId("alpha", "current_parent"),
				parentTaskId: "current_parent",
				status: "TASK_STATE_FAILED",
				missingEvidence: [],
				evidence: expect.objectContaining({
					correlation: true,
				}),
			}),
		);
	});

	it("pinpoints incomplete terminal lane evidence", () => {
		const audit = buildA2ACompletionAudit({
			swarm: {
				id: "swarm_2",
				status: "completed",
				config: {
					teammateCount: 1,
					planFile: "/tmp/plan.md",
					tasks: [],
					cwd: "/tmp",
				},
				teammates: [
					{
						id: "lane_beta",
						name: "Beta",
						status: "completed",
						completedTasks: ["task_parent"],
						a2a: {
							peer: "beta",
							source: "registry",
							taskId: "a2a_task_2",
							messageId: "a2a_message_2",
						},
					},
				],
				pendingTasks: [],
				activeTasks: new Map(),
				completedTasks: new Set(["task_parent"]),
				failedTasks: new Set(),
				startedAt: Date.now(),
			},
			ledger: { tasks: [] },
			pushTaskIds: new Set(),
		});

		expect(audit.complete).toBe(false);
		expect(audit.counts.incompleteLanes).toBe(1);
		expect(audit.lanes[0]?.missingEvidence).toEqual([
			"status",
			"artifact",
			"task",
			"workGraph",
			"push",
			"correlation",
		]);
	});
});

function remoteLane(
	id: string,
	peer: string,
	taskId: string,
	parentTaskId: string,
): SwarmState["teammates"][number] {
	return {
		id,
		name: peer,
		status: "completed",
		completedTasks: [parentTaskId],
		a2a: {
			peer,
			source: "registry",
			taskId,
			messageId: `${peer}_message`,
			contextId: `${peer}_context`,
		},
	};
}

function ledgerTask(
	peer: string,
	taskId: string,
	parentTaskId: string,
): A2ATaskLedgerFile["tasks"][number] {
	return {
		id: `${peer}_ledger`,
		kind: "delegation",
		peer,
		taskId,
		contextId: `${peer}_context`,
		messageId: `${peer}_message`,
		text: "review it",
		state: "TASK_STATE_COMPLETED",
		responseText: "done",
		workGraph: {
			state: "completed",
			childRunIds: [],
			toolExecutionIds: [],
			waitIds: [],
		},
		metadata: {
			swarmId: "swarm_collision",
			taskId: parentTaskId,
			transport: "a2a",
		},
		transcript: [],
		createdAt: "2026-05-23T18:00:00.000Z",
		updatedAt: "2026-05-23T18:00:01.000Z",
		completedAt: "2026-05-23T18:00:01.000Z",
	};
}
