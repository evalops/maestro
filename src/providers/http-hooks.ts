/**
 * HTTP Hooks for LLM Provider Interception
 *
 * Provides hooks for intercepting HTTP requests/responses to LLM providers.
 * Useful for:
 * - Debugging and logging API calls
 * - Adding custom headers (authentication, tracing)
 * - Request cancellation
 * - Response monitoring and metrics
 *
 * ## Usage
 *
 * ```typescript
 * import { httpHooks } from "./http-hooks.js";
 *
 * // Register a request hook
 * httpHooks.on("http_request", async (event) => {
 *   console.log(`→ ${event.method} ${event.url}`);
 *   // Optionally return headers to add/override
 *   return { headers: { "X-Request-ID": crypto.randomUUID() } };
 * });
 *
 * // Register a response hook
 * httpHooks.on("http_response", async (event) => {
 *   console.log(`← ${event.status} (${event.durationMs}ms)`);
 * });
 * ```
 *
 * ## Security
 *
 * Sensitive headers are automatically redacted:
 * - authorization, x-api-key, api-key
 * - anthropic-api-key, x-goog-api-key
 * - Any header containing: auth, token, key, secret, cookie
 */

import type { Provider } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("providers:http-hooks");

/**
 * HTTP request event fired before each request.
 */
export interface HttpRequestEvent {
	/** Provider making the request */
	provider: Provider;
	/** Model ID (if available) */
	modelId?: string;
	/** Request URL */
	url: string;
	/** HTTP method */
	method: string;
	/** Request headers (sensitive values redacted) */
	headers: Record<string, string>;
	/** Request body (if JSON, parsed; otherwise string or undefined) */
	body?: unknown;
	/** Timestamp when request started */
	timestamp: number;
	/** Unique request ID for correlation */
	requestId: string;
}

/**
 * Result from a request hook handler.
 */
export interface HttpRequestHookResult {
	/** Additional headers to add/override */
	headers?: Record<string, string>;
	/** Set to true to cancel the request */
	cancel?: boolean;
	/** Reason for cancellation (for logging) */
	cancelReason?: string;
}

/**
 * HTTP response event fired after each response.
 */
export interface HttpResponseEvent {
	/** Provider that made the request */
	provider: Provider;
	/** Model ID (if available) */
	modelId?: string;
	/** Request URL */
	url: string;
	/** HTTP status code */
	status: number;
	/** Response headers (sensitive values redacted) */
	headers: Record<string, string>;
	/** Duration in milliseconds */
	durationMs: number;
	/** Timestamp when response received */
	timestamp: number;
	/** Unique request ID for correlation */
	requestId: string;
	/** Whether request was successful (2xx) */
	success: boolean;
	/** Error message if request failed */
	error?: string;
}

export type HttpRequestHandler = (
	event: HttpRequestEvent,
) => Promise<HttpRequestHookResult | void> | HttpRequestHookResult | void;

export type HttpResponseHandler = (
	event: HttpResponseEvent,
) => Promise<void> | void;

/**
 * Headers that are always redacted (exact match, case-insensitive).
 */
const SENSITIVE_HEADERS_EXACT = new Set([
	"authorization",
	"x-api-key",
	"api-key",
	"x-goog-api-key",
	"anthropic-api-key",
	"proxy-authorization",
	"cookie",
	"set-cookie",
]);

/**
 * Header substrings that trigger redaction (case-insensitive).
 */
const SENSITIVE_HEADER_PATTERNS = ["auth", "token", "key", "secret", "cookie"];

/**
 * Check if a header name is sensitive and should be redacted.
 */
function isSensitiveHeader(name: string): boolean {
	const lower = name.toLowerCase();
	if (SENSITIVE_HEADERS_EXACT.has(lower)) {
		return true;
	}
	return SENSITIVE_HEADER_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Redact sensitive headers from a headers object.
 */
export function redactHeaders(
	headers: Record<string, string>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		result[key] = isSensitiveHeader(key) ? "[REDACTED]" : value;
	}
	return result;
}

/**
 * Generate a unique request ID.
 */
