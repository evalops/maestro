import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleSessionAttachment } from "../src/server/handlers/session-attachments.js";

vi.mock("../src/session/manager.js", () => ({
	SessionManager: vi.fn().mockImplementation(() => ({
		loadSession: vi.fn().mockResolvedValue({
			id: "test-session-1",
			messages: [
				{
					role: "user",
					attachments: [
						{
							id: "att-1",
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

function createMockRequest(url: string): IncomingMessage {
	return { method: "GET", url, headers: {} } as unknown as IncomingMessage;
}

function createMockResponse(): {
	res: ServerResponse;
	getStatus: () => number;
	getHeaders: () => Record<string, string>;
	getBody: () => Buffer | undefined;
} {
	let status = 0;
	const headers: Record<string, string> = {};
	let body: Buffer | undefined;

	const res = {
		writeHead: vi.fn((s: number, h?: Record<string, string>) => {
			status = s;
			if (h) Object.assign(headers, h);
		}),
		end: vi.fn((b?: Buffer) => {
			if (b) body = b;
		}),
	} as unknown as ServerResponse;

	return {
		res,
		getStatus: () => status,
		getHeaders: () => headers,
		getBody: () => body,
	};
}

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

describe("Session Attachment Endpoint", () => {
	it("returns raw bytes for an attachment", async () => {
		const req = createMockRequest(
			"/api/sessions/test-session-1/attachments/att-1",
		);
		const { res, getStatus, getHeaders, getBody } = createMockResponse();

		await handleSessionAttachment(
			req,
			res,
			{ id: "test-session-1", attachmentId: "att-1" },
			corsHeaders,
		);

		expect(getStatus()).toBe(200);
		expect(getHeaders()["Content-Type"]).toBe("text/plain");
		expect(getBody()?.toString("utf8")).toBe("hello");
	});

	it("sets content-disposition when download=1", async () => {
		const req = createMockRequest(
			"/api/sessions/test-session-1/attachments/att-1?download=1",
		);
		const { res, getHeaders } = createMockResponse();

		await handleSessionAttachment(
			req,
			res,
			{ id: "test-session-1", attachmentId: "att-1" },
			corsHeaders,
		);

		expect(getHeaders()["Content-Disposition"]).toContain("attachment;");
	});
});
