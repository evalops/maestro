/**
 * Environment Variable Parsing Utilities
 *
 * Type-safe parsing of environment variables with fallback values.
 * Handles common patterns like booleans, integers, and thresholds.
 */

/**
 * Parse a boolean environment variable.
 *
 * Truthy values: "1", "true", "yes", "on" (case-insensitive)
 * Falsy values: "0", "false", "no", "off" (case-insensitive)
 *
 * @param name - Environment variable name
 * @param fallback - Default value if not set or unrecognized
 * @returns Parsed boolean or fallback
 */
export function readBooleanEnv(name: string, fallback = false): boolean {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	return fallback;
}

/**
 * Parse a non-negative integer environment variable.
 *
 * @param name - Environment variable name
 * @param fallback - Default value if not set, invalid, or negative
 * @returns Parsed integer (>= 0) or fallback
 */
export function readNonNegativeInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 0) {
		return fallback;
	}
	return parsed;
}

/**
 * Parse a threshold environment variable.
 *
 * Special behavior: values <= 0 return Infinity (disable threshold).
 *
 * @param name - Environment variable name
 * @param fallback - Default value if not set or invalid
 * @returns Parsed threshold, Infinity if disabled, or fallback
 */
export function readThresholdEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) {
		return fallback;
	}
	if (parsed <= 0) {
		return Number.POSITIVE_INFINITY;
	}
	return parsed;
}

/**
 * Parse a positive integer environment variable with minimum bound.
 *
 * @param name - Environment variable name
 * @param fallback - Default value if not set, invalid, or below minimum
 * @param minimum - Minimum allowed value (default: 1)
 * @returns Parsed integer (>= minimum) or fallback
 */
export function readPositiveInt(
	name: string,
	fallback: number,
	minimum = 1,
): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < minimum) {
		return fallback;
	}
	return parsed;
}
