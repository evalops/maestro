import { describe, expect, it } from "vitest";
import {
	DEFAULT_RETRY_CONFIG,
	isRetryableError,
	translateToHostPath,
	withRetry,
} from "../src/agent-runner.js";

describe("isRetryableError", () => {
	it("returns false for non-Error values", () => {
		expect(isRetryableError(null)).toBe(false);
		expect(isRetryableError(undefined)).toBe(false);
		expect(isRetryableError("string")).toBe(false);
		expect(isRetryableError(42)).toBe(false);
		expect(isRetryableError({})).toBe(false);
	});

	describe("rate limit errors", () => {
		it("detects rate limit errors", () => {
			expect(isRetryableError(new Error("Rate limit exceeded"))).toBe(true);
			expect(isRetryableError(new Error("rate limit reached"))).toBe(true);
		});

		it("detects 429 status code", () => {
			expect(isRetryableError(new Error("HTTP 429 Too Many Requests"))).toBe(
				true,
			);
			expect(isRetryableError(new Error("Error: 429"))).toBe(true);
		});
	});

	describe("timeout errors", () => {
		it("detects timeout errors", () => {
			expect(isRetryableError(new Error("Request timeout"))).toBe(true);
			expect(isRetryableError(new Error("Connection timed out"))).toBe(true);
		});
	});

	describe("network errors", () => {
		it("detects network errors", () => {
			expect(isRetryableError(new Error("Network error"))).toBe(true);
			expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
			expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
			expect(isRetryableError(new Error("Socket hang up"))).toBe(true);
			expect(isRetryableError(new Error("Fetch failed"))).toBe(true);
		});
	});

	describe("server errors (5xx)", () => {
		it("detects 500 errors", () => {
			expect(isRetryableError(new Error("HTTP 500"))).toBe(true);
			expect(isRetryableError(new Error("Internal server error"))).toBe(true);
		});

		it("detects 502 errors", () => {
			expect(isRetryableError(new Error("HTTP 502"))).toBe(true);
			expect(isRetryableError(new Error("Bad gateway"))).toBe(true);
		});

		it("detects 503 errors", () => {
			expect(isRetryableError(new Error("HTTP 503"))).toBe(true);
			expect(isRetryableError(new Error("Service unavailable"))).toBe(true);
		});

		it("detects 504 errors", () => {
			expect(isRetryableError(new Error("HTTP 504"))).toBe(true);
		});
	});

	describe("overload errors", () => {
		it("detects overload errors", () => {
			expect(isRetryableError(new Error("Server overloaded"))).toBe(true);
			expect(isRetryableError(new Error("At capacity"))).toBe(true);
		});
	});

	describe("non-retryable errors", () => {
		it("returns false for auth errors", () => {
			expect(isRetryableError(new Error("Unauthorized"))).toBe(false);
			expect(isRetryableError(new Error("Invalid API key"))).toBe(false);
		});

		it("returns false for validation errors", () => {
			expect(isRetryableError(new Error("Invalid request"))).toBe(false);
			expect(isRetryableError(new Error("Missing required field"))).toBe(false);
		});

		it("returns false for 4xx client errors", () => {
			expect(isRetryableError(new Error("HTTP 400 Bad Request"))).toBe(false);
			expect(isRetryableError(new Error("HTTP 401 Unauthorized"))).toBe(false);
			expect(isRetryableError(new Error("HTTP 403 Forbidden"))).toBe(false);
			expect(isRetryableError(new Error("HTTP 404 Not Found"))).toBe(false);
		});
	});
});

