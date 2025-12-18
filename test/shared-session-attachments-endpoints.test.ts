import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	handleSessionShare,
	handleSharedSessionAttachment,
	resetShareRateLimit,
} from "../src/server/handlers/sessions.js";

vi.mock("../src/db/client.js", () => ({
	getDb: vi.fn(() => {
		throw new Error("DB not available in tests");
	}),
	isDbAvailable: vi.fn(() => false),
}));

vi.mock("../src/session/manager.js", () => ({
	SessionManager: vi.fn().mockImplementation(() => ({
		loadSession: vi.fn().mockResolvedValue({
			id: "test-session-1",
			title: "Test Session 1",
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-02T00:00:00Z",
			messageCount: 1,
			messages: [
				{
					role: "user",
					attachments: [
						{
							id: "att-1",
							type: "document",
							fileName: "hello.txt",
							mimeType: "text/plain",
							size: 5,
							content: Buffer.from("hello", "utf8").toString("base64"),
						},
					],
				},
			],
		}),
	})),
}));

function createMockRequest(
	method: string,
	url: string,
	body?: unknown,
): IncomingMessage {
	const req = {
		method,
		url,
		headers: {},
		socket: { remoteAddress: "127.0.0.1" },
		on: vi.fn((event: string, callback: (chunk?: Buffer) => void) => {
			if (event === "data" && body) {
				callback(Buffer.from(JSON.stringify(body)));
			}
			if (event === "end") {
				setTimeout(() => callback(), 0);
			}
		}),
	} as unknown as IncomingMessage;
	return req;
}

function createMockResponse(): {
	res: ServerResponse;
	getStatus: () => number;
	getHeaders: () => Record<string, string>;
	getBody: () => unknown;
	getRawBody: () => Buffer | undefined;
} {
	let status = 200;
	const headers: Record<string, string> = {};
	let bodyText = "";
	let rawBody: Buffer | undefined;

	const res = {
		writeHead: vi.fn((s: number, h?: Record<string, string>) => {
			status = s;
			if (h) Object.assign(headers, h);
		}),
		setHeader: vi.fn((key: string, value: string) => {
			headers[key] = value;
		}),
		end: vi.fn((b?: string | Buffer) => {
			if (typeof b === "string") {
				bodyText = b;
			} else if (Buffer.isBuffer(b)) {
				rawBody = b;
			}
		}),
	} as unknown as ServerResponse;

	return {
		res,
		getStatus: () => status,
		getHeaders: () => headers,
		getRawBody: () => rawBody,
		getBody: () => {
			try {
				return JSON.parse(bodyText);
			} catch {
				return bodyText;
			}
		},
	};
}

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

describe("Shared session attachments", () => {
	afterEach(async () => {
		await resetShareRateLimit();
	});

	it("fetches attachment bytes via share token", async () => {
		const shareReq = createMockRequest(
			"POST",
			"/api/sessions/test-session-1/share",
			{
				expiresInHours: 24,
				maxAccesses: 1,
			},
		);
		const shareRes = createMockResponse();

		await handleSessionShare(
			shareReq,
			shareRes.res,
			{ id: "test-session-1" },
			corsHeaders,
		);

		expect(shareRes.getStatus()).toBe(201);
		const shareBody = shareRes.getBody() as { shareToken: string };
		expect(shareBody.shareToken).toBeTruthy();

		const req = createMockRequest(
			"GET",
			`/api/sessions/shared/${shareBody.shareToken}/attachments/att-1`,
		);
		const { res, getStatus, getHeaders, getRawBody } = createMockResponse();

		await handleSharedSessionAttachment(
			req,
			res,
			{ token: shareBody.shareToken, attachmentId: "att-1" },
			corsHeaders,
		);

		expect(getStatus()).toBe(200);
		expect(getHeaders()["Content-Type"]).toBe("text/plain");
		expect(getRawBody()?.toString("utf8")).toBe("hello");
	});

	it("supports download=1 on token attachment endpoint", async () => {
		const shareReq = createMockRequest(
			"POST",
			"/api/sessions/test-session-1/share",
			{
				expiresInHours: 24,
				maxAccesses: 1,
			},
		);
		const shareRes = createMockResponse();

		await handleSessionShare(
			shareReq,
			shareRes.res,
			{ id: "test-session-1" },
			corsHeaders,
		);
		const shareBody = shareRes.getBody() as { shareToken: string };

		const req = createMockRequest(
			"GET",
			`/api/sessions/shared/${shareBody.shareToken}/attachments/att-1?download=1`,
		);
		const { res, getHeaders } = createMockResponse();

		await handleSharedSessionAttachment(
			req,
			res,
			{ token: shareBody.shareToken, attachmentId: "att-1" },
			corsHeaders,
		);

		expect(getHeaders()["Content-Disposition"]).toContain("attachment;");
	});
});
