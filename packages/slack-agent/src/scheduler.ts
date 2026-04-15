/**
 * Scheduler - Schedule tasks for future execution
 *
 * Supports:
 * - One-time tasks: "remind me in 2 hours"
 * - Recurring tasks: "run this every morning at 9am"
 */

import { existsSync, readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DateTime } from "luxon";
import * as logger from "./logger.js";
import { ensureDir, ensureDirSync } from "./utils/fs.js";

export interface ScheduledTask {
	id: string;
	channelId: string;
	createdBy: string;
	createdAt: string;
	description: string;
	prompt: string;
	/** Next execution time (ISO string in UTC) */
	nextRun: string;
	/** Cron-like schedule for recurring tasks (null for one-time) */
	schedule: string | null;
	/** Whether task is active */
	active: boolean;
	/** Whether task is paused (for recurring tasks) */
	paused: boolean;
	/** Number of times this task has run */
	runCount: number;
	/** Last run time (ISO string) */
	lastRun: string | null;
	/** Last run result */
	lastRunStatus: "success" | "failure" | null;
	/** Last error message if failed */
	lastError: string | null;
	/** Timezone for the task (IANA format, e.g., "America/New_York") */
	timezone: string;
	/** Retry count for failed one-time tasks */
	retryCount: number;
	/** Max retries for one-time tasks (default 0) */
	maxRetries: number;
	/** Minutes before task to send notification (0 = disabled) */
	notifyBefore: number;
	/** Whether notification was sent for next run */
	notificationSent: boolean;
}

export interface TaskRunResult {
	success: boolean;
	error?: string;
}

export interface SchedulerConfig {
	workingDir: string;
	/** Called when a task is due to run. Should return success/failure. */
	onTaskDue: (task: ScheduledTask) => Promise<TaskRunResult>;
	/** Called to send notification before task runs */
	onNotify?: (task: ScheduledTask, minutesUntil: number) => Promise<void>;
	/** Default timezone for tasks (default: "UTC") */
	defaultTimezone?: string;
}

/**
 * Get current time in a specific timezone.
 * Returns a Date representing the current instant, validated against IANA tz names.
 */
export function getNowInTimezone(timezone: string): Date {
	const zone = isValidTimezone(timezone) ? timezone : "UTC";
	return DateTime.now().setZone(zone).toJSDate();
}

/**
 * Validate timezone string (IANA format)
 */
export function isValidTimezone(tz: string): boolean {
	return DateTime.now().setZone(tz).isValid;
}

/**
 * Get day of week index (0=Sunday) for a day name
 */
const DAY_NAMES = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
];

function getDayIndex(name: string): number {
	return DAY_NAMES.indexOf(name.toLowerCase());
}

// Convert JS day index (0=Sunday..6=Saturday) to Luxon weekday (1=Monday..7=Sunday)
function toLuxonWeekday(dayIndex: number): number {
	if (dayIndex === 0) return 7;
	return dayIndex;
}

/**
 * Parse a human-readable time expression into a Date
 * Examples: "in 2 hours", "in 30 minutes", "tomorrow at 9am", "at 3pm",
 *           "next friday", "next friday at 3pm"
 */