describe("withRetry", () => {
	it("returns result on first successful attempt", async () => {
		let callCount = 0;
		const result = await withRetry(async () => {
			callCount++;
			return "success";
		});

		expect(result).toBe("success");
		expect(callCount).toBe(1);
	});

	it("retries on retryable error and succeeds", async () => {
		let callCount = 0;
		const result = await withRetry(
			async () => {
				callCount++;
				if (callCount < 3) {
					throw new Error("Rate limit exceeded");
				}
				return "success";
			},
			{ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
		);

		expect(result).toBe("success");
		expect(callCount).toBe(3);
	});

	it("throws immediately on non-retryable error", async () => {
		let callCount = 0;
		await expect(
			withRetry(
				async () => {
					callCount++;
					throw new Error("Invalid API key");
				},
				{ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
			),
		).rejects.toThrow("Invalid API key");

		expect(callCount).toBe(1);
	});

	it("throws after exhausting all attempts", async () => {
		let callCount = 0;
		await expect(
			withRetry(
				async () => {
					callCount++;
					throw new Error("Rate limit exceeded");
				},
				{ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
			),
		).rejects.toThrow("Rate limit exceeded");

		expect(callCount).toBe(3);
	});

	it("calls onRetry callback with correct arguments", async () => {
		const onRetryCalls: Array<{
			attempt: number;
			error: Error;
			delayMs: number;
		}> = [];
		let callCount = 0;

		await withRetry(
			async () => {
				callCount++;
				if (callCount < 3) {
					throw new Error("Rate limit");
				}
				return "success";
			},
			{ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
			(attempt, error, delayMs) => {
				onRetryCalls.push({ attempt, error, delayMs });
			},
		);

		expect(onRetryCalls).toHaveLength(2);
		expect(onRetryCalls[0].attempt).toBe(1);
		expect(onRetryCalls[0].error.message).toBe("Rate limit");
		expect(onRetryCalls[1].attempt).toBe(2);
	});

	it("uses exponential backoff for delays", async () => {
		const delays: number[] = [];
		let callCount = 0;

		try {
			await withRetry(
				async () => {
					callCount++;
					throw new Error("Rate limit");
				},
				{ maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 10000 },
				(_attempt, _error, delayMs) => {
					delays.push(delayMs);
				},
			);
		} catch {
			// Expected to fail
		}

		// Check exponential growth (with jitter, delays should be roughly 100, 200, 400)
		expect(delays).toHaveLength(3);
		// First delay should be around 100ms (base) + up to 30% jitter
		expect(delays[0]).toBeGreaterThanOrEqual(100);
		expect(delays[0]).toBeLessThanOrEqual(130);
		// Second delay should be around 200ms + jitter
		expect(delays[1]).toBeGreaterThanOrEqual(200);
		expect(delays[1]).toBeLessThanOrEqual(260);
		// Third delay should be around 400ms + jitter
		expect(delays[2]).toBeGreaterThanOrEqual(400);
		expect(delays[2]).toBeLessThanOrEqual(520);
	});

	it("caps delay at maxDelayMs", async () => {
		const delays: number[] = [];

		try {
			await withRetry(
				async () => {
					throw new Error("Rate limit");
				},
				{ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 200 },
				(_attempt, _error, delayMs) => {
					delays.push(delayMs);
				},
			);
		} catch {
			// Expected to fail
		}

		// All delays should be capped at 200ms
		for (const delay of delays) {
			expect(delay).toBeLessThanOrEqual(200);
		}
	});

	it("converts non-Error throws to Error", async () => {
		await expect(
			withRetry(
				async () => {
					throw "string error";
				},
				{ maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 50 },
			),
		).rejects.toThrow("string error");
	});
});

describe("DEFAULT_RETRY_CONFIG", () => {
	it("has expected default values", () => {
		expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(3);
		expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(1000);
		expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(30000);
	});
});

describe("translateToHostPath", () => {
	it("returns container path unchanged for non-docker workspace", () => {
		const result = translateToHostPath(
			"/some/path/file.txt",
			"/host/channel",
			"/host",
			"C123",
		);
		expect(result).toBe("/some/path/file.txt");
	});

	it("translates channel-specific path in docker mode", () => {
		const result = translateToHostPath(
			"/workspace/C123/scratch/file.txt",
			"/host/data/C123",
			"/workspace",
			"C123",
		);
		expect(result).toBe("/host/data/C123/scratch/file.txt");
	});

	it("translates workspace path in docker mode", () => {
		const result = translateToHostPath(
			"/workspace/MEMORY.md",
			"/host/data/C123",
			"/workspace",
			"C123",
		);
		// Should go up one level from channelDir
		expect(result).toBe("/host/data/MEMORY.md");
	});

	it("handles nested channel paths", () => {
		const result = translateToHostPath(
			"/workspace/C123/skills/myscript/run.sh",
			"/host/data/C123",
			"/workspace",
			"C123",
		);
		expect(result).toBe("/host/data/C123/skills/myscript/run.sh");
	});

	it("returns unchanged for non-matching docker paths", () => {
		const result = translateToHostPath(
			"/other/path/file.txt",
			"/host/data/C123",
			"/workspace",
			"C123",
		);
		expect(result).toBe("/other/path/file.txt");
	});
});
