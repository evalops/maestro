/**
 * @fileoverview HTTP Router for Composer Web Server
 *
 * This module provides a lightweight, Express-like router for handling HTTP requests
 * in the Composer web server. It supports:
 *
 * - **Path Parameters**: Dynamic route segments using `:param` syntax (e.g., `/api/sessions/:id`)
 * - **Method Matching**: Routes are matched by HTTP method (GET, POST, PUT, DELETE, etc.)
 * - **Fallback Handlers**: Optional fallback for unmatched routes (e.g., static file serving)
 * - **Error Handling**: Centralized error handling with ApiError support
 *
 * ## Route Matching Algorithm
 *
 * Routes are matched in registration order. The first route that matches both:
 * 1. The HTTP method (case-insensitive)
 * 2. The path pattern (exact match or parameter capture)
 *
 * ...will handle the request. If no route matches and a fallback is provided,
 * the fallback handler is invoked.
 *
 * ## Path Parameter Syntax
 *
 * ```
 * /api/users/:id        → { id: "123" }
 * /api/files/:path      → { path: "src/index.ts" }
 * /api/:resource/:id    → { resource: "sessions", id: "abc" }
 * ```
 *
 * ## Usage Example
 *
 * ```typescript
 * const routes: Route[] = [
 *   { method: "GET", path: "/api/status", handler: handleStatus },
 *   { method: "GET", path: "/api/sessions/:id", handler: handleGetSession },
 *   { method: "POST", path: "/api/chat", handler: handleChat },
 * ];
 *
 * const handler = createRequestHandler(routes, staticFileFallback, corsHeaders);
 * http.createServer((req, res) => handler(req, res, new URL(req.url!).pathname));
 * ```
 *
 * @module web/router
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("web:router");

/**
 * Handler function for processing HTTP requests.
 *
 * Route handlers receive the raw Node.js request/response objects plus
 * any path parameters extracted from the URL.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response object
 * @param params - Path parameters extracted from the URL (e.g., `{ id: "123" }`)
 * @returns A promise that resolves when the response is complete, or void for sync handlers
 *
 * @example
 * ```typescript
 * const handler: RouteHandler = async (req, res, params) => {
 *   const sessionId = params.id;
 *   const session = await getSession(sessionId);
 *   res.writeHead(200, { "Content-Type": "application/json" });
 *   res.end(JSON.stringify(session));
 * };
 * ```
 */
export type RouteHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	params: Record<string, string>,
) => Promise<void> | void;

/**
 * Route definition for the HTTP router.
 *
 * Each route specifies an HTTP method, a path pattern, and a handler function.
 * Path patterns can include dynamic segments using the `:param` syntax.
 *
 * @example
 * ```typescript
 * const route: Route = {
 *   method: "GET",
 *   path: "/api/sessions/:id",
 *   handler: async (req, res, params) => {
 *     // params.id contains the session ID from the URL
 *   },
 * };
 * ```
 */
export interface Route {
	/** HTTP method (GET, POST, PUT, DELETE, etc.) - case-insensitive */
	method: string;
	/** URL path pattern, may include `:param` segments for dynamic matching */
	path: string;
	/** Handler function to process matching requests */
	handler: RouteHandler;
}

/**
 * Splits a URL pathname into path segments.
 *
 * Handles edge cases like trailing slashes and root paths.
 *
 * @param pathname - The URL pathname to split
 * @returns Array of path segments (empty array for root path)
 *
 * @example
 * ```typescript
 * toSegments("/api/sessions/123")  // ["api", "sessions", "123"]
 * toSegments("/")                   // []
 * toSegments("/users/")             // ["users"]
 * ```
 *
 * @internal
 */
function toSegments(pathname: string): string[] {
	if (pathname === "/" || pathname === "") return [];
	return pathname.replace(/^\/+|\/+$/g, "").split("/");
}

/**
 * Matches a URL pathname against a route path pattern.
 *
 * Performs segment-by-segment comparison, extracting path parameters
 * from segments that start with `:`.
 *
 * @param routePath - The route path pattern (may contain `:param` segments)
 * @param pathname - The actual URL pathname to match
 * @returns Object containing match status and extracted parameters
 *
 * @example
 * ```typescript
 * matchPath("/api/sessions/:id", "/api/sessions/abc123")
 * // { matched: true, params: { id: "abc123" } }
 *
 * matchPath("/api/users/:id", "/api/sessions/abc")
 * // { matched: false, params: {} }
 * ```
 *
 * @internal
 */
