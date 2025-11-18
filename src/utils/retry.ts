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
	/** Called before each retry */
	onRetry?: (error: Error, attempt: number, delay: number) => void;
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
function defaultShouldRetry(error: Error, attempt: number): boolean {
	// Don't retry after max attempts
	if (attempt >= 3) return false;

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

			// Calculate delay for next attempt
			if (exponentialBackoff) {
				delay = Math.min(delay * backoffMultiplier, maxDelay);
			}

			logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, {
				error: lastError.message,
				attempt,
				maxAttempts,
			});

			// Call retry callback
			if (onRetry) {
				onRetry(lastError, attempt, delay);
			}

			// Wait before retrying
			await sleep(delay);
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
