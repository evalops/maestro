/**
 * Connector Middleware - Production enhancements for connector execution.
 *
 * Wraps connector.execute() with:
 * 1. Response truncation (prevents oversized LLM context)
 * 2. TTL caching (avoids redundant API calls)
 * 3. Rate limiting with exponential backoff
 * 4. Audit logging
 */

import type { AuditLogger } from "../audit.js";
import * as logger from "../logger.js";
import { TtlCache } from "../utils/ttl-cache.js";
import type { Connector, ConnectorResult } from "./types.js";

const MAX_RESPONSE_CHARS = 50_000;
const MAX_ARRAY_ITEMS = 100;

export interface MiddlewareConfig {
	/** Max chars in connector response text (default: 50000) */
	maxResponseChars?: number;
	/** Max array items before truncation (default: 100) */
	maxArrayItems?: number;
	/** Cache TTL in ms for read actions (default: 60000 = 1 min, 0 = disabled) */
	cacheTtlMs?: number;
	/** Max requests per minute per connector (default: 60, 0 = unlimited) */
	maxRequestsPerMinute?: number;
	/** Audit logger instance (optional) */
	auditLogger?: AuditLogger;
	/** User ID for audit logging (optional) */
	userId?: string;
}

interface RateLimitState {
	tokens: number;
	lastRefill: number;
	maxTokens: number;
	refillRate: number;
}

/**
 * Wrap a connector with production middleware (truncation, caching, rate limiting, audit).
 * Returns a new execute function that replaces connector.execute().
 */
export function withMiddleware(
	connector: Connector,
	instanceName: string,
	config: MiddlewareConfig = {},
): (
	action: string,
	params: Record<string, unknown>,
) => Promise<ConnectorResult> {
	const maxChars = config.maxResponseChars ?? MAX_RESPONSE_CHARS;
	const maxItems = config.maxArrayItems ?? MAX_ARRAY_ITEMS;
	const cacheTtl = config.cacheTtlMs ?? 60_000;
	const maxRpm = config.maxRequestsPerMinute ?? 60;

	const cache =
		cacheTtl > 0
			? new TtlCache<string, ConnectorResult>({ defaultTtlMs: cacheTtl })
			: null;

	const rateLimit: RateLimitState | null =
		maxRpm > 0
			? {
					tokens: maxRpm,
					lastRefill: Date.now(),
					maxTokens: maxRpm,
					refillRate: maxRpm / 60_000,
				}
			: null;

	const capabilities = connector.getCapabilities();
	const readActions = new Set(
		capabilities.filter((c) => c.category === "read").map((c) => c.action),
	);

	return async (
		action: string,
		params: Record<string, unknown>,
	): Promise<ConnectorResult> => {
		const isRead = readActions.has(action);

		// 1. Cache check (reads only)
		if (isRead && cache) {
			const cacheKey = `${instanceName}:${action}:${JSON.stringify(params)}`;
			const cached = cache.get(cacheKey);
			if (cached) {
				logger.logDebug(`Cache hit: ${instanceName}.${action}`);
				return cached;
			}
		}

		// 2. Rate limiting
		if (rateLimit) {
			refillTokens(rateLimit);
			if (rateLimit.tokens < 1) {
				const waitMs = Math.ceil((1 - rateLimit.tokens) / rateLimit.refillRate);
				logger.logDebug(
					`Rate limited: ${instanceName}.${action}, waiting ${waitMs}ms`,
				);
				await sleep(Math.min(waitMs, 5000));
				refillTokens(rateLimit);
				if (rateLimit.tokens < 1) {
					return {
						success: false,
						error: `Rate limited: ${instanceName} (max ${maxRpm} req/min). Try again shortly.`,
					};
				}
			}
			rateLimit.tokens -= 1;
		}

		// 3. Execute
		const startMs = Date.now();
		let result: ConnectorResult;
		try {
			result = await connector.execute(action, params);
		} catch (error) {
			result = {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const durationMs = Date.now() - startMs;

		// 4. Audit log
		if (config.auditLogger) {
			try {
				config.auditLogger.log({
					action: "tool_call",
					userId: config.userId,
					toolName: `connector_${instanceName}_${action}`,
					inputPreview: JSON.stringify(params).slice(0, 200),
					outputPreview: result.success
						? JSON.stringify(result.data).slice(0, 200)
						: result.error?.slice(0, 200),
					status: result.success ? "success" : "error",
					durationMs,
					metadata: { connector: instanceName, action },
				});
			} catch {
				// Never let audit logging break connector execution
			}
		}

		// 5. Truncate response
		if (result.success && result.data != null) {
			result = {
				...result,
				data: truncateData(result.data, maxChars, maxItems),
			};
		}

		// 6. Cache store (reads only, success only)
		if (isRead && cache && result.success) {
			const cacheKey = `${instanceName}:${action}:${JSON.stringify(params)}`;
			cache.set(cacheKey, result);
		}

		return result;
	};
}

function truncateData(
	data: unknown,
	maxChars: number,
	maxItems: number,
): unknown {
	if (Array.isArray(data)) {
		const truncated = data.slice(0, maxItems);
		const result =
			data.length > maxItems
				? [...truncated, `... (${data.length - maxItems} more items truncated)`]
				: truncated;
		return result;
	}

	if (typeof data === "string" && data.length > maxChars) {
		return `${data.slice(0, maxChars)}\n... (truncated, ${data.length} chars total)`;
	}

	if (typeof data === "object" && data !== null) {
		const json = JSON.stringify(data);
		if (json.length > maxChars) {
			// Try to truncate array fields within the object
			const obj = data as Record<string, unknown>;
			const result: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(obj)) {
				if (Array.isArray(value) && value.length > maxItems) {
					result[key] = [
						...value.slice(0, maxItems),
						`... (${value.length - maxItems} more items)`,
					];
				} else {
					result[key] = value;
				}
			}
			const resultJson = JSON.stringify(result);
			if (resultJson.length > maxChars) {
				return `${resultJson.slice(0, maxChars)}\n... (truncated)`;
			}
			return result;
		}
	}

	return data;
}

function refillTokens(state: RateLimitState): void {
	const now = Date.now();
	const elapsed = now - state.lastRefill;
	state.tokens = Math.min(
		state.maxTokens,
		state.tokens + elapsed * state.refillRate,
	);
	state.lastRefill = now;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
