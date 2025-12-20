/**
 * API Request Queue - Rate-limited request queue for Slack API
 *
 * Implements Slack's rate limiting best practices:
 * - Queues requests to prevent overwhelming the API
 * - Respects retry-after headers on 429 responses
 * - Supports per-method rate limit tiers
 * - Implements exponential backoff for retries
 *
 * @see https://docs.slack.dev/apis/web-api/rate-limits/
 */

import * as logger from "../logger.js";

/**
 * Slack API rate limit tiers (requests per minute)
 */
export const RATE_LIMIT_TIERS = {
	tier1: 1, // 1 req/min - conversations.history, conversations.replies (non-marketplace)
	tier2: 20, // 20 req/min - most read methods
	tier3: 50, // 50 req/min - most write methods
	tier4: 100, // 100 req/min - high volume methods
	special: 1, // 1 req/sec burst tolerance (recommended design target)
} as const;

export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS;

/**
 * Method-specific rate limit mappings
 */
export const METHOD_TIERS: Record<string, RateLimitTier> = {
	// Tier 1 methods (most restrictive for non-marketplace apps)
	"conversations.history": "tier1",
	"conversations.replies": "tier1",

	// Tier 2 methods (read)
	"users.list": "tier2",
	"channels.list": "tier2",
	"conversations.list": "tier2",
	"conversations.members": "tier2",
	"users.info": "tier2",
	"conversations.info": "tier2",

	// Tier 3 methods (write)
	"chat.postMessage": "tier3",
	"chat.update": "tier3",
	"chat.delete": "tier3",
	"reactions.add": "tier3",
	"reactions.remove": "tier3",
	"files.upload": "tier3",
	"files.uploadV2": "tier3",

	// Tier 4 methods (high volume)
	"auth.test": "tier4",
};

export interface QueuedRequest<T> {
	id: string;
	method: string;
	execute: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	retries: number;
	maxRetries: number;
	addedAt: number;
}

export interface ApiQueueOptions {
	/** Default rate limit tier for unknown methods */
	defaultTier?: RateLimitTier;
	/** Max retries for failed requests */
	maxRetries?: number;
	/** Base delay for exponential backoff (ms) */
	baseDelayMs?: number;
	/** Max delay cap (ms) */
	maxDelayMs?: number;
	/** Enable debug logging */
	debug?: boolean;
}

/**
 * API request queue with rate limiting and retry support.
 *
 * Ensures Slack API requests are sent at appropriate intervals
 * and handles rate limit responses gracefully.
 */
export class ApiQueue {
	private queue: QueuedRequest<unknown>[] = [];
	private processing = false;
	private pausedUntil = 0;
	private methodLastCall: Map<string, number> = new Map();
	private requestCounter = 0;

	private readonly defaultTier: RateLimitTier;
	private readonly maxRetries: number;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly debug: boolean;

	constructor(options: ApiQueueOptions = {}) {
		this.defaultTier = options.defaultTier ?? "tier3";
		this.maxRetries = options.maxRetries ?? 3;
		this.baseDelayMs = options.baseDelayMs ?? 1000;
		this.maxDelayMs = options.maxDelayMs ?? 30000;
		this.debug = options.debug ?? false;
	}

