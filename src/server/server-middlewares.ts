import type { IncomingMessage, ServerResponse } from "node:http";
import { parse } from "node:url";
import { createLogger } from "../utils/logger.js";
import { getArtifactAccessGrantFromRequest } from "./artifact-access.js";
import { checkApiAuth } from "./authz.js";
import { isOverloaded, logRequest } from "./logger.js";
import type { Middleware } from "./middleware.js";
import type { RateLimiter, TieredRateLimiter } from "./rate-limiter.js";
import { getRequestHeader, secureCompare, sendJson } from "./server-utils.js";

const logger = createLogger("middleware:ip-access");

// Helper for consistent safe URL parsing
function getPathname(req: IncomingMessage): string {
	try {
		// Use a dummy base for relative URLs (req.url) to ensure safe parsing
		const parsed = new URL(req.url || "/", "http://localhost");
		return parsed.pathname;
	} catch {
		return "/";
	}
}

export function createLoadSheddingMiddleware(
	corsHeaders: Record<string, string>,
): Middleware {
	return (req, res, next) => {
		const pathname = getPathname(req);
		// 1. Criticality-Aware Load Shedding (Global health)
		// We prioritize /healthz, /api/metrics, and existing SSE connections
		// We drop new /api/chat requests if overloaded
		if (
			isOverloaded() &&
			pathname !== "/healthz" &&
			pathname !== "/readyz" &&
			pathname !== "/api/metrics"
		) {
			// Drop non-critical traffic
			res.writeHead(503, {
				"Content-Type": "application/json",
				"Retry-After": "5",
				...corsHeaders,
			});
			res.end(
				JSON.stringify({ error: "Service Unavailable: Server is overloaded" }),
			);
			return;
		}
		return next();
	};
}

// Normalize IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 -> 127.0.0.1)
function normalizeIP(ip: string): string {
	if (ip.startsWith("::ffff:")) {
		return ip.substring(7);
	}
	return ip;
}

/**
 * Extract client IP from request, handling proxy headers.
 */
function getClientIp(
	req: IncomingMessage,
	trustProxy: boolean,
	trustProxyHops: number,
): string {
	let ip = req.socket.remoteAddress || "unknown";

	if (trustProxy) {
		const forwarded = req.headers["x-forwarded-for"];
		if (typeof forwarded === "string") {
			// Parse IPs and read from right-to-left to prevent spoofing
			// X-Forwarded-For format: "client, proxy1, proxy2, ..."
			// Each proxy appends its upstream IP to the right
			// trustProxyHops = number of trusted proxies between us and the internet
			// Example with CDN -> nginx -> app (2 hops):
			//   Header: "client, cdn, nginx" -> skip 2 from right -> use "client"
			const ips = forwarded
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (ips.length > 0) {
				// Skip trustProxyHops from the right to get the first untrusted IP
				const targetIndex = Math.max(0, ips.length - trustProxyHops - 1);
				ip = ips[targetIndex] || ip;
			}
		}
	}

	// Normalize IPv4-mapped IPv6 addresses for consistent rate limiting
	return normalizeIP(ip);
}

export function createRateLimitMiddleware(
	rateLimiter: RateLimiter,
	corsHeaders: Record<string, string>,
	trustProxy = false,
	trustProxyHops = 1,
): Middleware {
	return async (req, res, next) => {
		const pathname = getPathname(req);
		// Skip for static assets and critical health/metrics endpoints
		const isRateLimited =
			pathname.startsWith("/api") &&
			pathname !== "/api/metrics" &&
			pathname !== "/healthz";

		if (isRateLimited) {
			const ip = getClientIp(req, trustProxy, trustProxyHops);
			// Use async check to support Redis for distributed rate limiting
			const { allowed, remaining, reset, limit } =
				await rateLimiter.checkAsync(ip);

			if (!allowed) {
				res.writeHead(429, {
					"Content-Type": "application/json",
					"X-RateLimit-Limit": limit.toString(),
					"X-RateLimit-Remaining": "0",
					"X-RateLimit-Reset": Math.ceil(reset / 1000).toString(),
					"Retry-After": Math.ceil((reset - Date.now()) / 1000).toString(),
					...corsHeaders,
				});
				res.end(
					JSON.stringify({ error: "Too Many Requests: Rate limit exceeded" }),
				);
				return;
			}
			// Add rate limit headers to successful responses too
			res.setHeader("X-RateLimit-Limit", limit.toString());
			res.setHeader("X-RateLimit-Remaining", remaining.toString());
			res.setHeader("X-RateLimit-Reset", Math.ceil(reset / 1000).toString());
		}
		return next();
	};
}

