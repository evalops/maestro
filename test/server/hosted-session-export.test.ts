import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

function createMockRequest(method: string, body?: unknown): IncomingMessage {
	return {
		method,
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
}

function createMockResponse(): {
	res: ServerResponse;
	getStatus: () => number;
	getBody: () => unknown;
} {
	let status = 200;
	let body = "";
	const res = {
		writeHead: vi.fn((value: number) => {
			status = value;
		}),
		end: vi.fn((value?: string) => {
			if (value) body = value;
		}),
		setHeader: vi.fn(),
	} as unknown as ServerResponse;
	return {
		res,
		getStatus: () => status,
		getBody: () => {
			try {
				return JSON.parse(body);
			} catch {
				return body;
			}
		},
	};
}

describe("hosted session export", () => {
	afterEach(() => {
		vi.doUnmock("../../src/server/session-scope.js");
		vi.doUnmock("../../src/server/hosted-session-manager.js");
		vi.resetModules();
	});

	it("sends 404 when hosted JSONL entries disappear before export", async () => {
		const hostedManager = {
			storageKind: "database",
			loadSession: vi.fn(async () => ({
				id: "hosted-session",
				owner: "anon",
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
				messageCount: 1,
				messages: [{ role: "user", content: "hello" }],
			})),
			loadEntries: vi.fn(async () => null),
			getSessionFileById: vi.fn(() => "db:hosted-session"),
		};
		vi.doMock("../../src/server/session-scope.js", () => ({
			createWebSessionManagerForRequest: vi.fn(() => hostedManager),
			createWebSessionManagerForScope: vi.fn(() => hostedManager),
		}));
		vi.doMock("../../src/server/hosted-session-manager.js", () => ({
			isHostedSessionManager: (manager: unknown) =>
				typeof manager === "object" &&
				manager !== null &&
				(manager as { storageKind?: unknown }).storageKind === "database",
		}));

		const { handleSessionExport } = await import(
			"../../src/server/handlers/sessions.js"
		);
		const req = createMockRequest("POST", { format: "jsonl" });
		const { res, getStatus, getBody } = createMockResponse();

		await handleSessionExport(
			req,
			res,
			{ id: "hosted-session" },
			{ "Access-Control-Allow-Origin": "*" },
		);

		expect(getStatus()).toBe(404);
		expect(getBody()).toEqual({ error: "Session not found" });
	});
});
