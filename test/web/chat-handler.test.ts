import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RegisteredModel } from "../../src/models/registry.js";
import type { WebServerContext } from "../../src/server/app-context.js";
import { resetApprovalModeStore } from "../../src/server/approval-mode-store.js";
import { handleChatWebSocket } from "../../src/server/handlers/chat-ws.js";
import { handleChat } from "../../src/server/handlers/chat.js";
import { ApiError } from "../../src/server/server-utils.js";
import * as sessionScope from "../../src/server/session-scope.js";

const runNativeWebChatTurn = vi.hoisted(() => vi.fn());

vi.mock("../../src/server/web-native-chat.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/server/web-native-chat.js")
	>("../../src/server/web-native-chat.js");
	return { ...actual, runNativeWebChatTurn };
});

const MODEL: RegisteredModel = {
	id: "gpt-5.4",
	provider: "openai",
	name: "GPT-5.4",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1/responses",
	reasoning: true,
	toolUse: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
	providerName: "OpenAI",
	source: "builtin",
	isLocal: false,
};

class MockResponse extends EventEmitter {
	body = "";
	statusCode = 200;
	headers: Record<string, string | number> = {};
	headersSent = false;
	writableEnded = false;
	writable = true;
	destroyed = false;

	writeHead(status: number, headers: Record<string, string | number> = {}) {
		this.statusCode = status;
		this.headers = { ...this.headers, ...headers };
		this.headersSent = true;
		return this;
	}

	write(chunk: string | Buffer) {
		this.body += chunk.toString();
		return true;
	}

	end(chunk?: string | Buffer) {
		if (chunk) this.write(chunk);
		this.writableEnded = true;
		return this;
	}
}

class MockWebSocket extends EventEmitter {
	readyState = 1;
	sent: string[] = [];

	send(payload: string) {
		this.sent.push(payload);
	}

	close() {
		this.readyState = 3;
		this.emit("close");
	}
}

function request(body: unknown, headers: Record<string, string> = {}) {
	const req = new PassThrough() as PassThrough & IncomingMessage;
	req.method = "POST";
	req.url = "/api/chat";
	req.headers = { host: "localhost", ...headers };
	req.end(JSON.stringify(body));
	return req;
}

function sessionManager(overrides: Record<string, unknown> = {}) {
	return {
		getSessionFileById: vi.fn(() => null),
		setSessionFile: vi.fn(),
		loadSession: vi.fn(async () => null),
		getSessionId: vi.fn(() => "session-native"),
		isInitialized: vi.fn(() => false),
		loadAllSessions: vi.fn(() => []),
		countActiveSessions: vi.fn(async () => 0),
		startSession: vi.fn(),
		saveMessage: vi.fn(),
		flush: vi.fn(async () => {}),
		getSessionFile: vi.fn(() => "/tmp/session-native.jsonl"),
		getHeader: vi.fn(() => undefined),
		...overrides,
	};
}

function context(): WebServerContext {
	return {
		corsHeaders: { "Access-Control-Allow-Origin": "*" },
		staticMaxAge: 0,
		defaultApprovalMode: "prompt",
		defaultProvider: MODEL.provider,
		defaultModelId: MODEL.id,
		getRegisteredModel: vi.fn(async () => MODEL),
		getCurrentSelection: () => ({
			provider: MODEL.provider,
			modelId: MODEL.id,
		}),
		ensureCredential: vi.fn(),
		setModelSelection: vi.fn(),
		acquireSse: () => Symbol("lease"),
		releaseSse: vi.fn(),
	} as unknown as WebServerContext;
}

function installSuccessfulNativeTurn() {
	runNativeWebChatTurn.mockImplementation(async (options) => {
		const promptResolution = {
			systemPrompt: "native system prompt",
			promptMetadata: {
				name: "maestro-system",
				label: "production",
				hash: "prompt-hash",
				source: "bundled",
			},
			promptContextManifest: {
				cwd: "/workspace",
				candidates: [],
				bytesRead: 0,
				entries: [],
				diagnostics: [],
			},
			systemPromptSourcePaths: ["/workspace/APPEND_SYSTEM.md"],
		};
		await options.onBeforePrompt?.(promptResolution);
		await options.onStarted?.(promptResolution);
		options.onEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "native reply" }],
				timestamp: Date.now(),
			},
		});
		return { ok: true as const };
	});
}

