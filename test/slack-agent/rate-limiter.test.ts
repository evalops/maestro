/**
 * Tests for rate-limiter.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RateLimiter,
	formatRateLimitMessage,
} from "../../packages/slack-agent/src/rate-limiter.js";

describe("RateLimiter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("check", () => {
		it("allows requests within user limit", () => {
			const limiter = new RateLimiter({ maxPerUser: 3, maxPerChannel: 10 });

			const result1 = limiter.check("user1", "channel1");
			const result2 = limiter.check("user1", "channel1");
			const result3 = limiter.check("user1", "channel1");

			expect(result1.allowed).toBe(true);
			expect(result2.allowed).toBe(true);
			expect(result3.allowed).toBe(true);
		});

		it("blocks requests exceeding user limit", () => {
			const limiter = new RateLimiter({ maxPerUser: 2, maxPerChannel: 10 });

			limiter.check("user1", "channel1");
			limiter.check("user1", "channel1");
			const result = limiter.check("user1", "channel1");

			expect(result.allowed).toBe(false);
			expect(result.limitedBy).toBe("user");
		});

		it("blocks requests exceeding channel limit", () => {
			const limiter = new RateLimiter({ maxPerUser: 10, maxPerChannel: 2 });

			limiter.check("user1", "channel1");
			limiter.check("user2", "channel1");
			const result = limiter.check("user3", "channel1");

			expect(result.allowed).toBe(false);
			expect(result.limitedBy).toBe("channel");
		});

		it("tracks users independently", () => {
			const limiter = new RateLimiter({ maxPerUser: 2, maxPerChannel: 10 });

			limiter.check("user1", "channel1");
			limiter.check("user1", "channel1");
			const result = limiter.check("user2", "channel1");

			expect(result.allowed).toBe(true);
		});

		it("tracks channels independently", () => {
			const limiter = new RateLimiter({ maxPerUser: 10, maxPerChannel: 2 });

			limiter.check("user1", "channel1");
			limiter.check("user1", "channel1");
			const result = limiter.check("user1", "channel2");

			expect(result.allowed).toBe(true);
		});

		it("resets after window expires", () => {
			const limiter = new RateLimiter({
				maxPerUser: 2,
				maxPerChannel: 10,
				windowMs: 1000,
			});

			limiter.check("user1", "channel1");
			limiter.check("user1", "channel1");

			// Should be blocked
			expect(limiter.check("user1", "channel1").allowed).toBe(false);

			// Advance time past window
			vi.advanceTimersByTime(1001);

			// Should be allowed again
			expect(limiter.check("user1", "channel1").allowed).toBe(true);
		});

		it("returns remaining count", () => {
			const limiter = new RateLimiter({ maxPerUser: 5, maxPerChannel: 10 });

			const result1 = limiter.check("user1", "channel1");
			const result2 = limiter.check("user1", "channel1");

			expect(result1.remaining).toBe(4);
			expect(result2.remaining).toBe(3);
		});

		it("returns reset time when blocked", () => {
			const limiter = new RateLimiter({
				maxPerUser: 1,
				maxPerChannel: 10,
				windowMs: 5000,
			});

			vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
			limiter.check("user1", "channel1");

			vi.setSystemTime(new Date("2024-01-01T00:00:02Z"));
			const result = limiter.check("user1", "channel1");

			expect(result.allowed).toBe(false);
			// Should reset in ~3 seconds (5000ms window - 2000ms elapsed)
			expect(result.resetMs).toBeGreaterThan(2000);
			expect(result.resetMs).toBeLessThanOrEqual(3000);
		});
	});

	describe("getStats", () => {
		it("returns current usage stats", () => {
			const limiter = new RateLimiter({ maxPerUser: 10, maxPerChannel: 30 });

			limiter.check("user1", "channel1");
			limiter.check("user1", "channel1");
			limiter.check("user2", "channel1");

			const stats = limiter.getStats("user1", "channel1");

			expect(stats.userRequests).toBe(2);
			expect(stats.channelRequests).toBe(3);
			expect(stats.userLimit).toBe(10);
			expect(stats.channelLimit).toBe(30);
		});

		it("returns zero for unknown user/channel", () => {
			const limiter = new RateLimiter();

			const stats = limiter.getStats("unknown", "unknown");

			expect(stats.userRequests).toBe(0);
			expect(stats.channelRequests).toBe(0);
		});
	});

	describe("resetUser", () => {
		it("clears user request history", () => {
			const limiter = new RateLimiter({ maxPerUser: 2, maxPerChannel: 10 });

			limiter.check("user1", "channel1");
			limiter.check("user1", "channel1");
			expect(limiter.check("user1", "channel1").allowed).toBe(false);

			limiter.resetUser("user1");

			expect(limiter.check("user1", "channel1").allowed).toBe(true);
		});
	});

	describe("resetChannel", () => {
		it("clears channel request history", () => {
			const limiter = new RateLimiter({ maxPerUser: 10, maxPerChannel: 2 });

			limiter.check("user1", "channel1");
			limiter.check("user2", "channel1");
			expect(limiter.check("user3", "channel1").allowed).toBe(false);

			limiter.resetChannel("channel1");

			expect(limiter.check("user3", "channel1").allowed).toBe(true);
		});
	});
});

describe("formatRateLimitMessage", () => {
	it("returns empty string when allowed", () => {
		const result = formatRateLimitMessage({
			allowed: true,
			remaining: 5,
			resetMs: 60000,
		});

		expect(result).toBe("");
	});

	it("formats user limit message", () => {
		const result = formatRateLimitMessage({
			allowed: false,
			remaining: 0,
			resetMs: 30000,
			limitedBy: "user",
		});

		expect(result).toContain("You've");
		expect(result).toContain("rate limit");
		expect(result).toContain("30s");
	});

	it("formats channel limit message", () => {
		const result = formatRateLimitMessage({
			allowed: false,
			remaining: 0,
			resetMs: 45000,
			limitedBy: "channel",
		});

		expect(result).toContain("This channel");
		expect(result).toContain("rate limit");
		expect(result).toContain("45s");
	});
});
