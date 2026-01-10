import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleSessionExport,
	handleSessionShare,
	handleSessions,
	handleSharedSession,
} from "../src/server/handlers/sessions.js";

// Mock the SessionManager
vi.mock("../src/session/manager.js", () => ({
	SessionManager: vi.fn().mockImplementation(() => ({
		listSessions: vi.fn().mockResolvedValue([
			{
				id: "test-session-1",
				title: "Test Session 1",
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-02T00:00:00Z",
				messageCount: 5,
				favorite: false,
				tags: ["work"],
			},
			{
				id: "test-session-2",
				title: "Test Session 2",
				createdAt: "2024-01-03T00:00:00Z",
				updatedAt: "2024-01-04T00:00:00Z",
				messageCount: 10,
				favorite: true,
				tags: [],
			},
		]),
		loadSession: vi.fn().mockImplementation((id: string) => {
			if (id === "test-session-1") {
				return Promise.resolve({
					id: "test-session-1",
					title: "Test Session 1",
					createdAt: "2024-01-01T00:00:00Z",
					updatedAt: "2024-01-02T00:00:00Z",
					messageCount: 2,
					messages: [
						{ role: "user", content: "Hello" },
						{ role: "assistant", content: "Hi there!" },
					],
				});
			}
			if (id === "not-found") {
				return Promise.resolve(null);
			}
			return Promise.resolve({
				id,
				title: `Session ${id}`,
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-02T00:00:00Z",
				messageCount: 0,
				messages: [],
			});
		}),
		createSession: vi
			.fn()
			.mockImplementation((options?: { title?: string }) => {
				return Promise.resolve({
					id: "new-session-id",
					title: options?.title || "New Session",
					createdAt: "2024-01-01T00:00:00Z",
					updatedAt: "2024-01-01T00:00:00Z",
					messageCount: 0,
					messages: [],
				});
			}),
		deleteSession: vi.fn().mockResolvedValue(undefined),
		getSessionFileById: vi.fn().mockImplementation((id: string) => {
			return id === "not-found" ? null : `/sessions/${id}.jsonl`;
		}),
		setSessionFavorite: vi.fn(),
		setSessionTitle: vi.fn(),
		setSessionTags: vi.fn(),
	})),
}));

// Mock session-serialization
vi.mock("../src/server/session-serialization.js", () => ({
	convertAppMessagesToComposer: vi.fn((msgs, _opts) => msgs),
}));

function createMockRequest(method: string, body?: unknown): IncomingMessage {
	const req = {
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
	return req;
}

function createMockResponse(): {
	res: ServerResponse;
	getStatus: () => number;
	getBody: () => unknown;
	getHeaders: () => Record<string, string>;
} {
	let status = 200;
	let body = "";
	const headers: Record<string, string> = {};

	const res = {
		writeHead: vi.fn((s: number, h?: Record<string, string>) => {
			status = s;
			if (h) Object.assign(headers, h);
		}),
		end: vi.fn((b?: string) => {
			if (b) body = b;
		}),
		setHeader: vi.fn((key: string, value: string) => {
			headers[key] = value;
		}),
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
		getHeaders: () => headers,
	};
}

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

describe("Session Endpoints", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("handleSessions - GET (list)", () => {
		it("should return list of sessions", async () => {
			const req = createMockRequest("GET");
			const { res, getBody } = createMockResponse();

			await handleSessions(req, res, {}, corsHeaders);

			const body = getBody() as { sessions: Array<{ id: string }> };
			expect(body.sessions).toHaveLength(2);
			expect(body.sessions[0]!.id).toBe("test-session-1");
		});
	});

	describe("handleSessions - GET (single)", () => {
		it("should return a single session with messages", async () => {
			const req = createMockRequest("GET");
			const { res, getBody } = createMockResponse();

			await handleSessions(req, res, { id: "test-session-1" }, corsHeaders);

			const body = getBody() as {
				id: string;
				messages: Array<{ role: string }>;
			};
			expect(body.id).toBe("test-session-1");
			expect(body.messages).toHaveLength(2);
		});

		it("should return 404 for non-existent session", async () => {
			const req = createMockRequest("GET");
			const { res, getStatus, getBody } = createMockResponse();

			await handleSessions(req, res, { id: "not-found" }, corsHeaders);

			expect(getStatus()).toBe(404);
			expect(getBody()).toEqual({ error: "Session not found" });
		});

		it("should return 400 for invalid session id", async () => {
			const req = createMockRequest("GET");
			const { res, getStatus, getBody } = createMockResponse();

			await handleSessions(req, res, { id: "../malicious/path" }, corsHeaders);

			expect(getStatus()).toBe(400);
			expect(getBody()).toEqual({ error: "Invalid session id" });
		});
	});

	describe("handleSessions - POST (create)", () => {
		it("should create a new session", async () => {
			const req = createMockRequest("POST", { title: "My New Session" });
			const { res, getStatus, getBody } = createMockResponse();

			await handleSessions(req, res, {}, corsHeaders);

			expect(getStatus()).toBe(201);
			const body = getBody() as { id: string; title: string };
			expect(body.id).toBe("new-session-id");
		});
	});

	describe("handleSessions - PATCH (update)", () => {
		it("should update session metadata", async () => {
			const req = createMockRequest("PATCH", {
				title: "Updated Title",
				favorite: true,
			});
			const { res, getStatus, getBody } = createMockResponse();

			await handleSessions(req, res, { id: "test-session-1" }, corsHeaders);

			expect(getStatus()).toBe(200);
			const body = getBody() as { title: string; favorite: boolean };
			expect(body.title).toBe("Updated Title");
			expect(body.favorite).toBe(true);
		});

		it("should return 404 for non-existent session", async () => {
			const req = createMockRequest("PATCH", { title: "Updated" });
			const { res, getStatus } = createMockResponse();

			await handleSessions(req, res, { id: "not-found" }, corsHeaders);

			expect(getStatus()).toBe(404);
		});
	});

	describe("handleSessions - DELETE", () => {
		it("should delete a session", async () => {
			const req = createMockRequest("DELETE");
			const { res, getStatus } = createMockResponse();

			await handleSessions(req, res, { id: "test-session-1" }, corsHeaders);

			expect(getStatus()).toBe(204);
		});

		it("should return 400 for invalid session id", async () => {
			const req = createMockRequest("DELETE");
			const { res, getStatus } = createMockResponse();

			await handleSessions(req, res, { id: "invalid/id" }, corsHeaders);

			expect(getStatus()).toBe(400);
		});
	});
});

