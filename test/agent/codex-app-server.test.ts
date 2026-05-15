import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { streamCodexAppServer } from "../../src/agent/providers/codex-app-server.js";
import type {
	AgentTool,
	AssistantMessageEvent,
	Context,
	Model,
} from "../../src/agent/types.js";
import type {
	CodexAppServerClientLike,
	CodexAppServerInitializeOptions,
	CodexAppServerNotification,
	CodexAppServerRequest,
	CodexAppServerRequestHandler,
	CodexAppServerRequestHandlerResult,
} from "../../src/codex/app-server-client.js";

const model: Model<"openai-codex-app-server"> = {
	id: "gpt-5.5",
	name: "GPT-5.5 (Codex)",
	api: "openai-codex-app-server",
	provider: "openai-codex",
	baseUrl: "codex-app-server://local",
	reasoning: true,
	toolUse: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

const context: Context = {
	systemPrompt: "Be concise.",
	messages: [
		{
			role: "user",
			content: "Say hello",
			timestamp: 1,
		},
	],
	tools: [],
};

class FakeCodexAppServerClient implements CodexAppServerClientLike {
	readonly requests: Array<{ method: string; params?: unknown }> = [];
	readonly initializeCalls: Array<CodexAppServerInitializeOptions | undefined> =
		[];
	readonly serverRequestResults: unknown[] = [];
	private readonly listeners = new Set<
		(notification: CodexAppServerNotification) => void
	>();
	private readonly requestHandlers = new Set<CodexAppServerRequestHandler>();

	constructor(
		private readonly signedIn = true,
		private readonly requiresOpenaiAuth = true,
	) {}

	async initialize(
		options?: CodexAppServerInitializeOptions,
	): Promise<unknown> {
		this.initializeCalls.push(options);
		return {};
	}

	async request<TResult = unknown>(
		method: string,
		params?: unknown,
	): Promise<TResult> {
		this.requests.push({ method, params });
		if (method === "thread/start") {
			return { thread: { id: "thread-1" } } as TResult;
		}
		if (method === "turn/start") {
			queueMicrotask(async () => {
				this.emit("item/agentMessage/delta", {
					threadId: "thread-1",
					turnId: "turn-1",
					itemId: "item-1",
					delta: "Hello from ",
				});
				this.emit("item/agentMessage/delta", {
					threadId: "thread-1",
					turnId: "turn-1",
					itemId: "item-1",
					delta: "Codex app-server",
				});
				if (this.requestHandlers.size > 0) {
					const result = await this.callServerRequest({
						id: "server-1",
						method: "item/tool/call",
						params: {
							threadId: "thread-1",
							turnId: "turn-1",
							callId: "tool-call-1",
							namespace: null,
							tool: "lookup_ticket",
							arguments: { id: "ABC-123" },
						},
					});
					this.serverRequestResults.push(result);
				}
				this.emit("thread/tokenUsage/updated", {
					threadId: "thread-1",
					turnId: "turn-1",
					tokenUsage: {
						last: {
							totalTokens: 24,
							inputTokens: 13,
							cachedInputTokens: 5,
							outputTokens: 11,
							reasoningOutputTokens: 3,
						},
						total: {
							totalTokens: 24,
							inputTokens: 13,
							cachedInputTokens: 5,
							outputTokens: 11,
							reasoningOutputTokens: 3,
						},
						modelContextWindow: 272000,
					},
				});
				this.emit("turn/completed", {
					threadId: "thread-1",
					turn: { id: "turn-1", status: "completed" },
				});
			});
			return { turn: { id: "turn-1" } } as TResult;
		}
		throw new Error(`unexpected request ${method}`);
	}

	notify(): void {}

	onNotification(
		listener: (notification: CodexAppServerNotification) => void,
	): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async readAccount() {
		return {
			account: this.signedIn
				? {
						type: "chatgpt" as const,
						email: "user@example.com",
						planType: "pro",
					}
				: null,
			requiresOpenaiAuth: this.requiresOpenaiAuth,
		};
	}

	onRequest(listener: CodexAppServerRequestHandler): () => void {
		this.requestHandlers.add(listener);
		return () => {
			this.requestHandlers.delete(listener);
		};
	}

	async startChatGptLogin() {
		return {
			type: "chatgpt" as const,
			loginId: "login-1",
			authUrl: "https://chatgpt.com/auth",
		};
	}

	async waitForLoginCompletion() {
		return { loginId: "login-1", success: true, error: null };
	}

	async logout(): Promise<void> {}

	close(): void {}

	private emit(method: string, params: unknown): void {
		for (const listener of this.listeners) {
			listener({ method, params });
		}
	}

	private async callServerRequest(
		request: CodexAppServerRequest,
	): Promise<CodexAppServerRequestHandlerResult> {
		for (const handler of this.requestHandlers) {
			const result = await handler(request);
			if (result.handled) {
				return result;
			}
		}
		return { handled: false };
	}
}

describe("Codex app-server provider", () => {
	it("streams app-server agent message deltas into assistant text", async () => {
		const client = new FakeCodexAppServerClient();
		const events: AssistantMessageEvent[] = [];

		for await (const event of streamCodexAppServer(model, context, {
			codexAppServerClient: client,
			cwd: "/tmp/project",
		})) {
			events.push(event);
		}

		const done = events.find((event) => event.type === "done");
		expect(done).toMatchObject({
			type: "done",
			message: {
				api: "openai-codex-app-server",
				content: [{ type: "text", text: "Hello from Codex app-server" }],
				usage: expect.objectContaining({
					input: 8,
					output: 11,
					cacheRead: 5,
					cacheWrite: 0,
				}),
			},
		});
		expect(client.requests).toEqual([
			expect.objectContaining({
				method: "thread/start",
				params: expect.objectContaining({
					model: "gpt-5.5",
					cwd: "/tmp/project",
					ephemeral: true,
				}),
			}),
			expect.objectContaining({
				method: "turn/start",
				params: expect.objectContaining({
					threadId: "thread-1",
					model: "gpt-5.5",
					cwd: "/tmp/project",
				}),
			}),
		]);
		expect(client.initializeCalls).toEqual([undefined]);
	});

	it("returns a useful sign-in error when ChatGPT auth is missing", async () => {
		const client = new FakeCodexAppServerClient(false);
		const events: AssistantMessageEvent[] = [];

		for await (const event of streamCodexAppServer(model, context, {
			codexAppServerClient: client,
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			expect.objectContaining({
				type: "error",
				reason: "error",
				error: expect.objectContaining({
					errorMessage: expect.stringContaining("maestro codex login"),
				}),
			}),
		]);
	});

	it("forwards user image blocks to app-server turn input", async () => {
		const client = new FakeCodexAppServerClient();

		for await (const _event of streamCodexAppServer(
			model,
			{
				...context,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Inspect this screenshot" },
							{
								type: "image",
								mimeType: "image/png",
								data: "aW1hZ2UtYnl0ZXM=",
							},
						],
						timestamp: 1,
					},
				],
			},
			{ codexAppServerClient: client },
		)) {
			// Drain the stream.
		}

		expect(client.requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: "turn/start",
					params: expect.objectContaining({
						input: expect.arrayContaining([
							expect.objectContaining({
								type: "image",
								url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
							}),
						]),
					}),
				}),
			]),
		);
	});

	it("returns the sign-in error when account is unexpectedly absent", async () => {
		const client = new FakeCodexAppServerClient(false, false);
		const events: AssistantMessageEvent[] = [];

		for await (const event of streamCodexAppServer(model, context, {
			codexAppServerClient: client,
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			expect.objectContaining({
				type: "error",
				reason: "error",
				error: expect.objectContaining({
					errorMessage: expect.stringContaining("maestro codex login"),
				}),
			}),
		]);
	});

	it("registers and services Maestro tools through app-server dynamic tools", async () => {
		const client = new FakeCodexAppServerClient();
		const lookupTool: AgentTool = {
			name: "lookup_ticket",
			description: "Look up an internal ticket.",
			parameters: Type.Object({
				id: Type.String(),
			}),
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `Ticket ${String(args.id)} is open.` }],
			}),
		};
		const events: AssistantMessageEvent[] = [];

		for await (const event of streamCodexAppServer(
			model,
			{ ...context, tools: [lookupTool] },
			{
				codexAppServerClient: client,
				cwd: "/tmp/project",
				executeDynamicTool: async (toolCall) =>
					lookupTool.execute(toolCall.id, toolCall.arguments),
			},
		)) {
			events.push(event);
		}

		expect(client.initializeCalls).toEqual([
			expect.objectContaining({ experimentalApi: true }),
		]);
		expect(client.initializeCalls[0]).not.toHaveProperty("clientInfo");
		expect(client.requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: "thread/start",
					params: expect.objectContaining({
						dynamicTools: [
							expect.objectContaining({
								name: "lookup_ticket",
								description: "Look up an internal ticket.",
								inputSchema: expect.objectContaining({ type: "object" }),
							}),
						],
					}),
				}),
			]),
		);
		expect(client.serverRequestResults).toEqual([
			{
				handled: true,
				result: {
					contentItems: [
						{ type: "inputText", text: "Ticket ABC-123 is open." },
					],
					success: true,
				},
			},
		]);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	});

	it("does not advertise client-side tools as app-server dynamic tools", async () => {
		const client = new FakeCodexAppServerClient();
		const clientTool: AgentTool = {
			name: "pick_file",
			description: "Ask the client to pick a file.",
			parameters: Type.Object({}),
			executionLocation: "client",
			execute: async () => ({
				content: [{ type: "text", text: "picked" }],
			}),
		};

		for await (const _event of streamCodexAppServer(
			model,
			{ ...context, tools: [clientTool] },
			{
				codexAppServerClient: client,
				executeDynamicTool: async (toolCall) =>
					clientTool.execute(toolCall.id, toolCall.arguments),
			},
		)) {
			// Drain the stream.
		}

		expect(client.initializeCalls).toEqual([undefined]);
		expect(client.requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: "thread/start",
					params: expect.not.objectContaining({
						dynamicTools: expect.anything(),
					}),
				}),
			]),
		);
		expect(client.serverRequestResults).toEqual([]);
	});

	it("returns the same sign-in error when the app-server reports no account", async () => {
		const client = new FakeCodexAppServerClient(false, false);
		const events: AssistantMessageEvent[] = [];

		for await (const event of streamCodexAppServer(model, context, {
			codexAppServerClient: client,
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			expect.objectContaining({
				type: "error",
				reason: "error",
				error: expect.objectContaining({
					errorMessage: expect.stringContaining("maestro codex login"),
				}),
			}),
		]);
	});
});
