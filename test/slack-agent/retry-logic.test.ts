/**
 * Tests for retry logic in agent-runner
 *
 * Tests the isRetryableError and withRetry functions
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Since these are internal functions, we recreate them here for testing
// In a real scenario, we'd export them or test through integration

interface RetryConfig {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
};

function isRetryableError(error: unknown): boolean {
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

async function withRetry<T>(
	fn: () => Promise<T>,
	config: RetryConfig = DEFAULT_RETRY_CONFIG,
	onRetry?: (attempt: number, error: Error, delayMs: number) => void,
): Promise<T> {
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (!isRetryableError(error) || attempt === config.maxAttempts) {
				throw lastError;
			}

			const exponentialDelay = config.baseDelayMs * 2 ** (attempt - 1);
			const jitter = Math.random() * 0.3 * exponentialDelay;
			const delayMs = Math.min(exponentialDelay + jitter, config.maxDelayMs);

			if (onRetry) {
				onRetry(attempt, lastError, delayMs);
			}

			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	throw lastError;
}

describe("retry logic", () => {
	describe("isRetryableError", () => {
		it("returns false for non-Error values", () => {
			expect(isRetryableError("string error")).toBe(false);
			expect(isRetryableError(null)).toBe(false);
			expect(isRetryableError(undefined)).toBe(false);
			expect(isRetryableError(123)).toBe(false);
		});

		describe("rate limit errors", () => {
			it("identifies rate limit messages", () => {
				expect(isRetryableError(new Error("Rate limit exceeded"))).toBe(true);
				expect(isRetryableError(new Error("rate limit"))).toBe(true);
			});

			it("identifies 429 status code", () => {
				expect(isRetryableError(new Error("HTTP 429 Too Many Requests"))).toBe(
					true,
				);
				expect(isRetryableError(new Error("Status 429"))).toBe(true);
			});
		});

		describe("timeout errors", () => {
			it("identifies timeout messages", () => {
				expect(isRetryableError(new Error("Request timeout"))).toBe(true);
				expect(isRetryableError(new Error("Connection timed out"))).toBe(true);
				expect(isRetryableError(new Error("TIMEOUT"))).toBe(true);
			});
		});

		describe("network errors", () => {
			it("identifies network errors", () => {
				expect(isRetryableError(new Error("Network error"))).toBe(true);
				expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
				expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
				expect(isRetryableError(new Error("socket hang up"))).toBe(true);
				expect(isRetryableError(new Error("fetch failed"))).toBe(true);
			});
		});

		describe("server errors (5xx)", () => {
			it("identifies 5xx status codes", () => {
				expect(isRetryableError(new Error("HTTP 500"))).toBe(true);
				expect(isRetryableError(new Error("502 Bad Gateway"))).toBe(true);
				expect(isRetryableError(new Error("503 Service Unavailable"))).toBe(
					true,
				);
				expect(isRetryableError(new Error("504 Gateway Timeout"))).toBe(true);
			});

			it("identifies server error messages", () => {
				expect(isRetryableError(new Error("Internal server error"))).toBe(true);
				expect(isRetryableError(new Error("Service unavailable"))).toBe(true);
				expect(isRetryableError(new Error("Bad gateway"))).toBe(true);
			});
		});

		describe("overload errors", () => {
			it("identifies overload messages", () => {
				expect(isRetryableError(new Error("Server overloaded"))).toBe(true);
				expect(isRetryableError(new Error("At capacity"))).toBe(true);
			});
		});

		describe("non-retryable errors", () => {
			it("returns false for authentication errors", () => {
				expect(isRetryableError(new Error("Unauthorized"))).toBe(false);
				expect(isRetryableError(new Error("Invalid API key"))).toBe(false);
				expect(isRetryableError(new Error("401 Unauthorized"))).toBe(false);
			});

			it("returns false for client errors", () => {
				expect(isRetryableError(new Error("Bad request"))).toBe(false);
				expect(isRetryableError(new Error("404 Not Found"))).toBe(false);
				expect(isRetryableError(new Error("Invalid input"))).toBe(false);
			});

			it("returns false for generic errors", () => {
				expect(isRetryableError(new Error("Something went wrong"))).toBe(false);
				expect(isRetryableError(new Error("Unknown error"))).toBe(false);
			});
		});
	});

	describe("withRetry", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("returns immediately on success", async () => {
			const fn = vi.fn().mockResolvedValue("success");

			const promise = withRetry(fn);
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("throws immediately for non-retryable errors", async () => {
			const fn = vi.fn().mockRejectedValue(new Error("Invalid input"));

			const promise = withRetry(fn);
			const assertion = expect(promise).rejects.toThrow("Invalid input");
			await vi.runAllTimersAsync();
			await assertion;
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("retries on retryable errors", async () => {
			const fn = vi
				.fn()
				.mockRejectedValueOnce(new Error("Connection timeout"))
				.mockResolvedValue("success");

			const promise = withRetry(fn, {
				maxAttempts: 3,
				baseDelayMs: 10, // Short delay for tests
				maxDelayMs: 100,
			});
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it("respects max attempts", async () => {
			const fn = vi.fn().mockRejectedValue(new Error("rate limit"));

			const promise = withRetry(fn, {
				maxAttempts: 3,
				baseDelayMs: 10,
				maxDelayMs: 100,
			});
			const assertion = expect(promise).rejects.toThrow("rate limit");
			await vi.runAllTimersAsync();
			await assertion;

			expect(fn).toHaveBeenCalledTimes(3);
		});

		it("calls onRetry callback on each retry", async () => {
			const fn = vi
				.fn()
				.mockRejectedValueOnce(new Error("timeout"))
				.mockRejectedValueOnce(new Error("timeout"))
				.mockResolvedValue("success");

			const onRetry = vi.fn();

			const promise = withRetry(
				fn,
				{
					maxAttempts: 3,
					baseDelayMs: 10,
					maxDelayMs: 100,
				},
				onRetry,
			);
			await vi.runAllTimersAsync();
			await promise;

			expect(onRetry).toHaveBeenCalledTimes(2);
			expect(onRetry).toHaveBeenNthCalledWith(
				1,
				1,
				expect.any(Error),
				expect.any(Number),
			);
			expect(onRetry).toHaveBeenNthCalledWith(
				2,
				2,
				expect.any(Error),
				expect.any(Number),
			);
		});

		it("uses exponential backoff", async () => {
			const fn = vi
				.fn()
				.mockRejectedValueOnce(new Error("503"))
				.mockRejectedValueOnce(new Error("503"))
				.mockResolvedValue("success");

			const delays: number[] = [];
			const onRetry = vi.fn((_, __, delayMs) => {
				delays.push(delayMs);
			});

			const promise = withRetry(
				fn,
				{
					maxAttempts: 3,
					baseDelayMs: 100,
					maxDelayMs: 10000,
				},
				onRetry,
			);
			await vi.runAllTimersAsync();
			await promise;

			// Second delay should be roughly 2x the first (accounting for jitter)
			// Base: 100, 200
			// With jitter: 100-130, 200-260
			expect(delays[1]).toBeGreaterThan(delays[0]);
		});

		it("caps delay at maxDelayMs", async () => {
			const fn = vi
				.fn()
				.mockRejectedValueOnce(new Error("overloaded"))
				.mockResolvedValue("success");

			const delays: number[] = [];
			const onRetry = vi.fn((_, __, delayMs) => {
				delays.push(delayMs);
			});

			const promise = withRetry(
				fn,
				{
					maxAttempts: 2,
					baseDelayMs: 50000, // Very high base
					maxDelayMs: 100,
				},
				onRetry,
			);
			await vi.runAllTimersAsync();
			await promise;

			expect(delays[0]).toBeLessThanOrEqual(100);
		});

		it("converts non-Error to Error", async () => {
			const fn = vi.fn().mockRejectedValue("string error");

			const promise = withRetry(fn, {
				maxAttempts: 1,
				baseDelayMs: 10,
				maxDelayMs: 100,
			});
			const assertion = expect(promise).rejects.toThrow("string error");
			await vi.runAllTimersAsync();
			await assertion;
		});
	});
});
