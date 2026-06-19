import {
	mkdir,
	mkdtemp,
	readFile,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	a2aTaskEvidenceGaps,
	getA2ATaskLedgerPath,
	isAuditReadyA2ADelegationTask,
	isFinalA2AState,
	isTerminalA2AState,
	loadA2ATaskLedger,
	normalizeA2AState,
	recordA2ATaskReply,
	recordA2ATaskStart,
	summarizeA2ATaskLedger,
	updateA2ATaskInLedger,
} from "../../src/platform/a2a-task-ledger.js";

const NOW = new Date("2026-05-16T00:00:00.000Z");
const LATER = new Date("2026-05-16T00:01:00.000Z");

describe("A2A task ledger", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("classifies terminal states without substring success matches", () => {
		expect(isFinalA2AState("TASK_STATE_COMPLETED")).toBe(true);
		expect(isFinalA2AState("SUCCEEDED")).toBe(true);
		expect(isFinalA2AState("SUCCESS")).toBe(true);
		expect(normalizeA2AState(" TASK_STATE_COMPLETED ")).toBe(
			"TASK_STATE_COMPLETED",
		);
		expect(isFinalA2AState(" TASK_STATE_COMPLETED ")).toBe(true);
		expect(isFinalA2AState("TASK_STATE_FAILED")).toBe(true);
		expect(isTerminalA2AState("input-required")).toBe(true);
		expect(isTerminalA2AState("\ninput-required\t")).toBe(true);
		expect(isFinalA2AState("UNSUCCESSFUL")).toBe(false);
		expect(isFinalA2AState("TASK_STATE_UNSUCCESSFUL")).toBe(false);
	});

	it("summarizes audit-ready delegated work from shared evidence gates", () => {
		const tasks = [
			{
				id: "ledger-ready",
				kind: "delegation" as const,
				peer: "builder",
				taskId: "task-ready",
				text: "ship the valuable thing",
				state: "SUCCEEDED",
				responseText: "done",
				workGraph: {
					state: "completed",
					itemCount: 1,
					activeItemCount: 0,
					blockedItemCount: 0,
					waitingItemCount: 0,
					pendingToolCallCount: 0,
					childRunCount: 1,
					childRunIds: ["agent_run_child_1"],
					toolCallCount: 0,
					toolExecutionIds: [],
					waitItemCount: 0,
					waitIds: [],
				},
				transcript: [
					{ at: NOW.toISOString(), role: "user" as const, text: "go" },
					{ at: LATER.toISOString(), role: "agent" as const, text: "done" },
				],
				createdAt: NOW.toISOString(),
				updatedAt: LATER.toISOString(),
				completedAt: LATER.toISOString(),
			},
			{
				id: "ledger-one-sided",
				kind: "delegation" as const,
				peer: "builder",
				taskId: "task-one-sided",
				text: "finish with evidence",
				state: "TASK_STATE_COMPLETED",
				responseText: "done",
				workGraph: {
					state: "completed",
					itemCount: 1,
					activeItemCount: 0,
					blockedItemCount: 0,
					waitingItemCount: 0,
					pendingToolCallCount: 0,
					childRunCount: 0,
					childRunIds: [],
					toolCallCount: 0,
					toolExecutionIds: [],
					waitItemCount: 0,
					waitIds: [],
				},
				transcript: [
					{ at: NOW.toISOString(), role: "user" as const, text: "go" },
					{ at: LATER.toISOString(), role: "user" as const, text: "again" },
				],
				createdAt: NOW.toISOString(),
				updatedAt: LATER.toISOString(),
				completedAt: LATER.toISOString(),
			},
			{
				id: "ledger-message",
				kind: "message" as const,
				peer: "builder",
				taskId: "task-message",
				text: "status",
				state: "TASK_STATE_COMPLETED",
				responseText: "ok",
				workGraph: {
					state: "completed",
					itemCount: 1,
					activeItemCount: 0,
					blockedItemCount: 0,
					waitingItemCount: 0,
					pendingToolCallCount: 0,
					childRunCount: 0,
					childRunIds: [],
					toolCallCount: 0,
					toolExecutionIds: [],
					waitItemCount: 0,
					waitIds: [],
				},
				transcript: [
					{ at: NOW.toISOString(), role: "user" as const, text: "status" },
					{ at: LATER.toISOString(), role: "agent" as const, text: "ok" },
				],
				createdAt: NOW.toISOString(),
				updatedAt: LATER.toISOString(),
				completedAt: LATER.toISOString(),
			},
		];

		expect(isAuditReadyA2ADelegationTask(tasks[0]!)).toBe(true);
		const { responseText: _responseText, ...transcriptOnlyResponse } =
			tasks[0]!;
		expect(a2aTaskEvidenceGaps(transcriptOnlyResponse)).toEqual([]);
		expect(a2aTaskEvidenceGaps(tasks[1]!)).toEqual(["transcript"]);
		expect(isAuditReadyA2ADelegationTask(tasks[2]!)).toBe(false);
		expect(summarizeA2ATaskLedger(tasks)).toMatchObject({
			taskCount: 3,
			delegatedTaskCount: 2,
			completedTaskCount: 3,
			auditReadyTaskCount: 1,
			evidenceGapCount: 1,
			transcriptMessageCount: 6,
		});
	});

	it("normalizes protocol transcript agent roles when loading ledgers", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-protocol-role-")),
			"tasks.json",
		);
		await writeFile(
			path,
			`${JSON.stringify(
				{
					tasks: [
						{
							id: "ledger-protocol-role",
							kind: "delegation",
							peer: "builder",
							taskId: "task-protocol-role",
							text: "ship the valuable thing",
							state: "TASK_STATE_COMPLETED",
							responseText: "done",
							workGraph: {
								state: "completed",
								childRunIds: ["agent_run_child_1"],
								toolExecutionIds: [],
								waitIds: [],
							},
							transcript: [
								{
									at: NOW.toISOString(),
									role: "ROLE_USER",
									text: "go",
								},
								{
									at: LATER.toISOString(),
									role: "ROLE_AGENT",
									text: "done",
								},
							],
							createdAt: NOW.toISOString(),
							updatedAt: LATER.toISOString(),
							completedAt: LATER.toISOString(),
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const ledger = await loadA2ATaskLedger({ path });

		expect(ledger.tasks[0]?.transcript.map((entry) => entry.role)).toEqual([
			"user",
			"agent",
		]);
		expect(isAuditReadyA2ADelegationTask(ledger.tasks[0]!)).toBe(true);
		expect(summarizeA2ATaskLedger(ledger.tasks).auditReadyTaskCount).toBe(1);
	});

	it("hydrates Rust-style embedded task evidence when top-level fields are missing", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-rust-embedded-")),
			"tasks.json",
		);
		await writeFile(
			path,
			`${JSON.stringify(
				{
					tasks: [
						{
							id: "maestro-control-plane-task-rust",
							kind: "delegation",
							peer: "maestro-control-plane",
							taskId: "task-rust",
							contextId: "ctx-rust",
							text: "delegate through Rust",
							state: "TASK_STATE_COMPLETED",
							workGraph: {},
							transcript: [
								{
									at: NOW.toISOString(),
									role: "ROLE_USER",
									text: "go",
								},
								{
									at: LATER.toISOString(),
									role: "ROLE_AGENT",
									text: "done",
									messageId: "agent-message",
								},
							],
							createdAt: NOW.toISOString(),
							updatedAt: LATER.toISOString(),
							completedAt: LATER.toISOString(),
							a2aTask: {
								id: "task-rust",
								contextId: "ctx-rust",
								status: {
									state: "TASK_STATE_WORKING",
									message: {
										messageId: "agent-message",
										role: "ROLE_AGENT",
										parts: [{ text: "stale done" }],
									},
								},
								history: [
									{
										messageId: "user-message",
										role: "ROLE_USER",
										parts: [{ text: "go" }],
									},
									{
										messageId: "agent-message",
										role: "ROLE_AGENT",
										parts: [{ text: "stale done" }],
									},
									{
										messageId: "agent-followup",
										role: "ROLE_AGENT",
										parts: [{ text: "also done" }],
									},
								],
								metadata: {
									workGraph: {
										state: "completed",
										childRunIds: ["a2a-task:task-rust"],
										toolExecutionIds: [],
										waitIds: [],
									},
								},
							},
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const ledger = await loadA2ATaskLedger({ path });
		const task = ledger.tasks[0]!;

		expect(task.responseText).toBe("done");
		expect(task.workGraph?.childRunIds).toEqual(["a2a-task:task-rust"]);
		expect(task.transcript.map((entry) => entry.role)).toEqual([
			"user",
			"agent",
			"agent",
		]);
		expect(task.transcript.map((entry) => entry.text)).toEqual([
			"go",
			"done",
			"also done",
		]);
		expect(task.transcript.at(-1)?.state).toBe("TASK_STATE_COMPLETED");
		expect(a2aTaskEvidenceGaps(task)).toEqual([]);
		expect(isAuditReadyA2ADelegationTask(task)).toBe(true);
	});

	it("hydrates response text from merged embedded history before stale embedded status", async () => {
		const path = join(
			await mkdtemp(
				join(tmpdir(), "maestro-a2a-ledger-rust-history-response-"),
			),
			"tasks.json",
		);
		await writeFile(
			path,
			`${JSON.stringify(
				{
					tasks: [
						{
							id: "maestro-control-plane-task-history-response",
							kind: "delegation",
							peer: "maestro-control-plane",
							taskId: "task-history-response",
							contextId: "ctx-history-response",
							text: "delegate through Rust",
							state: "TASK_STATE_COMPLETED",
							transcript: [],
							createdAt: NOW.toISOString(),
							updatedAt: LATER.toISOString(),
							completedAt: LATER.toISOString(),
							a2aTask: {
								id: "task-history-response",
								contextId: "ctx-history-response",
								status: {
									state: "TASK_STATE_WORKING",
									message: {
										messageId: "agent-history-response",
										role: "ROLE_AGENT",
										parts: [{ text: "stale status response" }],
									},
								},
								history: [
									{
										messageId: "user-history-response",
										role: "ROLE_USER",
										parts: [{ text: "go" }],
									},
									{
										messageId: "agent-history-response",
										role: "ROLE_AGENT",
										parts: [{ text: "history response wins" }],
									},
								],
								metadata: {
									workGraph: {
										state: "completed",
										childRunIds: ["a2a-task:task-history-response"],
										toolExecutionIds: [],
										waitIds: [],
									},
								},
							},
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const ledger = await loadA2ATaskLedger({ path });
		const task = ledger.tasks[0]!;

		expect(task.responseText).toBe("history response wins");
		expect(task.transcript.map((entry) => entry.text)).toEqual([
			"go",
			"history response wins",
		]);
		expect(task.transcript.at(-1)?.state).toBe("TASK_STATE_COMPLETED");
		expect(a2aTaskEvidenceGaps(task)).toEqual([]);
	});

	it("records delegated task transcripts using the migration env alias", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-")),
			"tasks.json",
		);
		vi.stubEnv("CODEX_A2A_TASKS_FILE", path);

		await recordA2ATaskStart({
			peer: "dev-desktop",
			task: {
				id: "task-dev-1",
				status: { state: "TASK_STATE_SUBMITTED" },
				metadata: {
					workGraph: {
						state: "waiting",
						itemCount: "3",
						activeItemCount: 3,
						childRunCount: 1,
						childRunIds: ["agent_run_child_1", ""],
						toolCallCount: 2,
						pendingToolCallCount: 1,
						toolExecutionIds: ["tool_exec_1"],
						waitItemCount: 1,
						waitIds: ["thread_child_1"],
						stateCounts: {
							AGENT_WORK_ITEM_STATE_WAITING: "1",
						},
						correlationPath:
							"platform_agent_run_id=run_1 active_work_items=3 blocked_work_items=0 child_runs=1",
						codexSubagents: {
							edgeCount: "1",
							edges: [
								{
									spawnToolCallId: "toolu_spawn_child",
									waitToolCallId: "toolu_wait_child",
									childRunId: "agent_run_child_1",
									threadId: "thread_child_1",
									operation: "spawn_agent",
									status: "running",
								},
								{
									operation: "missing_ids",
									status: "ignored",
								},
							],
							childRunIds: ["agent_run_child_1"],
							toolCallIds: ["toolu_spawn_child", "toolu_wait_child"],
							threadIds: ["thread_child_1"],
						},
					},
				},
			},
			text: "run the full checks",
			messageId: "message-1",
			kind: "delegation",
			role: "heavy-builder",
			cwd: "/repo",
			now: NOW,
		});
		await updateA2ATaskInLedger({
			peer: "dev-desktop",
			task: {
				id: "task-dev-1",
				status: {
					state: "TASK_STATE_COMPLETED",
					message: {
						messageId: "agent-message-1",
						role: "ROLE_AGENT",
						parts: [{ text: "checks passed", mediaType: "text/plain" }],
					},
				},
			},
			now: LATER,
		});

		expect(getA2ATaskLedgerPath()).toBe(path);
		await expect(loadA2ATaskLedger()).resolves.toMatchObject({
			tasks: [
				{
					peer: "dev-desktop",
					taskId: "task-dev-1",
					state: "TASK_STATE_COMPLETED",
					responseText: "checks passed",
					transcript: [
						{ role: "user", text: "run the full checks" },
						{ role: "agent", text: "checks passed" },
					],
					workGraph: {
						state: "waiting",
						itemCount: 3,
						childRunIds: ["agent_run_child_1"],
						codexSubagents: {
							edgeCount: 1,
							threadIds: ["thread_child_1"],
							edges: [
								{
									childRunId: "agent_run_child_1",
									operation: "spawn_agent",
									status: "running",
								},
							],
						},
					},
				},
			],
		});
		const raw = await readFile(path, "utf8");
		expect(raw).toContain("heavy-builder");
		expect(raw).not.toContain("Bearer ");
	});

	it("normalizes protocol transcript roles when loading ledger files", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-import-")),
			"tasks.json",
		);
		await writeFile(
			path,
			`${JSON.stringify(
				{
					tasks: [
						{
							id: "ledger-import-1",
							kind: "delegation",
							peer: "dev-desktop",
							taskId: "task-import-1",
							text: "run the checks",
							state: "TASK_STATE_COMPLETED",
							responseText: "checks passed",
							workGraph: {
								state: "completed",
								itemCount: 1,
								activeItemCount: 0,
								blockedItemCount: 0,
								waitingItemCount: 0,
								pendingToolCallCount: 0,
								childRunCount: 1,
								childRunIds: ["agent_run_child_1"],
								toolCallCount: 0,
								toolExecutionIds: [],
								waitItemCount: 0,
								waitIds: [],
							},
							transcript: [
								{
									at: NOW.toISOString(),
									role: "ROLE_USER",
									text: "run the checks",
								},
								{
									at: LATER.toISOString(),
									role: "ROLE_AGENT",
									text: "checks passed",
								},
							],
							createdAt: NOW.toISOString(),
							updatedAt: LATER.toISOString(),
							completedAt: LATER.toISOString(),
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const ledger = await loadA2ATaskLedger({ path });
		expect(ledger.tasks[0]).toMatchObject({
			transcript: [
				{ role: "user", text: "run the checks" },
				{ role: "agent", text: "checks passed" },
			],
		});
		expect(a2aTaskEvidenceGaps(ledger.tasks[0]!)).toEqual([]);
		expect(isAuditReadyA2ADelegationTask(ledger.tasks[0]!)).toBe(true);
	});

	it("does not treat echoed user history as agent response text", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-history-")),
			"tasks.json",
		);

		const result = await recordA2ATaskStart({
			path,
			peer: "mac-mini",
			task: {
				id: "task-mac-1",
				status: { state: "TASK_STATE_SUBMITTED" },
				history: [
					{
						messageId: "message-1",
						role: "ROLE_USER",
						parts: [{ text: "run --json checks", mediaType: "text/plain" }],
					},
				],
			},
			text: "run --json checks",
			now: NOW,
		});

		expect(result.entry.responseText).toBeUndefined();
		expect(result.entry.transcript).toEqual([
			expect.objectContaining({
				role: "user",
				text: "run --json checks",
			}),
		]);
	});

	it("keeps safe task metadata across task refreshes without token-like fields", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-metadata-")),
			"tasks.json",
		);

		await recordA2ATaskStart({
			path,
			peer: "mac-mini",
			task: {
				id: "task-metadata-1",
				status: { state: "TASK_STATE_SUBMITTED" },
				metadata: {
					agentRunId: "run_1",
					traceparent:
						"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
					totalTokens: 42,
					totalToken: 43,
					tokenCount: 44,
					apiToken: "do-not-write",
					nested: { ignored: true },
				},
			},
			text: "run the traceable smoke",
			metadata: {
				requestKind: "maestro-peer-message",
			},
			now: NOW,
		});
		await updateA2ATaskInLedger({
			path,
			peer: "mac-mini",
			task: {
				id: "task-metadata-1",
				status: { state: "TASK_STATE_COMPLETED" },
				metadata: {
					worker: "mac-mini",
					bearer: "do-not-write",
				},
			},
			now: LATER,
		});

		const ledger = await loadA2ATaskLedger({ path });
		expect(ledger.tasks[0]?.metadata).toMatchObject({
			agentRunId: "run_1",
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			requestKind: "maestro-peer-message",
			worker: "mac-mini",
			totalTokens: 42,
			totalToken: 43,
			tokenCount: 44,
		});
		expect(ledger.tasks[0]?.metadata).not.toHaveProperty("apiToken");
		expect(ledger.tasks[0]?.metadata).not.toHaveProperty("bearer");
		expect(JSON.stringify(ledger.tasks[0])).not.toContain("do-not-write");
	});

	it("records task replies without marking action-required states completed", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-reply-")),
			"tasks.json",
		);

		await recordA2ATaskStart({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-2",
				contextId: "context-dev-2",
				status: { state: "TASK_STATE_INPUT_REQUIRED" },
			},
			text: "review the branch",
			messageId: "message-1",
			now: NOW,
		});
		await recordA2ATaskReply({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-2",
				contextId: "context-dev-2",
				status: { state: "TASK_STATE_WORKING" },
				history: [
					{
						messageId: "agent-message-old",
						role: "ROLE_AGENT",
						parts: [{ text: "old agent result", mediaType: "text/plain" }],
					},
					{
						messageId: "agent-message-new",
						role: "ROLE_AGENT",
						parts: [
							{
								text: "latest agent continuation",
								mediaType: "text/plain",
							},
						],
					},
				],
			},
			text: "use the smaller smoke suite",
			messageId: "message-2",
			now: LATER,
		});

		const ledger = await loadA2ATaskLedger({ path });
		expect(ledger.tasks[0]).toMatchObject({
			peer: "dev-desktop",
			taskId: "task-dev-2",
			contextId: "context-dev-2",
			state: "TASK_STATE_WORKING",
			text: "review the branch",
			responseText: "latest agent continuation",
			transcript: [
				{ role: "user", text: "review the branch" },
				{ role: "user", text: "use the smaller smoke suite" },
				{ role: "agent", text: "latest agent continuation" },
			],
		});
		expect(ledger.tasks[0]?.completedAt).toBeUndefined();
		expect(isTerminalA2AState("TASK_STATE_INPUT_REQUIRED")).toBe(true);
		expect(isFinalA2AState("TASK_STATE_INPUT_REQUIRED")).toBe(false);
		expect(isFinalA2AState("TASK_STATE_SUCCESS")).toBe(true);
		expect(isFinalA2AState("TASK_STATE_UNSUCCESSFUL")).toBe(false);
		expect(isTerminalA2AState("TASK_STATE_UNSUCCESSFUL")).toBe(false);
	});

	it("clears stale completedAt when re-recording a task in a non-final state", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-restart-")),
			"tasks.json",
		);

		await recordA2ATaskStart({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-3",
				status: { state: "TASK_STATE_COMPLETED" },
			},
			text: "finish the smoke",
			now: NOW,
		});
		await recordA2ATaskStart({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-3",
				status: { state: "TASK_STATE_INPUT_REQUIRED" },
			},
			text: "restart with more input",
			now: LATER,
		});

		const ledger = await loadA2ATaskLedger({ path });
		expect(ledger.tasks[0]).toMatchObject({
			peer: "dev-desktop",
			taskId: "task-dev-3",
			state: "TASK_STATE_INPUT_REQUIRED",
			text: "restart with more input",
		});
		expect(ledger.tasks[0]?.completedAt).toBeUndefined();
	});

	it("records the latest agent history response for continued tasks", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-history-reply-")),
			"tasks.json",
		);

		await recordA2ATaskStart({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-4",
				contextId: "context-dev-4",
				status: { state: "TASK_STATE_INPUT_REQUIRED" },
				history: [
					{
						messageId: "message-1",
						role: "ROLE_USER",
						parts: [{ text: "review the branch", mediaType: "text/plain" }],
					},
					{
						messageId: "agent-message-1",
						role: "ROLE_AGENT",
						parts: [{ text: "which suite?", mediaType: "text/plain" }],
					},
				],
			},
			text: "review the branch",
			messageId: "message-1",
			now: NOW,
		});
		await recordA2ATaskReply({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-4",
				contextId: "context-dev-4",
				status: { state: "TASK_STATE_COMPLETED" },
				history: [
					{
						messageId: "message-1",
						role: "ROLE_USER",
						parts: [{ text: "review the branch", mediaType: "text/plain" }],
					},
					{
						messageId: "agent-message-1",
						role: "ROLE_AGENT",
						parts: [{ text: "which suite?", mediaType: "text/plain" }],
					},
					{
						messageId: "message-2",
						role: "ROLE_USER",
						parts: [{ text: "short smoke", mediaType: "text/plain" }],
					},
					{
						messageId: "agent-message-2",
						role: "ROLE_AGENT",
						parts: [{ text: "short smoke passed", mediaType: "text/plain" }],
					},
				],
			},
			text: "short smoke",
			messageId: "message-2",
			now: LATER,
		});

		const ledger = await loadA2ATaskLedger({ path });
		expect(ledger.tasks[0]).toMatchObject({
			responseText: "short smoke passed",
			transcript: [
				{ role: "user", text: "review the branch" },
				{ role: "agent", text: "which suite?" },
				{ role: "user", text: "short smoke" },
				{ role: "agent", text: "short smoke passed" },
			],
		});
	});

	it("keeps repeated agent reply text when message ids differ", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-repeat-reply-")),
			"tasks.json",
		);

		await recordA2ATaskStart({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-repeat",
				contextId: "context-dev-repeat",
				status: { state: "TASK_STATE_INPUT_REQUIRED" },
				history: [
					{
						messageId: "message-1",
						role: "ROLE_USER",
						parts: [{ text: "start", mediaType: "text/plain" }],
					},
					{
						messageId: "agent-message-1",
						role: "ROLE_AGENT",
						parts: [{ text: "Done", mediaType: "text/plain" }],
					},
				],
			},
			text: "start",
			messageId: "message-1",
			now: NOW,
		});
		await recordA2ATaskReply({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-repeat",
				contextId: "context-dev-repeat",
				status: { state: "TASK_STATE_INPUT_REQUIRED" },
				history: [
					{
						messageId: "message-1",
						role: "ROLE_USER",
						parts: [{ text: "start", mediaType: "text/plain" }],
					},
					{
						messageId: "agent-message-1",
						role: "ROLE_AGENT",
						parts: [{ text: "Done", mediaType: "text/plain" }],
					},
					{
						messageId: "message-2",
						role: "ROLE_USER",
						parts: [{ text: "continue", mediaType: "text/plain" }],
					},
					{
						messageId: "agent-message-2",
						role: "ROLE_AGENT",
						parts: [{ text: "Done", mediaType: "text/plain" }],
					},
				],
			},
			text: "continue",
			messageId: "message-2",
			now: LATER,
		});
		await updateA2ATaskInLedger({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-repeat",
				contextId: "context-dev-repeat",
				status: { state: "TASK_STATE_INPUT_REQUIRED" },
				history: [
					{
						messageId: "agent-message-2",
						role: "ROLE_AGENT",
						parts: [{ text: "Done", mediaType: "text/plain" }],
					},
				],
			},
			now: new Date("2026-05-16T00:02:00.000Z"),
		});

		const ledger = await loadA2ATaskLedger({ path });
		expect(ledger.tasks[0]?.transcript).toEqual([
			expect.objectContaining({
				role: "user",
				text: "start",
				messageId: "message-1",
			}),
			expect.objectContaining({
				role: "agent",
				text: "Done",
				messageId: "agent-message-1",
			}),
			expect.objectContaining({
				role: "user",
				text: "continue",
				messageId: "message-2",
			}),
			expect.objectContaining({
				role: "agent",
				text: "Done",
				messageId: "agent-message-2",
			}),
		]);
	});

	it("preserves concurrent task starts in the same ledger", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-concurrent-")),
			"tasks.json",
		);

		await Promise.all([
			recordA2ATaskStart({
				path,
				peer: "mac-mini",
				task: {
					id: "task-mac-1",
					status: { state: "TASK_STATE_SUBMITTED" },
				},
				text: "run mac checks",
				now: NOW,
			}),
			recordA2ATaskStart({
				path,
				peer: "dev-desktop",
				task: {
					id: "task-dev-1",
					status: { state: "TASK_STATE_SUBMITTED" },
				},
				text: "run dev checks",
				now: NOW,
			}),
		]);

		await expect(loadA2ATaskLedger({ path })).resolves.toMatchObject({
			tasks: expect.arrayContaining([
				expect.objectContaining({
					peer: "mac-mini",
					taskId: "task-mac-1",
				}),
				expect.objectContaining({
					peer: "dev-desktop",
					taskId: "task-dev-1",
				}),
			]),
		});
		await expect(loadA2ATaskLedger({ path })).resolves.toHaveProperty(
			"tasks.length",
			2,
		);
	});

	it("preserves concurrent task starts and terminal updates from one process", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-concurrent-updates-")),
			"tasks.json",
		);
		const peers = Array.from({ length: 8 }, (_, index) => `peer-${index}`);

		await Promise.all(
			peers.map((peer, index) =>
				recordA2ATaskStart({
					path,
					peer,
					task: {
						id: `task-${index}`,
						status: { state: "TASK_STATE_SUBMITTED" },
					},
					text: `run task ${index}`,
					now: NOW,
				}),
			),
		);
		await Promise.all(
			peers.map((peer, index) =>
				updateA2ATaskInLedger({
					path,
					peer,
					task: {
						id: `task-${index}`,
						status: {
							state: "TASK_STATE_COMPLETED",
							message: {
								role: "ROLE_AGENT",
								parts: [{ text: `task ${index} done` }],
							},
						},
					},
					now: LATER,
				}),
			),
		);

		const ledger = await loadA2ATaskLedger({ path });
		expect(ledger.tasks).toHaveLength(peers.length);
		expect(ledger.tasks).toEqual(
			expect.arrayContaining(
				peers.map((peer, index) =>
					expect.objectContaining({
						peer,
						taskId: `task-${index}`,
						state: "TASK_STATE_COMPLETED",
						responseText: `task ${index} done`,
					}),
				),
			),
		);
	});

	it("recovers stale task ledger locks before writing", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-stale-lock-")),
			"tasks.json",
		);
		const lockPath = `${path}.lock`;
		await mkdir(lockPath);
		const stale = new Date(Date.now() - 60_000);
		await utimes(lockPath, stale, stale);

		await recordA2ATaskStart({
			path,
			peer: "mac-mini",
			task: {
				id: "task-mac-1",
				status: { state: "TASK_STATE_SUBMITTED" },
			},
			text: "run checks after stale lock",
			now: NOW,
		});

		await expect(loadA2ATaskLedger({ path })).resolves.toHaveProperty(
			"tasks.length",
			1,
		);
		await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("waits through the stale-lock horizon before failing acquisition", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-16T00:00:00.000Z"));
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-lock-horizon-")),
			"tasks.json",
		);
		const lockPath = `${path}.lock`;
		await mkdir(lockPath);
		const freshEnough = new Date(Date.now() - 1000);
		await utimes(lockPath, freshEnough, freshEnough);

		const write = recordA2ATaskStart({
			path,
			peer: "mac-mini",
			task: {
				id: "task-mac-1",
				status: { state: "TASK_STATE_SUBMITTED" },
			},
			text: "recover after abandoned lock",
			now: NOW,
		});
		await vi.advanceTimersByTimeAsync(31_000);

		await expect(write).resolves.toMatchObject({
			entry: {
				peer: "mac-mini",
				taskId: "task-mac-1",
				text: "recover after abandoned lock",
			},
		});
		await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("clears stale completedAt when re-recording a task in a non-terminal state", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-restart-")),
			"tasks.json",
		);

		await recordA2ATaskStart({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-3",
				status: { state: "TASK_STATE_COMPLETED" },
			},
			text: "finish the smoke",
			now: NOW,
		});
		await recordA2ATaskStart({
			path,
			peer: "dev-desktop",
			task: {
				id: "task-dev-3",
				status: { state: "TASK_STATE_SUBMITTED" },
			},
			text: "restart with more input",
			now: LATER,
		});

		const ledger = await loadA2ATaskLedger({ path });
		expect(ledger.tasks[0]).toMatchObject({
			peer: "dev-desktop",
			taskId: "task-dev-3",
			state: "TASK_STATE_SUBMITTED",
			text: "restart with more input",
		});
		expect(ledger.tasks[0]?.completedAt).toBeUndefined();
	});

	it("rejects array-shaped ledger files instead of treating them as empty", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-array-")),
			"tasks.json",
		);
		await writeFile(path, "[]\n", "utf8");

		await expect(loadA2ATaskLedger({ path })).rejects.toThrow(
			`A2A task ledger at ${path} must be a JSON object`,
		);
		await expect(readFile(path, "utf8")).resolves.toBe("[]\n");
	});
});
