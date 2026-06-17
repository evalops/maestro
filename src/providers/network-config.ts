/**
 * Per-provider network configuration.
 *
 * Allows configuring timeouts, retries, and backoff strategies per provider.
 *
 * Configuration via environment variables:
 *   MAESTRO_PROVIDER_TIMEOUT_MS - Global request timeout (default: 120000)
 *   MAESTRO_PROVIDER_MAX_RETRIES - Global max retries (default: 3)
 *   MAESTRO_STREAM_IDLE_TIMEOUT_MS - Stream idle timeout (default: 300000)
 *
 * Or via ~/.maestro/providers.json:
 * {
 *   "anthropic": { "timeout": 120000, "maxRetries": 3, "streamIdleTimeout": 300000 },
 *   "openai": { "timeout": 60000, "maxRetries": 5 }
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { isIP as netIsIP } from "node:net";
import { join } from "node:path";
import { Agent } from "undici";
import type { Provider } from "../agent/types.js";
import { PATHS } from "../config/constants.js";
import { getMergedCustomModelUrlPolicyConfig } from "../models/config-loader.js";
import {
	type ModelRequestUrlPolicyCheck,
	checkModelRequestUrlPolicy,
	recordCustomModelUrlPolicyBlock,
} from "../models/url-policy.js";
import { createLogger } from "../utils/logger.js";
import { parseRetryAfter } from "../utils/retry.js";
import { HttpHookCancelledError, httpHooks } from "./http-hooks.js";

// Re-export for consumers
export { httpHooks, HttpHookCancelledError } from "./http-hooks.js";

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
 * Checks MAESTRO_* variables first, then standard HTTP_PROXY/HTTPS_PROXY.
 * Supports HTTP, HTTPS, and SOCKS proxies.
 */
export function getProxyConfig(): ProxyConfig {
	const config: ProxyConfig = {};

	// Check MAESTRO_* vars first, then standard vars
	const httpProxy =
		process.env.MAESTRO_HTTP_PROXY ||
		process.env.HTTP_PROXY ||
		process.env.http_proxy;
	if (httpProxy) config.http = httpProxy;

	const httpsProxy =
		process.env.MAESTRO_HTTPS_PROXY ||
		process.env.HTTPS_PROXY ||
		process.env.https_proxy;
	if (httpsProxy) config.https = httpsProxy;

	const socksProxy = process.env.MAESTRO_SOCKS_PROXY;
	if (socksProxy) config.socks = socksProxy;

	const noProxy =
		process.env.MAESTRO_NO_PROXY ||
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

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type NormalizedFetchInit = NonNullable<FetchInit>;
type CloseableDispatcher = Agent;
type LookupAddress = { address: string; family: 4 | 6 };
type PinnedLookupOptions = { all?: boolean; family?: number | "IPv4" | "IPv6" };
type PinnedLookupCallback = (
	error: NodeJS.ErrnoException | null,
	address: string | LookupAddress[],
	family?: 4 | 6,
) => void;

function normalizeLookupHostname(hostname: string): string {
	return hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/u, "");
}

function toLookupAddress(address: string): LookupAddress | null {
	const family = netIsIP(address);
	if (family !== 4 && family !== 6) {
		return null;
	}
	return { address, family };
}

function createPinnedDnsLookup(hostname: string, resolvedAddresses: string[]) {
	const normalizedHostname = normalizeLookupHostname(hostname);
	const pinnedAddresses = resolvedAddresses
		.map(normalizeLookupHostname)
		.map(toLookupAddress)
		.filter((address): address is LookupAddress => address !== null);

	if (pinnedAddresses.length === 0) {
		return undefined;
	}

	return (
		lookupHostname: string,
		options: PinnedLookupOptions,
		callback: PinnedLookupCallback,
	) => {
		if (normalizeLookupHostname(lookupHostname) !== normalizedHostname) {
			const error = new Error(
				`Refusing DNS lookup for unexpected model request host: ${lookupHostname}`,
			) as NodeJS.ErrnoException;
			error.code = "ERR_DNS_PINNED_HOST_MISMATCH";
			callback(error, []);
			return;
		}

		if (options.all) {
			callback(null, pinnedAddresses);
			return;
		}

		const preferredFamily =
			options.family === 4 || options.family === "IPv4"
				? 4
				: options.family === 6 || options.family === "IPv6"
					? 6
					: undefined;
		const selected =
			pinnedAddresses.find(
				(address) =>
					preferredFamily === undefined || address.family === preferredFamily,
			) ?? pinnedAddresses[0];
		if (!selected) {
			const error = new Error(
				`No pinned DNS address available for ${hostname}`,
			) as NodeJS.ErrnoException;
			error.code = "ERR_DNS_PINNED_ADDRESS_UNAVAILABLE";
			callback(error, []);
			return;
		}
		callback(null, selected.address, selected.family);
	};
}

