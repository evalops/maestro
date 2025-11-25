import type { IncomingMessage, ServerResponse } from "node:http";

export type NextFunction = () => Promise<void> | void;

export type Middleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: NextFunction,
) => Promise<void> | void;

/**
 * Composes multiple middlewares into a single middleware.
 * Use this to build a pipeline of handlers.
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
