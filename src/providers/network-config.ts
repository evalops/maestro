/**
 * Per-provider network configuration.
 *
 * Allows configuring timeouts, retries, and backoff strategies per provider.
 *
 * Configuration via environment variables:
 *   COMPOSER_PROVIDER_TIMEOUT_MS - Global request timeout (default: 120000)
 *   COMPOSER_PROVIDER_MAX_RETRIES - Global max retries (default: 3)
 *   COMPOSER_STREAM_IDLE_TIMEOUT_MS - Stream idle timeout (default: 300000)
 *
 * Or via ~/.composer/providers.json:
 * {
 *   "anthropic": { "timeout": 120000, "maxRetries": 3, "streamIdleTimeout": 300000 },
 *   "openai": { "timeout": 60000, "maxRetries": 5 }
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../agent/types.js";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import { parseRetryAfter } from "../utils/retry.js";

const logger = createLogger("providers:network");

export interface ProviderNetworkConfig {
	/** Request timeout in milliseconds (default: 120000) */
	timeout: number;
	/** Maximum retry attempts for failed requests (default: 3) */
	maxRetries: number;
	/** Maximum retries for dropped streams (default: 5) */
	streamMaxRetries: number;
	/** Idle timeout for streaming responses in milliseconds (default: 300000) */
	streamIdleTimeout: number;
	/** Initial backoff delay in milliseconds (default: 1000) */
	backoffInitial: number;
	/** Maximum backoff delay in milliseconds (default: 30000) */
	backoffMax: number;
	/** Backoff multiplier (default: 2) */
	backoffMultiplier: number;
}

/**
 * Proxy configuration for network requests.
 */
export interface ProxyConfig {
	/** HTTP proxy URL (e.g., http://proxy.example.com:8080) */
	http?: string;
	/** HTTPS proxy URL */
	https?: string;
	/** SOCKS proxy URL (e.g., socks5://proxy.example.com:1080) */
	socks?: string;
	/** Hosts to bypass proxy (comma-separated list) */
	noProxy?: string[];
}

/**
 * Get proxy configuration from environment variables.
 *
 * Checks COMPOSER_* variables first, then standard HTTP_PROXY/HTTPS_PROXY.
 * Supports HTTP, HTTPS, and SOCKS proxies.
 */
export function getProxyConfig(): ProxyConfig {
	const config: ProxyConfig = {};

	// Check COMPOSER_* vars first, then standard vars
	const httpProxy =
		process.env.COMPOSER_HTTP_PROXY ||
		process.env.HTTP_PROXY ||
		process.env.http_proxy;
	if (httpProxy) config.http = httpProxy;

	const httpsProxy =
		process.env.COMPOSER_HTTPS_PROXY ||
		process.env.HTTPS_PROXY ||
		process.env.https_proxy;
	if (httpsProxy) config.https = httpsProxy;

	const socksProxy = process.env.COMPOSER_SOCKS_PROXY;
	if (socksProxy) config.socks = socksProxy;

	const noProxy =
		process.env.COMPOSER_NO_PROXY ||
		process.env.NO_PROXY ||
		process.env.no_proxy;
	if (noProxy) {
		config.noProxy = noProxy
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}

	return config;
}

/**
 * Check if a URL should bypass the proxy.
 */
export function shouldBypassProxy(url: string, config: ProxyConfig): boolean {
	if (!config.noProxy || config.noProxy.length === 0) {
		return false;
	}

	try {
		const parsedUrl = new URL(url);
		const hostname = parsedUrl.hostname.toLowerCase();

		for (const pattern of config.noProxy) {
			const p = pattern.toLowerCase();

			// Exact match
			if (hostname === p) return true;

			// Wildcard match (*.example.com or .example.com)
			if (p.startsWith("*.")) {
				const suffix = p.slice(1); // .example.com
				if (hostname.endsWith(suffix)) return true;
			} else if (p.startsWith(".")) {
				if (hostname.endsWith(p) || hostname === p.slice(1)) return true;
			}

			// IP/CIDR match (simplified - just exact IP match)
			if (hostname === p) return true;
		}
	} catch {
		// Invalid URL, don't bypass
	}

	return false;
}

const DEFAULT_CONFIG: ProviderNetworkConfig = {
	timeout: 120_000,
	maxRetries: 3,
	streamMaxRetries: 5,
	streamIdleTimeout: 300_000,
	backoffInitial: 1_000,
	backoffMax: 30_000,
	backoffMultiplier: 2,
};

let configCache: Map<string, ProviderNetworkConfig> | null = null;
let globalOverrides: Partial<ProviderNetworkConfig> | null = null;

/**
 * Load global overrides from environment variables.
 */
function loadGlobalOverrides(): Partial<ProviderNetworkConfig> {
	if (globalOverrides) return globalOverrides;

	globalOverrides = {};

	const timeout = process.env.COMPOSER_PROVIDER_TIMEOUT_MS;
	if (timeout) {
		const parsed = Number.parseInt(timeout, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			globalOverrides.timeout = parsed;
		}
	}

	const maxRetries = process.env.COMPOSER_PROVIDER_MAX_RETRIES;
	if (maxRetries) {
		const parsed = Number.parseInt(maxRetries, 10);
		if (!Number.isNaN(parsed) && parsed >= 0) {
			globalOverrides.maxRetries = parsed;
		}
	}

	const streamMaxRetries = process.env.COMPOSER_STREAM_MAX_RETRIES;
	if (streamMaxRetries) {
		const parsed = Number.parseInt(streamMaxRetries, 10);
		if (!Number.isNaN(parsed) && parsed >= 0) {
			globalOverrides.streamMaxRetries = parsed;
		}
	}

	const streamIdleTimeout = process.env.COMPOSER_STREAM_IDLE_TIMEOUT_MS;
	if (streamIdleTimeout) {
		const parsed = Number.parseInt(streamIdleTimeout, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			globalOverrides.streamIdleTimeout = parsed;
		}
	}

	return globalOverrides;
}

