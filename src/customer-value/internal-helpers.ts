/**
 * Shared leaf helpers extracted from report.ts so that the ambient-learning
 * subsystem and the report builder can both depend on them without creating a
 * runtime cycle between report.ts and ambient-learning.ts.
 *
 * Dependency direction (runtime): report.ts -> internal-helpers.ts,
 * ambient-learning.ts -> internal-helpers.ts. No runtime imports point back at
 * report.ts; the CustomerValueRange reference below is type-only (erased).
 */
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
import type { CustomerValueRange } from "./report.js";

export function sum<T>(values: T[], read: (value: T) => number): number {
	return values.reduce((total, value) => total + read(value), 0);
}

export function parseTimestampMs(timestamp: unknown): number | undefined {
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
		return timestamp;
	}
	if (typeof timestamp !== "string" || timestamp.trim() === "") {
		return undefined;
	}
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

export function isTimestampInRange(
	timestamp: unknown,
	range: CustomerValueRange,
): boolean {
	const timestampMs = parseTimestampMs(timestamp);
	if (timestampMs === undefined) return false;
	if (range.since !== undefined && timestampMs < range.since) return false;
	if (range.until !== undefined && timestampMs >= range.until) return false;
	return true;
}

export function isTimestampInRangeOrUnbounded(
	timestamp: number | undefined,
	range: CustomerValueRange,
): boolean {
	if (range.since === undefined && range.until === undefined) return true;
	if (timestamp === undefined) return false;
	return isTimestampInRange(timestamp, range);
}

export function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function numberOrZero(value: unknown): number {
	return numberField(value) ?? 0;
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
}

export function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

export function normalizeLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function redactLine(text: string): string {
	return sanitizeWithStaticMask(normalizeLine(text));
}

export function sanitizeA2ALabel(text: string, maxLength: number): string {
	return truncate(redactLine(text), maxLength);
}
