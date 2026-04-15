/**
 * Tool Call Rate Limiter
 *
 * Prevents runaway tool execution by enforcing rate limits on tool calls.
 * Essential for autonomous agents where a bug could cause infinite loops.
 *
 * ## Features
 *
 * - Per-tool rate limits
 * - Global tool call limits
 * - Sliding window tracking
 * - Burst allowances
 * - Automatic cooldowns
 *
 * ## Usage
 *
 * ```typescript
 * import { toolRateLimiter } from "./rate-limiter.js";
 *
 * // Check before executing tool
 * const check = toolRateLimiter.checkLimit("Bash");
 * if (!check.allowed) {
 *   console.warn(`Rate limited: ${check.reason}`);
 *   return;
 * }
 *
 * // Record execution
 * toolRateLimiter.recordCall("Bash");
 * ```
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:rate-limiter");

/**
 * Rate limit configuration for a tool
 */
export interface ToolRateLimit {
	/** Maximum calls per minute */
	perMinute: number;
	/** Maximum calls per hour */
	perHour?: number;
	/** Burst allowance (calls allowed in quick succession) */
	burstLimit?: number;
	/** Cooldown period after burst (ms) */
	burstCooldownMs?: number;
}

/**
 * Default rate limits by tool type
 */
const DEFAULT_LIMITS: Record<string, ToolRateLimit> = {
	// Dangerous tools - strict limits
	Bash: { perMinute: 30, perHour: 200, burstLimit: 5, burstCooldownMs: 10000 },
	Write: { perMinute: 20, perHour: 150, burstLimit: 5, burstCooldownMs: 5000 },
	Edit: { perMinute: 40, perHour: 300, burstLimit: 10, burstCooldownMs: 5000 },

	// Read operations - more lenient
	Read: {
		perMinute: 100,
		perHour: 1000,
		burstLimit: 20,
		burstCooldownMs: 2000,
	},
	Glob: { perMinute: 60, perHour: 500, burstLimit: 15, burstCooldownMs: 3000 },
	Grep: { perMinute: 60, perHour: 500, burstLimit: 15, burstCooldownMs: 3000 },

	// Network operations - moderate limits
	WebFetch: {
		perMinute: 20,
		perHour: 100,
		burstLimit: 5,
		burstCooldownMs: 10000,
	},
	WebSearch: {
		perMinute: 10,
		perHour: 50,
		burstLimit: 3,
		burstCooldownMs: 15000,
	},

	// Agent tools - strict limits
	Task: { perMinute: 10, perHour: 50, burstLimit: 3, burstCooldownMs: 30000 },

	// Default for unknown tools
	_default: {
		perMinute: 30,
		perHour: 200,
		burstLimit: 10,
		burstCooldownMs: 5000,
	},
};

/**
 * Global limits across all tools
 */
const GLOBAL_LIMITS = {
	perMinute: 200,
	perHour: 2000,
	perSession: 10000,
};

/**
 * Rate limit check result
 */
export interface RateLimitResult {
	allowed: boolean;
	reason?: string;
	retryAfterMs?: number;
	currentRate: number;
	limit: number;
}

/**
 * Call record for tracking
 */
interface CallRecord {
	tool: string;
	timestamp: number;
}

/**
 * Tool call rate limiter
 */
class ToolRateLimiter {
	private calls: CallRecord[] = [];
	private burstTracking = new Map<
		string,
		{ count: number; windowStart: number }
	>();
	private cooldowns = new Map<string, number>();
	private customLimits = new Map<string, ToolRateLimit>();
	private enabled = true;

	/**
	 * Set custom rate limit for a tool
	 */
	setLimit(tool: string, limit: ToolRateLimit): void {
		this.customLimits.set(tool, limit);
		logger.info("Custom rate limit set", { tool, limit });
	}

	/**
	 * Enable or disable rate limiting
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		logger.info(`Rate limiting ${enabled ? "enabled" : "disabled"}`);
	}

	/**
	 * Get rate limit config for a tool
	 */
	getLimit(tool: string): ToolRateLimit {
		return (
			this.customLimits.get(tool) ||
			DEFAULT_LIMITS[tool] ||
			DEFAULT_LIMITS._default!
		);
	}

