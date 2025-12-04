import { Redis } from "ioredis";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("rate-limiter");

export interface RateLimitConfig {
	windowMs: number;
	max: number;
}

/**
 * Per-endpoint rate limit overrides.
 * Endpoints not listed use the global rate limit.
 */
export interface EndpointRateLimits {
	[endpoint: string]: RateLimitConfig;
}

/**
 * Default endpoint-specific rate limits.
 * More restrictive for expensive operations.
 */
export const DEFAULT_ENDPOINT_LIMITS: EndpointRateLimits = {
	// Chat endpoint is expensive (LLM inference)
	"/api/chat": { windowMs: 60000, max: 30 },
	// Model switching is moderately expensive
	"/api/model": { windowMs: 60000, max: 60 },
	// File operations - moderate limit
	"/api/files": { windowMs: 60000, max: 200 },
	// Commands can trigger expensive operations
	"/api/commands": { windowMs: 60000, max: 100 },
	// Status endpoints are cheap
	"/api/status": { windowMs: 60000, max: 500 },
	"/api/config": { windowMs: 60000, max: 500 },
};

interface ClientState {
	tokens: number;
	lastRefill: number;
}

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	reset: number;
	limit: number;
}

// ============================================================================
// REDIS CONNECTION (shared singleton)
// ============================================================================

let redis: Redis | null = null;
let redisAvailable = false;
let redisInitPromise: Promise<boolean> | null = null;

/**
 * Initialize Redis connection if COMPOSER_REDIS_URL is configured.
 * Returns true if Redis is available, false otherwise.
 */
export async function initRedis(): Promise<boolean> {
	const redisUrl = process.env.COMPOSER_REDIS_URL;
	if (!redisUrl) {
		logger.debug(
			"No COMPOSER_REDIS_URL configured, using in-memory rate limiting",
		);
		return false;
	}

	if (redisInitPromise) {
		return redisInitPromise;
	}

	redisInitPromise = (async () => {
		try {
			const client = new Redis(redisUrl, {
				maxRetriesPerRequest: 1,
				retryStrategy: (times: number) => {
					if (times > 3) return null;
					return Math.min(times * 100, 1000);
				},
				lazyConnect: true,
				enableOfflineQueue: false,
			});

			client.on("error", (err: Error) => {
				logger.warn("Redis error", { error: err.message });
				redisAvailable = false;
			});

			client.on("connect", () => {
				redisAvailable = true;
				logger.info("Redis connected for rate limiting");
			});

			await client.connect();
			redis = client;
			redisAvailable = true;
			return true;
		} catch (error) {
			logger.warn("Redis connection failed, using in-memory fallback", {
				error: error instanceof Error ? error.message : String(error),
			});
			redis = null;
			redisAvailable = false;
			return false;
		}
	})();

	return redisInitPromise;
}

/**
 * Check if Redis is being used for rate limiting.
 */
export function isRedisAvailable(): boolean {
	return redisAvailable;
}

/**
 * Get the Redis client (for testing or advanced usage).
 */
export function getRedisClient(): Redis | null {
	return redis;
}

/**
 * Shutdown Redis connection gracefully.
 */
