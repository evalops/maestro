import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleContext } from "../../src/server/handlers/context.js";

const { loadSession } = vi.hoisted(() => ({
	loadSession: vi.fn(),
}));

vi.mock("../../src/server/authz.js", () => ({
	getAuthSubject: vi.fn(() => "user:alice"),
	requireApiAuth: vi.fn(async () => true),
}));

vi.mock("../../src/server/session-scope.js", () => ({
	createWebSessionManagerForRequest: vi.fn(() => ({
		loadSession,
	})),
}));

vi.mock("../../src/server/utils/session-rate-limit.js", () => ({
	checkSessionRateLimitAsync: vi.fn(async () => ({
		allowed: true,
		remaining: 10,
	})),
}));

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	writeHead(status: number, headers?: Record<string, string>): void;
	end(chunk?: string | Buffer): void;
}

function makeReq(sessionId: string): IncomingMessage {
	return {
		method: "GET",
		url: `/api/context?sessionId=${encodeURIComponent(sessionId)}`,
		headers: { host: "localhost" },
	} as IncomingMessage;
}

function makeRes(): MockResponse & ServerResponse {
	const res: MockResponse = {
		statusCode: 200,
		headers: {},
		body: "",
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			this.headers = headers ?? {};
		},
		end(chunk?: string | Buffer) {
			if (chunk) {
				this.body += chunk.toString();
			}
		},
	};
	return res as MockResponse & ServerResponse;
}

async function requestContext(sessionId: string): Promise<{
	statusCode: number;
	body: unknown;
}> {
	const req = makeReq(sessionId);
	const res = makeRes();

	await handleContext(req, res, corsHeaders);

	return {
		statusCode: res.statusCode,
		body: JSON.parse(res.body),
	};
}

describe("handleContext", () => {
	beforeEach(() => {
		loadSession.mockReset();
	});

	it("returns the same 404 body for missing and wrong-owner sessions", async () => {
		loadSession.mockResolvedValueOnce(null);
		const missing = await requestContext("missing-session");

		loadSession.mockResolvedValueOnce({
			id: "other-session",
			subject: "user:bob",
			messages: [],
		});
		const wrongOwner = await requestContext("other-session");

		expect(missing).toEqual({
			statusCode: 404,
			body: { error: "Session not found" },
		});
		expect(wrongOwner).toEqual(missing);
	});
});