function createPinnedModelRequestDispatcher(
	url: string,
	urlPolicy: ModelRequestUrlPolicyCheck,
): CloseableDispatcher | undefined {
	if (!urlPolicy.allowed || urlPolicy.resolvedAddresses.length === 0) {
		return undefined;
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}

	const hostname = urlPolicy.hostname ?? parsed.hostname;
	if (netIsIP(normalizeLookupHostname(hostname)) !== 0) {
		return undefined;
	}

	const lookup = createPinnedDnsLookup(hostname, urlPolicy.resolvedAddresses);
	if (!lookup) {
		return undefined;
	}

	return new Agent({
		connect: { lookup },
	});
}

function requestUrlFromFetchInput(input: FetchInput): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

interface ModelRequestRedirectOptions {
	allowInternalBaseUrl?: boolean;
	internalBaseUrl?: string | URL;
	maxRedirects?: number;
	policy?: ReturnType<typeof getMergedCustomModelUrlPolicyConfig>;
}

const MAX_MODEL_REQUEST_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_BODY_HEADER_NAMES = [
	"content-encoding",
	"content-language",
	"content-length",
	"content-location",
	"content-type",
];

function shouldRewriteModelRequestMethodOnRedirect(
	method: string | undefined,
	status: number,
): boolean {
	const normalizedMethod = (method ?? "GET").toUpperCase();
	return (
		status === 303 ||
		((status === 301 || status === 302) && normalizedMethod === "POST")
	);
}

function updateModelRequestInitForRedirect(
	init: FetchInit,
	status: number,
): NormalizedFetchInit {
	const requestInit = init ?? {};
	if (!shouldRewriteModelRequestMethodOnRedirect(requestInit.method, status)) {
		return { ...requestInit };
	}

	const headers = new Headers(requestInit.headers);
	for (const headerName of REQUEST_BODY_HEADER_NAMES) {
		headers.delete(headerName);
	}

	return {
		...requestInit,
		method: "GET",
		body: undefined,
		headers,
	};
}

/**
 * Fetch using the DNS addresses already approved by checkModelRequestUrlPolicy.
 * This prevents a second DNS lookup from rebinding the model request after the
 * policy check but before the connection is opened.
 */
export async function fetchWithPinnedModelRequestDns(
	input: FetchInput,
	init: FetchInit,
	urlPolicy: ModelRequestUrlPolicyCheck,
): Promise<Response> {
	const dispatcher = createPinnedModelRequestDispatcher(
		requestUrlFromFetchInput(input),
		urlPolicy,
	);
	const fetchInit: NormalizedFetchInit = {
		...(init ?? {}),
		redirect: "manual",
	};
	if (dispatcher) {
		fetchInit.dispatcher =
			dispatcher as unknown as NormalizedFetchInit["dispatcher"];
	}

	try {
		return await fetch(input, fetchInit);
	} finally {
		if (dispatcher) {
			void dispatcher.close().catch((error) => {
				logger.debug("Failed to close model request DNS dispatcher", {
					error,
				});
			});
		}
	}
}

export async function fetchWithModelRequestPolicyRedirects(
	url: string,
	init: FetchInit,
	urlPolicy: ModelRequestUrlPolicyCheck,
	options: ModelRequestRedirectOptions = {},
): Promise<Response> {
	const redirectMode = init?.redirect ?? "follow";
	let currentUrl = url;
	let currentInit: NormalizedFetchInit = { ...(init ?? {}) };
	let currentPolicy = urlPolicy;
	const maxRedirects = options.maxRedirects ?? MAX_MODEL_REQUEST_REDIRECTS;

	for (let redirectCount = 0; ; redirectCount += 1) {
		const response = await fetchWithPinnedModelRequestDns(
			currentUrl,
			{ ...currentInit, redirect: "manual" },
			currentPolicy,
		);
		if (!REDIRECT_STATUSES.has(response.status)) {
			return response;
		}
		if (redirectMode === "manual") {
			return response;
		}
		if (redirectMode === "error") {
			await response.body?.cancel();
			throw new TypeError("fetch failed");
		}
		if (redirectCount >= maxRedirects) {
			await response.body?.cancel();
			throw new Error(
				`Model request redirected more than ${maxRedirects} times`,
			);
		}

		const location = response.headers.get("location");
		if (!location) {
			return response;
		}

		const nextUrl = new URL(location, currentUrl).toString();
		await response.body?.cancel();

		const nextPolicy = await checkModelRequestUrlPolicy(nextUrl, {
			allowInternalBaseUrl: options.allowInternalBaseUrl,
			internalBaseUrl: options.internalBaseUrl,
			policy: options.policy,
		});
		if (!nextPolicy.allowed) {
			throw new Error(
				`Model request blocked by URL policy: ${nextPolicy.reason ?? "unknown_reason"}`,
			);
		}

		currentUrl = nextUrl;
		currentInit = updateModelRequestInitForRedirect(
			currentInit,
			response.status,
		);
		currentPolicy = nextPolicy;
	}
}

