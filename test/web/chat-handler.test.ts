import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/agent/agent.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import type { WebServerContext } from "../../src/server/app-context.js";
import {
	resetApprovalModeStore,
	setApprovalModeForSession,
} from "../../src/server/approval-mode-store.js";
import { handleChat } from "../../src/server/handlers/chat.js";

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

function findJsonlFiles(dir: string): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...findJsonlFiles(fullPath));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(fullPath);
		}
	}
	return files;
}

interface MockPassThrough extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

describe("handleChat", () => {
	afterEach(() => {
		resetApprovalModeStore();
		vi.unstubAllEnvs();
	});

	it("returns 400 when no messages supplied", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		req.end(JSON.stringify({ messages: [] }));

		const res = makeRes();

		const context: Partial<WebServerContext> = {
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
			context as WebServerContext,
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

		const context: Partial<WebServerContext> = {
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
				} as unknown as Agent;
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
			context as WebServerContext,
		);

		// SSE stream writes contain DONE marker
		expect(res.body).toContain("[DONE]");
		expect(res.statusCode).toBe(200);
	});

	it("persists user messages during streaming", async () => {
		const composerHome = mkdtempSync(join(tmpdir(), "composer-home-"));
		vi.stubEnv("MAESTRO_HOME", composerHome);

		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		const body = {
			messages: [{ role: "user", content: "hi" }],
		};
		req.end(JSON.stringify(body));

		const res = makeRes();

		const context: Partial<WebServerContext> = {
			createAgent: async () => {
				type EventCallback = (e: unknown) => void;
				let subscriber: EventCallback | undefined;
				const state = {
					systemPrompt: "",
					model: mockModel,
					thinkingLevel: "off",
					tools: [],
					messages: [] as unknown[],
					isStreaming: false,
					streamMessage: null,
					pendingToolCalls: new Map(),
				};
				return {
					state,
					subscribe: (fn: EventCallback) => {
						subscriber = fn;
						return () => {
							subscriber = undefined;
						};
					},
					replaceMessages: () => {},
					clearMessages: () => {},
					prompt: async () => {
						const userMessage = { role: "user", content: "hi" };
						state.messages = [...state.messages, userMessage];
						subscriber?.({
							type: "message_end",
							message: userMessage,
						});
						const assistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "Hello" }],
							api: mockModel.api,
							provider: mockModel.provider,
							model: mockModel.id,
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
						state.messages = [...state.messages, assistantMessage];
						subscriber?.({
							type: "message_end",
							message: assistantMessage,
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
			context as WebServerContext,
		);

		const sessionDir = join(composerHome, "agent", "sessions");
		const sessionFiles = findJsonlFiles(sessionDir);
		expect(sessionFiles.length).toBeGreaterThan(0);

		const entries = readFileSync(sessionFiles[0]!, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const messages = entries
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		expect(messages.some((msg) => msg.role === "user")).toBe(true);
	});

	it("slims toolcall update events when header is set", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = { "x-composer-slim-events": "true" };
		req.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));

		const res = makeRes();

		const context: Partial<WebServerContext> = {
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
							type: "message_update",
							message: { role: "assistant", content: [] },
							assistantMessageEvent: {
								type: "toolcall_delta",
								contentIndex: 0,
								delta: '{"path":"/tmp/one.txt"}',
								partial: {
									role: "assistant",
									content: [
										{
											type: "toolCall",
											id: "call_1",
											name: "read_file",
											arguments: { path: "/tmp/one.txt" },
										},
									],
								},
							},
						});
						subscriber?.({
							type: "message_end",
							message: { role: "assistant" },
						});
					},
					abort: () => {},
				} as unknown as Agent;
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
			context as WebServerContext,
		);

		const events = res.body
			.split("\n\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.replace(/^data:\s*/, ""))
			.filter((payload) => payload !== "[DONE]")
			.map((payload) => JSON.parse(payload));
		const update = events.find((event) => event.type === "message_update");

		expect(update).toBeTruthy();
		expect(update.message).toBeUndefined();
		expect(update.assistantMessageEvent.partial).toBeUndefined();
		expect(update.assistantMessageEvent.toolCallId).toBe("call_1");
		expect(update.assistantMessageEvent.toolCallName).toBe("read_file");
		expect(update.assistantMessageEvent.toolCallArgs).toEqual({
			path: "/tmp/one.txt",
		});
	});

	it("marks slim toolcall args as truncated when payload is large", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = { "x-composer-slim-events": "true" };
		req.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));

		const res = makeRes();
		const largePayload = "x".repeat(5000);

		const context: Partial<WebServerContext> = {
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
							type: "message_update",
							message: { role: "assistant", content: [] },
							assistantMessageEvent: {
								type: "toolcall_start",
								contentIndex: 0,
								partial: {
									role: "assistant",
									content: [
										{
											type: "toolCall",
											id: "call_big",
											name: "write_file",
											arguments: { data: largePayload },
										},
									],
								},
							},
						});
						subscriber?.({
							type: "message_end",
							message: { role: "assistant" },
						});
					},
					abort: () => {},
				} as unknown as Agent;
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
			context as WebServerContext,
		);

		const events = res.body
			.split("\n\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.replace(/^data:\s*/, ""))
			.filter((payload) => payload !== "[DONE]")
			.map((payload) => JSON.parse(payload));
		const update = events.find((event) => event.type === "message_update");

		expect(update).toBeTruthy();
		expect(update.assistantMessageEvent.toolCallArgs).toBeUndefined();
		expect(update.assistantMessageEvent.toolCallArgsTruncated).toBe(true);
	});

	it("accepts maestro slim-events headers", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = { "x-maestro-slim-events": "true" };
		req.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));

		const res = makeRes();

		const context: Partial<WebServerContext> = {
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
							type: "message_update",
							message: { role: "assistant", content: [] },
							assistantMessageEvent: {
								type: "toolcall_delta",
								contentIndex: 0,
								delta: '{"path":"/tmp/two.txt"}',
								partial: {
									role: "assistant",
									content: [
										{
											type: "toolCall",
											id: "call_2",
											name: "read_file",
											arguments: { path: "/tmp/two.txt" },
										},
									],
								},
							},
						});
						subscriber?.({
							type: "message_end",
							message: { role: "assistant" },
						});
					},
					abort: () => {},
				} as unknown as Agent;
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
			context as WebServerContext,
		);

		const events = res.body
			.split("\n\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.replace(/^data:\s*/, ""))
			.filter((payload) => payload !== "[DONE]")
			.map((payload) => JSON.parse(payload));
		const update = events.find((event) => event.type === "message_update");

		expect(update).toBeTruthy();
		expect(update.assistantMessageEvent.toolCallId).toBe("call_2");
		expect(update.assistantMessageEvent.toolCallArgs).toEqual({
			path: "/tmp/two.txt",
		});
	});

	it("uses the stored session approval mode when no header override is set", async () => {
		setApprovalModeForSession("session-approval", "fail");

		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		req.end(
			JSON.stringify({
				sessionId: "session-approval",
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		const res = makeRes();
		let capturedApproval: string | null = null;

		const context: Partial<WebServerContext> = {
			createAgent: async (_model, _thinking, approval) => {
				capturedApproval = approval;
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
				} as unknown as Agent;
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
			context as WebServerContext,
		);

		expect(capturedApproval).toBe("fail");
	});

	it("honors an auto approval header override", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = { "x-composer-approval-mode": "auto" };
		req.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));

		const res = makeRes();
		let capturedApproval: string | null = null;

		const context: Partial<WebServerContext> = {
			createAgent: async (_model, _thinking, approval) => {
				capturedApproval = approval;
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
				} as unknown as Agent;
			},
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "auto",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
			corsHeaders: cors,
		};

		await handleChat(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context as WebServerContext,
		);

		expect(capturedApproval).toBe("auto");
	});

	it("honors a maestro approval header override", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = { "x-maestro-approval-mode": "auto" };
		req.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));

		const res = makeRes();
		let capturedApproval: string | null = null;

		const context: Partial<WebServerContext> = {
			createAgent: async (_model, _thinking, approval) => {
				capturedApproval = approval;
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
				} as unknown as Agent;
			},
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "auto",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
			corsHeaders: cors,
		};

		await handleChat(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context as WebServerContext,
		);

		expect(capturedApproval).toBe("auto");
	});

	it("does not let a stored session mode relax a stricter server default", async () => {
		setApprovalModeForSession("session-approval", "auto");

		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		req.end(
			JSON.stringify({
				sessionId: "session-approval",
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		const res = makeRes();
		let capturedApproval: string | null = null;

		const context: Partial<WebServerContext> = {
			createAgent: async (_model, _thinking, approval) => {
				capturedApproval = approval;
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
				} as unknown as Agent;
			},
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "fail",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
			corsHeaders: cors,
		};

		await handleChat(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context as WebServerContext,
		);

		expect(capturedApproval).toBe("fail");
	});

	it("does not let an approval header relax a stricter server default", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = { "x-composer-approval-mode": "auto" };
		req.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));

		const res = makeRes();
		let capturedApproval: string | null = null;

		const context: Partial<WebServerContext> = {
			createAgent: async (_model, _thinking, approval) => {
				capturedApproval = approval;
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
				} as unknown as Agent;
			},
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "fail",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
			corsHeaders: cors,
		};

		await handleChat(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context as WebServerContext,
		);

		expect(capturedApproval).toBe("fail");
	});
});
