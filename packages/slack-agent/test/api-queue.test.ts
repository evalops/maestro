import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApiQueue,
	METHOD_TIERS,
	RATE_LIMIT_TIERS,
	createApiQueue,
} from "../src/utils/api-queue.js";

describe("RATE_LIMIT_TIERS", () => {
	it("defines expected tiers", () => {
		expect(RATE_LIMIT_TIERS.tier1).toBe(1);
		expect(RATE_LIMIT_TIERS.tier2).toBe(20);
		expect(RATE_LIMIT_TIERS.tier3).toBe(50);
		expect(RATE_LIMIT_TIERS.tier4).toBe(100);
		expect(RATE_LIMIT_TIERS.special).toBe(1);
	});
});

describe("METHOD_TIERS", () => {
	it("maps common methods to appropriate tiers", () => {
		expect(METHOD_TIERS["conversations.history"]).toBe("tier1");
		expect(METHOD_TIERS["chat.postMessage"]).toBe("tier3");
		expect(METHOD_TIERS["auth.test"]).toBe("tier4");
	});
});

describe("ApiQueue", () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.useFakeTimers();
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		vi.useRealTimers();
	});

	it("executes requests in order", async () => {
		const queue = new ApiQueue();
		const order: number[] = [];

		const p1 = queue.enqueue("test.method", async () => {
			order.push(1);
			return 1;
		});
		const p2 = queue.enqueue("test.method", async () => {
			order.push(2);
			return 2;
		});
		const p3 = queue.enqueue("test.method", async () => {
			order.push(3);
			return 3;
		});

		await vi.runAllTimersAsync();

		expect(await p1).toBe(1);
		expect(await p2).toBe(2);
		expect(await p3).toBe(3);
		expect(order).toEqual([1, 2, 3]);
	});

	it("spaces requests by rate limit tier", async () => {
		const queue = new ApiQueue();
		const timestamps: number[] = [];

		const p1 = queue.enqueue("chat.postMessage", async () => {
			timestamps.push(Date.now());
			return 1;
		});
		const p2 = queue.enqueue("chat.postMessage", async () => {
			timestamps.push(Date.now());
			return 2;
		});

		await vi.runAllTimersAsync();
		await p1;
		await p2;

		// Tier 3 = 50 req/min = 1200ms interval (but min 1000ms)
		const interval = timestamps[1] - timestamps[0];
		expect(interval).toBeGreaterThanOrEqual(1000);
	});

	it("handles request errors and rejects promise", async () => {
		const queue = new ApiQueue({ maxRetries: 0 });
		let caughtError: Error | null = null;

		const promise = queue.enqueue("test.method", async () => {
			throw new Error("Test error");
		});

		// Catch the error to prevent unhandled rejection
		promise.catch((e) => {
			caughtError = e;
		});

		await vi.runAllTimersAsync();

		expect(caughtError).not.toBeNull();
		expect(caughtError?.message).toBe("Test error");
	});

	it("retries on retryable errors", async () => {
		const queue = new ApiQueue({ maxRetries: 2, baseDelayMs: 100 });
		let attempts = 0;

		const promise = queue.enqueue("test.method", async () => {
			attempts++;
			if (attempts < 3) {
				throw new Error("network error");
			}
			return "success";
		});

		await vi.runAllTimersAsync();

		expect(await promise).toBe("success");
		expect(attempts).toBe(3);
	});

	it("respects max retries", async () => {
		const queue = new ApiQueue({ maxRetries: 2, baseDelayMs: 100 });
		let attempts = 0;
		let caughtError: Error | null = null;

		const promise = queue.enqueue("test.method", async () => {
			attempts++;
			throw new Error("network error");
		});

		// Catch the error to prevent unhandled rejection
		promise.catch((e) => {
			caughtError = e;
		});

		await vi.runAllTimersAsync();

		expect(caughtError).not.toBeNull();
		expect(caughtError?.message).toBe("network error");
		expect(attempts).toBe(3); // Initial + 2 retries
	});

	it("pauses queue on rate limit error", async () => {
		const queue = new ApiQueue();
		let rateLimited = true;
		let attempts = 0;

		const promise = queue.enqueue("test.method", async () => {
			attempts++;
			if (rateLimited) {
				rateLimited = false;
				const error: Error & { code?: string; retryAfter?: number } = new Error(
					"Rate limited",
				);
				error.code = "slack_webapi_rate_limited";
				error.retryAfter = 1; // 1 second
				throw error;
			}
			return "success";
		});

		await vi.runAllTimersAsync();

		expect(await promise).toBe("success");
		expect(attempts).toBe(2);
	});

	it("getStats returns queue information", async () => {
		const queue = new ApiQueue();

		// Add a slow request
		queue.enqueue("test.method", async () => {
			await new Promise((r) => setTimeout(r, 5000));
			return 1;
		});

		// Add another while first is processing
		queue.enqueue("test.method", async () => 2);

		// Let first request start
		await vi.advanceTimersByTimeAsync(10);

		const stats = queue.getStats();
		expect(stats.queueLength).toBeGreaterThanOrEqual(1);
		expect(stats.totalProcessed).toBeGreaterThanOrEqual(0);
	});

	it("clear rejects all pending requests", async () => {
		const queue = new ApiQueue();
		const rejections: Error[] = [];

		const p1 = queue.enqueue("test.method", async () => {
			await new Promise((r) => setTimeout(r, 10000));
			return 1;
		});
		const p2 = queue.enqueue("test.method", async () => 2);

		// Catch rejections to prevent unhandled rejection errors
		p1.catch((e) => rejections.push(e));
		p2.catch((e) => rejections.push(e));

		// Let first request start
		await vi.advanceTimersByTimeAsync(10);

		queue.clear();

		// Let timers run to complete cleanup
		await vi.runAllTimersAsync();

		// At least p2 should be rejected (p1 might have been in-flight)
		expect(rejections.length).toBeGreaterThanOrEqual(1);
		expect(rejections.some((e) => e.message === "Queue cleared")).toBe(true);
	});

	it("handles different error formats for rate limits", async () => {
		const queue = new ApiQueue();

		// Test with status code
		let firstCall = true;
		const p1 = queue.enqueue("test.method", async () => {
			if (firstCall) {
				firstCall = false;
				const error: Error & { status?: number } = new Error(
					"Too Many Requests",
				);
				error.status = 429;
				throw error;
			}
			return "success";
		});

		await vi.runAllTimersAsync();
		expect(await p1).toBe("success");
	});
});

describe("createApiQueue", () => {
	it("creates queue with default options", () => {
		const queue = createApiQueue();
		expect(queue).toBeInstanceOf(ApiQueue);
	});

	it("creates queue with custom options", () => {
		const queue = createApiQueue({
			defaultTier: "tier2",
			maxRetries: 5,
			baseDelayMs: 500,
		});
		expect(queue).toBeInstanceOf(ApiQueue);
	});
});
