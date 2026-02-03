import { DateTime } from "luxon";

/**
 * Validate timezone string (IANA format)
 */
export function isValidTimezone(tz: string): boolean {
	return DateTime.now().setZone(tz).isValid;
}

function toLuxonWeekday(dayIndex: number): number {
	if (dayIndex === 0) return 7;
	return dayIndex;
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

/**
 * Calculate the next run time from a cron-like schedule.
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
			: dayOfWeekPart.split(",").map((part) => Number.parseInt(part, 10));
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

	return base
		.plus({ months: 1 })
		.startOf("month")
		.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
}

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