/**
 * Load global overrides from environment variables.
 */
function loadGlobalOverrides(): Partial<ProviderNetworkConfig> {
	if (globalOverrides) return globalOverrides;

	globalOverrides = {};

	const timeout = process.env.MAESTRO_PROVIDER_TIMEOUT_MS;
	if (timeout) {
		const parsed = Number.parseInt(timeout, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			globalOverrides.timeout = parsed;
		}
	}

	const maxRetries = process.env.MAESTRO_PROVIDER_MAX_RETRIES;
	if (maxRetries) {
		const parsed = Number.parseInt(maxRetries, 10);
		if (!Number.isNaN(parsed) && parsed >= 0) {
			globalOverrides.maxRetries = parsed;
		}
	}

	const streamMaxRetries = process.env.MAESTRO_STREAM_MAX_RETRIES;
	if (streamMaxRetries) {
		const parsed = Number.parseInt(streamMaxRetries, 10);
		if (!Number.isNaN(parsed) && parsed >= 0) {
			globalOverrides.streamMaxRetries = parsed;
		}
	}

	const streamIdleTimeout = process.env.MAESTRO_STREAM_IDLE_TIMEOUT_MS;
	if (streamIdleTimeout) {
		const parsed = Number.parseInt(streamIdleTimeout, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			globalOverrides.streamIdleTimeout = parsed;
		}
	}

	return globalOverrides;
}

/**
 * Load per-provider configs from ~/.maestro/providers.json
 */
function loadProviderConfigs(): Map<string, Partial<ProviderNetworkConfig>> {
	const configs = new Map<string, Partial<ProviderNetworkConfig>>();

	const configPath = join(PATHS.MAESTRO_HOME, "providers.json");
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
 * Recognize a fail-closed URL-policy denial thrown by the request-time
 * `checkModelRequestUrlPolicy` guard. These never become retryable —
 * the policy decision is deterministic per URL — so the caller should
 * surface them instead of burning the retry budget.
 */
export function isModelRequestUrlPolicyError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.startsWith("Model request blocked by URL policy:")
	);
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
 * Options for fetchWithRetry.
 */
export interface FetchWithRetryOptions {
	/** Model ID for hook correlation */
	modelId?: string;
	/** Allow explicitly configured local/internal model endpoints. */
	allowInternalBaseUrl?: boolean;
	/** Configured internal model endpoint prefix allowed for this request. */
	internalBaseUrl?: string | URL;
}

/**
 * Retry a fetch operation with exponential backoff.
 *
 * Fires HTTP hooks before and after each request attempt.
 */
