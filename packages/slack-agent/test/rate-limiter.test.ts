import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimiter, formatRateLimitMessage } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("enforces per-user limit", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const limiter = new RateLimiter({
			maxPerUser: 2,
			maxPerChannel: 100,
			windowMs: 100, // 100ms window for fast testing
		});

		expect(limiter.check("u1", "c1").allowed).toBe(true);
		expect(limiter.check("u1", "c1").allowed).toBe(true);

		const third = limiter.check("u1", "c1");
		expect(third.allowed).toBe(false);
		expect(third.limitedBy).toBe("user");
		expect(formatRateLimitMessage(third)).toContain("rate limit");

		vi.advanceTimersByTime(110);
		expect(limiter.check("u1", "c1").allowed).toBe(true);
	});

	it("enforces per-channel limit", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const limiter = new RateLimiter({
			maxPerUser: 100,
			maxPerChannel: 2,
			windowMs: 100, // 100ms window for fast testing
		});

		expect(limiter.check("u1", "c1").allowed).toBe(true);
		expect(limiter.check("u2", "c1").allowed).toBe(true);

		const third = limiter.check("u3", "c1");
		expect(third.allowed).toBe(false);
		expect(third.limitedBy).toBe("channel");

		vi.advanceTimersByTime(110);
		expect(limiter.check("u3", "c1").allowed).toBe(true);
	});

	it("allows different users in same channel within user limit", () => {
		const limiter = new RateLimiter({
			maxPerUser: 2,
			maxPerChannel: 10,
			windowMs: 1000,
		});

		// Different users should each get their own limit
		expect(limiter.check("u1", "c1").allowed).toBe(true);
		expect(limiter.check("u2", "c1").allowed).toBe(true);
		expect(limiter.check("u3", "c1").allowed).toBe(true);
		expect(limiter.check("u1", "c1").allowed).toBe(true);
		expect(limiter.check("u2", "c1").allowed).toBe(true);

		// u1 hits limit
		expect(limiter.check("u1", "c1").allowed).toBe(false);
		// u2 hits limit
		expect(limiter.check("u2", "c1").allowed).toBe(false);
		// u3 still has requests
		expect(limiter.check("u3", "c1").allowed).toBe(true);
	});

	it("tracks remaining requests correctly", () => {
		const limiter = new RateLimiter({
			maxPerUser: 3,
			maxPerChannel: 10,
			windowMs: 1000,
		});

		const first = limiter.check("u1", "c1");
		expect(first.allowed).toBe(true);
		expect(first.remaining).toBe(2);

		const second = limiter.check("u1", "c1");
		expect(second.allowed).toBe(true);
		expect(second.remaining).toBe(1);

		const third = limiter.check("u1", "c1");
		expect(third.allowed).toBe(true);
		expect(third.remaining).toBe(0);

		const fourth = limiter.check("u1", "c1");
		expect(fourth.allowed).toBe(false);
	});

	it("getStats returns current usage", () => {
		const limiter = new RateLimiter({
			maxPerUser: 5,
			maxPerChannel: 10,
			windowMs: 1000,
		});

		limiter.check("u1", "c1");
		limiter.check("u1", "c1");
		limiter.check("u2", "c1");

		const stats = limiter.getStats("u1", "c1");
		expect(stats.userRequests).toBe(2);
		expect(stats.channelRequests).toBe(3);
		expect(stats.userLimit).toBe(5);
		expect(stats.channelLimit).toBe(10);
	});

	it("resetUser clears user limits", () => {
		const limiter = new RateLimiter({
			maxPerUser: 2,
			maxPerChannel: 10,
			windowMs: 1000,
		});

		limiter.check("u1", "c1");
		limiter.check("u1", "c1");
		expect(limiter.check("u1", "c1").allowed).toBe(false);

		limiter.resetUser("u1");
		expect(limiter.check("u1", "c1").allowed).toBe(true);
	});

	it("resetChannel clears channel limits", () => {
		const limiter = new RateLimiter({
			maxPerUser: 10,
			maxPerChannel: 2,
			windowMs: 1000,
		});

		limiter.check("u1", "c1");
		limiter.check("u2", "c1");
		expect(limiter.check("u3", "c1").allowed).toBe(false);

		limiter.resetChannel("c1");
		expect(limiter.check("u3", "c1").allowed).toBe(true);
	});
});

describe("formatRateLimitMessage", () => {
	it("returns empty string when allowed", () => {
		const result = formatRateLimitMessage({
			allowed: true,
			remaining: 5,
			resetMs: 1000,
		});
		expect(result).toBe("");
	});

	it("formats user limit message", () => {
		const result = formatRateLimitMessage({
			allowed: false,
			remaining: 0,
			resetMs: 5000,
			limitedBy: "user",
		});
		expect(result).toContain("You've");
		expect(result).toContain("rate limit");
		expect(result).toContain("5s");
	});

	it("formats channel limit message", () => {
		const result = formatRateLimitMessage({
			allowed: false,
			remaining: 0,
			resetMs: 10000,
			limitedBy: "channel",
		});
		expect(result).toContain("This channel");
		expect(result).toContain("rate limit");
		expect(result).toContain("10s");
	});
});
