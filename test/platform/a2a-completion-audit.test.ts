import { describe, expect, it } from "vitest";
import type { SwarmState } from "../../src/agent/swarm/types.js";
import {
	a2aDelegationLaneId,
	a2aPushSignalKey,
	buildA2ACompletionAudit,
} from "../../src/platform/a2a-completion-audit.js";
import type { A2ATaskLedgerFile } from "../../src/platform/a2a-task-ledger.js";

describe("A2A completion audit", () => {
	it("requires status, artifact, ledger task, work graph, push, and correlation signals for every completed remote lane", () => {
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
					transcript: [
						{
							at: "2026-05-23T18:00:00.000Z",
							role: "user",
							text: "review it",
						},
						{
							at: "2026-05-23T18:00:01.000Z",
							role: "agent",
							text: "done",
						},
					],
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
			schema: "evalops.maestro.a2a-completion-audit.v2",
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
					signals: {
						status: true,
						artifact: true,
						task: true,
						workGraph: true,
						transcript: true,
						push: true,
						correlation: true,
					},
					missingSignals: [],
				},
			],
		});
	});

	it("uses shared success-state aliases when choosing the completed parent", () => {
		const swarm = {
			id: "swarm_success_alias",
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
					completedTasks: ["stale_parent", "fresh_parent"],
					a2a: {
						peer: "alpha",
						source: "platform-agent-registry",
						taskId: "a2a_task_success",
						messageId: "a2a_message_success",
						contextId: "ctx_success",
					},
				},
			],
			pendingTasks: [],
			activeTasks: new Map(),
			completedTasks: new Set(["stale_parent", "fresh_parent"]),
			failedTasks: new Set(),
			startedAt: Date.now(),
		} satisfies SwarmState;
		const ledger = {
			tasks: [
				{
					id: "ledger_success",
					kind: "delegation",
					peer: "alpha",
					taskId: "a2a_task_success",
					contextId: "ctx_success",
					messageId: "a2a_message_success",
					text: "review it",
					state: "SUCCEEDED",
					responseText: "done",
					workGraph: {
						state: "completed",
						childRunIds: [],
						toolExecutionIds: [],
						waitIds: [],
					},
					metadata: {
						swarmId: "swarm_success_alias",
						taskId: "stale_parent",
						transport: "a2a",
					},
					transcript: [
						{
							at: "2026-05-23T18:00:00.000Z",
							role: "user",
							text: "review it",
						},
						{
							at: "2026-05-23T18:00:01.000Z",
							role: "agent",
							text: "done",
						},
					],
					createdAt: "2026-05-23T18:00:00.000Z",
					updatedAt: "2026-05-23T18:00:01.000Z",
					completedAt: "2026-05-23T18:00:01.000Z",
				},
			],
		} satisfies A2ATaskLedgerFile;

		const audit = buildA2ACompletionAudit({
			swarm,
			ledger,
			pushTaskIds: new Set(["a2a_task_success"]),
			generatedAt: "2026-05-23T18:00:02.000Z",
		});

		expect(audit.complete).toBe(false);
		expect(audit.lanes[0]).toMatchObject({
			laneId: a2aDelegationLaneId("alpha", "fresh_parent"),
			parentTaskId: "fresh_parent",
			status: "SUCCEEDED",
			terminal: true,
			signals: {
				status: true,
				artifact: true,
				task: true,
				workGraph: true,
				push: true,
				correlation: false,
			},
			missingSignals: ["correlation"],
		});
	});

	it("does not share push signals across peers that reuse the same remote task id", () => {
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
		expect(taskIdOnlyAudit.lanes.map((lane) => lane.signals.push)).toEqual([
			false,
			false,
		]);

		const peerScopedAudit = buildA2ACompletionAudit({
			swarm,
			ledger,
			pushSignalKeys: new Set([a2aPushSignalKey("alpha", "shared-task")]),
		});
		expect(peerScopedAudit.complete).toBe(false);
		expect(peerScopedAudit.counts.pushCoveredLanes).toBe(1);
		expect(peerScopedAudit.lanes.map((lane) => lane.signals.push)).toEqual([
			true,
			false,
		]);
		expect(peerScopedAudit.lanes[1]?.missingSignals).toContain("push");
	});

	it("requires terminal status, artifact, and task push signals when supplied", () => {
		const swarm = {
			id: "swarm_rich_push",
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
		const ledgerEntry = ledgerTask("alpha", "remote-task-1", "alpha_parent");
		ledgerEntry.metadata = {
			...ledgerEntry.metadata,
			swarmId: "swarm_rich_push",
		};
		const ledger = { tasks: [ledgerEntry] } satisfies A2ATaskLedgerFile;
		const signalKey = a2aPushSignalKey("alpha", "remote-task-1");

		const incompleteAudit = buildA2ACompletionAudit({
			swarm,
			ledger,
			pushSignals: new Map([
				[
					signalKey,
					{
						statusUpdateTerminal: true,
						taskTerminal: true,
					},
				],
			]),
		});
		expect(incompleteAudit.complete).toBe(false);
		expect(incompleteAudit.lanes[0]).toEqual(
			expect.objectContaining({
				signals: expect.objectContaining({ push: false }),
				missingSignals: ["push"],
			}),
		);

		const completeAudit = buildA2ACompletionAudit({
			swarm,
			ledger,
			pushSignals: new Map([
				[
					signalKey,
					{
						statusUpdateTerminal: true,
						artifactUpdate: true,
						taskTerminal: true,
					},
				],
			]),
		});
		expect(completeAudit.complete).toBe(true);
		expect(completeAudit.lanes[0]?.missingSignals).toEqual([]);
		expect(completeAudit.counts.pushCoveredLanes).toBe(1);
	});

	it("rejects correlation signals when ledger metadata points at a different parent task", () => {
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
			pushSignalKeys: new Set([a2aPushSignalKey("alpha", "remote-task-1")]),
		});

		expect(audit.complete).toBe(false);
		expect(audit.counts.completeLanes).toBe(0);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				parentTaskId: "alpha_parent",
				laneId: a2aDelegationLaneId("alpha", "alpha_parent"),
				signals: expect.objectContaining({
					status: true,
					artifact: true,
					task: true,
					workGraph: true,
					push: true,
					correlation: false,
				}),
				missingSignals: ["correlation"],
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
			pushSignalKeys: new Set([a2aPushSignalKey("alpha", "remote-task-1")]),
		});

		expect(audit.complete).toBe(true);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				laneId: a2aDelegationLaneId("alpha", "failed_parent"),
				parentTaskId: "failed_parent",
				signals: expect.objectContaining({
					correlation: true,
				}),
				missingSignals: [],
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
			pushSignalKeys: new Set([a2aPushSignalKey("alpha", "remote-task-1")]),
		});

		expect(audit.complete).toBe(true);
		expect(audit.counts.remoteLanes).toBe(1);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				laneId: a2aDelegationLaneId("alpha", "failed_parent"),
				parentTaskId: "failed_parent",
				peer: "alpha",
				a2aTaskId: "remote-task-1",
				missingSignals: [],
			}),
		);
	});

	it("keeps telemetry lane ids when ledger parent metadata is missing", () => {
		const lane = remoteLane(
			"lane_alpha",
			"alpha",
			"remote-task-1",
			"old_parent",
		);
		lane.completedTasks = [];
		const a2a = lane.a2a;
		if (!a2a) {
			throw new Error("remoteLane test helper must create A2A metadata");
		}
		lane.a2a = {
			...a2a,
			parentTaskId: "current_parent",
		};
		const ledgerEntry = ledgerTask("alpha", "remote-task-1", "missing_parent");
		ledgerEntry.metadata = {
			swarmId: "swarm_missing_parent_metadata",
			transport: "a2a",
		};

		const audit = buildA2ACompletionAudit({
			swarm: {
				id: "swarm_missing_parent_metadata",
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
				failedTasks: new Set(),
				startedAt: Date.now(),
			},
			ledger: { tasks: [ledgerEntry] },
			pushSignalKeys: new Set([a2aPushSignalKey("alpha", "remote-task-1")]),
		});

		expect(audit.complete).toBe(false);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				laneId: a2aDelegationLaneId("alpha", "current_parent"),
				parentTaskId: "current_parent",
				signals: expect.objectContaining({
					status: true,
					artifact: true,
					task: true,
					workGraph: true,
					push: true,
					correlation: false,
				}),
				missingSignals: ["correlation"],
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
			pushSignalKeys: new Set([
				a2aPushSignalKey("alpha", "remote-task-current"),
			]),
		});

		expect(audit.complete).toBe(true);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				laneId: a2aDelegationLaneId("alpha", "current_parent"),
				parentTaskId: "current_parent",
				missingSignals: [],
				signals: expect.objectContaining({
					correlation: true,
				}),
			}),
		);
	});

	it("uses shared completed-state helpers for succeeded parent selection", () => {
		const lane = remoteLane(
			"lane_alpha",
			"alpha",
			"remote-task-succeeded",
			"old_parent",
		);
		lane.completedTasks = ["old_parent"];
		const ledgerEntry = ledgerTask(
			"alpha",
			"remote-task-succeeded",
			"current_parent",
		);
		ledgerEntry.state = "SUCCEEDED";
		ledgerEntry.metadata = {
			...ledgerEntry.metadata,
			swarmId: "swarm_succeeded_parent",
		};

		const audit = buildA2ACompletionAudit({
			swarm: {
				id: "swarm_succeeded_parent",
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
				completedTasks: new Set(["old_parent"]),
				failedTasks: new Set(),
				startedAt: Date.now(),
			},
			ledger: { tasks: [ledgerEntry] },
			pushSignalKeys: new Set([
				a2aPushSignalKey("alpha", "remote-task-succeeded"),
			]),
		});

		expect(audit.complete).toBe(false);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				laneId: a2aDelegationLaneId("alpha", "old_parent"),
				parentTaskId: "old_parent",
				status: "SUCCEEDED",
				missingSignals: ["correlation"],
			}),
		);
	});

	it("keeps action-required lanes incomplete even when evidence is present", () => {
		const ledgerEntry = ledgerTask(
			"alpha",
			"remote-task-input",
			"parent_input",
		);
		ledgerEntry.state = "input-required";
		ledgerEntry.metadata = {
			...ledgerEntry.metadata,
			swarmId: "swarm_input_required",
		};

		const audit = buildA2ACompletionAudit({
			swarm: {
				id: "swarm_input_required",
				status: "completed",
				config: {
					teammateCount: 1,
					planFile: "/tmp/plan.md",
					tasks: [],
					cwd: "/tmp",
				},
				teammates: [
					remoteLane(
						"lane_alpha",
						"alpha",
						"remote-task-input",
						"parent_input",
					),
				],
				pendingTasks: [],
				activeTasks: new Map(),
				completedTasks: new Set(["parent_input"]),
				failedTasks: new Set(),
				startedAt: Date.now(),
			},
			ledger: { tasks: [ledgerEntry] },
			pushSignalKeys: new Set([a2aPushSignalKey("alpha", "remote-task-input")]),
		});

		expect(audit.complete).toBe(false);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				terminal: false,
				status: "input-required",
				missingSignals: [],
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
			pushSignalKeys: new Set([
				a2aPushSignalKey("alpha", "remote-task-current"),
			]),
		});

		expect(audit.complete).toBe(true);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				laneId: a2aDelegationLaneId("alpha", "current_parent"),
				parentTaskId: "current_parent",
				status: "TASK_STATE_FAILED",
				missingSignals: [],
				signals: expect.objectContaining({
					correlation: true,
				}),
			}),
		);
	});

	it("pinpoints incomplete terminal lane signals", () => {
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
		expect(audit.lanes[0]?.missingSignals).toEqual([
			"status",
			"artifact",
			"task",
			"workGraph",
			"transcript",
			"push",
			"correlation",
		]);
	});

	it("uses shared ledger evidence gaps for artifact and work graph readiness", () => {
		const swarm = {
			id: "swarm_evidence_gap",
			status: "completed",
			config: {
				teammateCount: 1,
				planFile: "/tmp/plan.md",
				tasks: [],
				cwd: "/tmp",
			},
			teammates: [
				remoteLane("lane_alpha", "alpha", "remote-task-gap", "parent_gap"),
			],
			pendingTasks: [],
			activeTasks: new Map(),
			completedTasks: new Set(["parent_gap"]),
			failedTasks: new Set(),
			startedAt: Date.now(),
		} satisfies SwarmState;
		const ledgerEntry = ledgerTask("alpha", "remote-task-gap", "parent_gap");
		delete ledgerEntry.responseText;
		ledgerEntry.transcript = [
			{
				at: "2026-05-23T18:00:00.000Z",
				role: "agent",
				text: "agent-only transcript is not enough",
			},
		];
		ledgerEntry.workGraph = undefined;
		ledgerEntry.metadata = {
			...ledgerEntry.metadata,
			swarmId: "swarm_evidence_gap",
		};

		const audit = buildA2ACompletionAudit({
			swarm,
			ledger: { tasks: [ledgerEntry] },
			pushSignalKeys: new Set([a2aPushSignalKey("alpha", "remote-task-gap")]),
		});

		expect(audit.complete).toBe(false);
		expect(audit.lanes[0]).toEqual(
			expect.objectContaining({
				signals: expect.objectContaining({
					status: true,
					artifact: true,
					task: true,
					workGraph: false,
					transcript: false,
					push: true,
					correlation: true,
				}),
				missingSignals: ["workGraph", "transcript"],
			}),
		);
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
		transcript: [
			{
				at: "2026-05-23T18:00:00.000Z",
				role: "user",
				text: "review it",
			},
			{
				at: "2026-05-23T18:00:01.000Z",
				role: "agent",
				text: "done",
			},
		],
		createdAt: "2026-05-23T18:00:00.000Z",
		updatedAt: "2026-05-23T18:00:01.000Z",
		completedAt: "2026-05-23T18:00:01.000Z",
	};
}
