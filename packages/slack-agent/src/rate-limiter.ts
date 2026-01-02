/**
 * Rate Limiter - Per-user and per-channel rate limiting
 *
 * Prevents abuse by limiting how often users can invoke the agent.
 * Uses a sliding window algorithm for smooth rate limiting.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDirSync } from "./utils/fs.js";

export interface RateLimitConfig {
	/** Max requests per user per window (default: 10) */
	maxPerUser: number;
	/** Max requests per channel per window (default: 30) */
	maxPerChannel: number;
	/** Window size in milliseconds (default: 60000 = 1 minute) */
	windowMs: number;
	/** Optional path to persist rate limiter state */
	persistPath?: string;
	/** Minimum ms between persistence writes */
	persistIntervalMs?: number;
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
	persistIntervalMs: 5000,
};

interface RequestRecord {
	timestamps: number[];
}

export class RateLimiter {
	private config: RateLimitConfig;
	private userRequests: Map<string, RequestRecord> = new Map();
	private channelRequests: Map<string, RequestRecord> = new Map();
	private lastPersistMs = 0;

	constructor(config: Partial<RateLimitConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.loadState();
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
		this.maybePersist();

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
		this.maybePersist();
	}

	/**
	 * Reset limits for a channel (admin action)
	 */
	resetChannel(channelId: string): void {
		this.channelRequests.delete(channelId);
		this.maybePersist();
	}

	private loadState(): void {
		if (!this.config.persistPath) return;
		try {
			if (!existsSync(this.config.persistPath)) return;
			const raw = readFileSync(this.config.persistPath, "utf-8");
			const data = JSON.parse(raw) as {
				userRequests?: Record<string, number[]>;
				channelRequests?: Record<string, number[]>;
			};
			const now = Date.now();
			const windowStart = now - this.config.windowMs;
			for (const [key, timestamps] of Object.entries(data.userRequests ?? {})) {
				const filtered = timestamps.filter((t) => t > windowStart);
				if (filtered.length > 0) {
					this.userRequests.set(key, { timestamps: filtered });
				}
			}
			for (const [key, timestamps] of Object.entries(
				data.channelRequests ?? {},
			)) {
				const filtered = timestamps.filter((t) => t > windowStart);
				if (filtered.length > 0) {
					this.channelRequests.set(key, { timestamps: filtered });
				}
			}
		} catch {
			// Ignore load errors
		}
	}

	private maybePersist(force = false): void {
		if (!this.config.persistPath) return;
		const now = Date.now();
		const interval = this.config.persistIntervalMs ?? 0;
		if (!force && interval > 0 && now - this.lastPersistMs < interval) {
			return;
		}
		this.lastPersistMs = now;
		try {
			ensureDirSync(dirname(this.config.persistPath));
			const data = {
				userRequests: Object.fromEntries(
					Array.from(this.userRequests.entries()).map(([key, value]) => [
						key,
						value.timestamps,
					]),
				),
				channelRequests: Object.fromEntries(
					Array.from(this.channelRequests.entries()).map(([key, value]) => [
						key,
						value.timestamps,
					]),
				),
			};
			writeFileSync(this.config.persistPath, JSON.stringify(data, null, 2));
		} catch {
			// Ignore persistence errors
		}
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
