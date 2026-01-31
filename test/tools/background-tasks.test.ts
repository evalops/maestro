import {
	existsSync,
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	getBackgroundTaskSettings,
	overrideBackgroundTaskSettingsPath,
	resetBackgroundTaskSettings,
	updateBackgroundTaskSettings,
} from "../../src/runtime/background-settings.js";
import {
	backgroundTaskManager,
	backgroundTasksTool,
	evaluateResourceLimitBreach,
	extractProcStatFields,
} from "../../src/tools/background-tasks.js";
import { computeRestartDelay } from "../../src/tools/background/index.js";

const settingsRoot = mkdtempSync(join(tmpdir(), "composer-bg-settings-"));
const settingsPath = join(settingsRoot, "settings.json");
const previousUnsafe = process.env.COMPOSER_BACKGROUND_SETTINGS_UNSAFE;
process.env.COMPOSER_BACKGROUND_SETTINGS_UNSAFE = "1";
overrideBackgroundTaskSettingsPath(settingsPath);
resetBackgroundTaskSettings();
const TASK_HOLD_MS = 500;
const joinParts = (...parts: string[]) => parts.join("");
const SAMPLE_REDACTED_TOKEN = joinParts(
	"sk",
	"-",
	"secret",
	"-",
	"1234567890abcdef1234567890",
);

afterAll(() => {
	process.env.COMPOSER_BACKGROUND_SETTINGS_UNSAFE = previousUnsafe;
	overrideBackgroundTaskSettingsPath(null);
	rmSync(settingsRoot, { recursive: true, force: true });
});

type ToolResult = { content?: Array<{ type: string; text?: string }> };
type TaskDetails = { id?: string; status?: string };

