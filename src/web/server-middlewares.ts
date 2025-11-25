import type { IncomingMessage, ServerResponse } from "node:http";
import { parse } from "node:url";
import { isOverloaded, logRequest } from "./logger.js";
import type { Middleware } from "./middleware.js";
import type { RateLimiter } from "./rate-limiter.js";
import { authenticateRequest, sendJson } from "./server-utils.js";

export function createLoadSheddingMiddleware(
	corsHeaders: Record<string, string>,
): Middleware {
	return (req, res, next) => {
		const pathname = req.url?.split("?")[0] || "/";
		// 1. Criticality-Aware Load Shedding (Global health)
		// We prioritize /healthz, /api/metrics, and existing SSE connections
		// We drop new /api/chat requests if overloaded
		if (
			isOverloaded() &&
			pathname !== "/healthz" &&
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

export function createRateLimitMiddleware(
	rateLimiter: RateLimiter,
	corsHeaders: Record<string, string>,
): Middleware {
	return (req, res, next) => {
		const pathname = req.url?.split("?")[0] || "/";
		// 2. Rate limiting check (Per-client fairness)
		// Skip for static assets/health checks to avoid blocking legitimate browser behavior
		if (pathname.startsWith("/api")) {
			const forwarded = req.headers["x-forwarded-for"];
			const ip =
				typeof forwarded === "string"
					? forwarded.split(",")[0].trim()
					: req.socket.remoteAddress || "unknown";

			const { allowed, remaining, reset } = rateLimiter.check(ip);

			if (!allowed) {
				res.writeHead(429, {
					"Content-Type": "application/json",
					"X-RateLimit-Limit": "1000",
					"X-RateLimit-Remaining": "0",
					"X-RateLimit-Reset": Math.ceil(reset / 1000).toString(),
					"Retry-After": Math.ceil((reset - Date.now()) / 1000).toString(),
					...corsHeaders,
				});
				res.end(
					JSON.stringify({ error: "Too Many Requests: Rate limit exceeded" }),
				);
				// Log the rejection immediately as it won't go through the router
				// We need start time for logRequest, but we can approximate or pass it if needed.
				// However, logRequest expects start time.
				// For now, we'll let the outer handler handle logging on 'finish'.
				return;
			}
			// Add rate limit headers to successful responses too
			res.setHeader("X-RateLimit-Limit", "1000");
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
): Middleware {
	return (req, res, next) => {
		const pathname = req.url?.split("?")[0] || "/";
		if (pathname.startsWith("/api")) {
			if (!authenticateRequest(req, res, corsHeaders, apiKey)) {
				return;
			}
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
		const parsedUrl = parse(req.url || "/", true);
		const pathname = parsedUrl.pathname || "/";
		await routerHandler(req, res, pathname);
		// Router handles the response, so we don't call next() unless it falls through,
		// but typically router is the end.
		// If router doesn't handle it (e.g. 404), it might send response itself or return.
		// Our current router sends 404/500 itself.
	};
}
