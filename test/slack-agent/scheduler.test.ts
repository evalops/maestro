/**
 * Tests for scheduler.ts - Scheduled tasks
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getNextRunFromSchedule,
	parseRecurringSchedule,
	parseTimeExpression,
} from "../../packages/slack-agent/src/scheduler.js";

describe("parseTimeExpression", () => {
	const now = new Date("2024-01-15T10:30:00Z");

	it("parses 'in X minutes'", () => {
		const result = parseTimeExpression("in 30 minutes", now);
		expect(result).not.toBeNull();
		expect(result?.getTime()).toBe(now.getTime() + 30 * 60 * 1000);
	});

	it("parses 'in X hours'", () => {
		const result = parseTimeExpression("in 2 hours", now);
		expect(result).not.toBeNull();
		expect(result?.getTime()).toBe(now.getTime() + 2 * 60 * 60 * 1000);
	});

	it("parses 'in X days'", () => {
		const result = parseTimeExpression("in 3 days", now);
		expect(result).not.toBeNull();
		expect(result?.getTime()).toBe(now.getTime() + 3 * 24 * 60 * 60 * 1000);
	});

	it("parses 'at HH:MM' for future time today", () => {
		const result = parseTimeExpression("at 14:00", now);
		expect(result).not.toBeNull();
		expect(result?.getHours()).toBe(14);
		expect(result?.getMinutes()).toBe(0);
		expect(result?.getDate()).toBe(now.getDate());
	});

	it("parses 'at HH:MM' for past time (schedules tomorrow)", () => {
		// Use a time that's definitely in the past relative to 10:30
		const result = parseTimeExpression("at 8:00", now);
		expect(result).not.toBeNull();
		expect(result?.getHours()).toBe(8);
		// Should be tomorrow (next day)
		expect(result?.getTime()).toBeGreaterThan(now.getTime());
	});

	it("parses 'at Ham/pm' format", () => {
		const result = parseTimeExpression("at 3pm", now);
		expect(result).not.toBeNull();
		expect(result?.getHours()).toBe(15);
	});

	it("parses 'tomorrow at HH:MM'", () => {
		const result = parseTimeExpression("tomorrow at 9:30", now);
		expect(result).not.toBeNull();
		expect(result?.getDate()).toBe(now.getDate() + 1);
		expect(result?.getHours()).toBe(9);
		expect(result?.getMinutes()).toBe(30);
	});

	it("parses 'tomorrow' without time (defaults to 9am)", () => {
		const result = parseTimeExpression("tomorrow", now);
		expect(result).not.toBeNull();
		expect(result?.getDate()).toBe(now.getDate() + 1);
		expect(result?.getHours()).toBe(9);
	});

	it("returns null for invalid expressions", () => {
		expect(parseTimeExpression("next week", now)).toBeNull();
		expect(parseTimeExpression("sometime", now)).toBeNull();
		expect(parseTimeExpression("", now)).toBeNull();
	});
});

describe("parseRecurringSchedule", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-01-15T10:30:00Z")); // Monday
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("parses 'every hour'", () => {
		const result = parseRecurringSchedule("every hour");
		expect(result).not.toBeNull();
		expect(result?.schedule).toBe("0 * * * *");
	});

	it("parses 'every 30 minutes'", () => {
		const result = parseRecurringSchedule("every 30 minutes");
		expect(result).not.toBeNull();
		expect(result?.schedule).toBe("*/30 * * * *");
	});

	it("parses 'every day at 9am'", () => {
		const result = parseRecurringSchedule("every day at 9am");
		expect(result).not.toBeNull();
		expect(result?.schedule).toBe("0 9 * * *");
	});

	it("parses 'every day at 14:30'", () => {
		const result = parseRecurringSchedule("every day at 14:30");
		expect(result).not.toBeNull();
		expect(result?.schedule).toBe("30 14 * * *");
	});

	it("parses 'every weekday at 9am'", () => {
		const result = parseRecurringSchedule("every weekday at 9am");
		expect(result).not.toBeNull();
		expect(result?.schedule).toBe("0 9 * * 1-5");
	});

	it("parses 'every monday at 10am'", () => {
		const result = parseRecurringSchedule("every monday at 10am");
		expect(result).not.toBeNull();
		expect(result?.schedule).toBe("0 10 * * 1");
	});

	it("returns null for invalid schedules", () => {
		expect(parseRecurringSchedule("sometimes")).toBeNull();
		expect(parseRecurringSchedule("every blue moon")).toBeNull();
	});
});

describe("getNextRunFromSchedule", () => {
	it("calculates next run for hourly schedule", () => {
		const now = new Date("2024-01-15T10:30:00Z");
		const next = getNextRunFromSchedule("0 * * * *", now);
		// Should be at the next hour mark
		expect(next.getMinutes()).toBe(0);
		expect(next.getTime()).toBeGreaterThan(now.getTime());
	});

	it("calculates next run for daily schedule", () => {
		const now = new Date("2024-01-15T10:30:00Z");
		const next = getNextRunFromSchedule("0 9 * * *", now);
		// Should be in the future
		expect(next.getTime()).toBeGreaterThan(now.getTime());
		expect(next.getHours()).toBe(9);
		expect(next.getMinutes()).toBe(0);
	});

	it("calculates next run for weekday schedule", () => {
		const now = new Date("2024-01-15T10:30:00Z"); // Monday
		const next = getNextRunFromSchedule("0 9 * * 1-5", now);
		// Should be a weekday (1-5) in the future
		expect(next.getTime()).toBeGreaterThan(now.getTime());
		expect(next.getDay()).toBeGreaterThanOrEqual(1);
		expect(next.getDay()).toBeLessThanOrEqual(5);
	});

	it("calculates next run for specific day schedule", () => {
		const now = new Date("2024-01-15T10:30:00Z"); // Monday
		const next = getNextRunFromSchedule("0 10 * * 3", now); // Wednesday
		expect(next.getDay()).toBe(3);
		expect(next.getHours()).toBe(10);
		expect(next.getTime()).toBeGreaterThan(now.getTime());
	});
});
