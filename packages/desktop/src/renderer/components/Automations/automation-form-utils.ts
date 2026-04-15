export type ScheduleKind = "once" | "daily" | "weekly" | "cron";

export const dayOptions = [
	{ label: "Sun", value: 0 },
	{ label: "Mon", value: 1 },
	{ label: "Tue", value: 2 },
	{ label: "Wed", value: 3 },
	{ label: "Thu", value: 4 },
	{ label: "Fri", value: 5 },
	{ label: "Sat", value: 6 },
];

export function formatLocalDateTimeInput(value: string | undefined) {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (num: number) => `${num}`.padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
		date.getDate(),
	)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTimeLabel(value: string) {
	if (!value) return "—";
	const [hourStr, minuteStr] = value.split(":");
	const hours = Number.parseInt(hourStr || "0", 10);
	const minutes = Number.parseInt(minuteStr || "0", 10);
	const date = new Date();
	date.setHours(hours);
	date.setMinutes(minutes);
	return date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}

export function formatDateLabel(value?: string | null) {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function parseCronSchedule(schedule: string | null | undefined) {
	if (!schedule) return null;
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [minute, hour, _dom, _month, dow] = parts;
	if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
	if (!minute || !hour) return null;
	const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
	const days =
		dow && dow !== "*"
			? dow
					.split(",")
					.flatMap((entry) => {
						if (entry.includes("-")) {
							const [startRaw, endRaw] = entry.split("-");
							const start = Number(startRaw);
							const end = Number(endRaw);
							if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
							return Array.from(
								{ length: end - start + 1 },
								(_, i) => start + i,
							);
						}
						const value = Number(entry);
						return Number.isFinite(value) ? [value] : [];
					})
					.filter((day) => Number.isFinite(day))
			: null;
	return { time, days };
}
