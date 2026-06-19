import { describe, expect, it } from "vitest";
import { buildAgentWorkBoard } from "../../src/agent/agent-work-board.js";
import type { MissionManifest } from "../../src/agent/mission-manifest.js";
import type { MissionStoreSnapshot } from "../../src/agent/mission-store.js";

describe("agent work board", () => {
	it("projects mission, a2a, todo, handoff, and github work into one board", () => {
		const mission: MissionManifest = {
			version: 1,
			missionId: "mission-1",
			milestones: [],
			createdAt: "2026-06-18T10:00:00.000Z",
			updatedAt: "2026-06-18T10:10:00.000Z",
			features: [
				{
					id: "feature-1",
					description: "Implement checkout retry",
					status: "passed",
					fulfills: ["checkout.retry"],
					handoff: {
						workerId: "worker-a",
						success: true,
						whatWasImplemented: "Retry path",
						whatWasLeftUndone: "none",
						verification: {
							commandsRun: [{ command: "npm test -- checkout" }],
						},
						handedOffAt: "2026-06-18T10:05:00.000Z",
					},
				},
				{
					id: "feature-2",
					description: "Verify checkout recovery in browser",
					status: "in-progress",
					fulfills: ["checkout.browser"],
				},
			],
		};

		const board = buildAgentWorkBoard(
			{
				missions: [mission],
				a2a: {
					generatedAt: "2026-06-18T10:30:00.000Z",
					registryPath: "registry.json",
					tasksPath: "tasks.json",
					counts: {
						peers: 1,
						onlinePeers: 1,
						unreachablePeers: 0,
						tasks: 1,
						runningTasks: 0,
						actionRequiredTasks: 1,
						failedTasks: 0,
						completedTasks: 0,
					},
					peers: [],
					tasks: [
						{
							ledgerId: "ledger-1",
							peer: "qa-peer",
							taskId: "task-1",
							state: "input-required",
							status: "waiting",
							requiresInput: true,
							terminal: false,
							final: false,
							text: "Need credentials",
							updatedAt: "2026-06-18T10:20:00.000Z",
						},
					],
					nextActions: [
						{
							id: "reply:qa-peer:task-1",
							label: "Reply to QA peer",
							command: "maestro a2a reply qa-peer task-1 RESPONSE",
							severity: "critical",
							peer: "qa-peer",
							taskId: "task-1",
							reason: "Input required",
						},
					],
				},
				todos: {
					"release-readiness": {
						goal: "Release readiness",
						updatedAt: "2026-06-18T10:25:00.000Z",
						items: [
							{
								id: "todo-1",
								content: "Attach QA video",
								status: "pending",
								priority: "high",
							},
						],
					},
				},
				githubTasks: [
					{
						id: "gh-1",
						title: "Open agent PR",
						status: "running",
						branch: "codex/agentic",
					},
				],
			},
			new Date("2026-06-18T10:30:00.000Z"),
		);

		expect(board.schemaVersion).toBe("evalops.maestro.agent-work-board.v1");
		expect(board.counts.total).toBe(5);
		expect(board.counts.waiting).toBe(1);
		expect(board.items[0]).toMatchObject({
			source: "a2a",
			status: "waiting",
			nextAction: { label: "Reply to QA peer" },
		});
		expect(board.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "mission:mission-1:feature-1",
					status: "completed",
					evidence: [
						{ kind: "verification-command", label: "npm test -- checkout" },
					],
				}),
				expect.objectContaining({
					id: "todo:Release readiness:todo-1",
					status: "pending",
				}),
			]),
		);
	});

	it("projects durable mission snapshots into blocked customer work", () => {
		const mission: MissionStoreSnapshot = {
			schemaVersion: "evalops.maestro.mission-store.v1",
			missionId: "deep",
			title: "Deep mission",
			state: "blocked",
			features: [],
			progressLog: [
				{
					type: "mission_blocked",
					timestamp: "2026-06-19T00:00:00.000Z",
					message: "Waiting on deploy credentials",
				},
				{
					type: "note",
					timestamp: "2026-06-19T00:05:00.000Z",
					message: "Pinged the platform team for an update",
				},
			],
			workerSessionIds: ["worker-1"],
			workerStates: {},
			tokenUsageBySessionId: {},
			createdAt: "2026-06-19T00:00:00.000Z",
			updatedAt: "2026-06-19T00:05:00.000Z",
		};

		const board = buildAgentWorkBoard({ missionSnapshots: [mission] });

		expect(board.items).toEqual([
			expect.objectContaining({
				id: "mission-store:deep:blocked",
				status: "blocked",
				blockers: ["Waiting on deploy credentials"],
				evidence: [{ kind: "worker-session", label: "worker-1" }],
			}),
		]);
	});

	it("projects durable mission snapshot handoff continuity", () => {
		const mission: MissionStoreSnapshot = {
			schemaVersion: "evalops.maestro.mission-store.v1",
			missionId: "deep",
			title: "Deep mission",
			state: "ready",
			features: [
				{
					id: "feature-1",
					description: "Implement hosted checkout",
					status: "passed",
					fulfills: [],
					handoff: {
						workerId: "worker-1",
						success: true,
						whatWasImplemented: "Checkout path",
						whatWasLeftUndone: "Run hosted checkout QA.",
						handedOffAt: "2026-06-19T00:05:00.000Z",
					},
				},
			],
			progressLog: [],
			workerSessionIds: ["worker-1"],
			workerStates: {},
			tokenUsageBySessionId: {},
			createdAt: "2026-06-19T00:00:00.000Z",
			updatedAt: "2026-06-19T00:06:00.000Z",
		};

		const board = buildAgentWorkBoard({ missionSnapshots: [mission] });

		expect(board.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "mission-store:deep:handoff:feature-1:unfinished_work:unfinished_work:run hosted checkout qa.",
					status: "blocked",
					title: "Run hosted checkout QA.",
					blockers: ["Unresolved mission handoff item"],
				}),
			]),
		);
	});

	it("prefers durable mission snapshots over duplicate manifests", () => {
		const manifest: MissionManifest = {
			version: 1,
			missionId: "deep",
			milestones: [],
			createdAt: "2026-06-18T10:00:00.000Z",
			updatedAt: "2026-06-18T10:10:00.000Z",
			features: [
				{
					id: "feature-1",
					description: "Manifest feature row",
					status: "in-progress",
					fulfills: ["deep.feature"],
				},
			],
		};
		const snapshot: MissionStoreSnapshot = {
			schemaVersion: "evalops.maestro.mission-store.v1",
			missionId: "deep",
			title: "Deep mission",
			state: "blocked",
			features: [
				{
					id: "feature-1",
					description: "Snapshot feature row",
					status: "in-progress",
					fulfills: ["deep.feature"],
				},
			],
			progressLog: [
				{
					type: "mission_blocked",
					timestamp: "2026-06-19T00:00:00.000Z",
					message: "Waiting on deploy credentials",
				},
			],
			workerSessionIds: ["worker-1"],
			workerStates: {},
			tokenUsageBySessionId: {},
			createdAt: "2026-06-19T00:00:00.000Z",
			updatedAt: "2026-06-19T00:00:00.000Z",
		};

		const board = buildAgentWorkBoard({
			missions: [manifest],
			missionSnapshots: [snapshot],
		});

		expect(board.items).toEqual([
			expect.objectContaining({
				id: "mission-store:deep:blocked",
			}),
			expect.objectContaining({
				id: "mission-store:deep:feature-1",
				title: "Snapshot feature row",
			}),
		]);
	});

	it("deduplicates manifests against normalized durable mission ids", () => {
		const manifest: MissionManifest = {
			version: 1,
			missionId: "Deep Mission",
			milestones: [],
			createdAt: "2026-06-18T10:00:00.000Z",
			updatedAt: "2026-06-18T10:10:00.000Z",
			features: [
				{
					id: "feature-1",
					description: "Manifest feature row",
					status: "in-progress",
					fulfills: ["deep.feature"],
				},
			],
		};
		const snapshot: MissionStoreSnapshot = {
			schemaVersion: "evalops.maestro.mission-store.v1",
			missionId: "Deep-Mission",
			title: "Deep mission",
			state: "ready",
			features: [
				{
					id: "feature-1",
					description: "Snapshot feature row",
					status: "pending",
					fulfills: ["deep.feature"],
				},
			],
			progressLog: [],
			workerSessionIds: [],
			workerStates: {},
			tokenUsageBySessionId: {},
			createdAt: "2026-06-19T00:00:00.000Z",
			updatedAt: "2026-06-19T00:00:00.000Z",
		};

		const board = buildAgentWorkBoard({
			missions: [manifest],
			missionSnapshots: [snapshot],
		});

		expect(board.items).toEqual([
			expect.objectContaining({
				id: "mission-store:Deep-Mission:feature-1",
				title: "Snapshot feature row",
			}),
		]);
	});

	it("keeps handoff continuity rows for durable mission snapshots", () => {
		const snapshot: MissionStoreSnapshot = {
			schemaVersion: "evalops.maestro.mission-store.v1",
			missionId: "deep",
			title: "Deep mission",
			state: "ready",
			features: [
				{
					id: "feature-1",
					description: "Shipped feature",
					status: "passed",
					fulfills: [],
					handoff: {
						workerId: "worker-1",
						success: true,
						whatWasLeftUndone: "Follow up with ops for credentials",
						handedOffAt: "2026-06-19T00:01:00.000Z",
					},
				},
			],
			progressLog: [],
			workerSessionIds: [],
			workerStates: {},
			tokenUsageBySessionId: {},
			createdAt: "2026-06-19T00:00:00.000Z",
			updatedAt: "2026-06-19T00:02:00.000Z",
		};

		const board = buildAgentWorkBoard({ missionSnapshots: [snapshot] });

		expect(board.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "mission-store:deep:feature-1",
					title: "Shipped feature",
				}),
				expect.objectContaining({
					id: "mission-store:deep:handoff:feature-1:unfinished_work:unfinished_work:follow up with ops for credentials",
					status: "blocked",
					title: "Follow up with ops for credentials",
					blockers: ["Unresolved mission handoff item"],
				}),
			]),
		);
	});

	it("matches A2A next actions by peer and task id", () => {
		const board = buildAgentWorkBoard(
			{
				a2a: {
					generatedAt: "2026-06-18T10:30:00.000Z",
					registryPath: "registry.json",
					tasksPath: "tasks.json",
					counts: {
						peers: 2,
						onlinePeers: 2,
						unreachablePeers: 0,
						tasks: 2,
						runningTasks: 0,
						actionRequiredTasks: 2,
						failedTasks: 0,
						completedTasks: 0,
					},
					peers: [],
					tasks: [
						{
							ledgerId: "ledger-a",
							peer: "peer-a",
							taskId: "shared-task",
							state: "input-required",
							status: "waiting",
							requiresInput: true,
							terminal: false,
							final: false,
							text: "Peer A needs input",
						},
						{
							ledgerId: "ledger-b",
							peer: "peer-b",
							taskId: "shared-task",
							state: "input-required",
							status: "waiting",
							requiresInput: true,
							terminal: false,
							final: false,
							text: "Peer B needs input",
						},
					],
					nextActions: [
						{
							id: "reply:peer-a:shared-task",
							label: "Reply to peer A",
							command: "maestro a2a reply peer-a shared-task RESPONSE",
							severity: "critical",
							peer: "peer-a",
							taskId: "shared-task",
							reason: "Input required",
						},
						{
							id: "reply:peer-b:shared-task",
							label: "Reply to peer B",
							command: "maestro a2a reply peer-b shared-task RESPONSE",
							severity: "critical",
							peer: "peer-b",
							taskId: "shared-task",
							reason: "Input required",
						},
					],
				},
			},
			new Date("2026-06-18T10:30:00.000Z"),
		);

		expect(
			board.items.find((item) => item.id === "a2a:peer-a:shared-task")
				?.nextAction,
		).toEqual({ label: "Reply to peer A", command: expect.any(String) });
		expect(
			board.items.find((item) => item.id === "a2a:peer-b:shared-task")
				?.nextAction,
		).toEqual({ label: "Reply to peer B", command: expect.any(String) });
	});

	it("labels handoff-derived work separately from todo items", () => {
		const board = buildAgentWorkBoard(
			{
				handoffs: [
					{
						sessionId: "session-1",
						title: "Continue checkout follow-up",
						status: "needs-followup",
						nextAction: "Resume the checkout session",
						blockers: [],
						evidence: {
							sessionPath: "/tmp/session-1.jsonl",
							updatedAt: "2026-06-18T10:20:00.000Z",
						},
					},
				],
				openWork: [
					{
						goal: "Checkout QA",
						id: "open-1",
						content: "Capture updated repro video",
						status: "pending",
						priority: "medium",
						updatedAt: "2026-06-18T10:25:00.000Z",
						blockers: [],
					},
				],
			},
			new Date("2026-06-18T10:30:00.000Z"),
		);

		expect(board.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "handoff:session-1",
					source: "handoff",
					status: "waiting",
				}),
				expect.objectContaining({
					id: "open-work:Checkout QA:open-1",
					source: "handoff",
					status: "pending",
				}),
			]),
		);
	});
});
