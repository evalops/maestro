import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { RegisteredModel } from "../../src/models/registry.js";
import {
	type ChatHandlerContext,
	handleChat,
} from "../../src/web/handlers/chat.js";

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

function makeRes(): MockResponse {
	const res: MockResponse = {
		statusCode: 200,
		headers: {} as Record<string, string>,
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
	return res;
}

interface MockPassThrough extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

describe("handleChat", () => {
	it("returns 400 when no messages supplied", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		req.end(JSON.stringify({ messages: [] }));

		const res = makeRes();

		const context: Partial<ChatHandlerContext> = {
			createAgent: async () => {
				throw new Error("should not create agent");
			},
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "prompt",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
			corsHeaders: cors,
		};

		await handleChat(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context as ChatHandlerContext,
		);

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain("No messages supplied");
	});

	it("streams DONE for valid request", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		const body = {
			messages: [{ role: "user", content: "hi" }],
		};
		req.end(JSON.stringify(body));

		const res = makeRes();

		const context: Partial<ChatHandlerContext> = {
			createAgent: async () => {
				type EventCallback = (e: unknown) => void;
				let subscriber: EventCallback | undefined;
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
					subscribe: (fn: EventCallback) => {
						subscriber = fn;
						return () => {
							subscriber = undefined;
						};
					},
					replaceMessages: () => {},
					clearMessages: () => {},
					prompt: async () => {
						subscriber?.({
							type: "message_end",
							message: { role: "assistant" },
						});
					},
					abort: () => {},
				};
			},
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "prompt",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
			corsHeaders: cors,
		};

		await handleChat(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context as ChatHandlerContext,
		);

		// SSE stream writes contain DONE marker
		expect(res.body).toContain("[DONE]");
		expect(res.statusCode).toBe(200);
	});
});
