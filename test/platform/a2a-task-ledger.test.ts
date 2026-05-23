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
	getA2ATaskLedgerPath,
	isFinalA2AState,
	isTerminalA2AState,
	loadA2ATaskLedger,
	recordA2ATaskReply,
	recordA2ATaskStart,
	updateA2ATaskInLedger,
} from "../../src/platform/a2a-task-ledger.js";

const NOW = new Date("2026-05-16T00:00:00.000Z");
const LATER = new Date("2026-05-16T00:01:00.000Z");

describe("A2A task ledger", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
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
