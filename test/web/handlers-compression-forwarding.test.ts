import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleConfig } from "../../src/server/handlers/config.js";
import { handleStatus } from "../../src/server/handlers/status.js";
import { handleUsage } from "../../src/server/handlers/usage.js";
import * as serverUtils from "../../src/server/server-utils.js";

const cors = {};

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

function createRes(): MockResponse {
	return {
		writableEnded: false,
		headersSent: false,
		writeHead: vi.fn(),
		end: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("handler compression forwarding", () => {
	it("handleStatus forwards req to respondWithApiError on failure", async () => {
		const req: MockRequest = {
			method: "GET",
			url: "/api/status",
			headers: { "accept-encoding": "gzip" },
		};
		const res = createRes();

		const sendJsonSpy = vi
			.spyOn(serverUtils, "sendJson")
			.mockImplementation(() => {
				throw new Error("boom");
			});
		const errorSpy = vi
			.spyOn(serverUtils, "respondWithApiError")
			.mockImplementation(() => true);

		handleStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			cors,
		);

		expect(sendJsonSpy).toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			res,
			expect.any(Error),
			500,
			cors,
			req,
		);
	});

	it("handleUsage forwards req to respondWithApiError on failure", () => {
		const req: MockRequest = {
			method: "GET",
			url: "/api/usage",
			headers: { "accept-encoding": "gzip" },
		};
		const res = createRes();

		vi.spyOn(serverUtils, "sendJson").mockImplementation(() => {
			throw new Error("fail");
		});
		const errorSpy = vi
			.spyOn(serverUtils, "respondWithApiError")
			.mockImplementation(() => true);

		handleUsage(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			cors,
		);

		expect(errorSpy).toHaveBeenCalledWith(
			res,
			expect.any(Error),
			500,
			cors,
			req,
		);
	});

	it("handleConfig forwards req to sendJson for compression negotiation", async () => {
		const req: MockRequest = {
			method: "GET",
			url: "/api/config",
			headers: { "accept-encoding": "gzip" },
		};
		const res = createRes();

		const sendJsonSpy = vi
			.spyOn(serverUtils, "sendJson")
			.mockImplementation(() => {});

		await handleConfig(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			cors,
		);

		expect(sendJsonSpy).toHaveBeenCalledWith(
			res,
			200,
			expect.anything(),
			cors,
			req,
		);
	});
});
