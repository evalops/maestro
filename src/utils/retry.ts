/**
 * Retry utilities for handling transient failures.
 */

import { createLogger } from "./logger.js";

const logger = createLogger("retry");

export interface RetryOptions {
	/** Maximum number of retry attempts */
	maxAttempts?: number;
	/** Initial delay in milliseconds */
	initialDelay?: number;
	/** Maximum delay in milliseconds */
	maxDelay?: number;
	/** Backoff multiplier */
	backoffMultiplier?: number;
	/** Whether to use exponential backoff */
	exponentialBackoff?: boolean;
	/** Function to determine if error is retryable */
	shouldRetry?: (error: Error, attempt: number) => boolean;
	/** Called before each retry. Return a number to override the sleep delay. */
	onRetry?: (
		error: Error,
		attempt: number,
		delay: number,
	) => number | undefined;
}

/**
 * Parse retry-after header value to milliseconds.
 * Supports: seconds (number), milliseconds header, or HTTP date format.
 */
export function parseRetryAfter(
	headers?: Record<string, string>,
): number | null {
	if (!headers) return null;

	// Check retry-after-ms first (milliseconds)
	const retryAfterMs = headers["retry-after-ms"];
	if (retryAfterMs) {
		const ms = Number.parseFloat(retryAfterMs);
		if (!Number.isNaN(ms) && ms > 0) {
			return Math.ceil(ms);
		}
	}

	// Check retry-after (seconds or HTTP date)
	const retryAfter = headers["retry-after"];
	if (retryAfter) {
		// Try parsing as seconds
		const seconds = Number.parseFloat(retryAfter);
		if (!Number.isNaN(seconds) && seconds > 0) {
			return Math.ceil(seconds * 1000);
		}

		// Try parsing as HTTP date (e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
		const dateMs = Date.parse(retryAfter);
		if (!Number.isNaN(dateMs)) {
			const delayMs = dateMs - Date.now();
			if (delayMs > 0) {
				return Math.ceil(delayMs);
			}
		}
	}

	return null;
}

/**
 * Extract headers from an error if available.
 * Works with fetch errors and custom error types.
 */
export function extractRetryHeaders(
	error: unknown,
): Record<string, string> | undefined {
	if (!error || typeof error !== "object") return undefined;

	// Check for responseHeaders property (common pattern)
	const errObj = error as Record<string, unknown>;
	if (errObj.responseHeaders && typeof errObj.responseHeaders === "object") {
		return errObj.responseHeaders as Record<string, string>;
	}

	// Check for headers property
	if (errObj.headers && typeof errObj.headers === "object") {
		return errObj.headers as Record<string, string>;
	}

	// Check for response.headers (fetch-like errors)
	if (errObj.response && typeof errObj.response === "object") {
		const response = errObj.response as Record<string, unknown>;
		if (response.headers && typeof response.headers === "object") {
			return response.headers as Record<string, string>;
		}
	}

	return undefined;
}

export class RetryError extends Error {
	constructor(
		message: string,
		public readonly attempts: number,
		public readonly lastError: Error,
	) {
		super(message);
		this.name = "RetryError";
	}
}

/**
 * Default retry predicate - retries on network errors and timeouts
 */
function defaultShouldRetry(error: Error, _attempt: number): boolean {
	// Retry on common transient errors
	const message = error.message.toLowerCase();
	return (
		message.includes("timeout") ||
		message.includes("econnreset") ||
		message.includes("enotfound") ||
		message.includes("econnrefused") ||
		message.includes("network") ||
		message.includes("fetch failed")
	);
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const {
		maxAttempts = 3,
		initialDelay = 1000,
		maxDelay = 30000,
		backoffMultiplier = 2,
		exponentialBackoff = true,
		shouldRetry = defaultShouldRetry,
		onRetry,
	} = options;

	let lastError: Error | undefined;
	let delay = initialDelay;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if we should retry
			if (attempt >= maxAttempts || !shouldRetry(lastError, attempt)) {
				throw lastError;
			}

			// Check for retry-after header first
			const retryHeaders = extractRetryHeaders(error);
			const retryAfterDelay = parseRetryAfter(retryHeaders);

			if (retryAfterDelay !== null) {
				// Use server-specified delay (capped at maxDelay)
				delay = Math.min(retryAfterDelay, maxDelay);
			} else if (exponentialBackoff) {
				// Fall back to exponential backoff
				delay = Math.min(delay * backoffMultiplier, maxDelay);
			}

			logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, {
				error: lastError.message,
				retryAfterHeader: retryAfterDelay !== null,
				attempt,
				maxAttempts,
			});

			let sleepDelay = delay;

			// Call retry callback and allow override of the sleep delay.
			if (onRetry) {
				const overrideDelay = onRetry(lastError, attempt, delay);
				if (
					typeof overrideDelay === "number" &&
					Number.isFinite(overrideDelay)
				) {
					sleepDelay = Math.max(0, Math.trunc(overrideDelay));
				}
			}

			// Wait before retrying
			await sleep(sleepDelay);
		}
	}

	// Should never reach here, but TypeScript needs it
	throw new RetryError(
		`Failed after ${maxAttempts} attempts`,
		maxAttempts,
		lastError || new Error("Unknown error"),
	);
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry with jitter to avoid thundering herd
 */
export async function retryWithJitter<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	return retry(fn, {
		...options,
		onRetry: (error, attempt, delay) => {
			// Add random jitter (±25%)
			const jitter = delay * 0.25 * (Math.random() * 2 - 1);
			const jitteredDelay = Math.max(0, delay + jitter);

			if (options.onRetry) {
				options.onRetry(error, attempt, jitteredDelay);
			}

			return jitteredDelay;
		},
	});
}

/**
 * Wrap a function with retry logic
 */
export function withRetry<TArgs extends unknown[], TResult>(
	fn: (...args: TArgs) => Promise<TResult>,
	options: RetryOptions = {},
): (...args: TArgs) => Promise<TResult> {
	return async (...args: TArgs): Promise<TResult> => {
		return retry(() => fn(...args), options);
	};
}
