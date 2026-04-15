import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	checkShareRateLimit,
	resetShareRateLimit,
	stopShareRateLimiter,
} from "../src/server/handlers/sessions.js";

describe("Share Rate Limiting", () => {
	beforeEach(async () => {
		// Reset rate limit state before each test
		await resetShareRateLimit();
	});

	afterEach(async () => {
		await resetShareRateLimit();
	});

	afterAll(() => {
		// Stop the rate limiter's cleanup interval
		stopShareRateLimiter();
	});

	it("allows requests under the limit", async () => {
		const ip = "192.168.1.1";

		// First 10 requests should be allowed (default limit)
		for (let i = 0; i < 10; i++) {
			const result = await checkShareRateLimit(ip);
			expect(result.allowed).toBe(true);
			expect(result.retryAfterSeconds).toBeUndefined();
		}
	});

	it("blocks requests over the limit", async () => {
		const ip = "192.168.1.2";

		// Use up the limit
		for (let i = 0; i < 10; i++) {
			await checkShareRateLimit(ip);
		}

		// 11th request should be blocked
		const result = await checkShareRateLimit(ip);
		expect(result.allowed).toBe(false);
		expect(result.retryAfterSeconds).toBeGreaterThan(0);
		expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
	});

	it("tracks different IPs separately", async () => {
		const ip1 = "192.168.1.3";
		const ip2 = "192.168.1.4";

		// Use up limit for ip1
		for (let i = 0; i < 10; i++) {
			await checkShareRateLimit(ip1);
		}

		// ip1 should be blocked
		expect((await checkShareRateLimit(ip1)).allowed).toBe(false);

		// ip2 should still be allowed
		expect((await checkShareRateLimit(ip2)).allowed).toBe(true);
	});

	it("resetShareRateLimit clears specific IP", async () => {
		const ip = "192.168.1.6";

		// Use up the limit
		for (let i = 0; i < 10; i++) {
			await checkShareRateLimit(ip);
		}
		expect((await checkShareRateLimit(ip)).allowed).toBe(false);

		// Reset just this IP
		await resetShareRateLimit(ip);

		// Should be allowed again
		expect((await checkShareRateLimit(ip)).allowed).toBe(true);
	});

	it("resetShareRateLimit with no args clears all", async () => {
		const ip1 = "192.168.1.7";
		const ip2 = "192.168.1.8";

		// Use up limits for both
		for (let i = 0; i < 10; i++) {
			await checkShareRateLimit(ip1);
			await checkShareRateLimit(ip2);
		}
		expect((await checkShareRateLimit(ip1)).allowed).toBe(false);
		expect((await checkShareRateLimit(ip2)).allowed).toBe(false);

		// Reset all
		await resetShareRateLimit();

		// Both should be allowed
		expect((await checkShareRateLimit(ip1)).allowed).toBe(true);
		expect((await checkShareRateLimit(ip2)).allowed).toBe(true);
	});

	it("stopShareRateLimiter can be called without error", () => {
		// Just verify it doesn't throw
		expect(() => stopShareRateLimiter()).not.toThrow();
	});
});
