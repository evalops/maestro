export interface RateLimitConfig {
	windowMs: number;
	max: number;
}

interface ClientState {
	tokens: number;
	lastRefill: number;
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

	check(ip: string): { allowed: boolean; remaining: number; reset: number } {
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
			};
		}

		const tokensNeeded = 1 - client.tokens;
		const msNeeded = tokensNeeded / this.refillRate;
		return {
			allowed: false,
			remaining: 0,
			reset: now + msNeeded,
		};
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
