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
	"/api/command": { windowMs: 60000, max: 100 },
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

export class RateLimiter {
	private clients = new Map<string, ClientState>();
	private windowMs: number;
	private max: number;
	private refillRate: number; // tokens per ms

	constructor(config: RateLimitConfig = { windowMs: 60000, max: 100 }) {
		this.windowMs = config.windowMs;
		this.max = config.max;
		this.refillRate = config.max / config.windowMs;

		// Cleanup old entries every minute
		setInterval(() => this.cleanup(), 60000).unref();
	}

	check(ip: string): RateLimitResult {
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
			// Reset time indicates when the next request can be made (when 1 token is available)
			// If we still have tokens (tokens >= 1), we can request immediately (reset = now)
			// If we dropped below 1 token, we calculate time to refill to 1
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
	 */
	check(ip: string, endpoint: string): RateLimitResult {
		// Always check global limit
		const globalResult = this.globalLimiter.check(ip);

		// If global limit exceeded, return immediately
		if (!globalResult.allowed) {
			return globalResult;
		}

		// Find matching endpoint limiter (supports prefix matching)
		const endpointLimiter = this.findEndpointLimiter(endpoint);
		if (!endpointLimiter) {
			return globalResult;
		}

		// Check endpoint-specific limit
		const endpointKey = `${ip}:${endpoint}`;
		const endpointResult = endpointLimiter.check(endpointKey);

		// Return the more restrictive result
		if (!endpointResult.allowed) {
			return endpointResult;
		}

		// Both allowed - return with lower remaining
		return globalResult.remaining <= endpointResult.remaining
			? globalResult
			: endpointResult;
	}

	/**
	 * Find the rate limiter for a given endpoint path.
	 * Supports exact match and prefix matching.
	 */
	private findEndpointLimiter(endpoint: string): RateLimiter | undefined {
		// Exact match
		if (this.endpointLimiters.has(endpoint)) {
			return this.endpointLimiters.get(endpoint);
		}

		// Prefix match (e.g., /api/files/read matches /api/files)
		for (const [pattern, limiter] of this.endpointLimiters) {
			if (endpoint.startsWith(pattern)) {
				return limiter;
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
}
