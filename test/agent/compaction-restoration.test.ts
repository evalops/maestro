import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_TASKS_COMPACTION_CUSTOM_TYPE,
	PLAN_FILE_COMPACTION_CUSTOM_TYPE,
	PLAN_MODE_COMPACTION_CUSTOM_TYPE,
	collectBackgroundTaskMessagesForCompaction,
	collectPlanMessagesForCompaction,
} from "../../src/agent/compaction-restoration.js";
import {
	getPlanFilePathForCompactionRestore,
	isPlanModeActive,
	readPlanFileForCompactionRestore,
} from "../../src/agent/plan-mode.js";
import { backgroundTaskManager } from "../../src/tools/background-tasks.js";

vi.mock("../../src/agent/plan-mode.js", () => ({
	getPlanFilePathForCompactionRestore: vi.fn(),
	isPlanModeActive: vi.fn(),
	readPlanFileForCompactionRestore: vi.fn(),
}));

vi.mock("../../src/tools/background-tasks.js", () => ({
	backgroundTaskManager: {
		getTasks: vi.fn(),
	},
}));

describe("collectPlanMessagesForCompaction", () => {
	beforeEach(() => {
		vi.mocked(isPlanModeActive).mockReset().mockReturnValue(false);
		vi.mocked(getPlanFilePathForCompactionRestore)
			.mockReset()
			.mockReturnValue(null);
		vi.mocked(readPlanFileForCompactionRestore)
			.mockReset()
			.mockReturnValue(null);
		vi.mocked(backgroundTaskManager.getTasks).mockReset().mockReturnValue([]);
	});

	it("returns no messages when no tracked plan file exists", () => {
		expect(collectPlanMessagesForCompaction([])).toEqual([]);
	});

	it("returns hidden plan file and plan-mode restoration messages when plan mode is active", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getPlanFilePathForCompactionRestore).mockReturnValue(
			"/tmp/plan.md",
		);
		vi.mocked(readPlanFileForCompactionRestore).mockReturnValue(
			"# Current plan\n- [ ] Ship it",
		);

		expect(collectPlanMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_FILE_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining("Current plan contents:"),
				details: { filePath: "/tmp/plan.md" },
			}),
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining("Plan file: /tmp/plan.md"),
				details: { filePath: "/tmp/plan.md" },
			}),
		]);
	});

	it("still restores plan mode when the active plan file cannot be read", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getPlanFilePathForCompactionRestore).mockReturnValue(
			"/tmp/plan.md",
		);
		vi.mocked(readPlanFileForCompactionRestore).mockReturnValue(null);

		expect(collectPlanMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
			}),
		]);
	});

	it("restores the tracked plan file after compaction even when plan mode is inactive", () => {
		vi.mocked(getPlanFilePathForCompactionRestore).mockReturnValue(
			"/tmp/plan.md",
		);
		vi.mocked(readPlanFileForCompactionRestore).mockReturnValue(
			"# Current plan\n- [ ] Ship it",
		);

		expect(collectPlanMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_FILE_COMPACTION_CUSTOM_TYPE,
				display: false,
				details: { filePath: "/tmp/plan.md" },
			}),
		]);
	});

	it("deduplicates already-present plan restoration messages", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getPlanFilePathForCompactionRestore).mockReturnValue(
			"/tmp/plan.md",
		);
		vi.mocked(readPlanFileForCompactionRestore).mockReturnValue(
			"# Current plan\n- [ ] Ship it",
		);

		const existingPlanContent = [
			"# Active plan file restored after compaction",
			"",
			"Plan file: /tmp/plan.md",
			"",
			"Current plan contents:",
			"# Current plan\n- [ ] Ship it",
		].join("\n");
		const existingMessages = [
			{
				role: "hookMessage" as const,
				customType: PLAN_FILE_COMPACTION_CUSTOM_TYPE,
				content: existingPlanContent,
				display: false,
				details: { filePath: "/tmp/plan.md" },
				timestamp: Date.now(),
			},
			{
				role: "hookMessage" as const,
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
				content: "Plan file: /tmp/plan.md",
				display: false,
				details: { filePath: "/tmp/plan.md" },
				timestamp: Date.now(),
			},
		];

		expect(collectPlanMessagesForCompaction(existingMessages)).toEqual([]);
	});
});

describe("collectBackgroundTaskMessagesForCompaction", () => {
	it("returns no messages when no background tasks are active", () => {
		expect(collectBackgroundTaskMessagesForCompaction([])).toEqual([]);
	});

	it("returns a hidden restoration message for running background tasks", () => {
		vi.mocked(backgroundTaskManager.getTasks).mockReturnValue([
			{
				id: "task-running",
				command: "npm run dev -- --token sk-super-secret-value",
				cwd: "/tmp/app",
				startedAt: 20,
				status: "running",
				shellMode: "exec",
			},
			{
				id: "task-restarting",
				command: "bun run watch",
				cwd: "/tmp/app",
				startedAt: 10,
				status: "restarting",
				shellMode: "shell",
			},
			{
				id: "task-stopped",
				command: "npm run lint",
				cwd: "/tmp/app",
				startedAt: 5,
				status: "stopped",
				shellMode: "exec",
			},
		] as never);

		expect(collectBackgroundTaskMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: BACKGROUND_TASKS_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining(
					"# Background tasks restored after compaction",
				),
			}),
		]);

		const content = String(
			collectBackgroundTaskMessagesForCompaction([])[0]?.content,
		);
		expect(content).toContain("id=task-running; status=running");
		expect(content).toContain("id=task-restarting; status=restarting");
		expect(content).not.toContain("task-stopped");
		expect(content).toContain("command=npm run dev -- --token [secret]");
		expect(content).toContain("background_tasks` action=list");
	});

	it("deduplicates already-present background task restoration messages", () => {
		vi.mocked(backgroundTaskManager.getTasks).mockReturnValue([
			{
				id: "task-running",
				command: "npm run dev",
				cwd: "/tmp/app",
				startedAt: 20,
				status: "running",
				shellMode: "exec",
			},
		] as never);

		const existingMessages = collectBackgroundTaskMessagesForCompaction([]);
		expect(
			collectBackgroundTaskMessagesForCompaction(existingMessages),
		).toEqual([]);
	});
});
