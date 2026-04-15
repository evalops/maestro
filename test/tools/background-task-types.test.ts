import { describe, expect, it } from "vitest";

import type { RestartPolicy } from "../../src/tools/background/index.js";
import {
	type BackgroundTask,
	buildTaskDetail,
	formatTaskSummary,
	formatUsageSummary,
} from "../../src/tools/background/task-types.js";

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id: "task-123",
		command: "echo hello",
		env: {},
		startedAt: Date.now() - 5000,
		status: "running",
		logPath: "/tmp/test.log",
		process: {} as never,
		completion: Promise.resolve(),
		shellMode: "exec",
		limits: {
			logSizeLimit: 5_000_000,
			logSegments: 2,
			retentionMs: 600_000,
		},
		...overrides,
	};
}

function makeRestartPolicy(
	overrides: Partial<RestartPolicy> = {},
): RestartPolicy {
	return {
		maxAttempts: 3,
		attempts: 0,
		delayMs: 1000,
		strategy: "fixed",
		maxDelayMs: 8000,
		jitterRatio: 0,
		...overrides,
	};
}

describe("formatUsageSummary", () => {
	it("returns null for undefined usage", () => {
		expect(formatUsageSummary(undefined)).toBeNull();
	});

	it("returns null for empty usage", () => {
		expect(formatUsageSummary({})).toBeNull();
	});

	it("formats RSS in MB", () => {
		const result = formatUsageSummary({ maxRssKb: 102_400 });
		expect(result).toBe("rss=100.0MB");
	});

	it("formats CPU user and system time", () => {
		const result = formatUsageSummary({ userMs: 1500, systemMs: 500 });
		expect(result).toBe("cpu(user=1500ms, sys=500ms)");
	});

	it("formats combined RSS and CPU", () => {
		const result = formatUsageSummary({
			maxRssKb: 51_200,
			userMs: 200,
			systemMs: 100,
		});
		expect(result).toBe("rss=50.0MB cpu(user=200ms, sys=100ms)");
	});
});

describe("formatTaskSummary", () => {
	it("includes task id, pid, and status", () => {
		const task = makeTask({ pid: 42 });
		const summary = formatTaskSummary(task);
		expect(summary).toContain("task-123");
		expect(summary).toContain("pid=42");
		expect(summary).toContain("status=running");
	});

	it("shows pid=unknown when pid is missing", () => {
		const task = makeTask({ pid: undefined });
		expect(formatTaskSummary(task)).toContain("pid=unknown");
	});

	it("includes exit code for finished tasks", () => {
		const task = makeTask({ status: "exited", exitCode: 0 });
		expect(formatTaskSummary(task)).toContain("exit=0");
	});

	it("includes signal for signaled tasks", () => {
		const task = makeTask({ status: "stopped", signal: "SIGTERM" });
		expect(formatTaskSummary(task)).toContain("signal=SIGTERM");
	});

	it("includes stopping label when stopRequested", () => {
		const task = makeTask({ stopRequested: true, status: "running" });
		expect(formatTaskSummary(task)).toContain("stopping");
	});

	it("includes logs=truncated when logTruncated", () => {
		const task = makeTask({ logTruncated: true });
		expect(formatTaskSummary(task)).toContain("logs=truncated");
	});

	it("includes restart counts", () => {
		const task = makeTask({
			status: "restarting",
			restartPolicy: makeRestartPolicy({ attempts: 1, maxAttempts: 3 }),
		});
		expect(formatTaskSummary(task)).toContain("restarts=1/3");
	});
});

describe("buildTaskDetail", () => {
	it("returns structured detail object", () => {
		const task = makeTask({
			pid: 99,
			status: "running",
			shellMode: "shell",
			logTruncated: true,
			failureReason: "out of memory",
			monitoringMode: "proc",
			resourceUsage: { maxRssKb: 1024 },
			restartPolicy: makeRestartPolicy({
				maxAttempts: 5,
				attempts: 2,
				delayMs: 500,
				strategy: "exponential",
			}),
		});
		const detail = buildTaskDetail(task);

		expect(detail).toMatchObject({
			id: "task-123",
			pid: 99,
			status: "running",
			command: "echo hello",
			shellMode: "shell",
			logTruncated: true,
			restartAttempts: 2,
			restartMaxAttempts: 5,
			restartDelayMs: 500,
			failureReason: "out of memory",
			monitoringMode: "proc",
		});
		expect(detail.resourceUsage).toEqual({ maxRssKb: 1024 });
	});

	it("handles missing optional fields", () => {
		const task = makeTask();
		const detail = buildTaskDetail(task);

		expect(detail.restartAttempts).toBe(0);
		expect(detail.restartMaxAttempts).toBe(0);
		expect(detail.restartDelayMs).toBeNull();
		expect(detail.resourceUsage).toBeNull();
		expect(detail.failureReason).toBeNull();
		expect(detail.monitoringMode).toBe("disabled");
	});
});
