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
	/** Next execution time (ISO string) */
	nextRun: string;
	/** Cron-like schedule for recurring tasks (null for one-time) */
	schedule: string | null;
	/** Whether task is active */
	active: boolean;
	/** Number of times this task has run */
	runCount: number;
	/** Last run time (ISO string) */
	lastRun: string | null;
}

export interface SchedulerConfig {
	workingDir: string;
	onTaskDue: (task: ScheduledTask) => Promise<void>;
}

/**
 * Parse a human-readable time expression into a Date
 * Examples: "in 2 hours", "in 30 minutes", "tomorrow at 9am", "at 3pm"
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

	return null;
}

/**
 * Parse a recurring schedule expression
 * Examples: "every day at 9am", "every hour", "every monday at 10am"
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

	return null;
}

/**
 * Calculate the next run time from a cron-like schedule
 */
export function getNextRunFromSchedule(
	schedule: string,
	after = new Date(),
): Date {
	// Simple cron parser for common patterns
	const parts = schedule.split(" ");
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
	private onTaskDue: (task: ScheduledTask) => Promise<void>;
	private checkInterval: ReturnType<typeof setInterval> | null = null;
	private tasksFile: string;

	constructor(config: SchedulerConfig) {
		this.workingDir = config.workingDir;
		this.onTaskDue = config.onTaskDue;
		this.tasksFile = join(this.workingDir, "scheduled_tasks.json");

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
	): Promise<ScheduledTask | null> {
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
				runCount: 0,
				lastRun: null,
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
				runCount: 0,
				lastRun: null,
			};

			this.tasks.set(task.id, task);
			await this.saveTasks();
			logger.logInfo(`Scheduled one-time task: ${task.id} - ${description}`);
			return task;
		}

		return null;
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
			if (!task.active) continue;

			const nextRun = new Date(task.nextRun);
			if (nextRun <= now) {
				try {
					logger.logInfo(
						`Running scheduled task: ${task.id} - ${task.description}`,
					);
					await this.onTaskDue(task);

					task.runCount++;
					task.lastRun = now.toISOString();

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

					await this.saveTasks();
				} catch (error) {
					logger.logWarning(
						`Failed to run scheduled task ${task.id}`,
						String(error),
					);
				}
			}
		}
	}
}