function matchPath(
	routePath: string,
	pathname: string,
): { matched: boolean; params: Record<string, string> } {
	const routeSegments = toSegments(routePath);
	const pathSegments = toSegments(pathname);

	if (routeSegments.length !== pathSegments.length) {
		return { matched: false, params: {} };
	}

	const params: Record<string, string> = {};
	for (let i = 0; i < routeSegments.length; i++) {
		const routeSegment = routeSegments[i]!;
		const pathSegment = pathSegments[i]!;
		if (routeSegment.startsWith(":")) {
			params[routeSegment.slice(1)] = pathSegment;
			continue;
		}
		if (routeSegment !== pathSegment) {
			return { matched: false, params: {} };
		}
	}

	return { matched: true, params };
}

/**
 * Finds the first matching route for an HTTP request.
 *
 * Iterates through routes in registration order, returning the first
 * route that matches both the HTTP method and path pattern.
 *
 * @param method - The HTTP method (GET, POST, etc.)
 * @param pathname - The URL pathname to match
 * @param routes - Array of route definitions to search
 * @returns The matching handler and extracted params, or null if no match
 *
 * @example
 * ```typescript
 * const routes = [
 *   { method: "GET", path: "/api/status", handler: statusHandler },
 *   { method: "GET", path: "/api/sessions/:id", handler: sessionHandler },
 * ];
 *
 * const result = matchRoute("GET", "/api/sessions/abc", routes);
 * // { handler: sessionHandler, params: { id: "abc" } }
 *
 * const noMatch = matchRoute("POST", "/api/status", routes);
 * // null (method doesn't match)
 * ```
 */
export function matchRoute(
	method: string,
	pathname: string,
	routes: Route[],
): { handler: RouteHandler; params: Record<string, string> } | null {
	const targetMethod = method.toUpperCase();
	for (const route of routes) {
		if (route.method.toUpperCase() !== targetMethod) {
			continue;
		}
		const { matched, params } = matchPath(route.path, pathname);
		if (matched) {
			return { handler: route.handler, params };
		}
	}
	return null;
}

import { ApiError, respondWithApiError } from "./server-utils.js";

/**
 * Creates a request handler function that routes HTTP requests to appropriate handlers.
 *
 * This is the main entry point for the router. It returns an async function that:
 * 1. Matches the request against registered routes
 * 2. Invokes the matching handler with extracted path parameters
 * 3. Falls back to a fallback handler if no route matches
 * 4. Handles errors gracefully with proper logging and sanitized responses
 *
 * ## Error Handling
 *
 * - All handler errors are logged with path and method context
 * - `ApiError` instances are sent to the client with their status code
 * - Other errors are sanitized to "Internal server error" for security
 * - If headers are already sent (e.g., during streaming), errors are logged but not re-sent
 *
 * @param routes - Array of route definitions to match against
 * @param fallback - Optional handler for unmatched routes (e.g., static file serving)
 * @param corsHeaders - CORS headers to include in error responses
 * @returns An async request handler function for use with Node.js HTTP server
 *
 * @example
 * ```typescript
 * const routes: Route[] = [
 *   { method: "GET", path: "/api/health", handler: healthCheck },
 *   { method: "POST", path: "/api/chat", handler: handleChat },
 * ];
 *
 * const handler = createRequestHandler(
 *   routes,
 *   serveStaticFiles,
 *   { "Access-Control-Allow-Origin": "*" }
 * );
 *
 * const server = http.createServer(async (req, res) => {
 *   const url = new URL(req.url!, `http://${req.headers.host}`);
 *   await handler(req, res, url.pathname);
 * });
 * ```
 */
export function createRequestHandler(
	routes: Route[],
	fallback?: (
		req: IncomingMessage,
		res: ServerResponse,
		pathname: string,
	) => Promise<void> | void,
	corsHeaders: Record<string, string> = {},
) {
	return async (
		req: IncomingMessage,
		res: ServerResponse,
		pathname: string,
	) => {
		try {
			const match = matchRoute(req.method || "GET", pathname, routes);
			if (match) {
				await match.handler(req, res, match.params);
				return;
			}
			if (fallback) {
				await fallback(req, res, pathname);
			}
		} catch (error) {
			// Always log router-level errors; streaming handlers may have sent headers already.
			logger.error("Router error", error instanceof Error ? error : undefined, {
				path: pathname,
				method: req.method,
			});
			if (res.headersSent || res.writableEnded) return;
			if (error instanceof ApiError) {
				respondWithApiError(res, error, 500, corsHeaders, req);
				return;
			}
			// Sanitize unexpected errors for clients while keeping server-side log above.
			respondWithApiError(
				res,
				new ApiError(500, "Internal server error"),
				500,
				corsHeaders,
				req,
			);
		}
	};
}