/**
 * Create tiered rate limit middleware with per-endpoint limits.
 * Uses TieredRateLimiter for endpoint-specific rate limits.
 */
export function createTieredRateLimitMiddleware(
	rateLimiter: TieredRateLimiter,
	corsHeaders: Record<string, string>,
	trustProxy = false,
	trustProxyHops = 1,
): Middleware {
	return async (req, res, next) => {
		const pathname = getPathname(req);
		// Skip for static assets and critical health/metrics endpoints
		const isRateLimited =
			pathname.startsWith("/api") &&
			pathname !== "/api/metrics" &&
			pathname !== "/healthz";

		if (isRateLimited) {
			const ip = getClientIp(req, trustProxy, trustProxyHops);
			// Use async check to support Redis for distributed rate limiting
			const { allowed, remaining, reset, limit } = await rateLimiter.checkAsync(
				ip,
				pathname,
			);

			if (!allowed) {
				res.writeHead(429, {
					"Content-Type": "application/json",
					"X-RateLimit-Limit": limit.toString(),
					"X-RateLimit-Remaining": "0",
					"X-RateLimit-Reset": Math.ceil(reset / 1000).toString(),
					"Retry-After": Math.ceil((reset - Date.now()) / 1000).toString(),
					...corsHeaders,
				});
				res.end(
					JSON.stringify({ error: "Too Many Requests: Rate limit exceeded" }),
				);
				return;
			}
			// Add rate limit headers to successful responses too
			res.setHeader("X-RateLimit-Limit", limit.toString());
			res.setHeader("X-RateLimit-Remaining", remaining.toString());
			res.setHeader("X-RateLimit-Reset", Math.ceil(reset / 1000).toString());
		}
		return next();
	};
}

export function createCorsMiddleware(
	corsHeaders: Record<string, string>,
): Middleware {
	return (req, res, next) => {
		if (req.method === "OPTIONS") {
			res.writeHead(204, corsHeaders);
			res.end();
			return;
		}
		return next();
	};
}

export function createAuthMiddleware(
	apiKey: string | null,
	corsHeaders: Record<string, string>,
	requireApiKey = false,
): Middleware {
	return async (req, res, next) => {
		const pathname = getPathname(req);
		const requiresAuthBoundary =
			pathname.startsWith("/api") || pathname === "/debug/z";
		if (requiresAuthBoundary) {
			const missingKey = !apiKey || apiKey.length === 0;

			// No key provided
			if (missingKey) {
				if (requireApiKey) {
					sendJson(
						res,
						401,
						{
							error:
								"MAESTRO_WEB_API_KEY is required for all API requests. Set the environment variable or disable requirement explicitly with MAESTRO_WEB_REQUIRE_KEY=0 for local testing only.",
						},
						corsHeaders,
						req,
					);
					return;
				}
				// Requirement off and no key: allow through.
				const auth = await checkApiAuth(req);
				if (!auth.ok) {
					sendJson(
						res,
						401,
						{ error: auth.error || "Unauthorized" },
						corsHeaders,
						req,
					);
					return;
				}
				return next();
			}

			// Key provided: validate it.
			if (
				pathname.startsWith("/api") &&
				getArtifactAccessGrantFromRequest(req)
			) {
				return next();
			}
			const auth = await checkApiAuth(req);
			if (!auth.ok) {
				sendJson(
					res,
					401,
					{ error: auth.error || "Unauthorized" },
					corsHeaders,
					req,
				);
				return;
			}
		}
		return next();
	};
}

export function createCsrfMiddleware(
	token: string | null,
	corsHeaders: Record<string, string>,
	enabled = false,
): Middleware {
	if (!enabled || !token) {
		return (_req, _res, next) => next();
	}
	return (req, res, next) => {
		const method = (req.method || "GET").toUpperCase();
		if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
			return next();
		}
		const pathname = getPathname(req);
		if (!pathname.startsWith("/api")) {
			return next();
		}
		const value = getRequestHeader(
			req,
			"x-composer-csrf",
			"x-maestro-csrf",
			"x-csrf-token",
			"x-xsrf-token",
		);
		if (!value || !secureCompare(String(value), token)) {
			sendJson(
				res,
				403,
				{ error: "Forbidden: missing or invalid CSRF token" },
				corsHeaders,
				req,
			);
			return;
		}
		return next();
	};
}

