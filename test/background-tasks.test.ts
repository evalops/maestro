import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	backgroundTaskManager,
	backgroundTasksTool,
	extractProcStatFields,
} from "../src/tools/background-tasks.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLogEntry(
	taskId: string,
	expected: string,
	attempts = 20,
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
		await sleep(100);
	}
	throw new Error(`Log output for ${taskId} never contained "${expected}"`);
}

async function waitForCondition(
	check: () => boolean | Promise<boolean>,
	attempts = 30,
	delayMs = 100,
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
		logDir = mkdtempSync(join(tmpdir(), "composer-bg-"));
		process.env.COMPOSER_BACKGROUND_LOG_DIR = logDir;
		backgroundTaskManager.resetLimits();
	});

	afterEach(async () => {
		await backgroundTaskManager.stopAll();
		backgroundTaskManager.clear();
		rmSync(logDir, { recursive: true, force: true });
		process.env.COMPOSER_BACKGROUND_LOG_DIR = undefined;
	});

	it("starts tasks and lists them", async () => {
		const startResult = await backgroundTasksTool.execute("bg-start", {
			action: "start",
			command: "node -e \"console.log('ready'); setTimeout(() => {}, 5000)\"",
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
			command:
				"node -e \"console.log('log-line'); setTimeout(() => {}, 5000)\"",
		});
		const taskId = (startResult.details as any)?.id as string;

		await sleep(200);
		const logText = await waitForLogEntry(taskId, "log-line");
		expect(logText).toContain("log-line");

		const stopResult = await backgroundTasksTool.execute("bg-stop", {
			action: "stop",
			taskId,
		});

		const details = stopResult.details as any;
		expect(details.id).toBe(taskId);
		expect(["stopped", "exited"]).toContain(details.status);

		const task = backgroundTaskManager.getTask(taskId);
		expect(task?.status === "stopped" || task?.status === "exited").toBe(true);
	});

	it("enforces configured task limits", async () => {
		backgroundTaskManager.configureLimits({ maxTasks: 1 });
		const startResult = await backgroundTasksTool.execute("bg-start-limit", {
			action: "start",
			command: 'node -e "setTimeout(() => {}, 2000)"',
		});
		const taskId = (startResult.details as any)?.id as string;

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
		const startResult = await backgroundTasksTool.execute("bg-usage", {
			action: "start",
			command: "node -e \"console.log('usage'); setTimeout(() => {}, 1000)\"",
		});
		const taskId = (startResult.details as any)?.id as string;
		const requiresUsage = process.platform === "linux";

		await waitForCondition(() => {
			const task = backgroundTaskManager.getTask(taskId);
			if (!task || (task.status !== "exited" && task.status !== "failed")) {
				return false;
			}
			return requiresUsage ? Boolean(task.resourceUsage) : true;
		});

		const task = backgroundTaskManager.getTask(taskId);
		if (requiresUsage) {
			expect(task?.resourceUsage).toBeTruthy();
			expect(task?.resourceUsage?.maxRssKb ?? 0).toBeGreaterThan(0);
		} else {
			expect(task?.resourceUsage ?? null).toBeNull();
		}
	});

	it("restarts failing tasks when restart policy is configured", async () => {
		const flagPath = join(logDir, "restart-flag.txt");
		const flagLiteral = JSON.stringify(flagPath).replace(/"/g, '\\"');
		const command = `node -e "const fs = require('node:fs'); const flag = ${flagLiteral}; if (!fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); process.exit(1); } else { fs.unlinkSync(flag); setTimeout(() => {}, 5000); }"`;
		const startResult = await backgroundTasksTool.execute("bg-restart", {
			action: "start",
			command,
			restart: { maxAttempts: 1, delayMs: 100 },
		});
		const taskId = (startResult.details as any)?.id as string;

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
		const command = `node -e "const fs = require('node:fs'); const flag = ${flagLiteral}; if (!fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); process.exit(1); } else { fs.unlinkSync(flag); setTimeout(() => {}, 2000); }"`;
		const startResult = await backgroundTasksTool.execute("bg-restart-usage", {
			action: "start",
			command,
			restart: { maxAttempts: 1, delayMs: 50 },
		});
		const taskId = (startResult.details as any)?.id as string;

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
		const command = `node -e "const fs = require('node:fs'); const flag = ${flagLiteral}; const chunk = 'B'.repeat(4096); process.stdout.write(chunk); if (!fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); process.exit(1); } else { fs.unlinkSync(flag); setTimeout(() => {}, 2000); }"`;
		const startResult = await backgroundTasksTool.execute("bg-restart-log", {
			action: "start",
			command,
			restart: { maxAttempts: 1, delayMs: 50 },
			limits: { logSizeLimit: 512, logSegments: 1 },
		});
		const taskId = (startResult.details as any)?.id as string;

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
			await sleep(100);
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
			command:
				"node -e \"process.stdout.write('hello world'); setTimeout(() => {}, 1000);\"",
			limits: { logSizeLimit: 0 },
		});
		const taskId = (startResult.details as any)?.id as string;
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
			command: 'node -e "setTimeout(() => {}, 2000)"',
			limits: { retentionMs: 1_000 },
		});
		const taskId = (startResult.details as any)?.id as string;
		await backgroundTaskManager.stopTask(taskId);
		await waitForCondition(
			() => backgroundTaskManager.getTask(taskId) === undefined,
			40,
			100,
		);
	});

	it("supports exponential restart strategy with jitter", () => {
		const computeRestartDelay = (
			backgroundTaskManager as unknown as {
				computeRestartDelay: (policy: any) => number;
			}
		).computeRestartDelay.bind(backgroundTaskManager);
		const policy = {
			delayMs: 100,
			maxAttempts: 3,
			attempts: 2,
			strategy: "exponential",
			maxDelayMs: 800,
			jitterRatio: 0,
		};
		expect(computeRestartDelay(policy)).toBe(200);
		const jitterPolicy = { ...policy, jitterRatio: 0.5 };
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
		const jitterDelay = computeRestartDelay(jitterPolicy);
		expect(jitterDelay).toBe(100);
		randomSpy.mockRestore();
	});

	it("parses /proc stat fields with nested parentheses", () => {
		const fields = extractProcStatFields(
			"12345 (test) foo) R 1 2 3 4 5 6 7 8 9 10 100 200",
		);
		expect(fields).toBeTruthy();
		expect(fields?.[11]).toBe("100");
		expect(fields?.[12]).toBe("200");
	});

	it("stopTask reports stopped=false for completed tasks", async () => {
		const startResult = await backgroundTasksTool.execute("bg-stop-finished", {
			action: "start",
			command: 'node -e "process.exit(0)"',
		});
		const taskId = (startResult.details as any)?.id as string;

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
			process: {} as unknown,
			completion: Promise.resolve(),
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
});