	/**
	 * Check if a tool call is allowed
	 */
	checkLimit(tool: string): RateLimitResult {
		if (!this.enabled) {
			return { allowed: true, currentRate: 0, limit: Number.POSITIVE_INFINITY };
		}

		const now = Date.now();
		this.cleanupOldCalls(now);

		const limit = this.getLimit(tool);

		// Check cooldown
		const cooldownEnd = this.cooldowns.get(tool);
		if (cooldownEnd && now < cooldownEnd) {
			const retryAfterMs = cooldownEnd - now;
			return {
				allowed: false,
				reason: `Tool ${tool} is in cooldown for ${Math.ceil(retryAfterMs / 1000)}s`,
				retryAfterMs,
				currentRate: this.getToolRate(tool, 60000),
				limit: limit.perMinute,
			};
		}

		// Check burst limit
		if (limit.burstLimit) {
			const burst = this.burstTracking.get(tool) || {
				count: 0,
				windowStart: now,
			};
			const burstWindowMs = 5000; // 5 second burst window

			if (now - burst.windowStart < burstWindowMs) {
				if (burst.count >= limit.burstLimit) {
					// Enter cooldown
					const cooldownMs = limit.burstCooldownMs || 10000;
					this.cooldowns.set(tool, now + cooldownMs);

					logger.warn("Burst limit exceeded, entering cooldown", {
						tool,
						burstCount: burst.count,
						burstLimit: limit.burstLimit,
						cooldownMs,
					});

					return {
						allowed: false,
						reason: `Tool ${tool} burst limit (${limit.burstLimit}) exceeded, cooling down for ${cooldownMs / 1000}s`,
						retryAfterMs: cooldownMs,
						currentRate: this.getToolRate(tool, 60000),
						limit: limit.perMinute,
					};
				}
			} else {
				// Reset burst window
				this.burstTracking.set(tool, { count: 0, windowStart: now });
			}
		}

		// Check per-minute limit
		const minuteRate = this.getToolRate(tool, 60000);
		if (minuteRate >= limit.perMinute) {
			return {
				allowed: false,
				reason: `Tool ${tool} rate limit (${limit.perMinute}/min) exceeded`,
				retryAfterMs: 60000,
				currentRate: minuteRate,
				limit: limit.perMinute,
			};
		}

		// Check per-hour limit
		if (limit.perHour) {
			const hourRate = this.getToolRate(tool, 3600000);
			if (hourRate >= limit.perHour) {
				return {
					allowed: false,
					reason: `Tool ${tool} hourly limit (${limit.perHour}/hour) exceeded`,
					retryAfterMs: 3600000,
					currentRate: hourRate,
					limit: limit.perHour,
				};
			}
		}

		// Check global limits
		const globalMinuteRate = this.getGlobalRate(60000);
		if (globalMinuteRate >= GLOBAL_LIMITS.perMinute) {
			return {
				allowed: false,
				reason: `Global rate limit (${GLOBAL_LIMITS.perMinute}/min) exceeded`,
				retryAfterMs: 60000,
				currentRate: globalMinuteRate,
				limit: GLOBAL_LIMITS.perMinute,
			};
		}

		const globalHourRate = this.getGlobalRate(3600000);
		if (globalHourRate >= GLOBAL_LIMITS.perHour) {
			return {
				allowed: false,
				reason: `Global hourly limit (${GLOBAL_LIMITS.perHour}/hour) exceeded`,
				retryAfterMs: 3600000,
				currentRate: globalHourRate,
				limit: GLOBAL_LIMITS.perHour,
			};
		}

		if (this.calls.length >= GLOBAL_LIMITS.perSession) {
			return {
				allowed: false,
				reason: `Session limit (${GLOBAL_LIMITS.perSession} total calls) exceeded`,
				currentRate: this.calls.length,
				limit: GLOBAL_LIMITS.perSession,
			};
		}

		return {
			allowed: true,
			currentRate: minuteRate,
			limit: limit.perMinute,
		};
	}

	/**
	 * Record a tool call
	 */
	recordCall(tool: string): void {
		const now = Date.now();
		this.calls.push({ tool, timestamp: now });

		// Update burst tracking
		const burst = this.burstTracking.get(tool) || {
			count: 0,
			windowStart: now,
		};
		if (now - burst.windowStart < 5000) {
			burst.count++;
		} else {
			burst.count = 1;
			burst.windowStart = now;
		}
		this.burstTracking.set(tool, burst);

		logger.debug("Tool call recorded", {
			tool,
			minuteRate: this.getToolRate(tool, 60000),
			globalRate: this.getGlobalRate(60000),
		});
	}

	/**
	 * Get call rate for a specific tool
	 */
	getToolRate(tool: string, windowMs: number): number {
		const cutoff = Date.now() - windowMs;
		return this.calls.filter((c) => c.tool === tool && c.timestamp > cutoff)
			.length;
	}

	/**
	 * Get global call rate
	 */
	getGlobalRate(windowMs: number): number {
		const cutoff = Date.now() - windowMs;
		return this.calls.filter((c) => c.timestamp > cutoff).length;
	}

	/**
	 * Clean up old call records
	 */
	private cleanupOldCalls(now: number): void {
		const cutoff = now - 3600000; // Keep 1 hour of history
		const before = this.calls.length;
		this.calls = this.calls.filter((c) => c.timestamp > cutoff);
		const removed = before - this.calls.length;
		if (removed > 0) {
			logger.debug("Cleaned up old call records", { removed });
		}
	}

	/**
	 * Get rate statistics
	 */
	getStats(): {
		totalCalls: number;
		globalMinuteRate: number;
		globalHourRate: number;
		byTool: Record<string, { minuteRate: number; hourRate: number }>;
	} {
		const byTool: Record<string, { minuteRate: number; hourRate: number }> = {};
		const tools = new Set(this.calls.map((c) => c.tool));

		for (const tool of tools) {
			byTool[tool] = {
				minuteRate: this.getToolRate(tool, 60000),
				hourRate: this.getToolRate(tool, 3600000),
			};
		}

		return {
			totalCalls: this.calls.length,
			globalMinuteRate: this.getGlobalRate(60000),
			globalHourRate: this.getGlobalRate(3600000),
			byTool,
		};
	}

	/**
	 * Reset the rate limiter
	 */
	reset(): void {
		this.calls = [];
		this.burstTracking.clear();
		this.cooldowns.clear();
		logger.info("Rate limiter reset");
	}

	/**
	 * Clear cooldown for a specific tool
	 */
	clearCooldown(tool: string): void {
		this.cooldowns.delete(tool);
		logger.info("Cooldown cleared", { tool });
	}
}

/**
 * Global rate limiter instance
 */
export const toolRateLimiter = new ToolRateLimiter();

/**
 * Decorator/wrapper for rate-limited tool execution
 */
export async function withRateLimit<T>(
	tool: string,
	fn: () => Promise<T>,
): Promise<T> {
	const check = toolRateLimiter.checkLimit(tool);
	if (!check.allowed) {
		throw new Error(check.reason || "Rate limit exceeded");
	}

	toolRateLimiter.recordCall(tool);
	return fn();
}
