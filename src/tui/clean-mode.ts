import type { CleanMode } from "../conversation/render-model.js";

/**
 * Parse a clean mode value from a string.
 * @param value - The string value to parse
 * @returns The parsed CleanMode or null if invalid
 */
export function parseCleanMode(value: string): CleanMode | null {
	const normalized = value.toLowerCase();
	if (normalized === "off" || normalized === "disable" || normalized === "0") {
		return "off";
	}
	if (
		normalized === "on" ||
		normalized === "true" ||
		normalized === "soft" ||
		normalized === "1"
	) {
		return "soft";
	}
	if (normalized === "aggressive") {
		return "aggressive";
	}
	return null;
}

/**
 * Read clean mode from environment variable.
 * @returns The CleanMode from COMPOSER_TUI_CLEAN or null if not set/invalid
 */
export function readCleanModeFromEnv(): CleanMode | null {
	const raw = process.env.COMPOSER_TUI_CLEAN;
	if (!raw) return null;
	return parseCleanMode(raw);
}
