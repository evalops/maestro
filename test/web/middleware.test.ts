import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
	type Middleware,
	type NextFunction,
	compose,
} from "../../src/server/middleware.js";

function makeReq(): IncomingMessage {
	return {} as IncomingMessage;
}

function makeRes(): ServerResponse {
	return {
		statusCode: 200,
		headersSent: false,
		writableEnded: false,
	} as unknown as ServerResponse;
}

describe("compose middleware", () => {
	it("executes middlewares in order", async () => {
		const order: number[] = [];

		const middleware1: Middleware = async (_req, _res, next) => {
			order.push(1);
			await next();
			order.push(4);
		};

		const middleware2: Middleware = async (_req, _res, next) => {
			order.push(2);
			await next();
			order.push(3);
		};

		const app = compose([middleware1, middleware2]);
		await app(makeReq(), makeRes(), () => {});

		expect(order).toEqual([1, 2, 3, 4]);
	});

	it("propagates errors from middleware", async () => {
		const errorMiddleware = async () => {
			throw new Error("Middleware error");
		};

		const app = compose([errorMiddleware]);

		await expect(app(makeReq(), makeRes(), () => {})).rejects.toThrow(
			"Middleware error",
		);
	});

	it("propagates async errors from middleware", async () => {
		const asyncErrorMiddleware = async () => {
			await Promise.resolve();
			throw new Error("Async middleware error");
		};

		const app = compose([asyncErrorMiddleware]);

		await expect(app(makeReq(), makeRes(), () => {})).rejects.toThrow(
			"Async middleware error",
		);
	});

	it("throws if next() called multiple times", async () => {
		const badMiddleware: Middleware = async (_req, _res, next) => {
			await next();
			await next();
		};

		const app = compose([badMiddleware]);

		await expect(app(makeReq(), makeRes(), () => {})).rejects.toThrow(
			"next() called multiple times",
		);
	});

	it("stops chain if middleware does not call next", async () => {
		const order: number[] = [];

		const middleware1 = async () => {
			order.push(1);
			// Does not call next
		};

		const middleware2: Middleware = async (_req, _res, next) => {
			order.push(2);
			await next();
		};

		const app = compose([middleware1, middleware2]);
		await app(makeReq(), makeRes(), () => {});

		expect(order).toEqual([1]);
	});

	it("calls final handler after all middlewares", async () => {
		let finalCalled = false;

		const middleware: Middleware = async (_req, _res, next) => {
			await next();
		};

		const app = compose([middleware]);
		await app(makeReq(), makeRes(), () => {
			finalCalled = true;
		});

		expect(finalCalled).toBe(true);
	});
});
