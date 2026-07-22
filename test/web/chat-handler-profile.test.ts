import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RegisteredModel } from "../../src/models/registry.js";
import type { WebServerContext } from "../../src/server/app-context.js";
import { handleChatWebSocket } from "../../src/server/handlers/chat-ws.js";
import { handleChat } from "../../src/server/handlers/chat.js";

const runNativeWebChatTurn = vi.hoisted(() =>
	vi.fn(async (options) => {
		const promptResolution = { systemPrompt: "resolved" };
		await options.onBeforePrompt?.(promptResolution);
		await options.onStarted?.(promptResolution);
		return { ok: true as const };
	}),
);

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
	baseUrl: "",
	reasoning: true,
	toolUse: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
	providerName: "OpenAI",
	source: "builtin",
	isLocal: false,
};

class MockResponse extends EventEmitter {
	body = "";
	statusCode = 200;
	headersSent = false;
	writableEnded = false;
	writable = true;
	destroyed = false;
	writeHead(status: number) {
		this.statusCode = status;
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
}

function context(): WebServerContext {
	return {
		corsHeaders: {},
		staticMaxAge: 0,
		defaultApprovalMode: "prompt",
		defaultProvider: MODEL.provider,
		defaultModelId: MODEL.id,
		profileName: "web-work",
		cliOverrides: {
			projects: { "/tmp/project": { trust_level: "trusted" } },
		},
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

function request() {
	const req = new PassThrough() as PassThrough & IncomingMessage;
	req.method = "POST";
	req.url = "/api/chat";
	req.headers = { host: "localhost" };
	req.end(JSON.stringify({ messages: [{ role: "user", content: "hello" }] }));
	return req;
}

afterEach(() => {
	runNativeWebChatTurn.mockClear();
	vi.restoreAllMocks();
});

describe("native chat profile threading", () => {
	it("forwards the server profile and CLI overrides over SSE", async () => {
		await handleChat(
			request(),
			new MockResponse() as unknown as ServerResponse,
			context(),
		);
		expect(runNativeWebChatTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				profileName: "web-work",
				cliOverrides: {
					projects: { "/tmp/project": { trust_level: "trusted" } },
				},
			}),
		);
	});

	it("forwards the server profile and CLI overrides over websocket", async () => {
		const req = request();
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
		await vi.waitFor(() => expect(runNativeWebChatTurn).toHaveBeenCalled());
		expect(runNativeWebChatTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				profileName: "web-work",
				cliOverrides: {
					projects: { "/tmp/project": { trust_level: "trusted" } },
				},
			}),
		);
	});
});
