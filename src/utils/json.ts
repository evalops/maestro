/**
 * Safe JSON parsing utilities with better error handling and validation.
 */

import { createLogger } from "./logger.js";

const logger = createLogger("json-utils");

export class JsonParseError extends Error {
	constructor(
		message: string,
		public readonly input: string,
		public override readonly cause?: Error,
	) {
		super(message);
		this.name = "JsonParseError";
	}
}

/**
 * Safely parse JSON with detailed error reporting
 */
export function safeJsonParse<T = unknown>(
	input: string,
	context?: string,
): { success: true; data: T } | { success: false; error: JsonParseError } {
	try {
		const data = JSON.parse(input) as T;
		return { success: true, data };
	} catch (error) {
		const message = context
			? `Failed to parse JSON in ${context}`
			: "Failed to parse JSON";

		const parseError = new JsonParseError(
			message,
			input.slice(0, 200), // Limit stored input
			error instanceof Error ? error : undefined,
		);

		logger.debug(message, { inputLength: input.length, error });
		return { success: false, error: parseError };
	}
}

/**
 * Parse JSON with a fallback value
 */
export function parseJsonOr<T>(input: string, fallback: T): T {
	try {
		return JSON.parse(input) as T;
	} catch {
		return fallback;
	}
}

/**
 * Safely stringify with circular reference handling
 */
export function safeJsonStringify(
	value: unknown,
	options: { pretty?: boolean; maxDepth?: number } = {},
): string {
	const { pretty = false, maxDepth = 10 } = options;
	const seen = new WeakSet();
	let depth = 0;

	const replacer = (_key: string, val: unknown): unknown => {
		// Handle primitives
		if (val === null || typeof val !== "object") {
			return val;
		}

		// Check depth limit
		if (depth >= maxDepth) {
			return "[Max Depth Reached]";
		}

		// Handle circular references
		if (seen.has(val as object)) {
			return "[Circular Reference]";
		}

		seen.add(val as object);
		depth++;
		try {
			// Handle special types
			if (val instanceof Error) {
				return {
					name: val.name,
					message: val.message,
					stack: val.stack,
				};
			}

			if (val instanceof Map) {
				return Object.fromEntries(val);
			}

			if (val instanceof Set) {
				return Array.from(val);
			}

			if (val instanceof Date) {
				return val.toISOString();
			}

			if (val instanceof RegExp) {
				return val.toString();
			}

			if (ArrayBuffer.isView(val)) {
				return "[Binary Data]";
			}

			return val;
		} finally {
			depth--;
		}
	};

	try {
		return JSON.stringify(value, replacer, pretty ? 2 : undefined);
	} catch (error) {
		logger.error(
			"Failed to stringify value",
			error instanceof Error ? error : undefined,
		);
		return "[Stringify Failed]";
	}
}

/**
 * Parse JSONL (JSON Lines) format
 */
export function parseJsonLines<T = unknown>(
	input: string,
	options: { skipErrors?: boolean } = {},
): T[] {
	const { skipErrors = false } = options;
	const results: T[] = [];
	const lines = input.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		if (!rawLine) continue;
		const line = rawLine.trim();
		if (!line) continue;

		const result = safeJsonParse<T>(line, `line ${i + 1}`);
		if (result.success) {
			results.push(result.data);
		} else if (!skipErrors) {
			throw "error" in result ? result.error : new Error("Parse error");
		}
	}

	return results;
}

/**
 * Validate JSON against a schema using simple type checking
 */
export function validateJsonShape<T>(
	data: unknown,
	schema: Record<string, "string" | "number" | "boolean" | "object" | "array">,
): data is T {
	if (typeof data !== "object" || data === null) {
		return false;
	}

	const obj = data as Record<string, unknown>;

	for (const [key, expectedType] of Object.entries(schema)) {
		const value = obj[key];

		if (expectedType === "array") {
			if (!Array.isArray(value)) return false;
		} else if (expectedType === "object") {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return false;
			}
		} else {
			// string, number, or boolean
			const valueType = typeof value;
			if (valueType !== expectedType) return false;
		}
	}

	return true;
}

/**
 * Try to parse JSON, returning undefined on failure.
 * Useful for simple cases where you don't need error details.
 */
export function tryParseJson<T = unknown>(input: string): T | undefined {
	try {
		return JSON.parse(input) as T;
	} catch {
		return undefined;
	}
}

/**
 * Parse JSON with validation using a type guard.
 * Returns the parsed and validated data or an error.
 */
export function parseJsonWithGuard<T>(
	input: string,
	guard: (data: unknown) => data is T,
	context?: string,
): { success: true; data: T } | { success: false; error: JsonParseError } {
	const result = safeJsonParse(input, context);
	if (!result.success) {
		return result;
	}

	if (!guard(result.data)) {
		const message = context
			? `Invalid data structure in ${context}`
			: "Invalid data structure";
		return {
			success: false,
			error: new JsonParseError(message, input.slice(0, 200)),
		};
	}

	return { success: true, data: result.data };
}

/**
 * Type guard for checking if a value is a plain object
 */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type guard for checking if a value is an array of a specific type
 */
export function isArrayOf<T>(
	value: unknown,
	guard: (item: unknown) => item is T,
): value is T[] {
	return Array.isArray(value) && value.every(guard);
}

/**
 * Type guard for string
 */
export function isString(value: unknown): value is string {
	return typeof value === "string";
}

/**
 * Type guard for number
 */
export function isNumber(value: unknown): value is number {
	return typeof value === "number" && !Number.isNaN(value);
}

/**
 * Type guard for boolean
 */
export function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}