export async function fetchWithRetry(
	url: string,
	options: RequestInit,
	provider: Provider,
	fetchOptions?: FetchWithRetryOptions,
): Promise<Response> {
	const config = getProviderNetworkConfig(provider);
	const urlPolicyConfig = getMergedCustomModelUrlPolicyConfig();
	let lastError: Error | null = null;

	// Fire request hooks (only once, before first attempt)
	const startTime = Date.now();
	const hookResult = await httpHooks.fireRequestHooks(
		provider,
		url,
		options,
		fetchOptions?.modelId,
	);

	if (hookResult.cancel) {
		const error = new HttpHookCancelledError(
			hookResult.cancelReason,
			hookResult.requestId,
		);
		await httpHooks.fireResponseHooks(
			provider,
			url,
			null,
			startTime,
			hookResult.requestId,
			fetchOptions?.modelId,
			error,
		);
		throw error;
	}

	// Merge additional headers from hooks
	const mergedHeaders: Record<string, string> = {};
	if (options.headers) {
		if (options.headers instanceof Headers) {
			options.headers.forEach((value, key) => {
				mergedHeaders[key] = value;
			});
		} else if (Array.isArray(options.headers)) {
			for (const [key, value] of options.headers) {
				mergedHeaders[key] = value;
			}
		} else {
			Object.assign(mergedHeaders, options.headers);
		}
	}
	Object.assign(mergedHeaders, hookResult.additionalHeaders);

	const optionsWithHookHeaders: RequestInit = {
		...options,
		headers: mergedHeaders,
	};

	for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
		const attemptStartTime = Date.now();
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), config.timeout);

			const fetchOpts: RequestInit = {
				...optionsWithHookHeaders,
				signal: optionsWithHookHeaders.signal
					? // Combine with existing signal
						anySignal([optionsWithHookHeaders.signal, controller.signal])
					: controller.signal,
			};

			try {
				const urlPolicy = await checkModelRequestUrlPolicy(url, {
					allowInternalBaseUrl: fetchOptions?.allowInternalBaseUrl,
					internalBaseUrl: fetchOptions?.internalBaseUrl ?? url,
					policy: urlPolicyConfig,
				});
				if (!urlPolicy.allowed) {
					recordCustomModelUrlPolicyBlock({
						provider,
						modelId: fetchOptions?.modelId,
						reason: urlPolicy.reason,
					});
					throw new Error(
						`Model request blocked by URL policy: ${urlPolicy.reason ?? "unknown_reason"}`,
					);
				}
				const response = await fetchWithModelRequestPolicyRedirects(
					url,
					fetchOpts,
					urlPolicy,
					{
						allowInternalBaseUrl: fetchOptions?.allowInternalBaseUrl,
						internalBaseUrl: fetchOptions?.internalBaseUrl ?? url,
						policy: urlPolicyConfig,
					},
				);
				clearTimeout(timeoutId);

				if (response.ok || !isRetryableStatus(response.status)) {
					// Fire response hooks on success or non-retryable status
					await httpHooks.fireResponseHooks(
						provider,
						url,
						response,
						attemptStartTime,
						hookResult.requestId,
						fetchOptions?.modelId,
					);
					return response;
				}

				// Retryable status code
				if (attempt < config.maxRetries) {
					const retryHeaders: Record<string, string> = {};
					const retryAfter = response.headers.get("retry-after");
					const retryAfterMs = response.headers.get("retry-after-ms");
					if (retryAfter) retryHeaders["retry-after"] = retryAfter;
					if (retryAfterMs) retryHeaders["retry-after-ms"] = retryAfterMs;
					const retryAfterDelay = parseRetryAfter(retryHeaders);
					const delay = retryAfterDelay ?? calculateBackoff(attempt, config);

					logger.debug("Retrying request after status", {
						status: response.status,
						attempt: attempt + 1,
						delay,
						requestId: hookResult.requestId,
					});

					await sleep(delay);
					continue;
				}

				// Final attempt with retryable status - fire response hooks
				await httpHooks.fireResponseHooks(
					provider,
					url,
					response,
					attemptStartTime,
					hookResult.requestId,
					fetchOptions?.modelId,
				);
				return response;
			} finally {
				clearTimeout(timeoutId);
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (
				error instanceof Error &&
				error.name === "AbortError" &&
				optionsWithHookHeaders.signal?.aborted
			) {
				// User-initiated abort, fire response hooks and don't retry
				await httpHooks.fireResponseHooks(
					provider,
					url,
					null,
					attemptStartTime,
					hookResult.requestId,
					fetchOptions?.modelId,
					lastError,
				);
				throw error;
			}

			// URL policy denials are fail-closed by design: retrying just
			// re-runs the same denied check against the same URL. Throw the
			// policy error directly so the caller surfaces it instead of
			// burning the retry budget on a guaranteed-failing call.
			if (isModelRequestUrlPolicyError(error)) {
				await httpHooks.fireResponseHooks(
					provider,
					url,
					null,
					attemptStartTime,
					hookResult.requestId,
					fetchOptions?.modelId,
					lastError,
				);
				throw error;
			}

			if (attempt < config.maxRetries && isRetryableError(error)) {
				const delay = calculateBackoff(attempt, config);
				logger.debug("Retrying request after error", {
					error: lastError.message,
					attempt: attempt + 1,
					delay,
					requestId: hookResult.requestId,
				});
				await sleep(delay);
				continue;
			}

			// Final error - fire response hooks
			await httpHooks.fireResponseHooks(
				provider,
				url,
				null,
				attemptStartTime,
				hookResult.requestId,
				fetchOptions?.modelId,
				lastError,
			);
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
