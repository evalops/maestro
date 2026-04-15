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
	describe("interval expressions", () => {
		it("parses 'every N minutes'", () => {
			const now = new Date("2025-01-01T12:00:00.000Z");
			const result = parseRecurringSchedule("every 15 minutes", now, "UTC");

			expect(result?.schedule).toBe("*/15 * * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T12:15:00.000Z");
		});

		it("aligns 'every N minutes' to cron boundaries", () => {
			const now = new Date("2025-01-01T12:03:00.000Z");
			const result = parseRecurringSchedule("every 10 minutes", now, "UTC");

			expect(result?.schedule).toBe("*/10 * * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T12:10:00.000Z");
		});

		it("parses 'every N mins'", () => {
			const now = new Date("2025-01-01T12:00:00.000Z");
			const result = parseRecurringSchedule("every 30 mins", now, "UTC");

			expect(result?.schedule).toBe("*/30 * * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T12:30:00.000Z");
		});

		it("parses 'every N hours'", () => {
			const now = new Date("2025-01-01T12:00:00.000Z");
			const result = parseRecurringSchedule("every 2 hours", now, "UTC");

			expect(result?.schedule).toBe("0 */2 * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T14:00:00.000Z");
		});

		it("aligns 'every N hours' to top-of-hour boundaries", () => {
			const now = new Date("2025-01-01T12:37:00.000Z");
			const result = parseRecurringSchedule("every 2 hours", now, "UTC");

			expect(result?.schedule).toBe("0 */2 * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T14:00:00.000Z");
		});

		it("parses 'every hour'", () => {
			const now = new Date("2025-01-01T12:30:00.000Z");
			const result = parseRecurringSchedule("every hour", now, "UTC");

			expect(result?.schedule).toBe("0 * * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T13:00:00.000Z");
		});
	});

	describe("daily expressions", () => {
		it("parses 'every day at 9am'", () => {
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

		it("parses 'every day at 3pm'", () => {
			const now = new Date("2025-01-01T12:00:00.000Z");
			const result = parseRecurringSchedule("every day at 3pm", now, "UTC");

			expect(result?.schedule).toBe("0 15 * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T15:00:00.000Z");
		});

		it("parses 'every day at 14:30'", () => {
			const now = new Date("2025-01-01T12:00:00.000Z");
			const result = parseRecurringSchedule("every day at 14:30", now, "UTC");

			expect(result?.schedule).toBe("30 14 * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T14:30:00.000Z");
		});

		it("parses 'every day' with default 9am", () => {
			const now = new Date("2025-01-01T06:00:00.000Z");
			const result = parseRecurringSchedule("every day", now, "UTC");

			expect(result?.schedule).toBe("0 9 * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T09:00:00.000Z");
		});

		it("rolls to next day when time has passed", () => {
			const now = new Date("2025-01-01T20:00:00.000Z"); // 8pm, past 3pm
			const result = parseRecurringSchedule("every day at 3pm", now, "UTC");

			expect(result?.nextRun.toISOString()).toBe("2025-01-02T15:00:00.000Z");
		});

		it("handles 12am correctly", () => {
			const now = new Date("2025-01-01T12:00:00.000Z");
			const result = parseRecurringSchedule("every day at 12am", now, "UTC");

			expect(result?.schedule).toBe("0 0 * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-02T00:00:00.000Z");
		});

		it("handles 12pm correctly", () => {
			const now = new Date("2025-01-01T06:00:00.000Z");
			const result = parseRecurringSchedule("every day at 12pm", now, "UTC");

			expect(result?.schedule).toBe("0 12 * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T12:00:00.000Z");
		});
	});

	describe("weekday expressions", () => {
		it("parses 'every weekday at 9am'", () => {
			const now = new Date("2025-01-01T06:00:00.000Z"); // Wed
			const result = parseRecurringSchedule("every weekday at 9am", now, "UTC");

			expect(result?.schedule).toBe("0 9 * * 1-5");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T09:00:00.000Z");
		});

		it("skips to Monday when now is Saturday", () => {
			const now = new Date("2025-01-04T12:00:00.000Z"); // Saturday
			const result = parseRecurringSchedule("every weekday at 9am", now, "UTC");

			expect(result?.schedule).toBe("0 9 * * 1-5");
			expect(result?.nextRun.toISOString()).toBe("2025-01-06T09:00:00.000Z"); // Monday
		});

		it("parses 'every weekday' with default 9am", () => {
			const now = new Date("2025-01-01T06:00:00.000Z"); // Wed
			const result = parseRecurringSchedule("every weekday", now, "UTC");

			expect(result?.schedule).toBe("0 9 * * 1-5");
		});
	});

	describe("specific day expressions", () => {
		it("parses 'every monday at 10am'", () => {
			const now = new Date("2025-01-01T00:00:00.000Z"); // Wed
			const result = parseRecurringSchedule("every monday at 10am", now, "UTC");

			expect(result?.schedule).toBe("0 10 * * 1");
			expect(result?.nextRun.toISOString()).toBe("2025-01-06T10:00:00.000Z");
		});

		it("parses 'every friday at 5pm'", () => {
			const now = new Date("2025-01-01T00:00:00.000Z"); // Wed
			const result = parseRecurringSchedule("every friday at 5pm", now, "UTC");

			expect(result?.schedule).toBe("0 17 * * 5");
			expect(result?.nextRun.toISOString()).toBe("2025-01-03T17:00:00.000Z");
		});

		it("parses 'every sunday' with default 9am", () => {
			const now = new Date("2025-01-01T00:00:00.000Z"); // Wed
			const result = parseRecurringSchedule("every sunday", now, "UTC");

			expect(result?.schedule).toBe("0 9 * * 0");
			expect(result?.nextRun.toISOString()).toBe("2025-01-05T09:00:00.000Z");
		});

		it("parses all days of week", () => {
			const now = new Date("2025-01-01T00:00:00.000Z");
			const days = [
				"sunday",
				"monday",
				"tuesday",
				"wednesday",
				"thursday",
				"friday",
				"saturday",
			];
			const expectedDayIndices = [0, 1, 2, 3, 4, 5, 6];

			days.forEach((day, i) => {
				const result = parseRecurringSchedule(`every ${day}`, now, "UTC");
				expect(result?.schedule).toBe(`0 9 * * ${expectedDayIndices[i]}`);
			});
		});
	});

	describe("weekly interval expressions", () => {
		it("parses 'every 2 weeks on monday at 9am'", () => {
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

		it("parses 'every 1 week on friday at 3pm'", () => {
			const now = new Date("2025-01-01T00:00:00.000Z"); // Wed
			const result = parseRecurringSchedule(
				"every 1 week on friday at 3pm",
				now,
				"UTC",
			);

			expect(result?.schedule).toBe("W1 0 15 * * 5");
			expect(result?.nextRun.toISOString()).toBe("2025-01-03T15:00:00.000Z");
		});
	});

	describe("nth day of month expressions", () => {
		it("parses 'first monday of month at 9am'", () => {
			const now = new Date("2025-01-15T00:00:00.000Z");
			const result = parseRecurringSchedule(
				"first monday of month at 9am",
				now,
				"UTC",
			);

			expect(result?.schedule).toBe("N1 0 9 * * 1");
			// First Monday of Feb 2025 is Feb 3
			expect(result?.nextRun.toISOString()).toBe("2025-02-03T09:00:00.000Z");
		});

		it("parses 'second tuesday of the month'", () => {
			const now = new Date("2025-01-01T00:00:00.000Z");
			const result = parseRecurringSchedule(
				"second tuesday of the month",
				now,
				"UTC",
			);

			expect(result?.schedule).toBe("N2 0 9 * * 2");
			// Second Tuesday of Jan 2025 is Jan 14
			expect(result?.nextRun.toISOString()).toBe("2025-01-14T09:00:00.000Z");
		});

		it("parses 'third wednesday of month at 2pm'", () => {
			const now = new Date("2025-01-01T00:00:00.000Z");
			const result = parseRecurringSchedule(
				"third wednesday of month at 2pm",
				now,
				"UTC",
			);

			expect(result?.schedule).toBe("N3 0 14 * * 3");
			// Third Wednesday of Jan 2025 is Jan 15
			expect(result?.nextRun.toISOString()).toBe("2025-01-15T14:00:00.000Z");
		});

		it("parses 'last friday of month'", () => {
			const now = new Date("2025-01-01T00:00:00.000Z");
			const result = parseRecurringSchedule("last friday of month", now, "UTC");

			expect(result?.schedule).toBe("N-1 0 9 * * 5");
			// Last Friday of Jan 2025 is Jan 31
			expect(result?.nextRun.toISOString()).toBe("2025-01-31T09:00:00.000Z");
		});
	});

	describe("raw cron expressions", () => {
		it("parses 'cron 0 9 * * 1'", () => {
			const now = new Date("2025-01-01T00:00:00.000Z"); // Wed
			const result = parseRecurringSchedule("cron 0 9 * * 1", now, "UTC");

			expect(result?.schedule).toBe("0 9 * * 1");
			// Next Monday 9am
			expect(result?.nextRun.toISOString()).toBe("2025-01-06T09:00:00.000Z");
		});

		it("parses complex cron expressions", () => {
			const now = new Date("2025-01-01T00:00:00.000Z");
			const result = parseRecurringSchedule("cron 30 14 1 * *", now, "UTC");

			expect(result?.schedule).toBe("30 14 1 * *");
			// 1st of month at 14:30
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T14:30:00.000Z");
		});
	});

	describe("edge cases", () => {
		it("returns null for invalid expressions", () => {
			const now = new Date();
			expect(parseRecurringSchedule("invalid", now, "UTC")).toBeNull();
			expect(parseRecurringSchedule("", now, "UTC")).toBeNull();
			expect(parseRecurringSchedule("at 9am", now, "UTC")).toBeNull();
			expect(parseRecurringSchedule("tomorrow", now, "UTC")).toBeNull();
		});

		it("handles case insensitivity", () => {
			const now = new Date("2025-01-01T00:00:00.000Z");
			const result1 = parseRecurringSchedule("EVERY DAY AT 9AM", now, "UTC");
			const result2 = parseRecurringSchedule("Every Monday At 3PM", now, "UTC");

			expect(result1?.schedule).toBe("0 9 * * *");
			expect(result2?.schedule).toBe("0 15 * * 1");
		});

		it("handles invalid timezone by falling back to UTC", () => {
			const now = new Date("2025-01-01T06:00:00.000Z");
			const result = parseRecurringSchedule(
				"every day at 9am",
				now,
				"Invalid/Timezone",
			);

			expect(result?.schedule).toBe("0 9 * * *");
			expect(result?.nextRun.toISOString()).toBe("2025-01-01T09:00:00.000Z");
		});

		it("handles leading/trailing whitespace", () => {
			const now = new Date("2025-01-01T06:00:00.000Z");
			const result = parseRecurringSchedule("  every day at 9am  ", now, "UTC");

			expect(result?.schedule).toBe("0 9 * * *");
		});
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