export async function shutdownRedis(): Promise<void> {
	if (redis) {
		await redis.quit().catch((err) => {
			logger.debug("Redis quit failed during shutdown", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
		redis = null;
		redisAvailable = false;
		redisInitPromise = null;
	}
}

// Initialize Redis on module load (non-blocking)
initRedis().catch((err) => {
	logger.warn("Redis initialization failed", {
		error: err instanceof Error ? err.message : String(err),
	});
});

// ============================================================================
// RATE LIMITER
// ============================================================================

export class RateLimiter {
	private clients = new Map<string, ClientState>();
	private windowMs: number;
	private max: number;
	private refillRate: number; // tokens per ms
	private keyPrefix: string;
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor(
		config: RateLimitConfig = { windowMs: 60000, max: 100 },
		keyPrefix = "rl",
	) {
		this.windowMs = config.windowMs;
		this.max = config.max;
		this.refillRate = config.max / config.windowMs;
		this.keyPrefix = keyPrefix;

		// Cleanup old entries every minute
		this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
		this.cleanupInterval.unref();
	}

	/**
	 * Check rate limit (async to support Redis).
	 */
	async checkAsync(ip: string): Promise<RateLimitResult> {
		if (redis && redisAvailable) {
			try {
				return await this.checkRedis(ip);
			} catch (error) {
				logger.debug("Redis check failed, using memory fallback", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return this.checkMemory(ip);
	}

	/**
	 * Synchronous check (memory only, for backwards compatibility).
	 */
	check(ip: string): RateLimitResult {
		return this.checkMemory(ip);
	}

	private async checkRedis(ip: string): Promise<RateLimitResult> {
		const key = `${this.keyPrefix}:${ip}`;
		const now = Date.now();

		// Lua script for atomic token bucket
		const script = `
			local key = KEYS[1]
			local max = tonumber(ARGV[1])
			local refillRate = tonumber(ARGV[2])
			local now = tonumber(ARGV[3])
			local windowMs = tonumber(ARGV[4])

			local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
			local tokens = tonumber(data[1]) or max
			local lastRefill = tonumber(data[2]) or now

			-- Refill tokens
			local timePassed = now - lastRefill
			local refillAmount = timePassed * refillRate
			tokens = math.min(max, tokens + refillAmount)

			local allowed = 0
			if tokens >= 1 then
				tokens = tokens - 1
				allowed = 1
			end

			redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', now)
			redis.call('PEXPIRE', key, windowMs)

			return {allowed, math.floor(tokens), now}
		`;

		if (!redis) {
			throw new Error("Redis not available");
		}
		const result = (await redis.eval(
			script,
			1,
			key,
			this.max,
			this.refillRate,
			now,
			this.windowMs,
		)) as [number, number, number];

		const allowed = result[0] === 1;
		const remaining = result[1];

		if (!allowed) {
			const tokensNeeded = 1 - remaining;
			const msNeeded = tokensNeeded / this.refillRate;
			return {
				allowed: false,
				remaining: 0,
				reset: now + msNeeded,
				limit: this.max,
			};
		}

		const tokensNeeded = 1 - remaining;
		const msNeeded = Math.max(0, tokensNeeded / this.refillRate);
		return {
			allowed: true,
			remaining,
			reset: now + msNeeded,
			limit: this.max,
		};
	}

	private checkMemory(ip: string): RateLimitResult {
		const now = Date.now();
		let client = this.clients.get(ip);

		if (!client) {
			client = {
				tokens: this.max,
				lastRefill: now,
			};
			this.clients.set(ip, client);
		}

		// Refill tokens
		const timePassed = now - client.lastRefill;
		const refillAmount = timePassed * this.refillRate;

		client.tokens = Math.min(this.max, client.tokens + refillAmount);
		client.lastRefill = now;

		if (client.tokens >= 1) {
			client.tokens -= 1;
			const tokensNeeded = 1 - client.tokens;
			const msNeeded = Math.max(0, tokensNeeded / this.refillRate);
			return {
				allowed: true,
				remaining: Math.floor(client.tokens),
				reset: now + msNeeded,
				limit: this.max,
			};
		}

		const tokensNeeded = 1 - client.tokens;
		const msNeeded = tokensNeeded / this.refillRate;
		return {
			allowed: false,
			remaining: 0,
			reset: now + msNeeded,
			limit: this.max,
		};
	}

	getConfig(): RateLimitConfig {
		return { windowMs: this.windowMs, max: this.max };
	}

	/**
	 * Check if a request would be allowed without consuming a token.
	 * Used by TieredRateLimiter to avoid token leaks.
	 */
	peek(ip: string): RateLimitResult {
		const now = Date.now();
		const client = this.clients.get(ip);

		if (!client) {
			// New client would have full tokens
			return {
				allowed: true,
				remaining: this.max - 1, // Would have this many after consuming
				reset: now,
				limit: this.max,
			};
		}

		// Calculate current tokens (with refill) without mutating state
		const timePassed = now - client.lastRefill;
		const refillAmount = timePassed * this.refillRate;
		const currentTokens = Math.min(this.max, client.tokens + refillAmount);

		if (currentTokens >= 1) {
			return {
				allowed: true,
				remaining: Math.floor(currentTokens - 1),
				reset: now,
				limit: this.max,
			};
		}

		const tokensNeeded = 1 - currentTokens;
		const msNeeded = tokensNeeded / this.refillRate;
		return {
			allowed: false,
			remaining: 0,
			reset: now + msNeeded,
			limit: this.max,
		};
	}

	/**
	 * Reset rate limit for an IP (for testing).
	 */
	async reset(ip?: string): Promise<void> {
		if (ip) {
			this.clients.delete(ip);
			if (redis && redisAvailable) {
				await redis.del(`${this.keyPrefix}:${ip}`).catch((err) => {
					logger.debug("Redis del failed during reset", {
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		} else {
			this.clients.clear();
			if (redis && redisAvailable) {
				// Use SCAN instead of KEYS to avoid blocking Redis
				let cursor = "0";
				do {
					const [nextCursor, keys] = await redis.scan(
						cursor,
						"MATCH",
						`${this.keyPrefix}:*`,
						"COUNT",
						100,
					);
					cursor = nextCursor;
					if (keys.length > 0) {
						await redis.del(...keys).catch((err) => {
							logger.debug("Redis bulk del failed during reset", {
								error: err instanceof Error ? err.message : String(err),
							});
						});
					}
				} while (cursor !== "0");
			}
		}
	}

	/**
	 * Stop cleanup interval (for graceful shutdown).
	 */
	stop(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
	}

	private cleanup() {
		const now = Date.now();
		for (const [ip, client] of this.clients.entries()) {
			if (now - client.lastRefill > this.windowMs) {
				this.clients.delete(ip);
			}
		}
	}
}

/**
 * Multi-tier rate limiter with per-endpoint limits.
 *
 * Provides both global IP-based rate limiting and endpoint-specific limits.
 * The more restrictive limit applies.
 */
export class TieredRateLimiter {
	private globalLimiter: RateLimiter;
	private endpointLimiters = new Map<string, RateLimiter>();
	private endpointLimits: EndpointRateLimits;

	constructor(
		globalConfig: RateLimitConfig = { windowMs: 60000, max: 1000 },
		endpointLimits: EndpointRateLimits = DEFAULT_ENDPOINT_LIMITS,
	) {
		this.globalLimiter = new RateLimiter(globalConfig);
		this.endpointLimits = endpointLimits;

		// Pre-create endpoint limiters
		for (const [endpoint, config] of Object.entries(endpointLimits)) {
			this.endpointLimiters.set(endpoint, new RateLimiter(config));
		}
	}

	/**
	 * Check rate limit for a specific IP and endpoint.
	 * Returns the most restrictive result between global and endpoint limits.
	 *
	 * Uses peek-then-consume pattern to avoid token leaks:
	 * - First peeks at both limits without consuming
	 * - Only consumes tokens if both limits allow the request
	 */
	check(ip: string, endpoint: string): RateLimitResult {
		// Peek at global limit first (no consumption)
		const globalPeek = this.globalLimiter.peek(ip);
		if (!globalPeek.allowed) {
			return globalPeek;
		}

		// Find matching endpoint limiter and pattern
		const match = this.findEndpointLimiter(endpoint);
		if (!match) {
			// No endpoint limit - consume global token and return
			return this.globalLimiter.check(ip);
		}

		// Use the matched pattern (not full path) for the key so all sub-routes
		// share the same bucket. E.g., /api/chat/approval uses key "ip:/api/chat"
		const endpointKey = `${ip}:${match.pattern}`;
		const endpointPeek = match.limiter.peek(endpointKey);
		if (!endpointPeek.allowed) {
			// Endpoint limit would reject - return without consuming global token
			return endpointPeek;
		}

		// Both limits allow - consume tokens from both
		const globalResult = this.globalLimiter.check(ip);
		const endpointResult = match.limiter.check(endpointKey);

		// Return the more restrictive result
		return globalResult.remaining <= endpointResult.remaining
			? globalResult
			: endpointResult;
	}

	/**
	 * Find the rate limiter for a given endpoint path.
	 * Supports exact match and prefix matching.
	 * Returns both the limiter and the matched pattern for consistent key generation.
	 */
	private findEndpointLimiter(
		endpoint: string,
	): { limiter: RateLimiter; pattern: string } | undefined {
		// Exact match
		const exactMatch = this.endpointLimiters.get(endpoint);
		if (exactMatch) {
			return {
				limiter: exactMatch,
				pattern: endpoint,
			};
		}

		// Prefix match (e.g., /api/files/read matches /api/files)
		// All sub-routes share the same bucket under the pattern
		for (const [pattern, limiter] of this.endpointLimiters) {
			if (endpoint.startsWith(pattern)) {
				return { limiter, pattern };
			}
		}

		return undefined;
	}

	/**
	 * Get all configured limits for debugging/metrics.
	 */
	getLimits(): { global: RateLimitConfig; endpoints: EndpointRateLimits } {
		return {
			global: this.globalLimiter.getConfig(),
			endpoints: this.endpointLimits,
		};
	}

	/**
	 * Add or update an endpoint-specific rate limit.
	 */
	setEndpointLimit(endpoint: string, config: RateLimitConfig): void {
		this.endpointLimits[endpoint] = config;
		this.endpointLimiters.set(endpoint, new RateLimiter(config));
	}

	/**
	 * Stop all cleanup intervals (for graceful shutdown and test cleanup).
	 */
	stop(): void {
		this.globalLimiter.stop();
		for (const limiter of this.endpointLimiters.values()) {
			limiter.stop();
		}
	}
}
