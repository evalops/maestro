/**
 * Safe JSON parsing utilities with better error handling and validation.
 */

import { createLogger } from "./logger.js";

const logger = createLogger("json-utils");

export class JsonParseError extends Error {
	constructor(
		message: string,
		public readonly input: string,
		public readonly cause?: Error,
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

		depth--;
		return val;
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
		const line = lines[i].trim();
		if (!line) continue;

		const result = safeJsonParse<T>(line, `line ${i + 1}`);
		if (result.success) {
			results.push(result.data);
		} else if (!skipErrors) {
			throw result.error;
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
