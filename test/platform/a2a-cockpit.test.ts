import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type A2ACockpitTaskStatus,
	buildA2ACockpit,
	summarizeA2ACockpit,
} from "../../src/platform/a2a-cockpit.js";
import type { A2AFleetSummary } from "../../src/platform/a2a-fleet.js";
import { matchesA2AOwnershipScope } from "../../src/platform/a2a-ownership.js";
import type {
	A2ATaskLedgerEntry,
	A2ATaskLedgerFile,
} from "../../src/platform/a2a-task-ledger.js";

describe("A2A cockpit", () => {
	it("does not let scope-key matches satisfy conflicting identity markers", () => {
		expect(
			matchesA2AOwnershipScope(
				{
					scopeKey: "workspace_ws-1__user_u-1",
					ownerSubject: "user:u-2",
				},
				{
					scopeKey: "workspace_ws-1__user_u-1",
					subject: "user:u-1",
					userId: "u-1",
				},
			),
		).toBe(false);
	});

	it("prioritizes actionable tasks and emits operator commands", () => {
		const summary = summarizeA2ACockpit({
			fleet: fleetSummary(),
			ledger: ledger([
				task({
					id: "completed-ledger",
					peer: "mac-mini",
					taskId: "task-done",
					state: "TASK_STATE_COMPLETED",
					text: "finished sweep",
					updatedAt: "2026-05-16T00:00:01.000Z",
				}),
				task({
					id: "running-ledger",
					peer: "mac-mini",
					taskId: "task-run",
					state: "TASK_STATE_WORKING",
					text: "run workspace checks",
					updatedAt: "2026-05-16T00:00:02.000Z",
				}),
				task({
					id: "waiting-ledger",
					peer: "linux-box",
					taskId: "task-wait",
					state: "TASK_STATE_INPUT_REQUIRED",
					text: "need approval",
					updatedAt: "2026-05-16T00:00:00.000Z",
				}),
				task({
					id: "failed-ledger",
					peer: "linux-box",
					taskId: "task-failed",
					state: "TASK_STATE_FAILED",
					text: "build failed",
					updatedAt: "2026-05-16T00:00:03.000Z",
				}),
			]),
			generatedAt: "2026-05-16T00:00:05.000Z",
		});

		expect(summary.generatedAt).toBe("2026-05-16T00:00:05.000Z");
		expect(summary.counts).toMatchObject({
			peers: 2,
			onlinePeers: 1,
			unreachablePeers: 1,
			tasks: 4,
			runningTasks: 1,
			actionRequiredTasks: 1,
			failedTasks: 1,
			completedTasks: 1,
		});
		expect(summary.tasks.map((entry) => entry.taskId)).toEqual([
			"task-wait",
			"task-failed",
			"task-run",
			"task-done",
		]);
		expect(statuses(summary.tasks)).toEqual([
			"waiting",
			"failed",
			"running",
			"completed",
		]);
		expect(summary.tasks[0]?.nextCommand).toBe(
			"maestro a2a reply linux-box task-wait <response> --wait --work-graph",
		);
		expect(summary.tasks[2]?.nextCommand).toBe(
			"maestro a2a wait mac-mini task-run --work-graph",
		);
		expect(summary.nextActions.map((action) => action.id)).toEqual([
			"reply:linux-box:task-wait",
			"refresh:linux-box:task-failed",
			"wait:mac-mini:task-run",
		]);
	});

	it("filters by peer and returns a fresh delegation action when idle", () => {
		const summary = summarizeA2ACockpit({
			fleet: fleetSummary(),
			ledger: ledger([
				task({
					id: "other-ledger",
					peer: "linux-box",
					taskId: "task-other",
					state: "TASK_STATE_INPUT_REQUIRED",
					text: "other task",
					updatedAt: "2026-05-16T00:00:01.000Z",
				}),
			]),
			peer: "mac-mini",
			limit: 1,
		});

		expect(summary.peer).toBe("mac-mini");
		expect(summary.counts).toMatchObject({
			peers: 1,
			onlinePeers: 1,
			tasks: 0,
		});
		expect(summary.tasks).toEqual([]);
		expect(summary.nextActions).toEqual([
			expect.objectContaining({
				id: "delegate:mac-mini",
				peer: "mac-mini",
				command:
					"maestro a2a delegate mac-mini <objective> --wait --work-graph",
			}),
		]);
	});

	it("retains ledger tasks when their peer is missing from the registry", () => {
		const summary = summarizeA2ACockpit({
			fleet: fleetSummary(),
			ledger: ledger([
				task({
					id: "orphan-ledger",
					peer: "retired-peer",
					taskId: "task-orphan",
					state: "TASK_STATE_INPUT_REQUIRED",
					text: "needs operator attention after peer rename",
					updatedAt: "2026-05-16T00:00:07.000Z",
				}),
				task({
					id: "current-ledger",
					peer: "mac-mini",
					taskId: "task-current",
					state: "TASK_STATE_COMPLETED",
					text: "current peer task",
					updatedAt: "2026-05-16T00:00:06.000Z",
				}),
			]),
		});

		expect(summary.peers.map((peer) => peer.name)).toEqual([
			"mac-mini",
			"linux-box",
		]);
		expect(summary.counts).toMatchObject({
			peers: 2,
			tasks: 2,
			actionRequiredTasks: 1,
			completedTasks: 1,
		});
		expect(summary.tasks.map((entry) => entry.taskId)).toEqual([
			"task-orphan",
			"task-current",
		]);
		expect(summary.tasks[0]).toMatchObject({
			peer: "retired-peer",
			orphanedPeer: true,
			status: "waiting",
		});
		expect(summary.tasks[0]?.nextCommand).toBeUndefined();
		expect(summary.tasks[1]?.orphanedPeer).toBeUndefined();
		expect(summary.nextActions).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					peer: "retired-peer",
					taskId: "task-orphan",
				}),
			]),
		);
		expect(summary.nextActions[0]).toMatchObject({
			id: "delegate:mac-mini",
			peer: "mac-mini",
		});
	});

	it("filters global A2A files by authenticated ownership metadata", () => {
		const summary = summarizeA2ACockpit({
			fleet: {
				...fleetSummary(),
				peers: [
					{
						name: "tenant-a",
						url: "http://127.0.0.1:4111",
						status: "online",
						workspaceId: "ws-1",
					},
					{
						name: "tenant-b",
						url: "http://127.0.0.1:4222",
						status: "online",
						workspaceId: "ws-2",
					},
					{
						name: "tenant-a-other-user",
						url: "http://127.0.0.1:4333",
						status: "online",
						workspaceId: "ws-1",
						ownerSubject: "user:u-2",
					},
					{
						name: "tenant-a-legacy-peer",
						url: "http://127.0.0.1:4444",
						status: "online",
						workspaceId: "ws-1",
					},
				],
			},
			ledger: ledger([
				task({
					id: "markerless-ledger",
					peer: "tenant-a",
					taskId: "task-markerless",
					state: "TASK_STATE_INPUT_REQUIRED",
					text: "legacy current-caller task without ownership markers",
					updatedAt: "2026-05-16T00:00:11.000Z",
				}),
				task({
					id: "markerless-other-user-ledger",
					peer: "tenant-a-other-user",
					taskId: "task-markerless-other-user",
					state: "TASK_STATE_INPUT_REQUIRED",
					text: "markerless task attached to another user's peer",
					updatedAt: "2026-05-16T00:00:12.000Z",
				}),
				task({
					id: "owned-ledger",
					peer: "tenant-a",
					taskId: "task-owned",
					state: "TASK_STATE_INPUT_REQUIRED",
					text: "needs scoped operator input",
					updatedAt: "2026-05-16T00:00:10.000Z",
					metadata: {
						ownerSubject: "user:u-1",
						workspaceId: "ws-1",
					},
				}),
				task({
					id: "other-workspace-ledger",
					peer: "tenant-b",
					taskId: "task-other-workspace",
					state: "TASK_STATE_INPUT_REQUIRED",
					text: "other workspace task",
					updatedAt: "2026-05-16T00:00:09.000Z",
					metadata: {
						ownerSubject: "user:u-1",
						workspaceId: "ws-2",
					},
				}),
				task({
					id: "legacy-workspace-ledger",
					peer: "tenant-a-legacy-peer",
					taskId: "task-legacy-workspace",
					state: "TASK_STATE_INPUT_REQUIRED",
					text: "legacy workspace-scoped task",
					updatedAt: "2026-05-16T00:00:07.000Z",
					metadata: {
						workspaceId: "ws-1",
					},
				}),
				task({
					id: "other-user-ledger",
					peer: "tenant-a-other-user",
					taskId: "task-other-user",
					state: "TASK_STATE_INPUT_REQUIRED",
					text: "other user task",
					updatedAt: "2026-05-16T00:00:08.000Z",
					metadata: {
						ownerSubject: "user:u-2",
						workspaceId: "ws-1",
					},
				}),
			]),
			ownershipScope: {
				subject: "user:u-1",
				userId: "u-1",
				workspaceId: "ws-1",
			},
		});

		expect(summary.peers.map((peer) => peer.name)).toEqual([
			"tenant-a",
			"tenant-a-legacy-peer",
		]);
		expect(summary.tasks.map((task) => task.taskId)).toEqual([
			"task-markerless",
			"task-owned",
			"task-legacy-workspace",
		]);
		expect(summary.nextActions.map((action) => action.peer)).toEqual([
			"tenant-a",
			"tenant-a",
			"tenant-a-legacy-peer",
		]);
		expect(summary.counts).toMatchObject({
			peers: 2,
			tasks: 3,
			actionRequiredTasks: 3,
		});
	});

	it("retains markerless shared-file tasks only for peers owned by the caller", async () => {
		const dir = await mkdtemp(join(tmpdir(), "a2a-cockpit-scope-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeFile(
			registryPath,
			JSON.stringify({
				peers: {
					"tenant-a": {
						url: "http://127.0.0.1:9",
						workspaceId: "ws-1",
					},
					"tenant-a-other-user": {
						url: "http://127.0.0.1:9",
						workspaceId: "ws-1",
						metadata: {
							ownerSubject: "user:u-2",
						},
					},
				},
			}),
		);
		await writeFile(
			tasksPath,
			JSON.stringify(
				ledger([
					task({
						id: "markerless-owned-peer-ledger",
						peer: "tenant-a",
						taskId: "task-markerless-owned-peer",
						state: "TASK_STATE_INPUT_REQUIRED",
						text: "legacy task on caller-owned peer",
						updatedAt: "2026-05-16T00:00:10.000Z",
					}),
					task({
						id: "markerless-other-user-peer-ledger",
						peer: "tenant-a-other-user",
						taskId: "task-markerless-other-user-peer",
						state: "TASK_STATE_INPUT_REQUIRED",
						text: "legacy task on another user's peer",
						updatedAt: "2026-05-16T00:00:11.000Z",
					}),
				]),
			),
		);

		const summary = await buildA2ACockpit({
			registryPath,
			tasksPath,
			timeoutMs: 1,
			ownershipScope: {
				subject: "user:u-1",
				userId: "u-1",
				workspaceId: "ws-1",
			},
		});

		expect(summary.tasks.map((entry) => entry.taskId)).toEqual([
			"task-markerless-owned-peer",
		]);
		expect(summary.peers.map((peer) => peer.name)).toEqual(["tenant-a"]);
	});
});

function fleetSummary(): A2AFleetSummary {
	return {
		generatedAt: "2026-05-16T00:00:04.000Z",
		registryPath: "/tmp/peers.json",
		tasksPath: "/tmp/tasks.json",
		peers: [
			{
				name: "mac-mini",
				displayName: "Mac Mini",
				url: "http://127.0.0.1:4111",
				status: "online",
			},
			{
				name: "linux-box",
				url: "http://127.0.0.1:4222",
				status: "unreachable",
				error: "connect ECONNREFUSED",
			},
		],
	};
}

function ledger(tasks: A2ATaskLedgerEntry[]): A2ATaskLedgerFile {
	return { tasks };
}

function task(
	overrides: Pick<
		A2ATaskLedgerEntry,
		"id" | "peer" | "taskId" | "state" | "text" | "updatedAt"
	> &
		Pick<Partial<A2ATaskLedgerEntry>, "metadata">,
): A2ATaskLedgerEntry {
	return {
		kind: "delegation",
		transcript: [],
		createdAt: overrides.updatedAt,
		...overrides,
	};
}

function statuses(
	tasks: Array<{ status: A2ACockpitTaskStatus }>,
): A2ACockpitTaskStatus[] {
	return tasks.map((task) => task.status);
}
