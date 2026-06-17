import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
	isAllowedLoopbackHost,
	rejectDisallowedLoopbackHost,
} from "../../src/utils/loopback-http.js";

function createResponse() {
	const response = {
		body: "",
		headers: undefined as Record<string, string> | undefined,
		statusCode: undefined as number | undefined,
		ended: false,
		writeHead(statusCode: number, headers: Record<string, string>) {
			this.statusCode = statusCode;
			this.headers = headers;
			return this;
		},
		end(chunk?: string) {
			this.ended = true;
			this.body += chunk ?? "";
			return this;
		},
	};
	return response;
}

describe("loopback HTTP Host guard", () => {
	it("allows only exact loopback host headers for the callback port", () => {
		expect(isAllowedLoopbackHost("127.0.0.1:1455", 1455)).toBe(true);
		expect(isAllowedLoopbackHost("localhost:1455", 1455)).toBe(true);
		expect(isAllowedLoopbackHost("[::1]:1455", 1455)).toBe(true);
		expect(isAllowedLoopbackHost("LOCALHOST:1455", 1455)).toBe(true);

		expect(isAllowedLoopbackHost(undefined, 1455)).toBe(false);
		expect(isAllowedLoopbackHost("localhost:1456", 1455)).toBe(false);
		expect(isAllowedLoopbackHost("127.0.0.1:1455.evil.test", 1455)).toBe(false);
		expect(isAllowedLoopbackHost("attacker.test:1455", 1455)).toBe(false);
		expect(isAllowedLoopbackHost(["localhost:1455"], 1455)).toBe(false);
	});

	it("returns 403 before loopback handlers process mismatched hosts", () => {
		const req = {
			headers: { host: "attacker.test:1455" },
		} as IncomingMessage;
		const res = createResponse();

		expect(
			rejectDisallowedLoopbackHost(req, res as unknown as ServerResponse, 1455),
		).toBe(true);
		expect(res.statusCode).toBe(403);
		expect(res.headers).toMatchObject({
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
		});
		expect(res.body).toBe("forbidden");
		expect(res.ended).toBe(true);
	});

	it("leaves allowed loopback requests for the OAuth callback handler", () => {
		const req = {
			headers: { host: "127.0.0.1:1455" },
		} as IncomingMessage;
		const res = createResponse();

		expect(
			rejectDisallowedLoopbackHost(req, res as unknown as ServerResponse, 1455),
		).toBe(false);
		expect(res.ended).toBe(false);
		expect(res.statusCode).toBeUndefined();
	});
});
