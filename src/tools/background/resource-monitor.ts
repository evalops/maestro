/**
 * Resource Monitor for Background Tasks
 *
 * Platform-specific resource usage monitoring for child processes.
 * Supports Linux (/proc filesystem) and macOS (ps command).
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Resource usage snapshot for a process.
 */
export interface TaskResourceUsage {
	/** Resident set size in kilobytes */
	maxRssKb?: number;
	/** User-mode CPU time in milliseconds */
	userMs?: number;
	/** System-mode CPU time in milliseconds */
	systemMs?: number;
}

/**
 * Clock ticks per second on Linux systems.
 * Standard value for most distributions.
 */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Extracts fields from /proc/<pid>/stat content.
 *
 * ## /proc/<pid>/stat Format
 *
 * Fields are space-separated. Key fields (0-indexed after parsing):
 * - Field 0: pid
 * - Field 1: comm (command name in parentheses)
 * - Field 2: state (R, S, D, Z, T, etc.)
 *
 * After the comm field:
 * - Index 11 (utime): User mode CPU time in clock ticks
 * - Index 12 (stime): Kernel mode CPU time in clock ticks
 *
 * ## Why lastIndexOf?
 *
 * The command name can contain ")" characters. For example:
 * `12345 (node (v18)) S 1234 ...`
 * Using lastIndexOf(") ") ensures we find the real end of the comm field.
 *
 * @param statRaw - Raw content of /proc/<pid>/stat
 * @returns Array of fields starting from field 3 (state), or null if parse fails
 */
export function extractProcStatFields(statRaw: string): string[] | null {
	const trimmed = statRaw.trim();
	// Find the closing parenthesis of the command name field
	// Use lastIndexOf because command name itself can contain ")"
	const splitIndex = trimmed.lastIndexOf(") ");
	if (splitIndex === -1) {
		return null;
	}
	// Everything after ") " is the remaining fields, space-separated
	const remainder = trimmed.slice(splitIndex + 2).trim();
	if (!remainder) {
		return null;
	}
	// Split on whitespace to get individual fields
	return remainder.split(/\s+/);
}

/**
 * Monitors resource usage for background processes.
 *
 * Provides platform-specific implementations:
 * - Linux: Reads /proc/<pid>/stat and /proc/<pid>/status
 * - macOS: Uses ps command
 */
export class ResourceMonitor {
	private readonly monitoringMode: "proc" | "ps" | "disabled";

	constructor() {
		this.monitoringMode = this.detectMonitoringMode();
	}

	/**
	 * Detect which monitoring mode to use based on platform.
	 */
	private detectMonitoringMode(): "proc" | "ps" | "disabled" {
		if (process.platform === "linux") return "proc";
		if (process.platform === "darwin") return "ps";
		return "disabled";
	}

	/**
	 * Get resource usage for a process.
	 *
	 * @param pid - Process ID to monitor
	 * @returns Resource usage snapshot, or null if unavailable
	 */
	getUsage(pid: number): TaskResourceUsage | null {
		switch (this.monitoringMode) {
			case "proc":
				return this.readUsageFromProc(pid);
			case "ps":
				return this.readUsageFromPs(pid);
			default:
				return null;
		}
	}

	/**
	 * Check if monitoring is available on this platform.
	 */
	isAvailable(): boolean {
		return this.monitoringMode !== "disabled";
	}

	/**
	 * Get the current monitoring mode.
	 */
	getMode(): "proc" | "ps" | "disabled" {
		return this.monitoringMode;
	}

	/**
	 * Read resource usage from Linux /proc filesystem.
	 */
	private readUsageFromProc(pid: number): TaskResourceUsage | null {
		const usage: TaskResourceUsage = {};

		// Read memory from /proc/<pid>/status
		try {
			const status = readFileSync(`/proc/${pid}/status`, "utf8");
			const match = status.match(/VmRSS:\s+(\d+)\s+kB/i);
			if (match?.[1]) {
				const rssValue = Number.parseInt(match[1], 10);
				if (Number.isFinite(rssValue)) {
					usage.maxRssKb = Math.max(rssValue, 0);
				}
			}
		} catch {
			// Ignore inability to read status (process likely exited)
		}

		// Read CPU time from /proc/<pid>/stat
		try {
			const statRaw = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
			const fields = extractProcStatFields(statRaw);
			if (fields) {
				const userTicks = Number.parseInt(fields[11] ?? "", 10);
				const systemTicks = Number.parseInt(fields[12] ?? "", 10);
				const msPerTick = 1000 / CLOCK_TICKS_PER_SECOND;

				if (Number.isFinite(userTicks)) {
					usage.userMs = Math.max(userTicks * msPerTick, 0);
				}
				if (Number.isFinite(systemTicks)) {
					usage.systemMs = Math.max(systemTicks * msPerTick, 0);
				}
			}
		} catch {
			// Ignore stat read errors; may not be available
		}

		return Object.keys(usage).length > 0 ? usage : null;
	}

	/**
	 * Read resource usage using macOS ps command.
	 */
	private readUsageFromPs(pid: number): TaskResourceUsage | null {
		try {
			const output = execSync(`ps -o rss= -o time= -p ${pid}`, {
				encoding: "utf-8",
			})
				.trim()
				.split(/\s+/)
				.filter(Boolean);

			if (output.length < 2) {
				return null;
			}

			const rssKb = Number.parseInt(output[0] ?? "", 10);
			const timeMs = this.parsePsTimeToMs(output[1] ?? "");
			const usage: TaskResourceUsage = {};

			if (Number.isFinite(rssKb)) {
				usage.maxRssKb = Math.max(rssKb, 0);
			}
			if (Number.isFinite(timeMs)) {
				// ps only reports total CPU time; treat as user time for limit enforcement
				usage.userMs = Math.max(timeMs, 0);
			}

			return Object.keys(usage).length > 0 ? usage : null;
		} catch {
			return null;
		}
	}

	/**
	 * Parse ps time format to milliseconds.
	 * Supports formats: [[dd-]hh:]mm:ss
	 */
	private parsePsTimeToMs(timeText: string): number {
		const daySplit = timeText.split("-");
		let dayPortion = 0;
		let timePortion = timeText;

		if (daySplit.length === 2) {
			dayPortion = Number.parseInt(daySplit[0] ?? "0", 10);
			timePortion = daySplit[1] ?? "";
		}

		const parts = timePortion.split(":").map((p) => Number.parseInt(p, 10));

		if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) {
			return Number.NaN;
		}

		const [hoursOrMinutes, minutesOrSeconds, seconds] =
			parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];

		const hours = (parts.length === 3 ? hoursOrMinutes : 0) ?? 0;
		const minutes =
			(parts.length === 3 ? minutesOrSeconds : hoursOrMinutes) ?? 0;
		const secs = (parts.length === 3 ? seconds : minutesOrSeconds) ?? 0;

		const totalSeconds =
			(dayPortion || 0) * 24 * 3600 + hours * 3600 + minutes * 60 + secs;

		return totalSeconds * 1000;
	}
}
