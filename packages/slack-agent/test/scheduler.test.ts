import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	Scheduler,
	getNextRunFromSchedule,
	parseRecurringSchedule,
	parseTimeExpression,
} from "../src/scheduler.js";

describe("parseTimeExpression", () => {
	it("parses relative expressions", () => {
		const now = new Date("2025-01-01T00:00:00.000Z");
		const result = parseTimeExpression("in 2 hours", now, "UTC");
		expect(result?.toISOString()).toBe("2025-01-01T02:00:00.000Z");
	});

	it("parses absolute time in timezone", () => {
		const now = new Date("2025-01-01T13:00:00.000Z");
		const result = parseTimeExpression("at 3pm", now, "UTC");
		expect(result?.toISOString()).toBe("2025-01-01T15:00:00.000Z");
	});

	it("rolls absolute time to tomorrow when already past", () => {
		const now = new Date("2025-01-01T16:00:00.000Z");
		const result = parseTimeExpression("at 3pm", now, "UTC");
		expect(result?.toISOString()).toBe("2025-01-02T15:00:00.000Z");
	});
});

describe("parseRecurringSchedule", () => {
	it("parses daily schedules in a specific timezone", () => {
		const tz = "America/New_York";
		const now = new Date("2025-01-01T12:00:00.000Z"); // 07:00 local
		const result = parseRecurringSchedule("every day at 9am", now, tz);

		expect(result?.schedule).toBe("0 9 * * *");

		const nowDt = DateTime.fromJSDate(now).setZone(tz);
		let expected = nowDt.set({
			hour: 9,
			minute: 0,
			second: 0,
			millisecond: 0,
		});
		if (expected.toMillis() <= nowDt.toMillis()) {
			expected = expected.plus({ days: 1 });
		}

		expect(result?.nextRun.toISOString()).toBe(
			expected.toUTC().toISO({ suppressMilliseconds: false }),
		);
	});

	it("does not delay first run for weekly-interval schedules", () => {
		const now = new Date("2025-01-01T00:00:00.000Z"); // Wed
		const result = parseRecurringSchedule(
			"every 2 weeks on monday at 9am",
			now,
			"UTC",
		);

		expect(result?.schedule).toBe("W2 0 9 * * 1");
		// First run should be the next Monday (not two weeks out).
		expect(result?.nextRun.toISOString()).toBe("2025-01-06T09:00:00.000Z");
	});
});

describe("getNextRunFromSchedule", () => {
	it("handles weekly-interval custom schedules", () => {
		const after = new Date("2025-01-01T00:00:00.000Z"); // Wed
		const next = getNextRunFromSchedule("W2 0 9 * * 1", after, "UTC");
		expect(next.toISOString()).toBe("2025-01-13T09:00:00.000Z");
	});

	it("handles nth-weekday-of-month custom schedules", () => {
		const tz = "UTC";
		const after = new Date("2025-01-10T00:00:00.000Z");
		const next = getNextRunFromSchedule("N1 0 9 * * 1", after, tz);

		const afterDt = DateTime.fromJSDate(after).setZone(tz);
		const firstMonday = (dt: DateTime) => {
			let c = dt
				.startOf("month")
				.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
			while (c.weekday !== 1) {
				c = c.plus({ days: 1 });
			}
			return c;
		};
		const thisMonth = firstMonday(afterDt);
		const expected =
			thisMonth.toMillis() > afterDt.toMillis()
				? thisMonth
				: firstMonday(afterDt.plus({ months: 1 }));

		expect(next.toISOString()).toBe(
			expected.toUTC().toISO({ suppressMilliseconds: false }),
		);
	});

	it("handles standard cron with weekday ranges", () => {
		const after = new Date("2025-01-01T08:00:00.000Z"); // Wed 08:00
		const next = getNextRunFromSchedule("0 9 * * 1-5", after, "UTC");
		expect(next.toISOString()).toBe("2025-01-01T09:00:00.000Z");
	});
});

describe("Scheduler.runNow", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-scheduler-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("prevents concurrent runs of the same task", async () => {
		let resolveDue: (() => void) | undefined;
		const duePromise = new Promise<void>((resolve) => {
			resolveDue = resolve;
		});

		let callCount = 0;
		const onTaskDue = async () => {
			callCount++;
			await duePromise;
			return { success: true };
		};

		const scheduler = new Scheduler({ workingDir: dir, onTaskDue });
		const task = await scheduler.schedule(
			"C1",
			"U1",
			"Test task",
			"Do thing",
			"in 1 hour", // Use a long time so it doesn't trigger during test
		);
		expect(task).not.toBeNull();

		if (!task) throw new Error("Expected task to be scheduled");
		const taskId = task.id;

		// Start first run (will block on duePromise)
		const firstRun = scheduler.runNow(taskId);

		// Give the first run a moment to start
		await new Promise((r) => setTimeout(r, 10));

		// Try second run while first is still running
		const secondRun = await scheduler.runNow(taskId);
		expect(secondRun?.success).toBe(false);
		expect(secondRun?.error?.toLowerCase()).toContain("already running");

		// Complete the first run
		resolveDue?.();
		const firstResult = await firstRun;
		expect(firstResult?.success).toBe(true);
		expect(callCount).toBe(1);
	});

	it("removes one-time task after successful run", async () => {
		const onTaskDue = async () => ({ success: true });

		const scheduler = new Scheduler({ workingDir: dir, onTaskDue });
		const task = await scheduler.schedule(
			"C1",
			"U1",
			"Test task",
			"Do thing",
			"in 1 hour",
		);

		if (!task) throw new Error("Expected task to be scheduled");

		const firstResult = await scheduler.runNow(task.id);
		expect(firstResult?.success).toBe(true);

		// One-time task should be removed after running
		const secondResult = await scheduler.runNow(task.id);
		expect(secondResult).toBeNull();
	});

	it("allows running recurring task multiple times", async () => {
		let callCount = 0;
		const onTaskDue = async () => {
			callCount++;
			return { success: true };
		};

		const scheduler = new Scheduler({ workingDir: dir, onTaskDue });
		const task = await scheduler.schedule(
			"C1",
			"U1",
			"Recurring task",
			"Do thing",
			"every day at 9am",
		);

		if (!task) throw new Error("Expected task to be scheduled");

		const firstResult = await scheduler.runNow(task.id);
		expect(firstResult?.success).toBe(true);

		const secondResult = await scheduler.runNow(task.id);
		expect(secondResult?.success).toBe(true);

		expect(callCount).toBe(2);
	});

	it("returns null for non-existent task", async () => {
		const onTaskDue = async () => ({ success: true });
		const scheduler = new Scheduler({ workingDir: dir, onTaskDue });

		const result = await scheduler.runNow("nonexistent-task-id");
		expect(result).toBeNull();
	});
});
