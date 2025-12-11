/**
 * Scheduler - Schedule tasks for future execution
 *
 * Supports:
 * - One-time tasks: "remind me in 2 hours"
 * - Recurring tasks: "run this every morning at 9am"
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as logger from "./logger.js";

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
 * Get current time in a specific timezone
 */
export function getNowInTimezone(timezone: string): Date {
	try {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
		const parts = formatter.formatToParts(new Date());
		const get = (type: string) =>
			parts.find((p) => p.type === type)?.value || "0";
		return new Date(
			`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`,
		);
	} catch {
		return new Date();
	}
}

/**
 * Validate timezone string
 */
export function isValidTimezone(tz: string): boolean {
	try {
		Intl.DateTimeFormat(undefined, { timeZone: tz });
		return true;
	} catch {
		return false;
	}
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

/**
 * Parse a human-readable time expression into a Date
 * Examples: "in 2 hours", "in 30 minutes", "tomorrow at 9am", "at 3pm",
 *           "next friday", "next friday at 3pm"
 */
export function parseTimeExpression(
	expr: string,
	now = new Date(),
): Date | null {
	const lowerExpr = expr.toLowerCase().trim();

	// "in X minutes/hours/days"
	const inMatch = lowerExpr.match(
		/^in\s+(\d+)\s*(min(?:ute)?s?|hour?s?|day?s?|week?s?)$/,
	);
	if (inMatch) {
		const amount = Number.parseInt(inMatch[1], 10);
		const unit = inMatch[2];
		const result = new Date(now);

		if (unit.startsWith("min")) {
			result.setMinutes(result.getMinutes() + amount);
		} else if (unit.startsWith("hour") || unit === "h") {
			result.setHours(result.getHours() + amount);
		} else if (unit.startsWith("day") || unit === "d") {
			result.setDate(result.getDate() + amount);
		} else if (unit.startsWith("week") || unit === "w") {
			result.setDate(result.getDate() + amount * 7);
		}
		return result;
	}

	// "at HH:MM" or "at Ham/pm"
	const atMatch = lowerExpr.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
	if (atMatch) {
		let hours = Number.parseInt(atMatch[1], 10);
		const minutes = atMatch[2] ? Number.parseInt(atMatch[2], 10) : 0;
		const ampm = atMatch[3];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		const result = new Date(now);
		result.setHours(hours, minutes, 0, 0);

		// If the time is in the past, schedule for tomorrow
		if (result <= now) {
			result.setDate(result.getDate() + 1);
		}
		return result;
	}

	// "tomorrow at HH:MM"
	const tomorrowMatch = lowerExpr.match(
		/^tomorrow(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (tomorrowMatch) {
		const result = new Date(now);
		result.setDate(result.getDate() + 1);

		if (tomorrowMatch[1]) {
			let hours = Number.parseInt(tomorrowMatch[1], 10);
			const minutes = tomorrowMatch[2]
				? Number.parseInt(tomorrowMatch[2], 10)
				: 0;
			const ampm = tomorrowMatch[3];

			if (ampm === "pm" && hours < 12) hours += 12;
			if (ampm === "am" && hours === 12) hours = 0;

			result.setHours(hours, minutes, 0, 0);
		} else {
			result.setHours(9, 0, 0, 0); // Default to 9am
		}
		return result;
	}

	// "next monday/tuesday/etc" or "next monday at 3pm"
	const nextDayMatch = lowerExpr.match(
		/^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (nextDayMatch) {
		const targetDay = getDayIndex(nextDayMatch[1]);
		let hours = nextDayMatch[2] ? Number.parseInt(nextDayMatch[2], 10) : 9;
		const minutes = nextDayMatch[3] ? Number.parseInt(nextDayMatch[3], 10) : 0;
		const ampm = nextDayMatch[4];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		const result = new Date(now);
		result.setHours(hours, minutes, 0, 0);

		// Find next occurrence (must be in the future)
		do {
			result.setDate(result.getDate() + 1);
		} while (result.getDay() !== targetDay);

		return result;
	}

	// "this friday" or "this friday at 3pm" (same week, or next if past)
	const thisDayMatch = lowerExpr.match(
		/^this\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (thisDayMatch) {
		const targetDay = getDayIndex(thisDayMatch[1]);
		let hours = thisDayMatch[2] ? Number.parseInt(thisDayMatch[2], 10) : 9;
		const minutes = thisDayMatch[3] ? Number.parseInt(thisDayMatch[3], 10) : 0;
		const ampm = thisDayMatch[4];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		const result = new Date(now);
		result.setHours(hours, minutes, 0, 0);

		// Find this week's occurrence or next week if past
		const currentDay = result.getDay();
		let daysToAdd = targetDay - currentDay;
		if (daysToAdd < 0 || (daysToAdd === 0 && result <= now)) {
			daysToAdd += 7;
		}
		result.setDate(result.getDate() + daysToAdd);

		return result;
	}

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
): { schedule: string; nextRun: Date } | null {
	const lowerExpr = expr.toLowerCase().trim();
	const now = new Date();

	// "every X minutes/hours"
	const intervalMatch = lowerExpr.match(
		/^every\s+(\d+)\s*(min(?:ute)?s?|hours?)$/,
	);
	if (intervalMatch) {
		const amount = Number.parseInt(intervalMatch[1], 10);
		const unit = intervalMatch[2];
		const nextRun = new Date(now);

		if (unit.startsWith("min")) {
			nextRun.setMinutes(nextRun.getMinutes() + amount);
			return { schedule: `*/${amount} * * * *`, nextRun };
		}
		if (unit.startsWith("hour")) {
			nextRun.setHours(nextRun.getHours() + amount);
			return { schedule: `0 */${amount} * * *`, nextRun };
		}
	}

	// "every hour"
	if (lowerExpr === "every hour") {
		const nextRun = new Date(now);
		nextRun.setHours(nextRun.getHours() + 1, 0, 0, 0);
		return { schedule: "0 * * * *", nextRun };
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

		const nextRun = new Date(now);
		nextRun.setHours(hours, minutes, 0, 0);
		if (nextRun <= now) {
			nextRun.setDate(nextRun.getDate() + 1);
		}

		return { schedule: `${minutes} ${hours} * * *`, nextRun };
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

		const nextRun = new Date(now);
		nextRun.setHours(hours, minutes, 0, 0);

		// Find next weekday
		while (nextRun <= now || nextRun.getDay() === 0 || nextRun.getDay() === 6) {
			nextRun.setDate(nextRun.getDate() + 1);
		}

		return { schedule: `${minutes} ${hours} * * 1-5`, nextRun };
	}

	// "every monday/tuesday/etc at HH:MM"
	const dayNames = [
		"sunday",
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
	];
	const dayMatch = lowerExpr.match(
		/^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (dayMatch) {
		const targetDay = dayNames.indexOf(dayMatch[1]);
		let hours = dayMatch[2] ? Number.parseInt(dayMatch[2], 10) : 9;
		const minutes = dayMatch[3] ? Number.parseInt(dayMatch[3], 10) : 0;
		const ampm = dayMatch[4];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		const nextRun = new Date(now);
		nextRun.setHours(hours, minutes, 0, 0);

		// Find next occurrence of this day
		while (nextRun <= now || nextRun.getDay() !== targetDay) {
			nextRun.setDate(nextRun.getDate() + 1);
		}

		return { schedule: `${minutes} ${hours} * * ${targetDay}`, nextRun };
	}

	// "every N weeks on monday at HH:MM"
	const weeksMatch = lowerExpr.match(
		/^every\s+(\d+)\s+weeks?\s+on\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
	);
	if (weeksMatch) {
		const intervalWeeks = Number.parseInt(weeksMatch[1], 10);
		const targetDay = getDayIndex(weeksMatch[2]);
		let hours = weeksMatch[3] ? Number.parseInt(weeksMatch[3], 10) : 9;
		const minutes = weeksMatch[4] ? Number.parseInt(weeksMatch[4], 10) : 0;
		const ampm = weeksMatch[5];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		const nextRun = new Date(now);
		nextRun.setHours(hours, minutes, 0, 0);

		// Find next occurrence of this day
		while (nextRun <= now || nextRun.getDay() !== targetDay) {
			nextRun.setDate(nextRun.getDate() + 1);
		}

		// Use custom schedule format: "W<weeks> <min> <hour> * * <day>"
		return {
			schedule: `W${intervalWeeks} ${minutes} ${hours} * * ${targetDay}`,
			nextRun,
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
		const nth = ordinals[nthDayMatch[1]];
		const targetDay = getDayIndex(nthDayMatch[2]);
		let hours = nthDayMatch[3] ? Number.parseInt(nthDayMatch[3], 10) : 9;
		const minutes = nthDayMatch[4] ? Number.parseInt(nthDayMatch[4], 10) : 0;
		const ampm = nthDayMatch[5];

		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;

		const nextRun = findNthDayOfMonth(now, targetDay, nth, hours, minutes);

		// Use custom schedule format: "N<nth> <min> <hour> * * <day>"
		return {
			schedule: `N${nth} ${minutes} ${hours} * * ${targetDay}`,
			nextRun,
		};
	}

	// Raw cron: "cron 0 9 * * 1"
	const cronMatch = lowerExpr.match(/^cron\s+(.+)$/);
	if (cronMatch) {
		const cronExpr = cronMatch[1].trim();
		const parts = cronExpr.split(/\s+/);
		if (parts.length === 5) {
			const nextRun = getNextRunFromSchedule(cronExpr, now);
			return { schedule: cronExpr, nextRun };
		}
	}

	return null;
}

/**
 * Find the nth occurrence of a weekday in a month
 */
function findNthDayOfMonth(
	after: Date,
	dayOfWeek: number,
	nth: number,
	hours: number,
	minutes: number,
): Date {
	const searchDate = new Date(after);
	searchDate.setHours(hours, minutes, 0, 0);

	// Try current month first, then next months
	for (let monthOffset = 0; monthOffset < 12; monthOffset++) {
		const year = searchDate.getFullYear();
		const month = searchDate.getMonth() + monthOffset;
		const result = getNthDayInMonth(year, month, dayOfWeek, nth);
		if (result) {
			result.setHours(hours, minutes, 0, 0);
			if (result > after) {
				return result;
			}
		}
	}

	// Fallback: next month
	const fallback = new Date(after);
	fallback.setMonth(fallback.getMonth() + 1);
	fallback.setDate(1);
	fallback.setHours(hours, minutes, 0, 0);
	return fallback;
}

/**
 * Get the nth weekday of a specific month
 */
function getNthDayInMonth(
	year: number,
	month: number,
	dayOfWeek: number,
	nth: number,
): Date | null {
	const normalizedMonth = month % 12;
	const normalizedYear = year + Math.floor(month / 12);

	if (nth === -1) {
		// Last occurrence: start from end of month
		const lastDay = new Date(normalizedYear, normalizedMonth + 1, 0);
		while (lastDay.getDay() !== dayOfWeek) {
			lastDay.setDate(lastDay.getDate() - 1);
		}
		return lastDay;
	}

	// Find first occurrence
	const firstOfMonth = new Date(normalizedYear, normalizedMonth, 1);
	let daysUntilTarget = dayOfWeek - firstOfMonth.getDay();
	if (daysUntilTarget < 0) daysUntilTarget += 7;

	const firstOccurrence = new Date(
		normalizedYear,
		normalizedMonth,
		1 + daysUntilTarget,
	);
	const nthOccurrence = new Date(firstOccurrence);
	nthOccurrence.setDate(firstOccurrence.getDate() + (nth - 1) * 7);

	// Check if still in same month
	if (nthOccurrence.getMonth() !== normalizedMonth) {
		return null;
	}

	return nthOccurrence;
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
): Date {
	const parts = schedule.split(" ");

	// Handle custom weekly interval format: "W<weeks> min hour * * day"
	if (parts[0].startsWith("W")) {
		const weeks = Number.parseInt(parts[0].slice(1), 10);
		const minute = Number.parseInt(parts[1], 10);
		const hour = Number.parseInt(parts[2], 10);
		const dayOfWeek = Number.parseInt(parts[5], 10);

		const next = new Date(after);
		next.setHours(hour, minute, 0, 0);

		// Find next occurrence of this day
		while (next <= after || next.getDay() !== dayOfWeek) {
			next.setDate(next.getDate() + 1);
		}

		// Add week interval (minus 1 since we already found next occurrence)
		if (weeks > 1) {
			next.setDate(next.getDate() + (weeks - 1) * 7);
		}

		return next;
	}

	// Handle custom nth day of month format: "N<nth> min hour * * day"
	if (parts[0].startsWith("N")) {
		const nth = Number.parseInt(parts[0].slice(1), 10);
		const minute = Number.parseInt(parts[1], 10);
		const hour = Number.parseInt(parts[2], 10);
		const dayOfWeek = Number.parseInt(parts[5], 10);

		return findNthDayOfMonth(after, dayOfWeek, nth, hour, minute);
	}

	// Standard cron format
	if (parts.length !== 5) {
		// Invalid schedule, return 1 hour from now
		const next = new Date(after);
		next.setHours(next.getHours() + 1);
		return next;
	}

	const [minutePart, hourPart, , , dayOfWeekPart] = parts;

	const next = new Date(after);
	next.setSeconds(0, 0);

	// Handle minute
	if (minutePart.startsWith("*/")) {
		const interval = Number.parseInt(minutePart.slice(2), 10);
		const currentMinute = next.getMinutes();
		const nextMinute = Math.ceil((currentMinute + 1) / interval) * interval;
		if (nextMinute >= 60) {
			next.setHours(next.getHours() + 1);
			next.setMinutes(nextMinute % 60);
		} else {
			next.setMinutes(nextMinute);
		}
		return next;
	}

	const minute = Number.parseInt(minutePart, 10);
	next.setMinutes(minute);

	// Handle hour
	if (hourPart === "*") {
		// Every hour at this minute
		if (next <= after) {
			next.setHours(next.getHours() + 1);
		}
		return next;
	}

	if (hourPart.startsWith("*/")) {
		const interval = Number.parseInt(hourPart.slice(2), 10);
		const currentHour = next.getHours();
		const nextHour = Math.ceil((currentHour + 1) / interval) * interval;
		if (nextHour >= 24) {
			next.setDate(next.getDate() + 1);
			next.setHours(nextHour % 24);
		} else {
			next.setHours(nextHour);
		}
		if (next <= after) {
			next.setHours(next.getHours() + interval);
		}
		return next;
	}

	const hour = Number.parseInt(hourPart, 10);
	next.setHours(hour);

	// Handle day of week
	if (dayOfWeekPart !== "*") {
		const targetDays = dayOfWeekPart.includes("-")
			? expandDayRange(dayOfWeekPart)
			: [Number.parseInt(dayOfWeekPart, 10)];

		while (next <= after || !targetDays.includes(next.getDay())) {
			next.setDate(next.getDate() + 1);
		}
		return next;
	}

	// Daily at specific time
	if (next <= after) {
		next.setDate(next.getDate() + 1);
	}

	return next;
}

function expandDayRange(range: string): number[] {
	const [start, end] = range.split("-").map((n) => Number.parseInt(n, 10));
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
	private tasksFile: string;
	private historyFile: string;

	constructor(config: SchedulerConfig) {
		this.workingDir = config.workingDir;
		this.onTaskDue = config.onTaskDue;
		this.onNotify = config.onNotify;
		this.defaultTimezone = config.defaultTimezone || "UTC";
		this.tasksFile = join(this.workingDir, "scheduled_tasks.json");
		this.historyFile = join(this.workingDir, "task_history.jsonl");

		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}

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
				this.tasks.set(task.id, task);
			}
			logger.logInfo(`Loaded ${this.tasks.size} scheduled tasks`);
		} catch (error) {
			logger.logWarning("Failed to load scheduled tasks", String(error));
		}
	}

	private async saveTasks(): Promise<void> {
		const tasksArray = Array.from(this.tasks.values());
		await writeFile(this.tasksFile, JSON.stringify(tasksArray, null, 2));
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
		const timezone = options?.timezone || this.defaultTimezone;

		// Try parsing as recurring schedule first
		const recurring = parseRecurringSchedule(when);
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
		const oneTime = parseTimeExpression(when);
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
		this.checkInterval = setInterval(() => this.checkDueTasks(), 60000);
		logger.logInfo("Scheduler started");

		// Run initial check
		this.checkDueTasks();
	}

	/**
	 * Stop the scheduler
	 */
	stop(): void {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
			logger.logInfo("Scheduler stopped");
		}
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

				// Log to history
				await this.logHistory(task, result);

				if (result.success) {
					task.retryCount = 0;
					task.notificationSent = false;

					if (task.schedule) {
						// Recurring task - calculate next run
						task.nextRun = getNextRunFromSchedule(
							task.schedule,
							now,
						).toISOString();
					} else {
						// One-time task - deactivate
						task.active = false;
					}
				} else {
					// Task failed
					if (!task.schedule && task.retryCount < task.maxRetries) {
						// One-time task with retries remaining
						task.retryCount++;
						// Retry in 5 minutes
						const retryTime = new Date(now.getTime() + 5 * 60 * 1000);
						task.nextRun = retryTime.toISOString();
						logger.logInfo(
							`Task ${task.id} failed, scheduling retry ${task.retryCount}/${task.maxRetries}`,
						);
					} else if (task.schedule) {
						// Recurring task - schedule next run anyway
						task.nextRun = getNextRunFromSchedule(
							task.schedule,
							now,
						).toISOString();
						task.notificationSent = false;
					} else {
						// One-time task with no retries left - deactivate
						task.active = false;
						logger.logWarning(
							`Task ${task.id} failed permanently after ${task.retryCount} retries`,
							result.error || "unknown error",
						);
					}
				}

				await this.saveTasks();
			}
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