describe("Session Sharing", () => {
	let shareToken: string;

	describe("handleSessionShare", () => {
		it("should generate a share link", async () => {
			const req = createMockRequest("POST", { expiresInHours: 48 });
			const { res, getStatus, getBody } = createMockResponse();

			await handleSessionShare(req, res, { id: "test-session-1" }, corsHeaders);

			expect(getStatus()).toBe(201);
			const body = getBody() as {
				shareToken: string;
				shareUrl: string;
				expiresAt: string;
			};
			expect(body.shareToken).toBeDefined();
			expect(body.shareUrl).toContain("/api/sessions/shared/");
			shareToken = body.shareToken;
		});

		it("should return 404 for non-existent session", async () => {
			const req = createMockRequest("POST", {});
			const { res, getStatus } = createMockResponse();

			await handleSessionShare(req, res, { id: "not-found" }, corsHeaders);

			expect(getStatus()).toBe(404);
		});

		it("should limit expiration to max 1 week", async () => {
			const req = createMockRequest("POST", { expiresInHours: 500 }); // More than 168 (1 week)
			const { res, getBody } = createMockResponse();

			await handleSessionShare(req, res, { id: "test-session-1" }, corsHeaders);

			const body = getBody() as { expiresAt: string };
			const expiresAt = new Date(body.expiresAt);
			const maxExpiry = new Date(Date.now() + 168 * 60 * 60 * 1000 + 60000); // 1 week + 1 min buffer
			expect(expiresAt.getTime()).toBeLessThanOrEqual(maxExpiry.getTime());
		});
	});

	describe("handleSharedSession", () => {
		it("should return 404 for invalid token", async () => {
			const req = createMockRequest("GET");
			const { res, getStatus, getBody } = createMockResponse();

			await handleSharedSession(
				req,
				res,
				{ token: "invalid-token" },
				corsHeaders,
			);

			expect(getStatus()).toBe(404);
			expect(getBody()).toEqual({
				error: "Share link not found or expired",
			});
		});
	});
});

describe("Session Export", () => {
	describe("handleSessionExport", () => {
		it("should export session as JSON", async () => {
			const req = createMockRequest("POST", { format: "json" });
			const { res, getHeaders } = createMockResponse();

			await handleSessionExport(
				req,
				res,
				{ id: "test-session-1" },
				corsHeaders,
			);

			const headers = getHeaders();
			expect(headers["Content-Type"]).toBe("application/json");
			expect(headers["Content-Disposition"]).toContain(
				"session-test-session-1.json",
			);
		});

		it("should export session as markdown", async () => {
			const req = createMockRequest("POST", { format: "markdown" });
			const { res, getHeaders } = createMockResponse();

			await handleSessionExport(
				req,
				res,
				{ id: "test-session-1" },
				corsHeaders,
			);

			const headers = getHeaders();
			expect(headers["Content-Type"]).toBe("text/markdown");
			expect(headers["Content-Disposition"]).toContain(
				"session-test-session-1.md",
			);
		});

		it("should export session as plain text", async () => {
			const req = createMockRequest("POST", { format: "text" });
			const { res, getHeaders } = createMockResponse();

			await handleSessionExport(
				req,
				res,
				{ id: "test-session-1" },
				corsHeaders,
			);

			const headers = getHeaders();
			expect(headers["Content-Type"]).toBe("text/plain");
			expect(headers["Content-Disposition"]).toContain(
				"session-test-session-1.txt",
			);
		});

		it("should return 404 for non-existent session", async () => {
			const req = createMockRequest("POST", { format: "json" });
			const { res, getStatus } = createMockResponse();

			await handleSessionExport(req, res, { id: "not-found" }, corsHeaders);

			expect(getStatus()).toBe(404);
		});

		it("should default to JSON format", async () => {
			const req = createMockRequest("POST", {});
			const { res, getHeaders } = createMockResponse();

			await handleSessionExport(
				req,
				res,
				{ id: "test-session-1" },
				corsHeaders,
			);

			const headers = getHeaders();
			expect(headers["Content-Type"]).toBe("application/json");
		});
	});
});
