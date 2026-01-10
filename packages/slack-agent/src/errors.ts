/**
 * Error Handling Utilities
 *
 * Provides consistent error handling patterns with proper logging
 * and stack trace preservation.
 */

import * as logger from "./logger.js";

/**
 * Base error class for slack-agent errors
 */
export class SlackAgentError extends Error {
	public readonly code: string;
	public override readonly cause?: Error;
	public readonly context?: Record<string, unknown>;

	constructor(
		message: string,
		options?: {
			code?: string;
			cause?: Error;
			context?: Record<string, unknown>;
		},
	) {
		super(message);
		this.name = "SlackAgentError";
		this.code = options?.code || "UNKNOWN_ERROR";
		this.cause = options?.cause;
		this.context = options?.context;

		// Capture stack trace
		Error.captureStackTrace?.(this, this.constructor);
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			context: this.context,
			stack: this.stack,
			cause: this.cause
				? {
						name: this.cause.name,
						message: this.cause.message,
						stack: this.cause.stack,
					}
				: undefined,
		};
	}
}

/**
 * API/Network related errors
 */
export class ApiError extends SlackAgentError {
	public readonly statusCode?: number;

	constructor(
		message: string,
		options?: {
			statusCode?: number;
			cause?: Error;
			context?: Record<string, unknown>;
		},
	) {
		super(message, { code: "API_ERROR", ...options });
		this.name = "ApiError";
		this.statusCode = options?.statusCode;
	}
}

/**
 * Configuration/Environment errors
 */
export class ConfigError extends SlackAgentError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, { code: "CONFIG_ERROR", context });
		this.name = "ConfigError";
	}
}

/**
 * File system errors
 */
export class FileSystemError extends SlackAgentError {
	public readonly path?: string;

	constructor(
		message: string,
		options?: {
			path?: string;
			cause?: Error;
			context?: Record<string, unknown>;
		},
	) {
		super(message, { code: "FS_ERROR", ...options });
		this.name = "FileSystemError";
		this.path = options?.path;
	}
}

/**
 * Validation errors
 */
export class ValidationError extends SlackAgentError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, { code: "VALIDATION_ERROR", context });
		this.name = "ValidationError";
	}
}

/**
 * Extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return String(error);
}

/**
 * Extract error stack from unknown error
 */
export function getErrorStack(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.stack;
	}
	return undefined;
}

/**
 * Wrap an error with additional context
 */
export function wrapError(
	error: unknown,
	message: string,
	context?: Record<string, unknown>,
): SlackAgentError {
	const cause = error instanceof Error ? error : new Error(String(error));
	return new SlackAgentError(message, { cause, context });
}

/**
 * Log an error with proper formatting
 */
export function logError(
	operation: string,
	error: unknown,
	context?: Record<string, unknown>,
): void {
	const message = getErrorMessage(error);
	const stack = getErrorStack(error);
	const contextStr = context ? JSON.stringify(context) : "";

	logger.logWarning(
		`${operation} failed: ${message}`,
		[stack, contextStr].filter(Boolean).join("\n"),
	);
}

/**
 * Execute a function and handle errors gracefully
 * Returns undefined if the operation fails (with optional logging)
 */
export async function tryAsync<T>(
	operation: string,
	fn: () => Promise<T>,
	options?: {
		silent?: boolean;
		context?: Record<string, unknown>;
		fallback?: T;
	},
): Promise<T | undefined> {
	try {
		return await fn();
	} catch (error) {
		if (!options?.silent) {
			logError(operation, error, options?.context);
		}
		return options?.fallback;
	}
}

/**
 * Synchronous version of tryAsync
 */
export function trySync<T>(
	operation: string,
	fn: () => T,
	options?: {
		silent?: boolean;
		context?: Record<string, unknown>;
		fallback?: T;
	},
): T | undefined {
	try {
		return fn();
	} catch (error) {
		if (!options?.silent) {
			logError(operation, error, options?.context);
		}
		return options?.fallback;
	}
}

/**
 * Check if an error is likely transient and retryable.
 * Checks for rate limits, timeouts, network errors, and server errors.
 */
export function isRetryableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	const message = error.message.toLowerCase();

	// Rate limit errors
	if (message.includes("rate limit") || message.includes("429")) return true;

	// Timeout errors
	if (message.includes("timeout") || message.includes("timed out")) return true;

	// Network errors
	if (
		message.includes("network") ||
		message.includes("econnreset") ||
		message.includes("econnrefused") ||
		message.includes("socket hang up") ||
		message.includes("fetch failed")
	)
		return true;

	// Server errors (5xx)
	if (
		message.includes("500") ||
		message.includes("502") ||
		message.includes("503") ||
		message.includes("504") ||
		message.includes("internal server error") ||
		message.includes("service unavailable") ||
		message.includes("bad gateway")
	)
		return true;

	// Overload errors
	if (message.includes("overloaded") || message.includes("capacity"))
		return true;

	return false;
}

/**
 * Retry an async operation with exponential backoff
 */
export async function retryAsync<T>(
	operation: string,
	fn: () => Promise<T>,
	options?: {
		maxAttempts?: number;
		initialDelayMs?: number;
		maxDelayMs?: number;
		/** Custom retry predicate. Defaults to isRetryableError. */
		shouldRetry?: (error: unknown) => boolean;
		/** Add jitter to delays (0-1, default 0.3 = 30%) */
		jitter?: number;
		/** Callback when retrying */
		onRetry?: (attempt: number, error: Error, delayMs: number) => void;
		context?: Record<string, unknown>;
	},
): Promise<T> {
	const maxAttempts = options?.maxAttempts ?? 3;
	const initialDelayMs = options?.initialDelayMs ?? 1000;
	const maxDelayMs = options?.maxDelayMs ?? 10000;
	const shouldRetry = options?.shouldRetry ?? isRetryableError;
	const jitterRatio = options?.jitter ?? 0.3;

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;

			if (attempt === maxAttempts || !shouldRetry(error)) {
				break;
			}

			// Exponential backoff with jitter
			const exponentialDelay = initialDelayMs * 2 ** (attempt - 1);
			const jitter = Math.random() * jitterRatio * exponentialDelay;
			const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

			if (options?.onRetry) {
				const err = error instanceof Error ? error : new Error(String(error));
				options.onRetry(attempt, err, delay);
			} else {
				logger.logWarning(
					`${operation} failed (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(delay)}ms`,
					getErrorMessage(error),
				);
			}

			await new Promise((r) => setTimeout(r, delay));
		}
	}

	throw wrapError(
		lastError,
		`${operation} failed after ${maxAttempts} attempts`,
		options?.context,
	);
}

/**
 * Assert a condition is true, throw ValidationError if not
 */
export function assertValid(
	condition: unknown,
	message: string,
	context?: Record<string, unknown>,
): asserts condition {
	if (!condition) {
		throw new ValidationError(message, context);
	}
}

/**
 * Assert a value is defined
 */
export function assertDefined<T>(
	value: T | undefined | null,
	message: string,
	context?: Record<string, unknown>,
): asserts value is T {
	if (value === undefined || value === null) {
		throw new ValidationError(message, context);
	}
}
