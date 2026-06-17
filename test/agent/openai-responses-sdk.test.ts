import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamResponsesApiSdk } from "../../src/agent/providers/openai-responses-sdk.js";
import type {
	AssistantMessageEvent,
	Context,
	Model,
} from "../../src/agent/types.js";

const openaiMock = vi.hoisted(() => {
	let streamFactory: () => AsyncIterable<unknown> = async function* () {};
	let lastParams: unknown;
	let lastClientOptions: unknown;

	return {
		setStream(factory: () => AsyncIterable<unknown>) {
			streamFactory = factory;
		},
		createStream(params?: unknown): AsyncIterable<unknown> {
			lastParams = params;
			return streamFactory();
		},
		setClientOptions(options: unknown) {
			lastClientOptions = options;
		},
		getLastParams() {
			return lastParams;
		},
		getLastClientOptions() {
			return lastClientOptions;
		},
		reset() {
			lastParams = undefined;
			lastClientOptions = undefined;
		},
	};
});

const configLoaderMock = vi.hoisted(() => ({
	getMergedCustomModelUrlPolicyConfig: vi.fn(() => ({})),
}));

const networkConfigMock = vi.hoisted(() => ({
	fetchWithModelRequestPolicyRedirects: vi.fn(),
}));

vi.mock("openai", () => ({
	default: class {
		constructor(options: unknown) {
			openaiMock.setClientOptions(options);
		}
		responses = {
			create: (params: unknown) => openaiMock.createStream(params),
		};
	},
}));

vi.mock("../../src/models/config-loader.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/models/config-loader.js")
	>("../../src/models/config-loader.js");
	return {
		...actual,
		getMergedCustomModelUrlPolicyConfig:
			configLoaderMock.getMergedCustomModelUrlPolicyConfig,
	};
});

vi.mock("../../src/providers/network-config.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/providers/network-config.js")
	>("../../src/providers/network-config.js");
	return {
		...actual,
		fetchWithModelRequestPolicyRedirects:
			networkConfigMock.fetchWithModelRequestPolicyRedirects,
	};
});

vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const baseContext: Context = {
	systemPrompt: "",
	messages: [],
	tools: [],
};

const responsesModel: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "gpt-test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1/responses",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 1024,
};

function makeEventStream(events: Array<unknown>): AsyncIterable<unknown> {
	return (async function* () {
		for (const event of events) {
			yield event;
		}
	})();
}

