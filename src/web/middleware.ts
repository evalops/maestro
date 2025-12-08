/**
 * @fileoverview HTTP Middleware Composition Utilities
 *
 * This module provides middleware types and a Koa-style composition function
 * for building HTTP request pipelines. Middleware functions can perform
 * pre-processing, post-processing, or early termination of requests.
 *
 * ## Middleware Pattern
 *
 * Each middleware receives the request, response, and a `next` function.
 * Calling `next()` passes control to the next middleware in the chain.
 * Not calling `next()` terminates the chain (useful for auth failures, etc.).
 *
 * ## Execution Order
 *
 * Middlewares execute in a "stack" pattern:
 * 1. Pre-processing runs top-to-bottom
 * 2. The final handler executes
 * 3. Post-processing runs bottom-to-top
 *
 * ```
 * compose([logRequest, authenticate, handleRequest])
 *
 * Request →  logRequest (pre)
 *         →  authenticate (pre)
 *         →  handleRequest (handler)
 *         ←  authenticate (post)
 *         ←  logRequest (post)
 * Response ←
 * ```
 *
 * ## Error Handling
 *
 * Errors thrown in any middleware will propagate up the chain.
 * Use try/catch in middleware for custom error handling.
 *
 * @module web/middleware
 *
 * @example
 * ```typescript
 * import { compose, type Middleware } from "./middleware.js";
 *
 * const logRequest: Middleware = async (req, res, next) => {
 *   console.log(`${req.method} ${req.url}`);
 *   await next();
 *   console.log(`Response: ${res.statusCode}`);
 * };
 *
 * const authenticate: Middleware = async (req, res, next) => {
 *   if (!req.headers.authorization) {
 *     res.writeHead(401);
 *     res.end("Unauthorized");
 *     return; // Don't call next() - terminates chain
 *   }
 *   await next();
 * };
 *
 * const handler = compose([logRequest, authenticate, myHandler]);
 * ```
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Callback function to pass control to the next middleware.
 *
 * Calling `next()` invokes the next middleware in the chain.
 * Not calling `next()` terminates the middleware chain early.
 *
 * @returns Promise that resolves when downstream middlewares complete
 */
export type NextFunction = () => Promise<void> | void;

/**
 * HTTP middleware function signature.
 *
 * Middlewares can:
 * - Modify the request before passing downstream
 * - Terminate the chain early (don't call `next()`)
 * - Modify the response after downstream completes
 * - Handle errors from downstream middlewares
 *
 * @param req - The incoming HTTP request
 * @param res - The server response object
 * @param next - Function to invoke the next middleware
 */
export type Middleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: NextFunction,
) => Promise<void> | void;

/**
 * Composes multiple middlewares into a single middleware function.
 *
 * Creates a Koa-style middleware pipeline where each middleware can
 * perform pre-processing, call `next()` to invoke downstream handlers,
 * and then perform post-processing.
 *
 * @param middlewares - Array of middleware functions to compose
 * @returns A single middleware function that executes the entire chain
 * @throws Error if `next()` is called multiple times in a middleware
 *
 * @example
 * ```typescript
 * const pipeline = compose([
 *   corsMiddleware,
 *   authMiddleware,
 *   rateLimitMiddleware,
 * ]);
 *
 * // Use with HTTP server
 * const server = http.createServer(async (req, res) => {
 *   await pipeline(req, res, () => {
 *     // Final handler
 *     res.end("Hello World");
 *   });
 * });
 * ```
 */
export function compose(middlewares: Middleware[]): Middleware {
	return async (req, res, next) => {
		let index = -1;
		async function dispatch(i: number): Promise<void> {
			if (i <= index) {
				throw new Error("next() called multiple times");
			}
			index = i;
			let fn = middlewares[i];
			if (i === middlewares.length) {
				fn = next;
			}
			if (!fn) return;
			await fn(req, res, () => dispatch(i + 1));
		}
		return dispatch(0);
	};
}
