/**
 * Rate Limiter - Per-user and per-channel rate limiting
 *
 * Prevents abuse by limiting how often users can invoke the agent.
 * Uses a sliding window algorithm for smooth rate limiting.
 */

export interface RateLimitConfig {
	/** Max requests per user per window (default: 10) */
	maxPerUser: number;
	/** Max requests per channel per window (default: 30) */
	maxPerChannel: number;
	/** Window size in milliseconds (default: 60000 = 1 minute) */
	windowMs: number;
}

export interface RateLimitResult {
	allowed: boolean;
	/** Requests remaining in current window */
	remaining: number;
	/** Milliseconds until window resets */
	resetMs: number;
	/** What triggered the limit (if not allowed) */
	limitedBy?: "user" | "channel";
}

const DEFAULT_CONFIG: RateLimitConfig = {
	maxPerUser: 10,
	maxPerChannel: 30,
	windowMs: 60 * 1000, // 1 minute
};

interface RequestRecord {
	timestamps: number[];
}

export class RateLimiter {
	private config: RateLimitConfig;
	private userRequests: Map<string, RequestRecord> = new Map();
	private channelRequests: Map<string, RequestRecord> = new Map();

	constructor(config: Partial<RateLimitConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Check if a request is allowed and record it if so
	 */
	check(userId: string, channelId: string): RateLimitResult {
		const now = Date.now();
		const windowStart = now - this.config.windowMs;

		// Clean and count user requests
		const userRecord = this.getOrCreate(this.userRequests, userId);
		this.pruneOld(userRecord, windowStart);
		const userCount = userRecord.timestamps.length;

		// Clean and count channel requests
		const channelRecord = this.getOrCreate(this.channelRequests, channelId);
		this.pruneOld(channelRecord, windowStart);
		const channelCount = channelRecord.timestamps.length;

		// Check user limit
		if (userCount >= this.config.maxPerUser) {
			const oldestUser = userRecord.timestamps[0] || now;
			return {
				allowed: false,
				remaining: 0,
				resetMs: oldestUser + this.config.windowMs - now,
				limitedBy: "user",
			};
		}

		// Check channel limit
		if (channelCount >= this.config.maxPerChannel) {
			const oldestChannel = channelRecord.timestamps[0] || now;
			return {
				allowed: false,
				remaining: 0,
				resetMs: oldestChannel + this.config.windowMs - now,
				limitedBy: "channel",
			};
		}

		// Record the request
		userRecord.timestamps.push(now);
		channelRecord.timestamps.push(now);

		const userRemaining = this.config.maxPerUser - userRecord.timestamps.length;
		const channelRemaining =
			this.config.maxPerChannel - channelRecord.timestamps.length;

		return {
			allowed: true,
			remaining: Math.min(userRemaining, channelRemaining),
			resetMs: this.config.windowMs,
		};
	}

	/**
	 * Get current usage stats without recording a request
	 */
	getStats(
		userId: string,
		channelId: string,
	): {
		userRequests: number;
		channelRequests: number;
		userLimit: number;
		channelLimit: number;
	} {
		const now = Date.now();
		const windowStart = now - this.config.windowMs;

		const userRecord = this.userRequests.get(userId);
		const channelRecord = this.channelRequests.get(channelId);

		const userCount = userRecord
			? userRecord.timestamps.filter((t) => t > windowStart).length
			: 0;
		const channelCount = channelRecord
			? channelRecord.timestamps.filter((t) => t > windowStart).length
			: 0;

		return {
			userRequests: userCount,
			channelRequests: channelCount,
			userLimit: this.config.maxPerUser,
			channelLimit: this.config.maxPerChannel,
		};
	}

	/**
	 * Reset limits for a user (admin action)
	 */
	resetUser(userId: string): void {
		this.userRequests.delete(userId);
	}

	/**
	 * Reset limits for a channel (admin action)
	 */
	resetChannel(channelId: string): void {
		this.channelRequests.delete(channelId);
	}

	private getOrCreate(
		map: Map<string, RequestRecord>,
		key: string,
	): RequestRecord {
		let record = map.get(key);
		if (!record) {
			record = { timestamps: [] };
			map.set(key, record);
		}
		return record;
	}

	private pruneOld(record: RequestRecord, windowStart: number): void {
		record.timestamps = record.timestamps.filter((t) => t > windowStart);
	}
}

/**
 * Format rate limit result as user-friendly message
 */
export function formatRateLimitMessage(result: RateLimitResult): string {
	if (result.allowed) {
		return "";
	}

	const seconds = Math.ceil(result.resetMs / 1000);
	const who = result.limitedBy === "user" ? "You've" : "This channel has";

	return `_${who} hit the rate limit. Please wait ${seconds}s before trying again._`;
}