beforeEach(() => {
	vi.spyOn(sessionScope, "createWebSessionManagerForRequest").mockReturnValue(
		sessionManager() as never,
	);
	runNativeWebChatTurn.mockReset();
	installSuccessfulNativeTurn();
});

afterEach(() => {
	resetApprovalModeStore();
	vi.restoreAllMocks();
});

describe("native-only web chat handlers", () => {
	it("rejects an empty message list before starting native", async () => {
		const res = new MockResponse();
		await handleChat(
			request({ messages: [] }),
			res as unknown as ServerResponse,
			context(),
		);
		expect(res.statusCode).toBe(400);
		expect(runNativeWebChatTurn).not.toHaveBeenCalled();
	});

	it("rejects HTTP requests that require unbridged client tools", async () => {
		const res = new MockResponse();
		await handleChat(
			request(
				{ messages: [{ role: "user", content: "hello" }] },
				{ "x-composer-client-tools": "1" },
			),
			res as unknown as ServerResponse,
			context(),
		);
		expect(res.statusCode).toBe(400);
		expect(res.body).toContain(
			"Native web chat does not yet support client-side tools",
		);
		expect(runNativeWebChatTurn).not.toHaveBeenCalled();
	});

	it("hides HTTP sessions owned by another subject", async () => {
		vi.mocked(sessionScope.createWebSessionManagerForRequest).mockReturnValue(
			sessionManager({
				getSessionFileById: vi.fn(() => "/tmp/victim.jsonl"),
				loadSession: vi.fn(async () => ({
					id: "victim",
					owner: "other-subject",
					messages: [],
				})),
			}) as never,
		);
		const res = new MockResponse();
		await handleChat(
			request({
				sessionId: "victim",
				messages: [{ role: "user", content: "hello" }],
			}),
			res as unknown as ServerResponse,
			context(),
		);
		expect(res.statusCode).toBe(404);
		expect(runNativeWebChatTurn).not.toHaveBeenCalled();
	});

	it("streams a native response and initializes persistence before saving", async () => {
		const manager = sessionManager();
		vi.mocked(sessionScope.createWebSessionManagerForRequest).mockReturnValue(
			manager as never,
		);
		const res = new MockResponse();
		await handleChat(
			request({ messages: [{ role: "user", content: "hello" }] }),
			res as unknown as ServerResponse,
			context(),
		);

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("native reply");
		expect(res.body).toContain("[DONE]");
		expect(res.body).toContain(
			'data: {"type":"session_update","sessionId":"session-native"}',
		);
		expect(manager.startSession).toHaveBeenCalledWith(
			expect.objectContaining({
				model: MODEL,
				systemPrompt: "native system prompt",
				promptMetadata: expect.objectContaining({ hash: "prompt-hash" }),
				promptContextManifest: expect.objectContaining({
					cwd: "/workspace",
				}),
				systemPromptSourcePaths: ["/workspace/APPEND_SYSTEM.md"],
			}),
			expect.any(Object),
		);
		expect(manager.startSession.mock.invocationCallOrder[0]).toBeLessThan(
			manager.saveMessage.mock.invocationCallOrder[0] as number,
		);
	});

	it("passes validated attachments and fails prompt approval closed", async () => {
		const manager = sessionManager();
		vi.mocked(sessionScope.createWebSessionManagerForRequest).mockReturnValue(
			manager as never,
		);
		const res = new MockResponse();
		await handleChat(
			request(
				{
					messages: [
						{
							role: "user",
							content: "earlier report",
							attachments: [
								{
									id: "prior",
									type: "document",
									fileName: "prior.pdf",
									mimeType: "application/pdf",
									size: 12,
									extractedText: "Prior attachment details",
								},
							],
						},
						{ role: "assistant", content: "reviewed" },
						{
							role: "user",
							content: "inspect",
							attachments: [
								{
									id: "a1",
									type: "document",
									fileName: "notes.txt",
									mimeType: "text/plain",
									size: 5,
									content: Buffer.from("hello").toString("base64"),
								},
							],
						},
					],
				},
				{ "x-maestro-approval-mode": "prompt" },
			),
			res as unknown as ServerResponse,
			context(),
		);

		expect(runNativeWebChatTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalMode: "prompt",
				attachments: [expect.objectContaining({ fileName: "notes.txt" })],
				history: [
					{
						role: "user",
						text: "earlier report\n\n[Attachment: prior.pdf]\nPrior attachment details",
					},
					{ role: "assistant", text: "reviewed" },
				],
			}),
		);
		expect(manager.saveMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "user",
				attachments: [expect.objectContaining({ fileName: "notes.txt" })],
			}),
		);
	});

	it("returns a server error when native startup fails", async () => {
		runNativeWebChatTurn.mockResolvedValue({
			ok: false,
			phase: "start",
			error: new Error("native unavailable"),
		});
		const res = new MockResponse();
		await handleChat(
			request({ messages: [{ role: "user", content: "hello" }] }),
			res as unknown as ServerResponse,
			context(),
		);
		expect(res.statusCode).toBe(500);
		expect(res.body).toContain("native unavailable");
	});

	it("returns native session policy denials as policy errors", async () => {
		runNativeWebChatTurn.mockResolvedValue({
			ok: false,
			phase: "turn",
			error: new ApiError(403, "[Policy] Session limit reached"),
		});
		const res = new MockResponse();
		await handleChat(
			request({ messages: [{ role: "user", content: "hello" }] }),
			res as unknown as ServerResponse,
			context(),
		);
		expect(res.statusCode).toBe(403);
		expect(res.body).toContain("[Policy] Session limit reached");
	});

	it("uses the native path for websocket chat", async () => {
		const req = request({});
		req.method = "GET";
		req.url = "/api/chat/ws";
		const ws = new MockWebSocket();
		handleChatWebSocket(ws as never, req, context());
		ws.emit(
			"message",
			Buffer.from(
				JSON.stringify({
					messages: [
						{
							role: "user",
							content: "see diagram",
							attachments: [
								{
									id: "diagram",
									type: "image",
									fileName: "diagram.png",
									mimeType: "image/png",
									size: 12,
								},
							],
						},
						{ role: "assistant", content: "reviewed" },
						{ role: "user", content: "hello" },
					],
				}),
			),
		);
		await vi.waitFor(() => expect(runNativeWebChatTurn).toHaveBeenCalled());
		expect(runNativeWebChatTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				history: [
					{
						role: "user",
						text: "see diagram\n\n[Attachment: diagram.png (image/png)]",
					},
					{ role: "assistant", text: "reviewed" },
				],
			}),
		);
		await vi.waitFor(() =>
			expect(ws.sent.some((payload) => payload.includes("native reply"))).toBe(
				true,
			),
		);
		expect(ws.sent).toContain(
			JSON.stringify({ type: "session_update", sessionId: "session-native" }),
		);
	});

	it("rejects websocket requests that require unbridged client tools", async () => {
		const req = request({}, { "x-maestro-client-tools": "true" });
		req.method = "GET";
		req.url = "/api/chat/ws";
		const ws = new MockWebSocket();
		handleChatWebSocket(ws as never, req, context());
		ws.emit(
			"message",
			Buffer.from(
				JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
			),
		);
		await vi.waitFor(() =>
			expect(
				ws.sent.some((payload) =>
					payload.includes(
						"Native web chat does not yet support client-side tools",
					),
				),
			).toBe(true),
		);
		expect(runNativeWebChatTurn).not.toHaveBeenCalled();
	});
});