export function createRouterMiddleware(
	routerHandler: (
		req: IncomingMessage,
		res: ServerResponse,
		pathname: string,
	) => Promise<void> | void,
): Middleware {
	return async (req, res, next) => {
		const pathname = getPathname(req);
		await routerHandler(req, res, pathname);
		// Router handles the response, so we don't call next() unless it falls through,
		// but typically router is the end.
		// If router doesn't handle it (e.g. 404), it might send response itself or return.
		// Our current router sends 404/500 itself.
	};
}

// ============================================================================
// IP ACCESS CONTROL
// ============================================================================

export interface IpAccessRule {
	/** CIDR notation (e.g., "192.168.1.0/24") or single IP */
	pattern: string;
	/** Whether this is an allow or deny rule */
	type: "allow" | "deny";
	/** Optional description */
	description?: string;
}

export interface IpAccessConfig {
	/** Default action when no rules match */
	defaultAction: "allow" | "deny";
	/** Rules evaluated in order, first match wins */
	rules: IpAccessRule[];
}

/**
 * Parse CIDR notation to IP range (IPv4 only for now)
 */
function parseCidr(cidr: string): { start: bigint; end: bigint } | null {
	const parts = cidr.split("/");
	const ip = parts[0];
	if (!ip) {
		return null;
	}
	const prefix = parts.length > 1 ? Number.parseInt(parts[1]!, 10) : 32;

	if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
		return null;
	}

	const ipParts = ip.split(".").map(Number);
	if (
		ipParts.length !== 4 ||
		ipParts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
	) {
		return null;
	}

	// Length check above guarantees these exist
	const ipNum = BigInt(
		((ipParts[0]! << 24) |
			(ipParts[1]! << 16) |
			(ipParts[2]! << 8) |
			ipParts[3]!) >>>
			0,
	);
	const mask = BigInt(0xffffffff) << BigInt(32 - prefix);
	const start = ipNum & mask;
	const end = start | (~mask & BigInt(0xffffffff));

	return { start, end };
}

/**
 * Convert IP string to numeric (IPv4)
 */
function ipToNumber(ip: string): bigint | null {
	const cleanIp = normalizeIP(ip);

	const parts = cleanIp.split(".").map(Number);
	if (
		parts.length !== 4 ||
		parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
	) {
		return null;
	}

	// Length check above guarantees these exist
	return BigInt(
		((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>>
			0,
	);
}

/**
 * Check if IP matches a pattern (CIDR or exact)
 */
function ipMatchesPattern(ip: string, pattern: string): boolean {
	const ipNum = ipToNumber(ip);
	if (ipNum === null) return false;

	const range = parseCidr(pattern);
	if (!range) {
		// Try exact match
		const patternNum = ipToNumber(pattern);
		return patternNum !== null && ipNum === patternNum;
	}

	return ipNum >= range.start && ipNum <= range.end;
}

/**
 * Check if an IP is allowed based on access rules
 */
export function checkIpAccess(
	ip: string,
	config: IpAccessConfig,
): { allowed: boolean; matchedRule?: IpAccessRule } {
	for (const rule of config.rules) {
		if (ipMatchesPattern(ip, rule.pattern)) {
			return {
				allowed: rule.type === "allow",
				matchedRule: rule,
			};
		}
	}

	return { allowed: config.defaultAction === "allow" };
}

/**
 * Create IP access control middleware.
 * getConfig is called per-request to allow dynamic config updates.
 */
export function createIpAccessMiddleware(
	getConfig: () => IpAccessConfig | null,
	corsHeaders: Record<string, string>,
	trustProxy = false,
	trustProxyHops = 1,
): Middleware {
	return (req, res, next) => {
		const config = getConfig();
		if (!config) {
			// No config means allow all
			return next();
		}

		let ip = req.socket.remoteAddress || "unknown";

		// Extract real client IP if behind proxy
		if (trustProxy) {
			const forwarded = req.headers["x-forwarded-for"];
			if (typeof forwarded === "string") {
				const ips = forwarded
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				if (ips.length > 0) {
					const targetIndex = Math.max(0, ips.length - trustProxyHops - 1);
					ip = ips[targetIndex] || ip;
				}
			}
		}

		ip = normalizeIP(ip);
		const result = checkIpAccess(ip, config);

		if (!result.allowed) {
			logger.warn("IP access denied", {
				ip,
				matchedRule: result.matchedRule?.pattern,
				description: result.matchedRule?.description,
			});

			res.writeHead(403, {
				"Content-Type": "application/json",
				...corsHeaders,
			});
			res.end(JSON.stringify({ error: "Forbidden: IP address not allowed" }));
			return;
		}

		return next();
	};
}