/**
 * Load per-provider configs from ~/.composer/providers.json
 */
function loadProviderConfigs(): Map<string, Partial<ProviderNetworkConfig>> {
	const configs = new Map<string, Partial<ProviderNetworkConfig>>();

	const configPath = join(PATHS.COMPOSER_HOME, "providers.json");
	if (!existsSync(configPath)) {
		return configs;
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(content);

		for (const [provider, config] of Object.entries(parsed)) {
			if (typeof config !== "object" || config === null) continue;

			const providerConfig: Partial<ProviderNetworkConfig> = {};
			const c = config as Record<string, unknown>;

			if (typeof c.timeout === "number") providerConfig.timeout = c.timeout;
			if (typeof c.maxRetries === "number")
				providerConfig.maxRetries = c.maxRetries;
			if (typeof c.streamMaxRetries === "number")
				providerConfig.streamMaxRetries = c.streamMaxRetries;
			if (typeof c.streamIdleTimeout === "number")
				providerConfig.streamIdleTimeout = c.streamIdleTimeout;
			if (typeof c.backoffInitial === "number")
				providerConfig.backoffInitial = c.backoffInitial;
			if (typeof c.backoffMax === "number")
				providerConfig.backoffMax = c.backoffMax;
			if (typeof c.backoffMultiplier === "number")
				providerConfig.backoffMultiplier = c.backoffMultiplier;

			if (Object.keys(providerConfig).length > 0) {
				configs.set(provider.toLowerCase(), providerConfig);
			}
		}
	} catch (error) {
		logger.warn("Failed to parse providers.json", { error });
	}

	return configs;
}

/**
 * Get network configuration for a provider.
 * Merges: defaults → global env overrides → per-provider config
 */
export function getProviderNetworkConfig(
	provider: Provider,
): ProviderNetworkConfig {
	if (!configCache) {
		configCache = new Map();
	}

	const providerKey = provider.toLowerCase();
	const cached = configCache.get(providerKey);
	if (cached) return cached;

	const globalOvr = loadGlobalOverrides();
	const providerConfigs = loadProviderConfigs();
	const providerOvr = providerConfigs.get(providerKey) ?? {};

	const config: ProviderNetworkConfig = {
		...DEFAULT_CONFIG,
		...globalOvr,
		...providerOvr,
	};

	configCache.set(providerKey, config);
	return config;
}

/**
 * Clear cached configuration (useful for testing).
 */
export function clearNetworkConfigCache(): void {
	configCache = null;
	globalOverrides = null;
}

/**
 * Calculate backoff delay for a given attempt.
 */
export function calculateBackoff(
	attempt: number,
	config: ProviderNetworkConfig,
): number {
	const delay = config.backoffInitial * config.backoffMultiplier ** attempt;
	return Math.min(delay, config.backoffMax);
}

/**
 * Check if an error is retryable.
 */
export function isRetryableError(error: unknown): boolean {
	if (error instanceof Error) {
		if (error.name === "AbortError") {
			return true;
		}
		const message = error.message.toLowerCase();
		// Network errors
		if (
			message.includes("network") ||
			message.includes("econnreset") ||
			message.includes("etimedout") ||
			message.includes("econnrefused") ||
			message.includes("socket hang up") ||
			message.includes("fetch failed")
		) {
			return true;
		}
	}

	return false;
}

/**
 * Check if an HTTP status code is retryable.
 */
export function isRetryableStatus(status: number): boolean {
	// 429 Too Many Requests
	// 500 Internal Server Error
	// 502 Bad Gateway
	// 503 Service Unavailable
	// 504 Gateway Timeout
	return status === 429 || status >= 500;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a fetch operation with exponential backoff.
 */
export async function fetchWithRetry(
	url: string,
	options: RequestInit,
	provider: Provider,
): Promise<Response> {
	const config = getProviderNetworkConfig(provider);
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), config.timeout);

			const fetchOptions: RequestInit = {
				...options,
				signal: options.signal
					? // Combine with existing signal
						anySignal([options.signal, controller.signal])
					: controller.signal,
			};

			try {
				const response = await fetch(url, fetchOptions);
				clearTimeout(timeoutId);

				if (response.ok || !isRetryableStatus(response.status)) {
					return response;
				}

				// Retryable status code
				if (attempt < config.maxRetries) {
					const retryAfterDelay = parseRetryAfter(
						Object.fromEntries(response.headers.entries()),
					);
					const delay = retryAfterDelay ?? calculateBackoff(attempt, config);

					logger.debug("Retrying request after status", {
						status: response.status,
						attempt: attempt + 1,
						delay,
					});

					await sleep(delay);
					continue;
				}

				return response;
			} finally {
				clearTimeout(timeoutId);
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (
				error instanceof Error &&
				error.name === "AbortError" &&
				options.signal?.aborted
			) {
				// User-initiated abort, don't retry
				throw error;
			}

			if (attempt < config.maxRetries && isRetryableError(error)) {
				const delay = calculateBackoff(attempt, config);
				logger.debug("Retrying request after error", {
					error: lastError.message,
					attempt: attempt + 1,
					delay,
				});
				await sleep(delay);
				continue;
			}

			throw error;
		}
	}

	throw lastError ?? new Error("Request failed after retries");
}

/**
 * Combine multiple AbortSignals into one.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();

	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			return controller.signal;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), {
			once: true,
		});
	}

	return controller.signal;
}