function getTextOutput(result: ToolResult): string {
	return (
		result.content
			?.filter(
				(c): c is { type: "text"; text: string } =>
					c.type === "text" && typeof c.text === "string",
			)
			.map((c) => c.text)
			.join("\n") || ""
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLogEntry(
	taskId: string,
	expected: string,
	attempts = 40,
	delayMs = 150,
): Promise<string> {
	for (let i = 0; i < attempts; i += 1) {
		const logsResult = await backgroundTasksTool.execute(
			`bg-logs-${taskId}-${i}`,
			{
				action: "logs",
				taskId,
				lines: 10,
			},
		);
		const text = getTextOutput(logsResult);
		if (text.includes(expected)) {
			return text;
		}
		await sleep(delayMs);
	}
	throw new Error(`Log output for ${taskId} never contained "${expected}"`);
}

async function waitForCondition(
	check: () => boolean | Promise<boolean>,
	attempts = 50,
	delayMs = 150,
): Promise<void> {
	for (let i = 0; i < attempts; i += 1) {
		const result = await check();
		if (result) {
			return;
		}
		await sleep(delayMs);
	}
	throw new Error("Condition was not met within the allotted attempts");
}

describe("backgroundTasksTool", () => {
	let logDir: string;

	beforeEach(() => {
		resetBackgroundTaskSettings();
		updateBackgroundTaskSettings({ statusDetailsEnabled: true });
		logDir = mkdtempSync(join(tmpdir(), "composer-bg-"));
		process.env.COMPOSER_BACKGROUND_LOG_DIR = logDir;
		backgroundTaskManager.resetLimits();
	});

	afterEach(async () => {
		await backgroundTaskManager.stopAll();
		backgroundTaskManager.clear();
		rmSync(logDir, { recursive: true, force: true });
		Reflect.deleteProperty(process.env, "COMPOSER_BACKGROUND_LOG_DIR");
	});

	it("starts tasks and lists them", async () => {
		const startResult = await backgroundTasksTool.execute("bg-start", {
			action: "start",
			command: `node -e "console.log('ready'); setTimeout(() => {}, ${TASK_HOLD_MS})"`,
		});

		expect(startResult.details).toMatchObject({ status: "running" });
		const listResult = await backgroundTasksTool.execute("bg-list", {
			action: "list",
		});
		const output = getTextOutput(listResult);

		expect(output).toContain("task-");
		expect(output).toContain("ready");
	});

	it("retrieves logs and stops a running task", async () => {
		const startResult = await backgroundTasksTool.execute("bg-start-stop", {
			action: "start",
			command: `node -e "console.log('log-line'); setTimeout(() => {}, ${TASK_HOLD_MS})"`,
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;

		const logText = await waitForLogEntry(taskId, "log-line");
		expect(logText).toContain("log-line");

		const stopResult = await backgroundTasksTool.execute("bg-stop", {
			action: "stop",
			taskId,
		});

		const details = stopResult.details as TaskDetails;
		expect(details.id).toBe(taskId);

		await waitForCondition(() => {
			const task = backgroundTaskManager.getTask(taskId);
			return task?.status === "stopped" || task?.status === "exited";
		});

		const task = backgroundTaskManager.getTask(taskId);
		expect(task?.status === "stopped" || task?.status === "exited").toBe(true);
	});

	it("enforces configured task limits", async () => {
		backgroundTaskManager.configureLimits({ maxTasks: 1 });
		const startResult = await backgroundTasksTool.execute("bg-start-limit", {
			action: "start",
			command: `node -e "setTimeout(() => {}, ${TASK_HOLD_MS})"`,
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;

		await expect(
			backgroundTasksTool.execute("bg-start-limit-2", {
				action: "start",
				command: "node -e \"console.log('second');\"",
			}),
		).rejects.toThrow(/maximum of 1 running task/);

		await backgroundTasksTool.execute("bg-stop-limit", {
			action: "stop",
			taskId,
		});
	});

	it("records resource usage for completed tasks", async () => {
		const usageHoldMs = Math.max(200, Math.floor(TASK_HOLD_MS / 2));
		const startResult = await backgroundTasksTool.execute("bg-usage", {
			action: "start",
			command: `node -e "console.log('usage'); setTimeout(() => {}, ${usageHoldMs})"`,
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;
		const supportsUsage = ["linux", "darwin"].includes(process.platform);

		await waitForCondition(() => {
			const task = backgroundTaskManager.getTask(taskId);
			if (!task || (task.status !== "exited" && task.status !== "failed")) {
				return false;
			}
			return supportsUsage ? Boolean(task.resourceUsage) : true;
		});

		const task = backgroundTaskManager.getTask(taskId);
		if (supportsUsage) {
			expect(task?.resourceUsage).toBeTruthy();
			expect(task?.resourceUsage?.maxRssKb ?? 0).toBeGreaterThan(0);
		} else {
			expect(task?.resourceUsage ?? null).toBeNull();
		}
	});

	it("refreshes health snapshots when background settings change", async () => {
		updateBackgroundTaskSettings({
			statusDetailsEnabled: false,
			notificationsEnabled: false,
		});

		const startResult = await backgroundTasksTool.execute(
			"bg-settings-toggle",
			{
				action: "start",
				command: `node -e "setTimeout(() => {}, ${TASK_HOLD_MS})"`,
			},
		);
		const taskId = (startResult.details as TaskDetails)?.id as string;
		expect(taskId).toBeTruthy();

		const snapshotWithoutDetails = backgroundTaskManager.getHealthSnapshot({
			maxEntries: 2,
			logLines: 1,
			historyLimit: 5,
		});

		expect(snapshotWithoutDetails?.detailsRedacted).toBe(true);
		expect(snapshotWithoutDetails?.notificationsEnabled).toBe(false);

		updateBackgroundTaskSettings({
			statusDetailsEnabled: true,
			notificationsEnabled: true,
		});

		await waitForCondition(() => {
			const snapshot = backgroundTaskManager.getHealthSnapshot({
				maxEntries: 2,
				logLines: 1,
				historyLimit: 5,
			});
			return snapshot?.detailsRedacted === false;
		});

		const snapshotWithDetails = backgroundTaskManager.getHealthSnapshot({
			maxEntries: 2,
			logLines: 1,
			historyLimit: 5,
		});

		expect(snapshotWithDetails?.detailsRedacted).toBe(false);
		expect(snapshotWithDetails?.notificationsEnabled).toBe(true);

		await backgroundTasksTool.execute("bg-settings-stop", {
			action: "stop",
			taskId,
		});
	});

	it("reloads settings when the file is edited externally", async () => {
		updateBackgroundTaskSettings({
			notificationsEnabled: false,
			statusDetailsEnabled: false,
		});
		const { notificationsEnabled: beforeNotify } = getBackgroundTaskSettings();
		expect(beforeNotify).toBe(false);

		// Ensure a distinct mtime before writing.
		await sleep(5);
		writeFileSync(
			settingsPath,
			JSON.stringify({ notificationsEnabled: true }, null, 2),
		);
		// Nudge mtime in case the fs timestamp resolution is coarse (linux runners).
		utimesSync(settingsPath, new Date(), new Date());

		await waitForCondition(() => {
			const { notificationsEnabled } = getBackgroundTaskSettings();
			return notificationsEnabled === true;
		});
	});

	it("restarts failing tasks when restart policy is configured", async () => {
		const flagPath = join(logDir, "restart-flag.txt");
		const flagLiteral = JSON.stringify(flagPath).replace(/"/g, '\\"');
		const command = `node -e "const fs = require('node:fs'); const flag = ${flagLiteral}; if (!fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); process.exit(1); } else { fs.unlinkSync(flag); setTimeout(() => {}, ${TASK_HOLD_MS}); }"`;
		const startResult = await backgroundTasksTool.execute("bg-restart", {
			action: "start",
			command,
			restart: { maxAttempts: 1, delayMs: 100 },
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;

		try {
			await waitForCondition(
				() => {
					const task = backgroundTaskManager.getTask(taskId);
					return (
						task?.restartPolicy?.attempts === 1 && task.status === "running"
					);
				},
				200,
				100,
			);
			const task = backgroundTaskManager.getTask(taskId);
			expect(task?.restartPolicy?.attempts).toBe(1);
			expect(task?.status).toBe("running");
		} finally {
			rmSync(flagPath, { force: true });
		}
	});

	it("preserves resource usage across restarts", async () => {
		const flagPath = join(logDir, "restart-usage-flag.txt");
		const flagLiteral = JSON.stringify(flagPath).replace(/"/g, '\\"');
		const command = `node -e "const fs = require('node:fs'); const flag = ${flagLiteral}; if (!fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); process.exit(1); } else { fs.unlinkSync(flag); setTimeout(() => {}, ${TASK_HOLD_MS}); }"`;
		const startResult = await backgroundTasksTool.execute("bg-restart-usage", {
			action: "start",
			command,
			restart: { maxAttempts: 1, delayMs: 50 },
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;

		try {
			await waitForCondition(
				() => backgroundTaskManager.getTask(taskId)?.status === "restarting",
				200,
				50,
			);
			const taskBeforeRestart = backgroundTaskManager.getTask(taskId);
			expect(taskBeforeRestart).toBeTruthy();
			if (taskBeforeRestart) {
				taskBeforeRestart.resourceUsage = { maxRssKb: 123 };
			}

			await waitForCondition(
				() => backgroundTaskManager.getTask(taskId)?.status === "running",
				200,
				50,
			);
			const restartedTask = backgroundTaskManager.getTask(taskId);
			const preserved = restartedTask?.resourceUsage?.maxRssKb ?? 0;
			expect(preserved).toBeGreaterThanOrEqual(123);
		} finally {
			rmSync(flagPath, { force: true });
		}
	});

	it("caps log file size across restarts", async () => {
		const flagPath = join(logDir, "restart-log-flag.txt");
		const flagLiteral = JSON.stringify(flagPath).replace(/"/g, '\\"');
		const command = `node -e "const fs = require('node:fs'); const flag = ${flagLiteral}; const chunk = 'B'.repeat(4096); process.stdout.write(chunk); if (!fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); process.exit(1); } else { fs.unlinkSync(flag); setTimeout(() => {}, ${TASK_HOLD_MS}); }"`;
		const startResult = await backgroundTasksTool.execute("bg-restart-log", {
			action: "start",
			command,
			restart: { maxAttempts: 1, delayMs: 50 },
			limits: { logSizeLimit: 512, logSegments: 1 },
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;

		try {
			await waitForCondition(
				() => backgroundTaskManager.getTask(taskId)?.status === "restarting",
				200,
				50,
			);
			await waitForCondition(
				() => {
					const task = backgroundTaskManager.getTask(taskId);
					return (
						task?.restartPolicy?.attempts === 1 && task.status === "running"
					);
				},
				200,
				50,
			);
			await waitForCondition(() => {
				const task = backgroundTaskManager.getTask(taskId);
				if (!task?.logPath) {
					return false;
				}
				return existsSync(task.logPath) && statSync(task.logPath).size > 0;
			});
			const task = backgroundTaskManager.getTask(taskId);
			expect(task?.logPath).toBeTruthy();
			if (task?.logPath) {
				const size = statSync(task.logPath).size;
				expect(size).toBeLessThanOrEqual(512);
			}
		} finally {
			rmSync(flagPath, { force: true });
			await backgroundTaskManager.stopTask(taskId);
		}
	});

	it("handles zero log size limit without hanging", async () => {
		const startResult = await backgroundTasksTool.execute("bg-zero-limit", {
			action: "start",
			command: `node -e "process.stdout.write('hello world'); setTimeout(() => {}, ${TASK_HOLD_MS});"`,
			limits: { logSizeLimit: 0 },
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;
		await waitForCondition(
			() => backgroundTaskManager.getTask(taskId)?.status === "running",
		);
		await waitForCondition(() =>
			Boolean(backgroundTaskManager.getTask(taskId)?.logTruncated),
		);
		const logs = backgroundTaskManager.getLogs(taskId, 10);
		expect(logs).toContain("No logs available.");
		expect(logs).toContain("Log output truncated at 0 KB.");
		await backgroundTaskManager.stopTask(taskId);
	});

	it("honors per-task retention overrides", async () => {
		const startResult = await backgroundTasksTool.execute("bg-retention", {
			action: "start",
			command: `node -e "setTimeout(() => {}, ${TASK_HOLD_MS})"`,
			limits: { retentionMs: 1_000 },
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;
		await backgroundTaskManager.stopTask(taskId);
		await waitForCondition(
			() => backgroundTaskManager.getTask(taskId) === undefined,
			40,
			100,
		);
	});

	it("supports exponential restart strategy with jitter", () => {
		const policy = {
			delayMs: 100,
			maxAttempts: 3,
			attempts: 2,
			strategy: "exponential" as const,
			maxDelayMs: 800,
			jitterRatio: 0,
		};
		// Exponential: 100 * 2^(2-1) = 200ms
		expect(computeRestartDelay(policy)).toBe(200);
		const jitterPolicy = { ...policy, jitterRatio: 0.5 };
		// With jitter: delay=200, jitter=100, min=max(50,100)=100, max=300
		// randomFn()=0 → delay = 100 + 0 * 200 = 100
		const jitterDelay = computeRestartDelay(jitterPolicy, () => 0);
		expect(jitterDelay).toBe(100);
	});

	it("parses /proc stat fields with nested parentheses", () => {
		const fields = extractProcStatFields(
			"12345 (test) foo) R 1 2 3 4 5 6 7 8 9 10 100 200",
		);
		expect(fields).toBeTruthy();
		expect(fields?.[11]).toBe("100");
		expect(fields?.[12]).toBe("200");
	});

	it("evaluates resource limit breaches", () => {
		const memoryBreach = evaluateResourceLimitBreach(
			{ maxRssKb: 512, userMs: 10, systemMs: 5 },
			{ maxRssKb: 128, maxCpuMs: 1_000 },
		);
		expect(memoryBreach).toMatchObject({ kind: "memory" });
		const cpuBreach = evaluateResourceLimitBreach(
			{ userMs: 600, systemMs: 600 },
			{ maxRssKb: 0, maxCpuMs: 1_000 },
		);
		expect(cpuBreach).toMatchObject({ kind: "cpu" });
		const noBreach = evaluateResourceLimitBreach(
			{ maxRssKb: 10, userMs: 50, systemMs: 25 },
			{ maxRssKb: 1_024, maxCpuMs: 5_000 },
		);
		expect(noBreach).toBeNull();
	});

	it("stopTask reports stopped=false for completed tasks", async () => {
		const startResult = await backgroundTasksTool.execute("bg-stop-finished", {
			action: "start",
			command: 'node -e "process.exit(0)"',
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;

		await waitForCondition(() => {
			const task = backgroundTaskManager.getTask(taskId);
			return task?.status === "exited" || task?.status === "failed";
		});

		const result = await backgroundTaskManager.stopTask(taskId);
		expect(result).not.toBeNull();
		expect(result?.stopped).toBe(false);
		expect(result?.task.status).toBe("exited");
	});

	it("stopAll forces cleanup of zombie tasks", async () => {
		const internalManager = backgroundTaskManager as unknown as {
			tasks: Map<string, unknown>;
			cleanupTimers: Map<string, NodeJS.Timeout>;
		};
		const originalTasks = internalManager.tasks;
		const originalTimers = internalManager.cleanupTimers;
		const zombieLog = join(logDir, "task-zombie.log");
		writeFileSync(zombieLog, "zombie");
		const zombieTask = {
			id: "task-zombie",
			command: "sleep",
			startedAt: Date.now(),
			status: "running" as const,
			logPath: zombieLog,
			process: {} as unknown as import("node:child_process").ChildProcess,
			completion: Promise.resolve(),
			shellMode: "exec" as const,
			limits: {
				logSizeLimit: 0,
				logSegments: 0,
				retentionMs: 1_000,
			},
		};
		internalManager.tasks = new Map([[zombieTask.id, zombieTask]]);
		internalManager.cleanupTimers = new Map();
		const stopSpy = vi
			.spyOn(backgroundTaskManager, "stopTask")
			.mockResolvedValue({ task: zombieTask, stopped: false });
		try {
			await backgroundTaskManager.stopAll();
			expect(backgroundTaskManager.getTasks()).toHaveLength(0);
		} finally {
			stopSpy.mockRestore();
			internalManager.tasks = originalTasks;
			internalManager.cleanupTimers = originalTimers;
			rmSync(zombieLog, { force: true });
		}
	});

	it("provides task health snapshots with log previews", async () => {
		const startResult = await backgroundTasksTool.execute("bg-health", {
			action: "start",
			command: `node -e "console.log('health-check'); setTimeout(() => {}, ${TASK_HOLD_MS})"`,
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;
		await waitForCondition(
			() => backgroundTaskManager.getTask(taskId)?.status === "running",
		);
		await waitForCondition(() => {
			const preview = backgroundTaskManager.getHealthSnapshot({
				maxEntries: 1,
				logLines: 1,
			});
			return (preview?.entries[0]?.lastLogLine ?? "").includes("health-check");
		});
		const snapshot = backgroundTaskManager.getHealthSnapshot({
			maxEntries: 1,
			logLines: 1,
		});
		expect(snapshot).toBeTruthy();
		expect(snapshot?.entries[0]?.lastLogLine ?? "").toContain("health-check");
		await backgroundTaskManager.stopTask(taskId);
	});

	it("redacts sensitive tokens in log previews", async () => {
		const startResult = await backgroundTasksTool.execute("bg-redact", {
			action: "start",
			command: `node -e "console.log('${SAMPLE_REDACTED_TOKEN}'); setTimeout(() => {}, ${TASK_HOLD_MS})"`,
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;
		await waitForCondition(() => {
			const snapshot = backgroundTaskManager.getHealthSnapshot({
				maxEntries: 1,
				logLines: 1,
			});
			return Boolean(snapshot?.entries[0]?.lastLogLine);
		});
		const snapshot = backgroundTaskManager.getHealthSnapshot({
			maxEntries: 1,
			logLines: 1,
		});
		const preview = snapshot?.entries[0]?.lastLogLine ?? "";
		expect(preview).toContain("[secret:");
		expect(preview).not.toContain(SAMPLE_REDACTED_TOKEN);
		await backgroundTaskManager.stopTask(taskId);
	});

	it("hides task details when status details are disabled", async () => {
		updateBackgroundTaskSettings({ statusDetailsEnabled: false });
		const startResult = await backgroundTasksTool.execute("bg-redacted", {
			action: "start",
			command: `node -e "console.log('one'); setTimeout(() => {}, ${TASK_HOLD_MS})"`,
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;
		await waitForCondition(() => {
			const snapshot = backgroundTaskManager.getHealthSnapshot({
				maxEntries: 1,
				logLines: 1,
			});
			return Boolean(snapshot);
		});
		const snapshot = backgroundTaskManager.getHealthSnapshot({
			maxEntries: 1,
			logLines: 1,
		});
		expect(snapshot).toBeTruthy();
		expect(snapshot?.detailsRedacted).toBe(true);
		expect(snapshot?.entries.length).toBe(0);
		await backgroundTaskManager.stopTask(taskId);
		updateBackgroundTaskSettings({ statusDetailsEnabled: true });
	});

	it("returns history even when no tasks remain", async () => {
		const startResult = await backgroundTasksTool.execute("bg-history", {
			action: "start",
			command: "node -e \"console.log('history');\"",
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;
		await waitForCondition(() => {
			const task = backgroundTaskManager.getTask(taskId);
			return task?.status === "exited" || task?.status === "failed";
		});
		await backgroundTaskManager.stopTask(taskId);
		backgroundTaskManager.clear();
		const snapshot = backgroundTaskManager.getHealthSnapshot({
			historyLimit: 5,
		});
		expect(snapshot).toBeTruthy();
		expect(snapshot?.history.length ?? 0).toBeGreaterThan(0);
	});

	it("rotates logs into archived segments", async () => {
		const startResult = await backgroundTasksTool.execute("bg-rotate", {
			action: "start",
			command:
				"node -e \"const chunk = 'A'.repeat(2048); let count = 0; const timer = setInterval(() => { process.stdout.write(chunk); count += 1; if (count === 4) { clearInterval(timer); process.exit(0); } }, 20);\"",
			limits: { logSizeLimit: 1024, logSegments: 2 },
		});
		const taskId = (startResult.details as TaskDetails)?.id as string;
		await waitForCondition(() => {
			const task = backgroundTaskManager.getTask(taskId);
			return task?.status === "exited" || task?.status === "failed";
		});
		const task = backgroundTaskManager.getTask(taskId);
		expect(task).toBeTruthy();
		expect(task?.logWriter).toBeTruthy();
		expect(task?.logPath).toBeTruthy();
		if (task?.logWriter && task?.logPath) {
			const rotation = await task.logWriter.waitForRotation();
			expect(existsSync(rotation.archivePath)).toBe(true);
		}
		await backgroundTaskManager.stopTask(taskId);
	});
});