describe("OpenAI Responses SDK streaming", () => {
	beforeEach(() => {
		openaiMock.setStream(() => makeEventStream([]));
		openaiMock.reset();
		configLoaderMock.getMergedCustomModelUrlPolicyConfig.mockReset();
		configLoaderMock.getMergedCustomModelUrlPolicyConfig.mockReturnValue({});
		networkConfigMock.fetchWithModelRequestPolicyRedirects.mockReset();
		networkConfigMock.fetchWithModelRequestPolicyRedirects.mockResolvedValue(
			new Response("ok"),
		);
	});

	it("uses policy-aware redirect handling for SDK fetch hooks", async () => {
		const iterator = streamResponsesApiSdk(responsesModel, baseContext, {
			apiKey: "k",
		});

		await iterator.next();

		const clientOptions = openaiMock.getLastClientOptions() as {
			fetch: typeof fetch;
		};
		const response = await clientOptions.fetch(
			"https://gateway.example/v1/responses",
			{
				method: "POST",
				body: JSON.stringify({ hello: "world" }),
			},
		);

		expect(await response.text()).toBe("ok");
		expect(
			networkConfigMock.fetchWithModelRequestPolicyRedirects,
		).toHaveBeenCalledWith(
			"https://gateway.example/v1/responses",
			{
				method: "POST",
				body: JSON.stringify({ hello: "world" }),
			},
			expect.objectContaining({
				allowed: true,
				hostname: "gateway.example",
			}),
			{
				allowInternalBaseUrl: false,
				internalBaseUrl: "https://api.openai.com/v1/responses",
				policy: {},
			},
		);

		await iterator.return(undefined);
	});

	it("handles streaming function_call arguments", async () => {
		openaiMock.setStream(() =>
			makeEventStream([
				{
					type: "response.output_item.added",
					item: {
						type: "function_call",
						call_id: "call_1",
						id: "tool_1",
						name: "read",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					delta: '{"path": "',
				},
				{
					type: "response.function_call_arguments.delta",
					delta: '/tmp/test.txt"}',
				},
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call_1",
						id: "tool_1",
						name: "read",
						arguments: '{"path": "/tmp/test.txt"}',
					},
				},
				{
					type: "response.completed",
					response: { status: "completed" },
				},
			]),
		);

		const events: AssistantMessageEvent[] = [];
		for await (const ev of streamResponsesApiSdk(responsesModel, baseContext, {
			apiKey: "k",
		})) {
			events.push(ev);
		}

		const toolEnd = events.find((ev) => ev.type === "toolcall_end") as Extract<
			AssistantMessageEvent,
			{ type: "toolcall_end" }
		>;
		expect(toolEnd.toolCall.arguments).toEqual({ path: "/tmp/test.txt" });
	});

	it("handles object function_call arguments", async () => {
		openaiMock.setStream(() =>
			makeEventStream([
				{
					type: "response.output_item.added",
					item: {
						type: "function_call",
						call_id: "call_2",
						id: "tool_2",
						name: "read",
						arguments: { path: "/tmp/object.txt" },
					},
				},
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call_2",
						id: "tool_2",
						name: "read",
						arguments: { path: "/tmp/object.txt" },
					},
				},
				{
					type: "response.completed",
					response: { status: "completed" },
				},
			]),
		);

		const events: AssistantMessageEvent[] = [];
		for await (const ev of streamResponsesApiSdk(responsesModel, baseContext, {
			apiKey: "k",
		})) {
			events.push(ev);
		}

		const toolEnd = events.find((ev) => ev.type === "toolcall_end") as Extract<
			AssistantMessageEvent,
			{ type: "toolcall_end" }
		>;
		expect(toolEnd.toolCall.arguments).toEqual({ path: "/tmp/object.txt" });
	});

	it("filters user images when the model does not support image input", async () => {
		const context: Context = {
			...baseContext,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Check this" },
						{ type: "image", data: "abc", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
		};

		for await (const _ of streamResponsesApiSdk(responsesModel, context, {
			apiKey: "k",
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			input?: Array<{ role?: string; content?: Array<{ type: string }> }>;
		};
		const user = params.input?.find((entry) => entry.role === "user");
		expect(user?.content?.some((block) => block.type === "input_image")).toBe(
			false,
		);
	});

	it("merges provider-specific request body fields into responses requests", async () => {
		for await (const _ of streamResponsesApiSdk(responsesModel, baseContext, {
			apiKey: "k",
			requestBody: {
				provider_ref: {
					provider: "openai",
					environment: "prod",
				},
			},
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			provider_ref?: Record<string, string>;
		};
		expect(params.provider_ref).toEqual({
			provider: "openai",
			environment: "prod",
		});
	});

	it("adds tool result images as follow-up user content when supported", async () => {
		const modelWithImages: Model<"openai-responses"> = {
			...responsesModel,
			input: ["text", "image"],
		};

		const context: Context = {
			...baseContext,
			messages: [
				{
					role: "toolResult",
					toolCallId: "call_1|tool_1",
					toolName: "read",
					content: [{ type: "image", data: "abc", mimeType: "image/png" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};

		for await (const _ of streamResponsesApiSdk(modelWithImages, context, {
			apiKey: "k",
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			input?: Array<{ role?: string; content?: Array<{ type: string }> }>;
		};
		const hasImageMessage = params.input?.some(
			(entry) =>
				entry.role === "user" &&
				entry.content?.some((block) => block.type === "input_image"),
		);
		expect(hasImageMessage).toBe(true);
	});

	it("sets reasoning summary when provided", async () => {
		const reasoningModel: Model<"openai-responses"> = {
			...responsesModel,
			reasoning: true,
		};

		for await (const _ of streamResponsesApiSdk(reasoningModel, baseContext, {
			apiKey: "k",
			reasoningSummary: "detailed",
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			reasoning?: { effort?: string; summary?: string | null };
		};
		expect(params.reasoning?.summary).toBe("detailed");
		expect(params.reasoning?.effort).toBe("medium");
	});

	it("adds a gpt-5 reasoning suppression hint when no reasoning options are set", async () => {
		const gpt5Model: Model<"openai-responses"> = {
			...responsesModel,
			id: "gpt-5",
			name: "GPT-5",
			reasoning: true,
		};

		for await (const _ of streamResponsesApiSdk(gpt5Model, baseContext, {
			apiKey: "k",
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			input?: Array<{
				role?: string;
				content?: Array<{ type: string; text?: string }>;
			}>;
		};
		const hasHint = params.input?.some(
			(entry) =>
				entry.role === "developer" &&
				entry.content?.some((block) => block.text === "# Juice: 0 !important"),
		);
		expect(hasHint).toBe(true);
	});

	it("does not add a gpt-5 reasoning suppression hint when reasoning summary is set", async () => {
		const gpt5Model: Model<"openai-responses"> = {
			...responsesModel,
			id: "gpt-5",
			name: "GPT-5",
			reasoning: true,
		};

		for await (const _ of streamResponsesApiSdk(gpt5Model, baseContext, {
			apiKey: "k",
			reasoningSummary: "detailed",
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			reasoning?: { effort?: string; summary?: string };
			input?: Array<{
				role?: string;
				content?: Array<{ type: string; text?: string }>;
			}>;
		};
		expect(params.reasoning?.summary).toBe("detailed");
		expect(params.reasoning?.effort).toBe("medium");
		const hasHint = params.input?.some(
			(entry) =>
				entry.role === "developer" &&
				entry.content?.some((block) => block.text === "# Juice: 0 !important"),
		);
		expect(hasHint).toBe(false);
	});

	it("does not add a gpt-5 reasoning suppression hint when reasoning summary is null", async () => {
		const gpt5Model: Model<"openai-responses"> = {
			...responsesModel,
			id: "gpt-5",
			name: "GPT-5",
			reasoning: true,
		};

		for await (const _ of streamResponsesApiSdk(gpt5Model, baseContext, {
			apiKey: "k",
			reasoningSummary: null,
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			reasoning?: { effort?: string; summary?: string };
			input?: Array<{
				role?: string;
				content?: Array<{ type: string; text?: string }>;
			}>;
		};
		const hasHint = params.input?.some(
			(entry) =>
				entry.role === "developer" &&
				entry.content?.some((block) => block.text === "# Juice: 0 !important"),
		);
		expect(params.reasoning).toBeUndefined();
		expect(hasHint).toBe(false);
	});

	it("does not include a reasoning summary when only effort is provided", async () => {
		const reasoningModel: Model<"openai-responses"> = {
			...responsesModel,
			reasoning: true,
		};

		for await (const _ of streamResponsesApiSdk(reasoningModel, baseContext, {
			apiKey: "k",
			reasoningEffort: "low",
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			reasoning?: { effort?: string; summary?: string };
		};
		expect(params.reasoning?.effort).toBe("low");
		expect(params.reasoning?.summary).toBeUndefined();
	});

	it("sets tool_choice when tools are provided", async () => {
		const context: Context = {
			...baseContext,
			tools: [
				{
					name: "read",
					description: "read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
		};

		for await (const _ of streamResponsesApiSdk(responsesModel, context, {
			apiKey: "k",
			toolChoice: "none",
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			tool_choice?: string;
		};
		expect(params.tool_choice).toBe("none");
	});

	it("drops forced tool_choice when that tool is filtered out", async () => {
		const context: Context = {
			...baseContext,
			tools: [
				{
					name: "read",
					description: "read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
				{
					name: "unsupported",
					description: "unsupported schema",
					parameters: { enum: ["a", "b"] },
				},
			],
		};

		for await (const _ of streamResponsesApiSdk(responsesModel, context, {
			apiKey: "k",
			toolChoice: { type: "function", function: { name: "unsupported" } },
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			tools?: Array<{ name: string }>;
			tool_choice?: unknown;
		};
		expect(params.tools?.map((tool) => tool.name)).toEqual(["read"]);
		expect(params.tool_choice).toBeUndefined();
	});

	it("normalizes top-level union tool schemas before Responses filtering", async () => {
		const context: Context = {
			...baseContext,
			tools: [
				{
					name: "background_tasks",
					description: "manage background tasks",
					parameters: {
						anyOf: [
							{
								type: "object",
								properties: { action: { const: "list" } },
								required: ["action"],
							},
							{
								type: "object",
								properties: {
									action: { const: "stop", type: "string" },
									taskId: { type: "string" },
								},
								required: ["action"],
							},
						],
					},
				},
			],
		};

		for await (const _ of streamResponsesApiSdk(responsesModel, context, {
			apiKey: "k",
		})) {
			// drain
		}

		const params = openaiMock.getLastParams() as {
			tools?: Array<{
				name: string;
				parameters: Record<string, unknown>;
			}>;
		};
		expect(params.tools).toHaveLength(1);
		expect(params.tools?.[0]).toMatchObject({
			name: "background_tasks",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["list", "stop"] },
					taskId: { type: "string" },
				},
				required: ["action"],
				additionalProperties: false,
			},
		});
	});

	it("streams reasoning summary deltas when provided", async () => {
		openaiMock.setStream(() =>
			makeEventStream([
				{
					type: "response.output_item.added",
					item: {
						type: "reasoning",
						id: "reason_1",
						summary: [],
					},
				},
				{
					type: "response.reasoning_summary_part.added",
					part: { type: "summary_text", text: "" },
				},
				{
					type: "response.reasoning_summary_text.delta",
					delta: "Reasoning summary",
				},
				{
					type: "response.reasoning_summary_part.done",
				},
				{
					type: "response.output_item.done",
					item: {
						type: "reasoning",
						id: "reason_1",
						summary: [{ type: "summary_text", text: "Reasoning summary" }],
					},
				},
				{
					type: "response.completed",
					response: { status: "completed" },
				},
			]),
		);

		const events: AssistantMessageEvent[] = [];
		for await (const ev of streamResponsesApiSdk(responsesModel, baseContext, {
			apiKey: "k",
		})) {
			events.push(ev);
		}

		const deltas = events.filter(
			(ev) => ev.type === "thinking_delta",
		) as Extract<AssistantMessageEvent, { type: "thinking_delta" }>[];
		expect(
			deltas.some((delta) => delta.delta.includes("Reasoning summary")),
		).toBe(true);
	});

	it("adds X-Initiator header for GitHub Copilot responses", async () => {
		const copilotModel: Model<"openai-responses"> = {
			...responsesModel,
			provider: "github-copilot",
		};

		const context: Context = {
			...baseContext,
			messages: [
				{
					role: "user",
					content: "Hello",
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi" }],
					api: "openai-responses",
					provider: "github-copilot",
					model: "gpt-test",
					usage: {
						input: 0,
						output: 0,
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
			],
		};

		for await (const _ of streamResponsesApiSdk(copilotModel, context, {
			apiKey: "k",
		})) {
			// drain
		}

		const clientOptions = openaiMock.getLastClientOptions() as {
			defaultHeaders?: Record<string, string>;
		};
		expect(clientOptions.defaultHeaders?.["X-Initiator"]).toBe("agent");
	});

	it("re-checks each SDK fetch URL against allowedBaseUrls", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		configLoaderMock.getMergedCustomModelUrlPolicyConfig.mockReturnValue({
			allowedBaseUrls: ["https://api.openai.com/v1/responses"],
		});

		try {
			for await (const _ of streamResponsesApiSdk(responsesModel, baseContext, {
				apiKey: "k",
			})) {
				// drain
			}

			const clientOptions = openaiMock.getLastClientOptions() as {
				fetch?: (input: string, init?: RequestInit) => Promise<Response>;
			};
			expect(clientOptions.fetch).toBeTypeOf("function");
			await expect(
				clientOptions.fetch?.("https://api.openai.com/v1/chat/completions"),
			).rejects.toThrow(/not_in_allowed_base_urls/);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
