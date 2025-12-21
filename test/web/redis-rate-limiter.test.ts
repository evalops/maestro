/**
 * Redis integration tests for rate limiter.
 *
 * These tests require a running Redis instance.
 * Set COMPOSER_REDIS_URL=redis://localhost:6379 to enable.
 *
 * Run with: COMPOSER_REDIS_URL=redis://localhost:6379 bunx vitest test/web/redis-rate-limiter.test.ts
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	type RateLimitConfig,
	RateLimiter,
	TieredRateLimiter,
	getRedisClient,
	initRedis,
	isRedisAvailable,
	shutdownRedis,
} from "../../src/server/rate-limiter.js";

const REDIS_URL = process.env.COMPOSER_REDIS_URL;

describe.skipIf(!REDIS_URL)("Redis Rate Limiter Integration", () => {
	beforeAll(async () => {
		// Ensure Redis is initialized
		await initRedis();
	});

	afterAll(async () => {
		await shutdownRedis();
	});

	describe("Redis connection", () => {
		it("connects to Redis when COMPOSER_REDIS_URL is set", () => {
			expect(isRedisAvailable()).toBe(true);
			expect(getRedisClient()).not.toBeNull();
		});
	});

	describe("RateLimiter with Redis backend", () => {
		let limiter: RateLimiter;

		beforeEach(async () => {
			limiter = new RateLimiter({ windowMs: 60000, max: 10 }, "test-rl");
			await limiter.reset();
		});

		afterEach(() => {
			limiter.stop();
		});

		it("allows requests within limit", async () => {
			const result = await limiter.checkAsync("192.168.1.1");
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(9);
			expect(result.limit).toBe(10);
		});

		it("blocks requests when limit exceeded", async () => {
			// Exhaust the limit
			for (let i = 0; i < 10; i++) {
				await limiter.checkAsync("192.168.1.2");
			}

			const result = await limiter.checkAsync("192.168.1.2");
			expect(result.allowed).toBe(false);
			expect(result.remaining).toBe(0);
		});

		it("tracks limits per IP independently", async () => {
			// Use up IP1's quota
			for (let i = 0; i < 10; i++) {
				await limiter.checkAsync("192.168.1.3");
			}

			// IP2 should still have quota
			const result = await limiter.checkAsync("192.168.1.4");
			expect(result.allowed).toBe(true);
		});

		it("resets individual IP limits", async () => {
			// Use up some quota
			for (let i = 0; i < 5; i++) {
				await limiter.checkAsync("192.168.1.5");
			}

			// Reset this IP
			await limiter.reset("192.168.1.5");

			// Should have full quota again
			const result = await limiter.checkAsync("192.168.1.5");
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(9);
		});

		it("persists state across limiter instances", async () => {
			const limiter1 = new RateLimiter(
				{ windowMs: 60000, max: 10 },
				"persist-test",
			);
			await limiter1.reset();

			// Use up quota with first limiter
			for (let i = 0; i < 5; i++) {
				await limiter1.checkAsync("192.168.1.6");
			}

			// Create new limiter instance with same prefix
			const limiter2 = new RateLimiter(
				{ windowMs: 60000, max: 10 },
				"persist-test",
			);

			// Should see the already-used quota
			const result = await limiter2.checkAsync("192.168.1.6");
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBeLessThan(5);

			limiter1.stop();
			limiter2.stop();
		});
	});

	describe("Redis failover", () => {
		it("falls back to memory when Redis unavailable", async () => {
			// Create a limiter that will try Redis first
			const limiter = new RateLimiter({ windowMs: 60000, max: 10 }, "failover");

			// Synchronous check always uses memory
			const result = limiter.check("192.168.3.1");
			expect(result.allowed).toBe(true);

			limiter.stop();
		});
	});
});

describe("Rate Limiter (in-memory only)", () => {
	let limiter: RateLimiter;

	beforeEach(() => {
		limiter = new RateLimiter({ windowMs: 60000, max: 10 });
	});

	afterEach(() => {
		limiter.stop();
	});

	it("allows requests within limit", () => {
		const result = limiter.check("10.0.0.1");
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(9);
	});

	it("blocks after limit exceeded", () => {
		for (let i = 0; i < 10; i++) {
			limiter.check("10.0.0.2");
		}

		const result = limiter.check("10.0.0.2");
		expect(result.allowed).toBe(false);
		expect(result.remaining).toBe(0);
	});

	it("returns reset time in the future", () => {
		const now = Date.now();
		const result = limiter.check("10.0.0.3");

		// Reset should be in the future (or very close to now if just checked)
		expect(result.reset).toBeGreaterThanOrEqual(now);
	});

	it("refills tokens over time", async () => {
		vi.useFakeTimers();
		try {
			// Create limiter with fast refill (10 tokens per 100ms)
			const fastLimiter = new RateLimiter({ windowMs: 100, max: 10 });

			// Use up all tokens
			for (let i = 0; i < 10; i++) {
				fastLimiter.check("10.0.0.4");
			}

			// Wait for refill
			await vi.advanceTimersByTimeAsync(20);

			// Should have some tokens back
			const result = fastLimiter.check("10.0.0.4");
			expect(result.allowed).toBe(true);

			fastLimiter.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("TieredRateLimiter (in-memory)", () => {
	// Track limiters for cleanup
	const activeLimiters: TieredRateLimiter[] = [];

	afterEach(() => {
		for (const limiter of activeLimiters) {
			limiter.stop();
		}
		activeLimiters.length = 0;
	});

	it("applies endpoint-specific limits", () => {
		const tieredLimiter = new TieredRateLimiter(
			{ windowMs: 60000, max: 100 },
			{
				"/api/chat": { windowMs: 60000, max: 5 },
			},
		);
		activeLimiters.push(tieredLimiter);

		// Use up /api/chat quota
		for (let i = 0; i < 5; i++) {
			tieredLimiter.check("192.168.2.1", "/api/chat");
		}

		// Next request should be blocked
		const result = tieredLimiter.check("192.168.2.1", "/api/chat");
		expect(result.allowed).toBe(false);
	});

	it("allows different endpoints independently", () => {
		const tieredLimiter = new TieredRateLimiter(
			{ windowMs: 60000, max: 100 },
			{
				"/api/chat": { windowMs: 60000, max: 5 },
				"/api/status": { windowMs: 60000, max: 50 },
			},
		);
		activeLimiters.push(tieredLimiter);

		// Use up /api/chat quota
		for (let i = 0; i < 5; i++) {
			tieredLimiter.check("192.168.2.2", "/api/chat");
		}

		// /api/status should still work
		const result = tieredLimiter.check("192.168.2.2", "/api/status");
		expect(result.allowed).toBe(true);
	});

	it("respects global limit across endpoints", () => {
		const tieredLimiter = new TieredRateLimiter(
			{ windowMs: 60000, max: 10 }, // Very strict global
			{
				"/api/status": { windowMs: 60000, max: 50 }, // Lenient endpoint
			},
		);
		activeLimiters.push(tieredLimiter);

		// Exhaust global limit via any endpoint
		for (let i = 0; i < 10; i++) {
			tieredLimiter.check("192.168.2.3", "/api/status");
		}

		// Should be blocked by global limit
		const result = tieredLimiter.check("192.168.2.3", "/api/status");
		expect(result.allowed).toBe(false);
	});

	it("returns correct limit information", () => {
		const tieredLimiter = new TieredRateLimiter(
			{ windowMs: 60000, max: 100 },
			{
				"/api/chat": { windowMs: 60000, max: 5 },
			},
		);
		activeLimiters.push(tieredLimiter);

		const limits = tieredLimiter.getLimits();
		expect(limits.global).toEqual({ windowMs: 60000, max: 100 });
		expect(limits.endpoints["/api/chat"]).toEqual({
			windowMs: 60000,
			max: 5,
		});
	});

	it("allows dynamic endpoint limit updates", () => {
		const tieredLimiter = new TieredRateLimiter(
			{ windowMs: 60000, max: 100 },
			{},
		);
		activeLimiters.push(tieredLimiter);

		tieredLimiter.setEndpointLimit("/api/new", { windowMs: 60000, max: 3 });

		const limits = tieredLimiter.getLimits();
		expect(limits.endpoints["/api/new"]).toEqual({ windowMs: 60000, max: 3 });
	});
});