export function parseTimeExpression(
	expr: string,
	now = new Date(),
	timezone = "UTC",
): Date | null {
	const lowerExpr = expr.toLowerCase().trim();
	const zone = isValidTimezone(timezone) ? timezone : "UTC";
	const nowDt = DateTime.fromJSDate(now).setZone(zone);

	// "in X minutes/hours/days/weeks" (relative, timezone-agnostic)
	const inMatch = lowerExpr.match(
		/^in\s+(\d+)\s*(min(?:ute)?s?|hour?s?|day?s?|week?s?)$/,
	);
	if (inMatch) {
		const amount = Number.parseInt(inMatch[1]!, 10);
		const unit = inMatch[2]!;
		let dt = nowDt;

		if (unit.startsWith("min")) {
			dt = dt.plus({ minutes: amount });
		} else if (unit.startsWith("hour") || unit === "h") {
			dt = dt.plus({ hours: amount });
		} else if (unit.startsWith("day") || unit === "d") {
			dt = dt.plus({ days: amount });
		} else if (unit.startsWith("week") || unit === "w") {
			dt = dt.plus({ weeks: amount });
		}
		return dt.toJSDate();
	}

	// "at HH:MM" or "at Ham/pm" (interpreted in task timezone)
	const atMatch = lowerExpr.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
	if (atMatch) {
		let hours = Number.parseInt(atMatch[1]!, 10);
		const minutes = atMatch[2] ? Number.parseInt(atMatch[2], 10) : 0;
		const ampm = atMatch[3];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		let dt = nowDt.set({
			hour: hours,
			minute: minutes,
			second: 0,
			millisecond: 0,
		});

		if (dt.toMillis() <= nowDt.toMillis()) {
			dt = dt.plus({ days: 1 });
		}
		return dt.toJSDate();
	}

	// "tomorrow at HH:MM"
	const tomorrowMatch = lowerExpr.match(
		/^tomorrow(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (tomorrowMatch) {
		let hours = 9;
		let minutes = 0;
		if (tomorrowMatch[1]) {
			hours = Number.parseInt(tomorrowMatch[1], 10);
			minutes = tomorrowMatch[2] ? Number.parseInt(tomorrowMatch[2], 10) : 0;
			const ampm = tomorrowMatch[3];
			if (ampm === "pm" && hours < 12) hours += 12;
			if (ampm === "am" && hours === 12) hours = 0;
		}

		const dt = nowDt
			.plus({ days: 1 })
			.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
		return dt.toJSDate();
	}

	// "next monday/tuesday/etc" or "next monday at 3pm"
	const nextDayMatch = lowerExpr.match(
		/^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (nextDayMatch) {
		const targetDay = toLuxonWeekday(getDayIndex(nextDayMatch[1]!));
		let hours = nextDayMatch[2] ? Number.parseInt(nextDayMatch[2], 10) : 9;
		const minutes = nextDayMatch[3] ? Number.parseInt(nextDayMatch[3], 10) : 0;
		const ampm = nextDayMatch[4];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		let dt = nowDt.set({
			hour: hours,
			minute: minutes,
			second: 0,
			millisecond: 0,
		});

		do {
			dt = dt.plus({ days: 1 });
		} while (dt.weekday !== targetDay);

		return dt.toJSDate();
	}

	// "this friday" or "this friday at 3pm" (same week, or next if past)
	const thisDayMatch = lowerExpr.match(
		/^this\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (thisDayMatch) {
		const targetDay = toLuxonWeekday(getDayIndex(thisDayMatch[1]!));
		let hours = thisDayMatch[2] ? Number.parseInt(thisDayMatch[2], 10) : 9;
		const minutes = thisDayMatch[3] ? Number.parseInt(thisDayMatch[3], 10) : 0;
		const ampm = thisDayMatch[4];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		let dt = nowDt.set({
			hour: hours,
			minute: minutes,
			second: 0,
			millisecond: 0,
		});

		const currentDay = dt.weekday;
		let daysToAdd = targetDay - currentDay;
		if (
			daysToAdd < 0 ||
			(daysToAdd === 0 && dt.toMillis() <= nowDt.toMillis())
		) {
			daysToAdd += 7;
		}

		dt = dt.plus({ days: daysToAdd });
		return dt.toJSDate();
	}

	// (duplicate legacy JS-Date implementation removed in favor of Luxon version above)
	return null;
}

/**
 * Parse a recurring schedule expression
 * Examples: "every day at 9am", "every hour", "every monday at 10am",
 *           "every 2 weeks on monday", "first monday of month at 9am",
 *           or raw cron: "cron 0 9 * * 1"
 */
export function parseRecurringSchedule(
	expr: string,
	now = new Date(),
	timezone = "UTC",
): { schedule: string; nextRun: Date } | null {
	const lowerExpr = expr.toLowerCase().trim();
	const zone = isValidTimezone(timezone) ? timezone : "UTC";
	const nowDt = DateTime.fromJSDate(now).setZone(zone);

	// "every X minutes/hours"
	const intervalMatch = lowerExpr.match(
		/^every\s+(\d+)\s*(min(?:ute)?s?|hours?)$/,
	);
	if (intervalMatch) {
		const amount = Number.parseInt(intervalMatch[1]!, 10);
		const unit = intervalMatch[2]!;

		if (unit.startsWith("min")) {
			const schedule = `*/${amount} * * * *`;
			const nextRun = getNextRunFromSchedule(schedule, now, timezone);
			return { schedule, nextRun };
		}
		if (unit.startsWith("hour")) {
			const schedule = `0 */${amount} * * *`;
			const nextRun = getNextRunFromSchedule(schedule, now, timezone);
			return { schedule, nextRun };
		}
	}

	// "every hour"
	if (lowerExpr === "every hour") {
		const nextRun = nowDt
			.plus({ hours: 1 })
			.set({ minute: 0, second: 0, millisecond: 0 });
		return { schedule: "0 * * * *", nextRun: nextRun.toJSDate() };
	}

	// "every day at HH:MM"
	const dailyMatch = lowerExpr.match(
		/^every\s+day(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (dailyMatch) {
		let hours = dailyMatch[1] ? Number.parseInt(dailyMatch[1], 10) : 9;
		const minutes = dailyMatch[2] ? Number.parseInt(dailyMatch[2], 10) : 0;
		const ampm = dailyMatch[3];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		let nextRun = nowDt.set({
			hour: hours,
			minute: minutes,
			second: 0,
			millisecond: 0,
		});
		if (nextRun.toMillis() <= nowDt.toMillis()) {
			nextRun = nextRun.plus({ days: 1 });
		}

		return {
			schedule: `${minutes} ${hours} * * *`,
			nextRun: nextRun.toJSDate(),
		};
	}

	// "every weekday at HH:MM" (Mon-Fri)
	const weekdayMatch = lowerExpr.match(
		/^every\s+weekday(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (weekdayMatch) {
		let hours = weekdayMatch[1] ? Number.parseInt(weekdayMatch[1], 10) : 9;
		const minutes = weekdayMatch[2] ? Number.parseInt(weekdayMatch[2], 10) : 0;
		const ampm = weekdayMatch[3];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		let nextRun = nowDt.set({
			hour: hours,
			minute: minutes,
			second: 0,
			millisecond: 0,
		});

		while (nextRun.toMillis() <= nowDt.toMillis() || nextRun.weekday > 5) {
			nextRun = nextRun.plus({ days: 1 });
		}

		return {
			schedule: `${minutes} ${hours} * * 1-5`,
			nextRun: nextRun.toJSDate(),
		};
	}

	// "every monday/tuesday/etc at HH:MM"
	const dayMatch = lowerExpr.match(
		/^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (dayMatch) {
		const targetDayIndex = getDayIndex(dayMatch[1]!);
		const targetWeekday = toLuxonWeekday(targetDayIndex);
		let hours = dayMatch[2] ? Number.parseInt(dayMatch[2], 10) : 9;
		const minutes = dayMatch[3] ? Number.parseInt(dayMatch[3], 10) : 0;
		const ampm = dayMatch[4];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		let nextRun = nowDt.set({
			hour: hours,
			minute: minutes,
			second: 0,
			millisecond: 0,
		});

		while (
			nextRun.toMillis() <= nowDt.toMillis() ||
			nextRun.weekday !== targetWeekday
		) {
			nextRun = nextRun.plus({ days: 1 });
		}

		return {
			schedule: `${minutes} ${hours} * * ${targetDayIndex}`,
			nextRun: nextRun.toJSDate(),
		};
	}

	// "every N weeks on monday at HH:MM"
	const weeksMatch = lowerExpr.match(
		/^every\s+(\d+)\s+weeks?\s+on\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (weeksMatch) {
		const intervalWeeks = Number.parseInt(weeksMatch[1]!, 10);
		const targetDayIndex = getDayIndex(weeksMatch[2]!);
		const targetWeekday = toLuxonWeekday(targetDayIndex);
		let hours = weeksMatch[3] ? Number.parseInt(weeksMatch[3], 10) : 9;
		const minutes = weeksMatch[4] ? Number.parseInt(weeksMatch[4], 10) : 0;
		const ampm = weeksMatch[5];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		let nextRun = nowDt.set({
			hour: hours,
			minute: minutes,
			second: 0,
			millisecond: 0,
		});

		while (
			nextRun.toMillis() <= nowDt.toMillis() ||
			nextRun.weekday !== targetWeekday
		) {
			nextRun = nextRun.plus({ days: 1 });
		}

		return {
			schedule: `W${intervalWeeks} ${minutes} ${hours} * * ${targetDayIndex}`,
			nextRun: nextRun.toJSDate(),
		};
	}

	// "first/second/third/fourth/last monday of month at HH:MM"
	const nthDayMatch = lowerExpr.match(
		/^(first|second|third|fourth|last)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+of\s+(?:the\s+)?month(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (nthDayMatch) {
		const ordinals: Record<string, number> = {
			first: 1,
			second: 2,
			third: 3,
			fourth: 4,
			last: -1,
		};
		const nth = ordinals[nthDayMatch[1]!]!;
		const targetDayIndex = getDayIndex(nthDayMatch[2]!);
		const targetWeekday = toLuxonWeekday(targetDayIndex);
		let hours = nthDayMatch[3] ? Number.parseInt(nthDayMatch[3], 10) : 9;
		const minutes = nthDayMatch[4] ? Number.parseInt(nthDayMatch[4], 10) : 0;
		const ampm = nthDayMatch[5];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		const nextRunDt = findNthDayOfMonth(
			nowDt,
			targetWeekday,
			nth,
			hours,
			minutes,
		);

		return {
			schedule: `N${nth} ${minutes} ${hours} * * ${targetDayIndex}`,
			nextRun: nextRunDt.toJSDate(),
		};
	}

	// Raw cron: "cron 0 9 * * 1"
	const cronMatch = lowerExpr.match(/^cron\s+(.+)$/);
	if (cronMatch) {
		const cronExpr = cronMatch[1]!.trim();
		const parts = cronExpr.split(/\s+/);
		if (parts.length === 5) {
			const nextRun = getNextRunFromSchedule(cronExpr, now, timezone);
			return { schedule: cronExpr, nextRun };
		}
	}

	// (duplicate legacy JS-Date recurring implementation removed)
	return null;
}

/**
 * Find the nth occurrence of a weekday in a month (timezone-aware).
 * Weekday uses Luxon numbering (1=Mon..7=Sun).
 */
function findNthDayOfMonth(
	after: DateTime,
	weekday: number,
	nth: number,
	hours: number,
	minutes: number,
): DateTime {
	const zone = after.zoneName || "UTC";
	const base = after.set({
		hour: hours,
		minute: minutes,
		second: 0,
		millisecond: 0,
	});

	for (let monthOffset = 0; monthOffset < 12; monthOffset++) {
		const monthDt = base.plus({ months: monthOffset });
		const candidate = getNthDayInMonth(
			monthDt.year,
			monthDt.month,
			weekday,
			nth,
			hours,
			minutes,
			zone,
		);
		if (candidate && candidate.toMillis() > after.toMillis()) {
			return candidate;
		}
	}

	// Fallback: first day of next month at given time
	return base
		.plus({ months: 1 })
		.startOf("month")
		.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
}

/**
 * Get the nth weekday of a specific month (timezone-aware).
 * Month is 1-based (Luxon). Weekday uses Luxon numbering (1=Mon..7=Sun).
 */
function getNthDayInMonth(
	year: number,
	month: number,
	weekday: number,
	nth: number,
	hours: number,
	minutes: number,
	zone: string,
): DateTime | null {
	const monthStart = DateTime.fromObject(
		{
			year,
			month,
			day: 1,
			hour: hours,
			minute: minutes,
			second: 0,
			millisecond: 0,
		},
		{ zone },
	);

	if (nth === -1) {
		let last = monthStart.endOf("month");
		while (last.weekday !== weekday) {
			last = last.minus({ days: 1 });
		}
		return last.set({
			hour: hours,
			minute: minutes,
			second: 0,
			millisecond: 0,
		});
	}

	const firstWeekday = monthStart.weekday;
	const daysUntilTarget = (weekday - firstWeekday + 7) % 7;
	const candidate = monthStart.plus({
		days: daysUntilTarget + (nth - 1) * 7,
	});

	if (candidate.month !== month) {
		return null;
	}
	return candidate;
}

/**
 * Calculate the next run time from a cron-like schedule
 * Supports standard cron and custom formats:
 * - Standard: "0 9 * * 1" (min hour dom month dow)
 * - Weekly interval: "W2 0 9 * * 1" (every 2 weeks on Monday at 9am)
 * - Nth day of month: "N1 0 9 * * 1" (first Monday of month at 9am)
 */
export function getNextRunFromSchedule(
	schedule: string,
	after = new Date(),
	timezone = "UTC",
): Date {
	const parts = schedule.split(" ");
	const zone = isValidTimezone(timezone) ? timezone : "UTC";
	const afterDt = DateTime.fromJSDate(after).setZone(zone);

	// Handle custom weekly interval format: "W<weeks> min hour * * day"
	if (parts[0]?.startsWith("W")) {
		const weeks = Number.parseInt(parts[0].slice(1), 10);
		const minute = Number.parseInt(parts[1]!, 10);
		const hour = Number.parseInt(parts[2]!, 10);
		const dayOfWeekIndex = Number.parseInt(parts[5]!, 10);
		const targetWeekday = toLuxonWeekday(dayOfWeekIndex);

		let nextDt = afterDt.set({
			hour,
			minute,
			second: 0,
			millisecond: 0,
		});

		while (
			nextDt.toMillis() <= afterDt.toMillis() ||
			nextDt.weekday !== targetWeekday
		) {
			nextDt = nextDt.plus({ days: 1 });
		}

		if (weeks > 1) {
			nextDt = nextDt.plus({ weeks: weeks - 1 });
		}

		return nextDt.toJSDate();
	}

	// Handle custom nth day of month format: "N<nth> min hour * * day"
	if (parts[0]?.startsWith("N")) {
		const nth = Number.parseInt(parts[0].slice(1), 10);
		const minute = Number.parseInt(parts[1]!, 10);
		const hour = Number.parseInt(parts[2]!, 10);
		const dayOfWeekIndex = Number.parseInt(parts[5]!, 10);
		const targetWeekday = toLuxonWeekday(dayOfWeekIndex);

		return findNthDayOfMonth(
			afterDt,
			targetWeekday,
			nth,
			hour,
			minute,
		).toJSDate();
	}

	// Standard cron format
	if (parts.length !== 5) {
		return afterDt.plus({ hours: 1 }).toJSDate();
	}

	const minutePart = parts[0]!;
	const hourPart = parts[1]!;
	const dayOfWeekPart = parts[4]!;

	let nextDt = afterDt.set({ second: 0, millisecond: 0 });

	// Handle minute
	if (minutePart.startsWith("*/")) {
		const interval = Number.parseInt(minutePart.slice(2), 10);
		const currentMinute = nextDt.minute;
		const nextMinute = Math.ceil((currentMinute + 1) / interval) * interval;
		if (nextMinute >= 60) {
			nextDt = nextDt.plus({ hours: 1 }).set({ minute: nextMinute % 60 });
		} else {
			nextDt = nextDt.set({ minute: nextMinute });
		}
		return nextDt.toJSDate();
	}

	const minute = Number.parseInt(minutePart, 10);
	nextDt = nextDt.set({ minute });

	// Handle hour
	if (hourPart === "*") {
		if (nextDt.toMillis() <= afterDt.toMillis()) {
			nextDt = nextDt.plus({ hours: 1 });
		}
		return nextDt.toJSDate();
	}

	if (hourPart.startsWith("*/")) {
		const interval = Number.parseInt(hourPart.slice(2), 10);
		const currentHour = nextDt.hour;
		const nextHour = Math.ceil((currentHour + 1) / interval) * interval;
		if (nextHour >= 24) {
			nextDt = nextDt.plus({ days: 1 }).set({ hour: nextHour % 24 });
		} else {
			nextDt = nextDt.set({ hour: nextHour });
		}
		if (nextDt.toMillis() <= afterDt.toMillis()) {
			nextDt = nextDt.plus({ hours: interval });
		}
		return nextDt.toJSDate();
	}

	const hour = Number.parseInt(hourPart, 10);
	nextDt = nextDt.set({ hour });

	// Handle day of week (cron DOW uses JS indices 0-6)
	if (dayOfWeekPart !== "*") {
		const targetDays = dayOfWeekPart.includes("-")
			? expandDayRange(dayOfWeekPart)
			: [Number.parseInt(dayOfWeekPart, 10)];
		const targetWeekdays = targetDays.map(toLuxonWeekday);

		while (
			nextDt.toMillis() <= afterDt.toMillis() ||
			!targetWeekdays.includes(nextDt.weekday)
		) {
			nextDt = nextDt.plus({ days: 1 });
		}
		return nextDt.toJSDate();
	}

	// Daily at specific time
	if (nextDt.toMillis() <= afterDt.toMillis()) {
		nextDt = nextDt.plus({ days: 1 });
	}

	return nextDt.toJSDate();
}

function expandDayRange(range: string): number[] {
	const parts = range.split("-").map((n) => Number.parseInt(n, 10));
	const start = parts[0] ?? 0;
	const end = parts[1] ?? start;
	const days: number[] = [];
	for (let i = start; i <= end; i++) {
		days.push(i);
	}
	return days;
}

export class Scheduler {
	private workingDir: string;
	private tasks: Map<string, ScheduledTask> = new Map();
	private onTaskDue: (task: ScheduledTask) => Promise<TaskRunResult>;
	private onNotify?: (
		task: ScheduledTask,
		minutesUntil: number,
	) => Promise<void>;
	private defaultTimezone: string;
	private checkInterval: ReturnType<typeof setInterval> | null = null;
	private checking = false;
	private checkPromise: Promise<void> | null = null;
	private tasksFile: string;
	private historyFile: string;
	private runningTaskIds: Set<string> = new Set();

	constructor(config: SchedulerConfig) {
		this.workingDir = config.workingDir;
		this.onTaskDue = config.onTaskDue;
		this.onNotify = config.onNotify;
		const requestedDefaultTz = config.defaultTimezone || "UTC";
		if (!isValidTimezone(requestedDefaultTz)) {
			logger.logWarning(
				"Invalid default timezone provided to Scheduler; falling back to UTC",
				requestedDefaultTz,
			);
			this.defaultTimezone = "UTC";
		} else {
			this.defaultTimezone = requestedDefaultTz;
		}
		this.tasksFile = join(this.workingDir, "scheduled_tasks.json");
		this.historyFile = join(this.workingDir, "task_history.jsonl");

		ensureDirSync(this.workingDir);
		this.loadTasks();
	}

	private loadTasks(): void {
		if (!existsSync(this.tasksFile)) {
			return;
		}

		try {
			const content = readFileSync(this.tasksFile, "utf-8");
			const tasksArray = JSON.parse(content) as ScheduledTask[];
			for (const task of tasksArray) {
				// Normalize invalid stored timezones to reflect actual scheduling behavior.
				// Historically, invalid timezones were treated as UTC during parsing.
				if (!task.timezone || !isValidTimezone(task.timezone)) {
					task.timezone = "UTC";
				}
				this.tasks.set(task.id, task);
			}
			logger.logInfo(`Loaded ${this.tasks.size} scheduled tasks`);
		} catch (error) {
			logger.logWarning("Failed to load scheduled tasks", String(error));
		}
	}

	private async saveTasks(): Promise<void> {
		// Ensure the working directory still exists (tests may clean tmp dirs)
		await ensureDir(this.workingDir);
		const tasksArray = Array.from(this.tasks.values());
		const serialized = JSON.stringify(tasksArray, null, 2);
		const tmpPath = `${this.tasksFile}.tmp`;
		await writeFile(tmpPath, serialized);
		try {
			await rename(tmpPath, this.tasksFile);
		} catch {
			// Fallback to direct write if rename fails (e.g., cross-device)
			await writeFile(this.tasksFile, serialized);
			await unlink(tmpPath).catch(() => undefined);
		}
	}

	/**
	 * Schedule a new task
	 */
	async schedule(
		channelId: string,
		createdBy: string,
		description: string,
		prompt: string,
		when: string,
		options?: {
			timezone?: string;
			maxRetries?: number;
			notifyBefore?: number;
		},
	): Promise<ScheduledTask | null> {
		const requestedTz = options?.timezone || this.defaultTimezone;
		const timezone = isValidTimezone(requestedTz)
			? requestedTz
			: this.defaultTimezone;
		const now = new Date();

		// Try parsing as recurring schedule first
		const recurring = parseRecurringSchedule(when, now, timezone);
		if (recurring) {
			const task: ScheduledTask = {
				id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				channelId,
				createdBy,
				createdAt: new Date().toISOString(),
				description,
				prompt,
				nextRun: recurring.nextRun.toISOString(),
				schedule: recurring.schedule,
				active: true,
				paused: false,
				runCount: 0,
				lastRun: null,
				lastRunStatus: null,
				lastError: null,
				timezone,
				retryCount: 0,
				maxRetries: 0, // Recurring tasks don't retry, they just run next time
				notifyBefore: options?.notifyBefore || 0,
				notificationSent: false,
			};

			this.tasks.set(task.id, task);
			await this.saveTasks();
			logger.logInfo(
				`Scheduled recurring task: ${task.id} - ${description} (${recurring.schedule})`,
			);
			return task;
		}

		// Try parsing as one-time
		const oneTime = parseTimeExpression(when, now, timezone);
		if (oneTime) {
			const task: ScheduledTask = {
				id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				channelId,
				createdBy,
				createdAt: new Date().toISOString(),
				description,
				prompt,
				nextRun: oneTime.toISOString(),
				schedule: null,
				active: true,
				paused: false,
				runCount: 0,
				lastRun: null,
				lastRunStatus: null,
				lastError: null,
				timezone,
				retryCount: 0,
				maxRetries: options?.maxRetries || 0,
				notifyBefore: options?.notifyBefore || 0,
				notificationSent: false,
			};

			this.tasks.set(task.id, task);
			await this.saveTasks();
			logger.logInfo(`Scheduled one-time task: ${task.id} - ${description}`);
			return task;
		}

		return null;
	}

	/**
	 * Pause a recurring task
	 */
	async pause(taskId: string): Promise<boolean> {
		const task = this.tasks.get(taskId);
		if (!task || !task.schedule) {
			return false;
		}

		task.paused = true;
		await this.saveTasks();
		logger.logInfo(`Paused task: ${taskId}`);
		return true;
	}

	/**
	 * Resume a paused recurring task
	 */
	async resume(taskId: string): Promise<boolean> {
		const task = this.tasks.get(taskId);
		if (!task || !task.paused) {
			return false;
		}

		task.paused = false;
		// Recalculate next run from now
		if (task.schedule) {
			task.nextRun = getNextRunFromSchedule(
				task.schedule,
				new Date(),
				task.timezone,
			).toISOString();
		}
		task.notificationSent = false;
		await this.saveTasks();
		logger.logInfo(`Resumed task: ${taskId}`);
		return true;
	}

	/**
	 * Cancel a scheduled task
	 */
	async cancel(taskId: string): Promise<boolean> {
		const task = this.tasks.get(taskId);
		if (!task) {
			return false;
		}

		task.active = false;
		await this.saveTasks();
		logger.logInfo(`Cancelled task: ${taskId}`);
		return true;
	}

	/**
	 * List tasks for a channel
	 */
	listTasks(channelId: string): ScheduledTask[] {
		return Array.from(this.tasks.values()).filter(
			(t) => t.channelId === channelId && t.active,
		);
	}

	/**
	 * Start the scheduler check loop
	 */
	start(): void {
		if (this.checkInterval) {
			return;
		}

		// Check every minute
		this.checkInterval = setInterval(() => void this.runCheck(), 60000);
		logger.logInfo("Scheduler started");

		// Run initial check
		void this.runCheck();
	}

	/**
	 * Stop the scheduler
	 */
	async stop(): Promise<void> {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
			logger.logInfo("Scheduler stopped");
		}
		if (this.checkPromise) {
			await this.checkPromise;
		}
	}

	private async runCheck(): Promise<void> {
		if (this.checkPromise) {
			return this.checkPromise;
		}
		const runPromise = (async () => {
			this.checking = true;
			try {
				await this.checkDueTasks();
			} catch (error) {
				logger.logWarning("Scheduler check failed", String(error));
			} finally {
				this.checking = false;
				this.checkPromise = null;
			}
		})();
		this.checkPromise = runPromise;
		return runPromise;
	}

	private async checkDueTasks(): Promise<void> {
		const now = new Date();

		for (const task of this.tasks.values()) {
			if (!task.active || task.paused) continue;

			const nextRun = new Date(task.nextRun);
			const minutesUntil = (nextRun.getTime() - now.getTime()) / 60000;

			// Check for pre-run notification
			if (
				task.notifyBefore > 0 &&
				!task.notificationSent &&
				minutesUntil <= task.notifyBefore &&
				minutesUntil > 0 &&
				this.onNotify
			) {
				try {
					await this.onNotify(task, Math.ceil(minutesUntil));
					task.notificationSent = true;
					await this.saveTasks();
				} catch (error) {
					logger.logWarning(
						`Failed to send notification for task ${task.id}`,
						String(error),
					);
				}
			}

			// Check if task is due
			if (nextRun <= now) {
				await this.runTaskAndUpdate(task, now);
			}
		}
	}

	/**
	 * Run a task immediately and update state/logs as if it were due.
	 * Returns null if task doesn't exist or is inactive.
	 */
	async runNow(taskId: string): Promise<TaskRunResult | null> {
		const task = this.tasks.get(taskId);
		if (!task || !task.active) return null;
		const now = new Date();
		const result = await this.runTaskAndUpdate(task, now);
		return result;
	}

	private async runTaskAndUpdate(
		task: ScheduledTask,
		now: Date,
	): Promise<TaskRunResult> {
		if (this.runningTaskIds.has(task.id)) {
			return {
				success: false,
				error: "Task already running",
			};
		}

		this.runningTaskIds.add(task.id);
		try {
			logger.logInfo(
				`Running scheduled task: ${task.id} - ${task.description}`,
			);

			let result: TaskRunResult;
			try {
				result = await this.onTaskDue(task);
			} catch (error) {
				result = {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}

			task.runCount++;
			task.lastRun = now.toISOString();
			task.lastRunStatus = result.success ? "success" : "failure";
			task.lastError = result.error || null;

			if (result.success && !task.schedule) {
				// One-time task: mark inactive immediately to avoid races with async logging
				task.active = false;
				this.tasks.delete(task.id);
			}

			await this.logHistory(task, result);

			if (result.success) {
				task.retryCount = 0;
				task.notificationSent = false;

				if (task.schedule) {
					task.nextRun = getNextRunFromSchedule(
						task.schedule,
						now,
						task.timezone,
					).toISOString();
				}
			} else {
				if (!task.schedule && task.retryCount < task.maxRetries) {
					task.retryCount++;
					const retryTime = new Date(now.getTime() + 5 * 60 * 1000);
					task.nextRun = retryTime.toISOString();
					logger.logInfo(
						`Task ${task.id} failed, scheduling retry ${task.retryCount}/${task.maxRetries}`,
					);
				} else if (task.schedule) {
					task.nextRun = getNextRunFromSchedule(
						task.schedule,
						now,
						task.timezone,
					).toISOString();
					task.notificationSent = false;
				} else {
					task.active = false;
					logger.logWarning(
						`Task ${task.id} failed permanently after ${task.retryCount} retries`,
						result.error || "unknown error",
					);
				}
			}

			await this.saveTasks();
			return result;
		} finally {
			this.runningTaskIds.delete(task.id);
		}
	}

	/**
	 * Log task execution to history file
	 */
	private async logHistory(
		task: ScheduledTask,
		result: TaskRunResult,
	): Promise<void> {
		const entry = {
			timestamp: new Date().toISOString(),
			taskId: task.id,
			channelId: task.channelId,
			description: task.description,
			success: result.success,
			error: result.error || null,
			runCount: task.runCount,
			retryCount: task.retryCount,
		};

		try {
			await ensureDir(this.workingDir);
			const { appendFile } = await import("node:fs/promises");
			await appendFile(this.historyFile, `${JSON.stringify(entry)}\n`);
		} catch (error) {
			logger.logWarning("Failed to log task history", String(error));
		}
	}

	/**
	 * Get task execution history
	 */
	getHistory(
		channelId?: string,
		limit = 50,
	): Array<{
		timestamp: string;
		taskId: string;
		channelId: string;
		description: string;
		success: boolean;
		error: string | null;
	}> {
		if (!existsSync(this.historyFile)) {
			return [];
		}

		try {
			const content = readFileSync(this.historyFile, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			const entries = lines
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter(Boolean);

			// Filter by channel if specified
			const filtered = channelId
				? entries.filter((e) => e.channelId === channelId)
				: entries;

			// Return most recent entries
			return filtered.slice(-limit).reverse();
		} catch {
			return [];
		}
	}
}
