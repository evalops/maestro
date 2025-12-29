/**
 * Input validation utilities for data sanitization and type checking.
 */

export class ValidationError extends Error {
	constructor(
		message: string,
		public readonly field?: string,
		public readonly value?: unknown,
	) {
		super(message);
		this.name = "ValidationError";
	}
}

/**
 * Validate string is not empty
 */
export function requireNonEmpty(
	value: string | undefined | null,
	fieldName: string,
): asserts value is string {
	if (!value || value.trim().length === 0) {
		throw new ValidationError(
			`${fieldName} is required and cannot be empty`,
			fieldName,
		);
	}
}

/**
 * Validate number is within range
 */
export function requireInRange(
	value: number,
	min: number,
	max: number,
	fieldName: string,
): void {
	if (value < min || value > max) {
		throw new ValidationError(
			`${fieldName} must be between ${min} and ${max}`,
			fieldName,
			value,
		);
	}
}

/**
 * Validate value is one of allowed values
 */
export function requireOneOf<T>(
	value: T,
	allowed: readonly T[],
	fieldName: string,
): void {
	if (!allowed.includes(value)) {
		throw new ValidationError(
			`${fieldName} must be one of: ${allowed.join(", ")}`,
			fieldName,
			value,
		);
	}
}

/**
 * Sanitize string to prevent injection attacks
 */
export function sanitizeString(
	input: string,
	options: { maxLength?: number } = {},
): string {
	const { maxLength = 10000 } = options;

	// Remove null bytes and control characters (0x00-0x1F, 0x7F)
	let sanitized = "";
	for (const char of input) {
		const code = char.charCodeAt(0);
		const isControl =
			code <= 0x08 ||
			code === 0x0b ||
			code === 0x0c ||
			(code >= 0x0e && code <= 0x1f) ||
			code === 0x7f;
		if (!isControl) {
			sanitized += char;
		}
	}

	// Truncate if too long
	if (sanitized.length > maxLength) {
		sanitized = sanitized.slice(0, maxLength);
	}

	return sanitized;
}

/**
 * Removes unpaired Unicode surrogate characters from a string.
 *
 * Unpaired surrogates (high surrogates 0xD800-0xDBFF without matching low surrogates 0xDC00-0xDFFF,
 * or vice versa) cause JSON serialization errors in many API providers.
 *
 * Valid emoji and other characters outside the Basic Multilingual Plane use properly paired
 * surrogates and will NOT be affected by this function.
 *
 * @param text - The text to sanitize
 * @returns The sanitized text with unpaired surrogates removed
 *
 * @example
 * // Valid emoji (properly paired surrogates) are preserved
 * sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"
 *
 * // Unpaired high surrogate is removed
 * const unpaired = String.fromCharCode(0xD83D); // high surrogate without low
 * sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"
 */
export function sanitizeSurrogates(text: string): string {
	// Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
	// Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
	return text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"",
	);
}

/**
 * Validate email format (basic check)
 */
export function isValidEmail(email: string): boolean {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
}

/**
 * Validate URL format
 */
export function isValidUrl(url: string): boolean {
	try {
		new URL(url);
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate and sanitize command line arguments
 */
export function sanitizeCommandArg(arg: string): string {
	// Remove dangerous shell characters
	return arg.replace(/[;&|`$(){}[\]<>]/g, "");
}

/**
 * Check if value is a plain object
 */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/**
 * Type guard for non-null values
 */
export function isNotNull<T>(value: T | null | undefined): value is T {
	return value !== null && value !== undefined;
}

/**
 * Validate array has items
 */
export function requireNonEmptyArray<T>(
	value: T[] | undefined | null,
	fieldName: string,
): asserts value is T[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new ValidationError(
			`${fieldName} must be a non-empty array`,
			fieldName,
			value,
		);
	}
}

/**
 * Parse and validate integer
 */
export function parseIntSafe(
	value: string | number,
	fieldName: string,
	options: { min?: number; max?: number } = {},
): number {
	const num = typeof value === "number" ? value : Number.parseInt(value, 10);

	if (Number.isNaN(num)) {
		throw new ValidationError(
			`${fieldName} must be a valid integer`,
			fieldName,
			value,
		);
	}

	if (options.min !== undefined && num < options.min) {
		throw new ValidationError(
			`${fieldName} must be at least ${options.min}`,
			fieldName,
			num,
		);
	}

	if (options.max !== undefined && num > options.max) {
		throw new ValidationError(
			`${fieldName} must be at most ${options.max}`,
			fieldName,
			num,
		);
	}

	return num;
}

/**
 * Validate object has required keys
 */
export function requireKeys<T extends Record<string, unknown>>(
	obj: unknown,
	requiredKeys: string[],
	objectName = "object",
): asserts obj is T {
	if (!isPlainObject(obj)) {
		throw new ValidationError(`${objectName} must be an object`);
	}

	for (const key of requiredKeys) {
		if (!(key in obj)) {
			throw new ValidationError(
				`${objectName} is missing required key: ${key}`,
				key,
			);
		}
	}
}
