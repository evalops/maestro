/**
 * Redis integration tests for rate limiter.
 *
 * These tests require a running Redis instance.
 * Set MAESTRO_REDIS_URL=redis://localhost:6379 to enable.
 *
 * Run with: MAESTRO_REDIS_URL=redis://localhost:6379 bunx vitest test/web/redis-rate-limiter.test.ts
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

const REDIS_URL = process.env.MAESTRO_REDIS_URL;

describe.skipIf(!REDIS_URL)("Redis Rate Limiter Integration", () => {
	beforeAll(async () => {
		// Ensure Redis is initialized
		await initRedis();
	});

	afterAll(async () => {
		await shutdownRedis();
	});

	describe("Redis connection", () => {
		it("connects to Redis when MAESTRO_REDIS_URL is set", () => {
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

	describe("TieredRateLimiter with Redis backend", () => {
		it("does not drain endpoint quota when the global limit rejects", async () => {
			const client = getRedisClient();
			expect(client).not.toBeNull();
			const ip = "192.168.4.1";
			await client!.del(`rl:${ip}`, `rl:${ip}:/api/chat`);

			const tieredLimiter = new TieredRateLimiter(
				{ windowMs: 60000, max: 1 },
				{
					"/api/chat": { windowMs: 60000, max: 2 },
				},
			);

			try {
				expect((await tieredLimiter.checkAsync(ip, "/api/chat")).allowed).toBe(
					true,
				);
				expect((await tieredLimiter.checkAsync(ip, "/api/chat")).allowed).toBe(
					false,
				);

				const endpointTokens = await client!.hget(
					`rl:${ip}:/api/chat`,
					"tokens",
				);
				expect(Number(endpointTokens)).toBeGreaterThanOrEqual(1);
			} finally {
				tieredLimiter.stop();
				await client!.del(`rl:${ip}`, `rl:${ip}:/api/chat`);
			}
		});
	});
});

describe("RateLimiter Redis refund recovery", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.doUnmock("ioredis");
		vi.resetModules();
	});

	it("replays queued Redis refunds before the next consume", async () => {
		vi.resetModules();
		vi.stubEnv("MAESTRO_REDIS_URL", "redis://localhost:6379");

		const tokens = new Map<string, number>();
		let failRefund = true;

		class MockRedis {
			private handlers = new Map<string, Array<() => void>>();

			on(event: string, handler: () => void): this {
				const handlers = this.handlers.get(event) ?? [];
				handlers.push(handler);
				this.handlers.set(event, handlers);
				return this;
			}

			async connect(): Promise<void> {
				for (const handler of this.handlers.get("connect") ?? []) {
					handler();
				}
			}

			async eval(
				_script: string,
				_numKeys: number,
				key: string,
				max: number,
				_refillRate: number,
				now: number,
				_windowMs: number,
				refundCount?: number,
			): Promise<number | [number, number, number]> {
				const currentTokens = tokens.get(key) ?? max;

				if (typeof refundCount === "number") {
					if (failRefund) {
						throw new Error("refund failed");
					}
					const nextTokens = Math.min(max, currentTokens + refundCount);
					tokens.set(key, nextTokens);
					return nextTokens;
				}

				if (currentTokens >= 1) {
					const nextTokens = currentTokens - 1;
					tokens.set(key, nextTokens);
					return [1, Math.floor(nextTokens), now];
				}

				tokens.set(key, currentTokens);
				return [0, 0, now];
			}

			async del(...keys: string[]): Promise<number> {
				for (const key of keys) {
					tokens.delete(key);
				}
				return keys.length;
			}

			async scan(): Promise<[string, string[]]> {
				return ["0", []];
			}

			async quit(): Promise<void> {}
		}

		vi.doMock("ioredis", () => ({ Redis: MockRedis }));

		const rateLimiterModule = await import("../../src/server/rate-limiter.js");
		await rateLimiterModule.initRedis();

		const limiter = new rateLimiterModule.RateLimiter(
			{ windowMs: 60000, max: 2 },
			"queued-refund",
		);
		const ip = "192.168.10.10:/api/chat";
		const redisKey = `queued-refund:${ip}`;

		try {
			const first = await limiter.consumeAsync(ip);
			expect(first.allowed).toBe(true);
			expect(first.backend).toBe("redis");
			expect(first.remaining).toBe(1);

			await limiter.refundAsync(ip, "redis");
			expect(tokens.get(redisKey)).toBe(1);

			failRefund = false;

			const second = await limiter.consumeAsync(ip);
			expect(second.allowed).toBe(true);
			expect(second.backend).toBe("redis");
			expect(second.remaining).toBe(1);
			expect(tokens.get(redisKey)).toBe(1);
		} finally {
			limiter.stop();
			await rateLimiterModule.shutdownRedis();
		}
	});

	it("fails closed when queued Redis refunds cannot be replayed", async () => {
		vi.resetModules();
		vi.stubEnv("MAESTRO_REDIS_URL", "redis://localhost:6379");

		const tokens = new Map<string, number>();

		class MockRedis {
			private handlers = new Map<string, Array<() => void>>();

			on(event: string, handler: () => void): this {
				const handlers = this.handlers.get(event) ?? [];
				handlers.push(handler);
				this.handlers.set(event, handlers);
				return this;
			}

			async connect(): Promise<void> {
				for (const handler of this.handlers.get("connect") ?? []) {
					handler();
				}
			}

			async eval(
				_script: string,
				_numKeys: number,
				key: string,
				max: number,
				_refillRate: number,
				now: number,
				_windowMs: number,
				refundCount?: number,
			): Promise<number | [number, number, number]> {
				const currentTokens = tokens.get(key) ?? max;

				if (typeof refundCount === "number") {
					throw new Error("refund failed");
				}

				if (currentTokens >= 1) {
					const nextTokens = currentTokens - 1;
					tokens.set(key, nextTokens);
					return [1, Math.floor(nextTokens), now];
				}

				return [0, 0, now];
			}

			async del(...keys: string[]): Promise<number> {
				for (const key of keys) {
					tokens.delete(key);
				}
				return keys.length;
			}

			async scan(): Promise<[string, string[]]> {
				return ["0", []];
			}

			async quit(): Promise<void> {}
		}

		vi.doMock("ioredis", () => ({ Redis: MockRedis }));

		const rateLimiterModule = await import("../../src/server/rate-limiter.js");
		await rateLimiterModule.initRedis();

		const limiter = new rateLimiterModule.RateLimiter(
			{ windowMs: 60000, max: 2 },
			"queued-refund-closed",
		);
		const ip = "192.168.10.11:/api/chat";
		const redisKey = `queued-refund-closed:${ip}`;

		try {
			const first = await limiter.consumeAsync(ip);
			expect(first.allowed).toBe(true);
			expect(first.backend).toBe("redis");
			expect(first.remaining).toBe(1);

			await limiter.refundAsync(ip, "redis");
			expect(tokens.get(redisKey)).toBe(1);

			const second = await limiter.consumeAsync(ip);
			expect(second.allowed).toBe(false);
			expect(second.backend).toBe("redis");
			expect(second.remaining).toBe(0);
			expect(tokens.get(redisKey)).toBe(1);
		} finally {
			limiter.stop();
			await rateLimiterModule.shutdownRedis();
		}
	});

	it("replays queued Redis refunds before pair consumes", async () => {
		vi.resetModules();
		vi.stubEnv("MAESTRO_REDIS_URL", "redis://localhost:6379");

		const tokens = new Map<string, number>();
		let failRefund = true;

		class MockRedis {
			private handlers = new Map<string, Array<() => void>>();

			on(event: string, handler: () => void): this {
				const handlers = this.handlers.get(event) ?? [];
				handlers.push(handler);
				this.handlers.set(event, handlers);
				return this;
			}

			async connect(): Promise<void> {
				for (const handler of this.handlers.get("connect") ?? []) {
					handler();
				}
			}

			async eval(
				_script: string,
				numKeys: number,
				...args: Array<number | string>
			): Promise<
				| number
				| [number, number, number]
				| [number, number, number, number, number]
			> {
				if (numKeys === 2) {
					const [
						globalKey,
						endpointKey,
						globalMax,
						_globalRefillRate,
						_globalWindowMs,
						endpointMax,
						_endpointRefillRate,
						_endpointWindowMs,
						now,
					] = args as [
						string,
						string,
						number,
						number,
						number,
						number,
						number,
						number,
						number,
					];
					let globalTokens = tokens.get(globalKey) ?? globalMax;
					let endpointTokens = tokens.get(endpointKey) ?? endpointMax;
					const globalAllowed = globalTokens >= 1;
					const endpointAllowed = endpointTokens >= 1;
					if (globalAllowed && endpointAllowed) {
						globalTokens -= 1;
						endpointTokens -= 1;
					}
					tokens.set(globalKey, globalTokens);
					tokens.set(endpointKey, endpointTokens);
					return [
						globalAllowed ? 1 : 0,
						endpointAllowed ? 1 : 0,
						Math.floor(globalTokens),
						Math.floor(endpointTokens),
						now,
					];
				}

				const [key, max, _refillRate, now, _windowMs, refundCount] = args as [
					string,
					number,
					number,
					number,
					number,
					number | undefined,
				];
				const currentTokens = tokens.get(key) ?? max;

				if (typeof refundCount === "number") {
					if (failRefund) {
						throw new Error("refund failed");
					}
					const nextTokens = Math.min(max, currentTokens + refundCount);
					tokens.set(key, nextTokens);
					return nextTokens;
				}

				if (currentTokens >= 1) {
					const nextTokens = currentTokens - 1;
					tokens.set(key, nextTokens);
					return [1, Math.floor(nextTokens), now];
				}

				return [0, 0, now];
			}

			async del(...keys: string[]): Promise<number> {
				for (const key of keys) {
					tokens.delete(key);
				}
				return keys.length;
			}

			async scan(): Promise<[string, string[]]> {
				return ["0", []];
			}

			async quit(): Promise<void> {}
		}

		vi.doMock("ioredis", () => ({ Redis: MockRedis }));

		const rateLimiterModule = await import("../../src/server/rate-limiter.js");
		await rateLimiterModule.initRedis();

		const globalLimiter = new rateLimiterModule.RateLimiter(
			{ windowMs: 60000, max: 10 },
			"queued-pair-global",
		);
		const endpointLimiter = new rateLimiterModule.RateLimiter(
			{ windowMs: 60000, max: 2 },
			"queued-pair-endpoint",
		);
		const ip = "192.168.10.12";
		const endpointIp = `${ip}:/api/chat`;
		const endpointKey = `queued-pair-endpoint:${endpointIp}`;

		try {
			const first = await globalLimiter.consumePairRedisAsync(
				ip,
				endpointLimiter,
				endpointIp,
			);
			expect(first?.allowed).toBe(true);
			expect(tokens.get(endpointKey)).toBe(1);

			await endpointLimiter.refundAsync(endpointIp, "redis");
			expect(tokens.get(endpointKey)).toBe(1);

			failRefund = false;

			const second = await globalLimiter.consumePairRedisAsync(
				ip,
				endpointLimiter,
				endpointIp,
			);
			expect(second?.allowed).toBe(true);
			expect(tokens.get(endpointKey)).toBe(1);
		} finally {
			globalLimiter.stop();
			endpointLimiter.stop();
			await rateLimiterModule.shutdownRedis();
		}
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

	it("does not apply endpoint limits to sibling path prefixes", () => {
		const tieredLimiter = new TieredRateLimiter(
			{ windowMs: 60000, max: 100 },
			{
				"/api/chat": { windowMs: 60000, max: 1 },
			},
		);
		activeLimiters.push(tieredLimiter);

		expect(tieredLimiter.check("192.168.2.6", "/api/chat").allowed).toBe(true);
		expect(tieredLimiter.check("192.168.2.6", "/api/chat").allowed).toBe(false);
		expect(tieredLimiter.check("192.168.2.6", "/api/chatx").allowed).toBe(true);
		expect(tieredLimiter.check("192.168.2.6", "/api/chat/stream").allowed).toBe(
			false,
		);
	});

	it("does not let concurrent async bursts exceed endpoint limits", async () => {
		const tieredLimiter = new TieredRateLimiter(
			{ windowMs: 60000, max: 100 },
			{
				"/api/chat": { windowMs: 60000, max: 1 },
			},
		);
		activeLimiters.push(tieredLimiter);

		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				tieredLimiter.checkAsync("192.168.2.7", "/api/chat"),
			),
		);

		expect(results.filter((result) => result.allowed)).toHaveLength(1);
		expect(results.filter((result) => !result.allowed)).toHaveLength(7);
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

	it("does not drain endpoint quota when async global check rejects", async () => {
		vi.useFakeTimers();
		try {
			const tieredLimiter = new TieredRateLimiter(
				{ windowMs: 50, max: 1 },
				{
					"/api/chat": { windowMs: 60000, max: 2 },
				},
			);
			activeLimiters.push(tieredLimiter);

			expect(
				(await tieredLimiter.checkAsync("192.168.2.8", "/api/chat")).allowed,
			).toBe(true);
			expect(
				(await tieredLimiter.checkAsync("192.168.2.8", "/api/chat")).allowed,
			).toBe(false);

			await vi.advanceTimersByTimeAsync(60);

			expect(
				(await tieredLimiter.checkAsync("192.168.2.8", "/api/chat")).allowed,
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
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
