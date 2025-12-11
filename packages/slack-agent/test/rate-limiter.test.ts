import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimiter, formatRateLimitMessage } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("enforces per-user limit", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const limiter = new RateLimiter({
			maxPerUser: 2,
			maxPerChannel: 100,
			windowMs: 1000,
		});

		expect(limiter.check("u1", "c1").allowed).toBe(true);
		expect(limiter.check("u1", "c1").allowed).toBe(true);

		const third = limiter.check("u1", "c1");
		expect(third.allowed).toBe(false);
		expect(third.limitedBy).toBe("user");
		expect(formatRateLimitMessage(third)).toContain("rate limit");

		vi.advanceTimersByTime(1001);
		expect(limiter.check("u1", "c1").allowed).toBe(true);
	});

	it("enforces per-channel limit", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const limiter = new RateLimiter({
			maxPerUser: 100,
			maxPerChannel: 2,
			windowMs: 1000,
		});

		expect(limiter.check("u1", "c1").allowed).toBe(true);
		expect(limiter.check("u2", "c1").allowed).toBe(true);

		const third = limiter.check("u3", "c1");
		expect(third.allowed).toBe(false);
		expect(third.limitedBy).toBe("channel");

		vi.advanceTimersByTime(1001);
		expect(limiter.check("u3", "c1").allowed).toBe(true);
	});
});