function generateRequestId(): string {
	return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * HTTP hooks manager for LLM provider interception.
 */
class HttpHooksManager {
	private requestHandlers: HttpRequestHandler[] = [];
	private responseHandlers: HttpResponseHandler[] = [];
	private enabled = true;

	/**
	 * Register a hook handler.
	 */
	on(event: "http_request", handler: HttpRequestHandler): () => void;
	on(event: "http_response", handler: HttpResponseHandler): () => void;
	on(
		event: "http_request" | "http_response",
		handler: HttpRequestHandler | HttpResponseHandler,
	): () => void {
		if (event === "http_request") {
			this.requestHandlers.push(handler as HttpRequestHandler);
			return () => {
				const idx = this.requestHandlers.indexOf(handler as HttpRequestHandler);
				if (idx >= 0) this.requestHandlers.splice(idx, 1);
			};
		} else {
			this.responseHandlers.push(handler as HttpResponseHandler);
			return () => {
				const idx = this.responseHandlers.indexOf(
					handler as HttpResponseHandler,
				);
				if (idx >= 0) this.responseHandlers.splice(idx, 1);
			};
		}
	}

	/**
	 * Remove all handlers.
	 */
	clear(): void {
		this.requestHandlers = [];
		this.responseHandlers = [];
	}

	/**
	 * Enable or disable hooks.
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/**
	 * Check if hooks are enabled.
	 */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Fire request hooks before making a request.
	 *
	 * @returns Combined result with additional headers and cancel flag
	 */
	async fireRequestHooks(
		provider: Provider,
		url: string,
		options: RequestInit,
		modelId?: string,
	): Promise<{
		requestId: string;
		additionalHeaders: Record<string, string>;
		cancel: boolean;
		cancelReason?: string;
	}> {
		const requestId = generateRequestId();

		if (!this.enabled || this.requestHandlers.length === 0) {
			return { requestId, additionalHeaders: {}, cancel: false };
		}

		const headers: Record<string, string> = {};
		if (options.headers) {
			if (options.headers instanceof Headers) {
				options.headers.forEach((value, key) => {
					headers[key] = value;
				});
			} else if (Array.isArray(options.headers)) {
				for (const [key, value] of options.headers) {
					headers[key] = value;
				}
			} else {
				Object.assign(headers, options.headers);
			}
		}

		let body: unknown;
		if (typeof options.body === "string") {
			try {
				body = JSON.parse(options.body);
			} catch {
				body = options.body;
			}
		}

		const event: HttpRequestEvent = {
			provider,
			modelId,
			url,
			method: options.method || "GET",
			headers: redactHeaders(headers),
			body,
			timestamp: Date.now(),
			requestId,
		};

		const additionalHeaders: Record<string, string> = {};
		let cancel = false;
		let cancelReason: string | undefined;

		for (const handler of this.requestHandlers) {
			try {
				const result = await handler(event);
				if (result) {
					if (result.headers) {
						Object.assign(additionalHeaders, result.headers);
					}
					if (result.cancel) {
						cancel = true;
						cancelReason = result.cancelReason;
						break;
					}
				}
			} catch (error) {
				logger.warn("Request hook handler error", {
					error: error instanceof Error ? error.message : String(error),
					requestId,
				});
			}
		}

		return { requestId, additionalHeaders, cancel, cancelReason };
	}

	/**
	 * Fire response hooks after receiving a response.
	 */
	async fireResponseHooks(
		provider: Provider,
		url: string,
		response: Response | null,
		startTime: number,
		requestId: string,
		modelId?: string,
		error?: Error,
	): Promise<void> {
		if (!this.enabled || this.responseHandlers.length === 0) {
			return;
		}

		const headers: Record<string, string> = {};
		if (response?.headers) {
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});
		}

		const event: HttpResponseEvent = {
			provider,
			modelId,
			url,
			status: response?.status ?? 0,
			headers: redactHeaders(headers),
			durationMs: Date.now() - startTime,
			timestamp: Date.now(),
			requestId,
			success: response ? response.ok : false,
			error: error?.message,
		};

		for (const handler of this.responseHandlers) {
			try {
				await handler(event);
			} catch (err) {
				logger.warn("Response hook handler error", {
					error: err instanceof Error ? err.message : String(err),
					requestId,
				});
			}
		}
	}
}

/**
 * Global HTTP hooks manager instance.
 */
export const httpHooks = new HttpHooksManager();

/**
 * Error thrown when a request is cancelled by a hook.
 */
export class HttpHookCancelledError extends Error {
	constructor(
		public readonly reason?: string,
		public readonly requestId?: string,
	) {
		super(reason ? `Request cancelled: ${reason}` : "Request cancelled by hook");
		this.name = "HttpHookCancelledError";
	}
}
