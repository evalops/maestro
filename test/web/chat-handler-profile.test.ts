import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/agent/agent.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import type { WebServerContext } from "../../src/server/app-context.js";
import { serverRequestManager } from "../../src/server/server-request-manager.js";

const mockModel: RegisteredModel = {
	id: "claude-sonnet-4-5",
	provider: "anthropic",
	name: "Claude",
	api: "anthropic-messages",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
	providerName: "Anthropic",
	source: "builtin",
	isLocal: false,
};

const cors = { "Access-Control-Allow-Origin": "*" };

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	writableEnded: boolean;
	on: () => void;
	off: () => void;
	writeHead(status: number, headers?: Record<string, string>): void;
	write(chunk: string | Buffer): void;
	end(chunk?: string | Buffer): void;
}

interface MockPassThrough extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

class MockWebSocket extends EventEmitter {
	readyState = 1;
	sent: string[] = [];

	send(payload: string) {
		this.sent.push(payload);
	}
}

function makeRes(): MockResponse {
	return {
		statusCode: 200,
		headers: {},
		body: "",
		writableEnded: false,
		on: () => {},
		off: () => {},
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			this.headers = headers || {};
		},
		write(chunk: string | Buffer) {
			this.body += chunk.toString();
		},
		end(chunk?: string | Buffer) {
			if (chunk) this.write(chunk);
			this.writableEnded = true;
		},
	};
}

function createMockAgent(): Agent {
	return {
		state: {
			systemPrompt: "",
			model: mockModel,
			thinkingLevel: "off",
			tools: [],
			messages: [],
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Map(),
		},
		subscribe: () => () => {},
		replaceMessages: () => {},
		clearMessages: () => {},
		prompt: async () => {},
		abort: () => {},
	} as unknown as Agent;
}

async function importChatHandlersWithMock(
	runUserPromptWithRecovery: ReturnType<typeof vi.fn>,
) {
	vi.resetModules();
	vi.doMock("../../src/agent/user-prompt-runtime.js", async () => {
		const actual = await vi.importActual<
			typeof import("../../src/agent/user-prompt-runtime.js")
		>("../../src/agent/user-prompt-runtime.js");
		return {
			...actual,
			runUserPromptWithRecovery,
		};
	});
	const [{ handleChat }, { handleChatWebSocket }] = await Promise.all([
		import("../../src/server/handlers/chat.js"),
		import("../../src/server/handlers/chat-ws.js"),
	]);
	return { handleChat, handleChatWebSocket };
}

describe("chat handler profile threading", () => {
	afterEach(() => {
		for (const request of serverRequestManager.listPending()) {
			serverRequestManager.cancel(request.id, "test cleanup", "runtime");
		}
		vi.doUnmock("../../src/agent/user-prompt-runtime.js");
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("passes the server profile into SSE prompt recovery", async () => {
		const runUserPromptWithRecovery = vi.fn(async () => {});
		const { handleChat } = await importChatHandlersWithMock(
			runUserPromptWithRecovery,
		);
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		req.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));

		const res = makeRes();
		const context: Partial<WebServerContext> = {
			profileName: "work",
			cliOverrides: {
				projects: { "/tmp/project": { trust_level: "trusted" } },
			},
			createAgent: async () => createMockAgent(),
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "prompt",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
			corsHeaders: cors,
		};

		await handleChat(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context as WebServerContext,
		);

		expect(runUserPromptWithRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				profileName: "work",
				cliOverrides: {
					projects: { "/tmp/project": { trust_level: "trusted" } },
				},
			}),
		);
	});

	it("passes the server profile into websocket prompt recovery", async () => {
		const runUserPromptWithRecovery = vi.fn(async () => {});
		const { handleChatWebSocket } = await importChatHandlersWithMock(
			runUserPromptWithRecovery,
		);
		const req = new PassThrough() as MockPassThrough;
		req.method = "GET";
		req.url = "/api/chat/ws";
		req.headers = { host: "localhost" };
		const ws = new MockWebSocket();
		const context: Partial<WebServerContext> = {
			profileName: "work",
			cliOverrides: {
				projects: { "/tmp/project": { trust_level: "trusted" } },
			},
			createAgent: async () => createMockAgent(),
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "prompt",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
			corsHeaders: cors,
		};

		handleChatWebSocket(
			ws as unknown as Parameters<typeof handleChatWebSocket>[0],
			req as unknown as IncomingMessage,
			context as WebServerContext,
		);
		ws.emit(
			"message",
			JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		await vi.waitFor(() => {
			expect(runUserPromptWithRecovery).toHaveBeenCalledWith(
				expect.objectContaining({
					profileName: "work",
					cliOverrides: {
						projects: { "/tmp/project": { trust_level: "trusted" } },
					},
				}),
			);
		});
	});
});