	/**
	 * Add a request to the queue
	 */
	enqueue<T>(method: string, execute: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const request: QueuedRequest<T> = {
				id: `req_${++this.requestCounter}`,
				method,
				execute,
				resolve: resolve as (value: unknown) => void,
				reject,
				retries: 0,
				maxRetries: this.maxRetries,
				addedAt: Date.now(),
			};

			this.queue.push(request as QueuedRequest<unknown>);

			if (this.debug) {
				logger.logDebug(`Enqueued ${method} request`, { id: request.id });
			}

			this.processQueue();
		});
	}

	/**
	 * Get the minimum delay before a method can be called
	 */
	private getMethodDelay(method: string): number {
		const tier = METHOD_TIERS[method] ?? this.defaultTier;
		const requestsPerMinute = RATE_LIMIT_TIERS[tier];

		// Recommended: design for 1 req/sec with burst tolerance
		const minIntervalMs = Math.max(1000, Math.ceil(60000 / requestsPerMinute));

		const lastCall = this.methodLastCall.get(method) ?? 0;
		const timeSinceLastCall = Date.now() - lastCall;

		return Math.max(0, minIntervalMs - timeSinceLastCall);
	}

	/**
	 * Process the queue
	 */
	private async processQueue(): Promise<void> {
		if (this.processing || this.queue.length === 0) {
			return;
		}

		this.processing = true;

		while (this.queue.length > 0) {
			// Check if we're paused (rate limited)
			const now = Date.now();
			if (now < this.pausedUntil) {
				const waitTime = this.pausedUntil - now;
				if (this.debug) {
					logger.logDebug(`Queue paused for ${waitTime}ms`);
				}
				await this.delay(waitTime);
			}

			const request = this.queue[0];
			if (!request) break;

			// Check method-specific rate limit
			const methodDelay = this.getMethodDelay(request.method);
			if (methodDelay > 0) {
				await this.delay(methodDelay);
			}

			// Execute the request
			try {
				this.methodLastCall.set(request.method, Date.now());
				const result = await request.execute();
				this.queue.shift();
				request.resolve(result);
			} catch (error) {
				const handled = await this.handleError(request, error);
				if (!handled) {
					this.queue.shift();
					request.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			}
		}

		this.processing = false;
	}

	/**
	 * Handle request errors, including rate limiting
	 */
	private async handleError(
		request: QueuedRequest<unknown>,
		error: unknown,
	): Promise<boolean> {
		// Check for rate limit response (429)
		if (this.isRateLimitError(error)) {
			const retryAfter = this.getRetryAfter(error);
			const retryMs = retryAfter * 1000;

			logger.logWarning(
				`Rate limited on ${request.method}`,
				`Pausing queue for ${retryAfter}s`,
			);

			this.pausedUntil = Date.now() + retryMs;

			// Don't count rate limits against retry count
			return true;
		}

		// Check for retryable errors
		if (this.isRetryableError(error) && request.retries < request.maxRetries) {
			request.retries++;
			const backoffMs = Math.min(
				this.baseDelayMs * 2 ** (request.retries - 1),
				this.maxDelayMs,
			);

			logger.logWarning(
				`Retrying ${request.method} (attempt ${request.retries}/${request.maxRetries})`,
				`Waiting ${backoffMs}ms`,
			);

			await this.delay(backoffMs);
			return true;
		}

		return false;
	}

	/**
	 * Check if error is a rate limit response
	 */
	private isRateLimitError(error: unknown): boolean {
		if (error && typeof error === "object") {
			// Slack SDK error format
			if ("code" in error && error.code === "slack_webapi_rate_limited") {
				return true;
			}
			// HTTP status check
			if ("status" in error && error.status === 429) {
				return true;
			}
			// Message check
			if ("message" in error && typeof error.message === "string") {
				const msg = error.message.toLowerCase();
				if (msg.includes("rate limit") || msg.includes("429")) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Extract retry-after value from error (in seconds)
	 */
	private getRetryAfter(error: unknown): number {
		if (error && typeof error === "object") {
			// Slack SDK includes retryAfter
			if ("retryAfter" in error) {
				const value = (error as { retryAfter?: unknown }).retryAfter;
				if (typeof value === "number") {
					return value;
				}
				if (typeof value === "string") {
					const parsed = Number.parseFloat(value);
					if (Number.isFinite(parsed)) {
						return parsed;
					}
				}
			}
			// Check headers
			if ("headers" in error && error.headers) {
				const headers = error.headers as
					| Record<string, string>
					| { get?: (name: string) => string | null };
				const retryAfter =
					typeof headers.get === "function"
						? headers.get("retry-after")
						: headers["retry-after"] || headers["Retry-After"];
				if (retryAfter) {
					const parsed = Number.parseFloat(retryAfter);
					if (Number.isFinite(parsed)) {
						return parsed;
					}
				}
			}
		}
		// Default to 30 seconds if not specified
		return 30;
	}

	/**
	 * Check if error is retryable (network errors, 5xx, etc.)
	 */
	private isRetryableError(error: unknown): boolean {
		if (!(error instanceof Error)) return false;

		const message = error.message.toLowerCase();

		// Network errors
		if (
			message.includes("network") ||
			message.includes("econnreset") ||
			message.includes("econnrefused") ||
			message.includes("timeout") ||
			message.includes("socket hang up")
		) {
			return true;
		}

		// Server errors
		if (
			message.includes("500") ||
			message.includes("502") ||
			message.includes("503") ||
			message.includes("504")
		) {
			return true;
		}

		return false;
	}

	/**
	 * Delay helper
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Get queue statistics
	 */
	getStats(): {
		queueLength: number;
		isPaused: boolean;
		pausedUntil: number;
		totalProcessed: number;
	} {
		return {
			queueLength: this.queue.length,
			isPaused: Date.now() < this.pausedUntil,
			pausedUntil: this.pausedUntil,
			totalProcessed: this.requestCounter - this.queue.length,
		};
	}

	/**
	 * Clear the queue (reject all pending requests)
	 */
	clear(): void {
		const pending = this.queue.splice(0);
		for (const request of pending) {
			request.reject(new Error("Queue cleared"));
		}
	}
}

/**
 * Create a default API queue instance
 */
export function createApiQueue(options?: ApiQueueOptions): ApiQueue {
	return new ApiQueue(options);
}
