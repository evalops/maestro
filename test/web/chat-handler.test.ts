import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/agent/agent.js";
import { clearRegisteredHooks, registerHook } from "../../src/hooks/index.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import type { WebServerContext } from "../../src/server/app-context.js";
import {
	resetApprovalModeStore,
	setApprovalModeForSession,
} from "../../src/server/approval-mode-store.js";
import { handleApproval } from "../../src/server/handlers/approval.js";
import { handleChat } from "../../src/server/handlers/chat.js";
import { handleClientToolResult } from "../../src/server/handlers/client-tools.js";
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

async function waitForPendingRequest(
	kind?: "approval" | "client_tool" | "user_input" | "tool_retry",
) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const request = serverRequestManager
			.listPending()
			.find((entry) => (kind ? entry.kind === kind : true));
		if (request) {
			return request;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(
		kind
			? `Timed out waiting for pending ${kind} request`
			: "Timed out waiting for pending request",
	);
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
		clearRegisteredHooks();
		for (const request of serverRequestManager.listPending()) {
			serverRequestManager.cancel(request.id, "test cleanup", "runtime");
		}
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

	it("resolves approval requests through the shared approval endpoint during SSE chat", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		req.end(
			JSON.stringify({
				messages: [{ role: "user", content: "run the command" }],
			}),
		);

		const res = makeRes();
		const createAgent: WebServerContext["createAgent"] = async (
			_model,
			_thinking,
			_approval,
			options,
		) => {
			type EventCallback = (e: unknown) => void | Promise<void>;
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
					const approvalService = options?.approvalService;
					if (!approvalService) {
						throw new Error("approval service missing");
					}
					const decision = await approvalService.requestApproval({
						id: "approval_web_chat",
						toolName: "bash",
						args: { command: "git push --force" },
						reason: "Force push requires approval",
					});
					await subscriber?.({
						type: "message_end",
						message: {
							role: "assistant",
							content: [
								{
									type: "text",
									text: decision.approved ? "approved" : "denied",
								},
							],
							api: mockModel.api,
							provider: mockModel.provider,
							model: mockModel.id,
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							},
							stopReason: "stop",
							timestamp: Date.now(),
						},
					});
				},
				abort: () => {},
			} as unknown as Agent;
		};

		const context: Partial<WebServerContext> = {
			createAgent,
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "prompt",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
			corsHeaders: cors,
		};

		const chatPromise = handleChat(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context as WebServerContext,
		);

		const pendingRequest = await waitForPendingRequest("approval");
		expect(pendingRequest).toMatchObject({
			id: "approval_web_chat",
			kind: "approval",
			toolName: "bash",
		});

		const approvalReq = new PassThrough() as MockPassThrough;
		approvalReq.method = "POST";
		approvalReq.url = "/api/chat/approval";
		approvalReq.headers = {};
		approvalReq.end(
			JSON.stringify({
				requestId: pendingRequest.id,
				decision: "approved",
				reason: "Looks good",
			}),
		);

		const approvalRes = makeRes();
		await handleApproval(
			approvalReq as unknown as IncomingMessage,
			approvalRes as unknown as ServerResponse,
			context as WebServerContext,
		);

		await chatPromise;

		expect(approvalRes.statusCode).toBe(200);
		expect(approvalRes.body).toContain('"success":true');
		expect(serverRequestManager.listPending()).toEqual([]);
		expect(res.body).toContain("[DONE]");
		expect(res.body).toContain("approved");
	});

	it("resolves client tool requests through the shared client-tool endpoint during SSE chat", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = { "x-composer-client-tools": "1" };
		req.end(
			JSON.stringify({
				messages: [{ role: "user", content: "create an artifact" }],
			}),
		);

		const res = makeRes();
		const createAgent: WebServerContext["createAgent"] = async (
			_model,
			_thinking,
			_approval,
			options,
		) => {
			type EventCallback = (e: unknown) => void | Promise<void>;
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
					const executionService = options?.clientToolService;
					if (!executionService) {
						throw new Error("client tool service missing");
					}
					const result = await executionService.requestExecution(
						"client_tool_web_chat",
						"artifacts",
						{ command: "create", filename: "report.txt" },
					);
					await subscriber?.({
						type: "message_end",
						message: {
							role: "assistant",
							content: result.content,
							api: mockModel.api,
							provider: mockModel.provider,
							model: mockModel.id,
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							},
							stopReason: "stop",
							timestamp: Date.now(),
						},
					});
				},
				abort: () => {},
			} as unknown as Agent;
		};

		const context: Partial<WebServerContext> = {
			createAgent,
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "prompt",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
			corsHeaders: cors,
		};

		const chatPromise = handleChat(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context as WebServerContext,
		);

		const pendingRequest = await waitForPendingRequest("client_tool");
		expect(pendingRequest).toMatchObject({
			id: "client_tool_web_chat",
			kind: "client_tool",
			toolName: "artifacts",
		});

		const toolResultReq = new PassThrough() as MockPassThrough;
		toolResultReq.method = "POST";
		toolResultReq.url = "/api/chat/client-tool-result";
		toolResultReq.headers = {};
		toolResultReq.end(
			JSON.stringify({
				toolCallId: pendingRequest.id,
				content: [{ type: "text", text: "artifact created" }],
				isError: false,
			}),
		);

		const toolResultRes = makeRes();
		await handleClientToolResult(
			toolResultReq as unknown as IncomingMessage,
			toolResultRes as unknown as ServerResponse,
			context as WebServerContext,
		);

		await chatPromise;

		expect(toolResultRes.statusCode).toBe(200);
		expect(toolResultRes.body).toContain('"success":true');
		expect(serverRequestManager.listPending()).toEqual([]);
		expect(res.body).toContain("[DONE]");
		expect(res.body).toContain("artifact created");
	});

	it("runs Notification hooks during SSE chat even without desktop notifications configured", async () => {
		process.env.MAESTRO_NOTIFY_PROGRAM = "";
		process.env.MAESTRO_NOTIFY_EVENTS = "";
		process.env.MAESTRO_NOTIFY_TERMINAL = "";

		const captured: Array<{ notification_type: string; message: string }> = [];
		registerHook("Notification", {
			type: "callback",
			callback: async (input) => {
				captured.push({
					notification_type: (
						input as { notification_type: string; message: string }
					).notification_type,
					message: (input as { notification_type: string; message: string })
						.message,
				});
				return {};
			},
		});

		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		req.end(
			JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		const res = makeRes();

		const context: Partial<WebServerContext> = {
			createAgent: async () => {
				type EventCallback = (e: unknown) => void | Promise<void>;
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
					replaceMessages: (messages: unknown[]) => {
						state.messages = messages;
					},
					clearMessages: () => {},
					prompt: async () => {
						await subscriber?.({
							type: "turn_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "Done" }],
								api: mockModel.api,
								provider: mockModel.provider,
								model: mockModel.id,
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									cost: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										total: 0,
									},
								},
								stopReason: "stop",
								timestamp: Date.now(),
							},
							toolResults: [],
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

		expect(captured).toEqual([
			{
				notification_type: "turn-complete",
				message: "Done",
			},
		]);
	});

	it("runs UserPromptSubmit hooks before executing SSE chat prompts", async () => {
		const queueNextRunHistoryMessage = vi.fn();
		const queueNextRunSystemPromptAddition = vi.fn();

		registerHook("UserPromptSubmit", {
			type: "callback",
			callback: async () => ({
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: "Remember the repo coding conventions.",
				},
				systemMessage: "Avoid unnecessary refactors.",
			}),
		});

		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		req.end(
			JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		const res = makeRes();

		const context: Partial<WebServerContext> = {
			createAgent: async () => {
				type EventCallback = (e: unknown) => void | Promise<void>;
				let subscriber: EventCallback | undefined;
				return {
					state: {
						systemPrompt: "",
						model: mockModel,
						thinkingLevel: "off",
						tools: [],
						messages: [] as unknown[],
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
					queueNextRunHistoryMessage,
					queueNextRunSystemPromptAddition,
					replaceMessages: () => {},
					clearMessages: () => {},
					prompt: async () => {
						await subscriber?.({
							type: "turn_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "Done" }],
								api: mockModel.api,
								provider: mockModel.provider,
								model: mockModel.id,
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									cost: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										total: 0,
									},
								},
								stopReason: "stop",
								timestamp: Date.now(),
							},
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

		expect(queueNextRunSystemPromptAddition).toHaveBeenCalledWith(
			"UserPromptSubmit hook system guidance:\nAvoid unnecessary refactors.",
		);
		expect(queueNextRunHistoryMessage).toHaveBeenCalledWith({
			role: "hookMessage",
			customType: "UserPromptSubmit",
			content: "Remember the repo coding conventions.",
			display: true,
			details: undefined,
			timestamp: expect.any(Number),
		});
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
