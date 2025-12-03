import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestHandler } from "../../src/web/router.js";
import * as serverUtils from "../../src/web/server-utils.js";
import { ApiError } from "../../src/web/server-utils.js";

interface MockRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
}

interface MockResponse {
	writableEnded: boolean;
	headersSent: boolean;
	writeHead: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("router error handler", () => {
	it("passes the request to respondWithApiError so compression can negotiate", async () => {
		const spy = vi
			.spyOn(serverUtils, "respondWithApiError")
			.mockImplementation(() => true);

		const routes = [
			{
				method: "GET",
				path: "/boom",
				handler: async () => {
					throw new Error("boom");
				},
			},
		];

		const handler = createRequestHandler(routes, undefined, {});

		const req: MockRequest = {
			method: "GET",
			url: "/boom",
			headers: { "accept-encoding": "gzip" },
		};

		const res: MockResponse = {
			writableEnded: false,
			headersSent: false,
			writeHead: vi.fn(),
			end: vi.fn(),
		};

		await handler(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			"/boom",
		);

		expect(spy).toHaveBeenCalledWith(res, expect.any(ApiError), 500, {}, req);
	});
});
