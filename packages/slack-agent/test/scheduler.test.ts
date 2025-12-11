import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
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
