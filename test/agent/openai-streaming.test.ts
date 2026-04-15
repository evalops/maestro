import { TextEncoder } from "node:util";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type OpenAIResponseFormat,
	type OpenAIToolChoice,
	filterResponsesApiTools,
	streamOpenAI,
} from "../../src/agent/providers/openai.js";
import type {
	AssistantMessageEvent,
	Context,
	Model,
} from "../../src/agent/types.js";

const encoder = new TextEncoder();

function makeStream(lines: string[]): ReadableStream {
	return new ReadableStream({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		},
	});
}

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

const completionsModel: Model<"openai-completions"> = {
	...responsesModel,
	api: "openai-completions",
	baseUrl: "https://api.openai.com/v1/chat/completions",
};

describe("OpenAI streaming", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("handles array content deltas safely (Completions API)", async () => {
		const lines = [
			'data: {"choices":[{"delta":{"content":[{"text":"Hello"}]}}]}\n',
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];

		const mockResponse = new Response(makeStream(lines), { status: 200 });
		mockFetch.mockResolvedValue(mockResponse);

		let messageText = "";
		for await (const ev of streamOpenAI(completionsModel, baseContext, {
			apiKey: "k",
		})) {
			if (ev.type === "text_delta") {
				messageText += ev.delta;
			}
		}

		expect(messageText).toBe("Hello");
	});

	it("handles tool call arguments as objects (Completions API)", async () => {
		const lines = [
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":{"path":"/tmp/test.txt"}}}]}}]}\n',
			'data: {"choices":[{"finish_reason":"tool_calls"}]}\n',
			"data: [DONE]\n",
		];

		const mockResponse = new Response(makeStream(lines), { status: 200 });
		mockFetch.mockResolvedValue(mockResponse);

		const events: AssistantMessageEvent[] = [];
		for await (const ev of streamOpenAI(completionsModel, baseContext, {
			apiKey: "k",
		})) {
			events.push(ev);
		}

		const toolEnd = events.find((ev) => ev.type === "toolcall_end") as Extract<
			AssistantMessageEvent,
			{ type: "toolcall_end" }
		>;
		const toolDelta = events.find(
			(ev) => ev.type === "toolcall_delta",
		) as Extract<AssistantMessageEvent, { type: "toolcall_delta" }>;
		expect(toolDelta.delta).toBe('{"path":"/tmp/test.txt"}');
		expect(toolEnd.toolCall.arguments).toEqual({ path: "/tmp/test.txt" });
	});

	it("uses max_tokens for OpenAI-compatible vendors", async () => {
		const lines = [
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];

		const mockResponse = new Response(makeStream(lines), { status: 200 });
		mockFetch.mockResolvedValue(mockResponse);

		const vendorModel: Model<"openai-completions"> = {
			...completionsModel,
			provider: "mistral",
			baseUrl: "https://api.mistral.ai/v1/chat/completions",
		};

		for await (const _ of streamOpenAI(vendorModel, baseContext, {
			apiKey: "k",
		})) {
			// consume stream
		}

		const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.max_tokens).toBe(vendorModel.maxTokens);
		expect(body.max_completion_tokens).toBeUndefined();
		expect(body.store).toBeUndefined();
	});

	it("merges provider-specific request body fields into chat completions", async () => {
		const lines = [
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];

		const mockResponse = new Response(makeStream(lines), { status: 200 });
		mockFetch.mockResolvedValue(mockResponse);

		for await (const _ of streamOpenAI(completionsModel, baseContext, {
			apiKey: "k",
			requestBody: {
				provider_ref: {
					provider: "openai",
					environment: "prod",
				},
			},
		})) {
			// consume stream
		}

		const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.provider_ref).toEqual({
			provider: "openai",
			environment: "prod",
		});
	});

	it("sends tool stubs for tool history and forwards tool result images", async () => {
		const lines = [
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];

		const mockResponse = new Response(makeStream(lines), { status: 200 });
		mockFetch.mockResolvedValue(mockResponse);

		const toolCallId = "call_image";
		const context: Context = {
			systemPrompt: "",
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: toolCallId,
							name: "screenshot",
							arguments: {},
						},
					],
					api: "openai-completions",
					provider: "openai",
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
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId,
					toolName: "screenshot",
					content: [
						{
							type: "image",
							data: "AAAA",
							mimeType: "image/png",
						},
					],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};

		const visionModel: Model<"openai-completions"> = {
			...completionsModel,
			input: ["text", "image"],
		};

		for await (const _ of streamOpenAI(visionModel, context, { apiKey: "k" })) {
			// consume stream
		}

		const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.tools).toEqual([]);
		const hasImageFollowup = body.messages.some(
			(message: { role: string; content?: Array<{ type: string }> }) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((part) => part.type === "image_url"),
		);
		expect(hasImageFollowup).toBe(true);
	});

	it("skips tool_choice when tools array is empty", async () => {
		const lines = [
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];

		const mockResponse = new Response(makeStream(lines), { status: 200 });
		mockFetch.mockResolvedValue(mockResponse);

		const toolCallId = "call_tool";
		const context: Context = {
			systemPrompt: "",
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: toolCallId,
							name: "read",
							arguments: { path: "/tmp/test.txt" },
						},
					],
					api: "openai-completions",
					provider: "openai",
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
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
			],
		};

		for await (const _ of streamOpenAI(completionsModel, context, {
			apiKey: "k",
			toolChoice: "required",
		})) {
			// consume stream
		}

		const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.tools).toEqual([]);
		expect(body.tool_choice).toBeUndefined();
	});
});

// Note: Responses API SDK tests are integration tests that require actual API calls
// or complex SDK mocking. The SDK implementation is tested via the actual API behavior.
// Unit tests focus on the utility functions and Completions API which uses raw SSE.

describe("filterResponsesApiTools", () => {
	it("filters out tools with empty names", () => {
		const tools = [
			{ name: "", description: "empty", parameters: {} },
			{ name: "valid", description: "valid tool", parameters: {} },
		];
		const result = filterResponsesApiTools(tools);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("valid");
	});

	it("filters out tools with oneOf schema", () => {
		const tools = [
			{
				name: "complex",
				description: "complex tool",
				parameters: { oneOf: [{ type: "string" }, { type: "number" }] },
			},
			{ name: "simple", description: "simple tool", parameters: {} },
		];
		const result = filterResponsesApiTools(tools);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("simple");
	});

	it("filters out tools with anyOf schema", () => {
		const tools = [
			{
				name: "anyof",
				description: "anyOf tool",
				parameters: { anyOf: [{ type: "string" }] },
			},
		];
		const result = filterResponsesApiTools(tools);
		expect(result).toHaveLength(0);
	});

	it("filters out tools with allOf schema", () => {
		const tools = [
			{
				name: "allof",
				description: "allOf tool",
				parameters: { allOf: [{ required: ["a"] }] },
			},
		];
		const result = filterResponsesApiTools(tools);
		expect(result).toHaveLength(0);
	});

	it("filters out tools with enum schema", () => {
		const tools = [
			{
				name: "enumtool",
				description: "enum tool",
				parameters: { enum: ["a", "b", "c"] },
			},
		];
		const result = filterResponsesApiTools(tools);
		expect(result).toHaveLength(0);
	});

	it("filters out tools with not schema", () => {
		const tools = [
			{
				name: "nottool",
				description: "not tool",
				parameters: { not: { type: "null" } },
			},
		];
		const result = filterResponsesApiTools(tools);
		expect(result).toHaveLength(0);
	});

	it("keeps tools with valid nested schemas", () => {
		const tools = [
			{
				name: "nested",
				description: "nested properties are ok",
				parameters: {
					type: "object",
					properties: {
						field: { oneOf: [{ type: "string" }] }, // nested oneOf is ok
					},
				},
			},
		];
		const result = filterResponsesApiTools(tools);
		expect(result).toHaveLength(1);
	});

	it("handles null/undefined parameters", () => {
		const tools = [
			{ name: "nullparams", description: "null params", parameters: null },
			{
				name: "undefinedparams",
				description: "undefined params",
				parameters: undefined,
			},
		];
		const result = filterResponsesApiTools(
			tools as Array<{
				name: string;
				description: string;
				parameters: unknown;
			}>,
		);
		expect(result).toHaveLength(2);
	});
});

describe("toolChoice parameter", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const contextWithTools: Context = {
		systemPrompt: "",
		messages: [],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: Type.Object({}),
			},
		],
	};

	const completionsModel: Model<"openai-completions"> = {
		id: "gpt-4",
		name: "GPT-4",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1/chat/completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	};

	it('includes tool_choice "required" in request body', async () => {
		const lines = [
			'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];
		const mockResponse = new Response(
			new ReadableStream({
				start(controller) {
					for (const line of lines) {
						controller.enqueue(new TextEncoder().encode(line));
					}
					controller.close();
				},
			}),
			{ status: 200 },
		);
		mockFetch.mockResolvedValue(mockResponse);

		// Consume the generator to trigger the fetch
		for await (const _ of streamOpenAI(completionsModel, contextWithTools, {
			apiKey: "k",
			toolChoice: "required",
		})) {
			// consume events
		}

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, fetchOptions] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(fetchOptions.body);
		expect(body.tool_choice).toBe("required");
	});

	it("includes specific tool choice in request body", async () => {
		const lines = [
			'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];
		const mockResponse = new Response(
			new ReadableStream({
				start(controller) {
					for (const line of lines) {
						controller.enqueue(new TextEncoder().encode(line));
					}
					controller.close();
				},
			}),
			{ status: 200 },
		);
		mockFetch.mockResolvedValue(mockResponse);

		const specificTool: OpenAIToolChoice = {
			type: "function",
			function: { name: "test_tool" },
		};

		for await (const _ of streamOpenAI(completionsModel, contextWithTools, {
			apiKey: "k",
			toolChoice: specificTool,
		})) {
			// consume events
		}

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, fetchOptions] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(fetchOptions.body);
		expect(body.tool_choice).toEqual(specificTool);
	});

	it("does not include tool_choice when not specified", async () => {
		const lines = [
			'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];
		const mockResponse = new Response(
			new ReadableStream({
				start(controller) {
					for (const line of lines) {
						controller.enqueue(new TextEncoder().encode(line));
					}
					controller.close();
				},
			}),
			{ status: 200 },
		);
		mockFetch.mockResolvedValue(mockResponse);

		for await (const _ of streamOpenAI(completionsModel, contextWithTools, {
			apiKey: "k",
		})) {
			// consume events
		}

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, fetchOptions] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(fetchOptions.body);
		expect(body.tool_choice).toBeUndefined();
	});
});

describe("responseFormat parameter (Structured Outputs)", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseContext: Context = {
		systemPrompt: "",
		messages: [],
		tools: [],
	};

	const completionsModel: Model<"openai-completions"> = {
		id: "gpt-4o-2024-08-06",
		name: "GPT-4o",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1/chat/completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	};

	it("includes json_object response_format in request body", async () => {
		const lines = [
			'data: {"choices":[{"delta":{"content":"{\\"name\\":\\"test\\"}"}}]}\n',
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];
		const mockResponse = new Response(
			new ReadableStream({
				start(controller) {
					for (const line of lines) {
						controller.enqueue(new TextEncoder().encode(line));
					}
					controller.close();
				},
			}),
			{ status: 200 },
		);
		mockFetch.mockResolvedValue(mockResponse);

		const responseFormat: OpenAIResponseFormat = { type: "json_object" };

		for await (const _ of streamOpenAI(completionsModel, baseContext, {
			apiKey: "k",
			responseFormat,
		})) {
			// consume events
		}

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, fetchOptions] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(fetchOptions.body);
		expect(body.response_format).toEqual({ type: "json_object" });
	});

	it("includes json_schema response_format in request body", async () => {
		const lines = [
			'data: {"choices":[{"delta":{"content":"{\\"name\\":\\"Alice\\",\\"age\\":30}"}}]}\n',
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];
		const mockResponse = new Response(
			new ReadableStream({
				start(controller) {
					for (const line of lines) {
						controller.enqueue(new TextEncoder().encode(line));
					}
					controller.close();
				},
			}),
			{ status: 200 },
		);
		mockFetch.mockResolvedValue(mockResponse);

		const responseFormat: OpenAIResponseFormat = {
			type: "json_schema",
			json_schema: {
				name: "person",
				strict: true,
				schema: {
					type: "object",
					properties: {
						name: { type: "string" },
						age: { type: "number" },
					},
					required: ["name", "age"],
					additionalProperties: false,
				},
			},
		};

		for await (const _ of streamOpenAI(completionsModel, baseContext, {
			apiKey: "k",
			responseFormat,
		})) {
			// consume events
		}

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, fetchOptions] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(fetchOptions.body);
		expect(body.response_format).toEqual(responseFormat);
	});

	it("includes json_schema with description in request body", async () => {
		const lines = [
			'data: {"choices":[{"delta":{"content":"{\\"items\\":[]}"}}]}\n',
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];
		const mockResponse = new Response(
			new ReadableStream({
				start(controller) {
					for (const line of lines) {
						controller.enqueue(new TextEncoder().encode(line));
					}
					controller.close();
				},
			}),
			{ status: 200 },
		);
		mockFetch.mockResolvedValue(mockResponse);

		const responseFormat: OpenAIResponseFormat = {
			type: "json_schema",
			json_schema: {
				name: "shopping_list",
				description: "A list of items to buy",
				strict: true,
				schema: {
					type: "object",
					properties: {
						items: {
							type: "array",
							items: { type: "string" },
						},
					},
					required: ["items"],
					additionalProperties: false,
				},
			},
		};

		for await (const _ of streamOpenAI(completionsModel, baseContext, {
			apiKey: "k",
			responseFormat,
		})) {
			// consume events
		}

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, fetchOptions] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(fetchOptions.body);
		expect(body.response_format).toEqual(responseFormat);
		expect(body.response_format.json_schema.description).toBe(
			"A list of items to buy",
		);
	});

	it("does not include response_format when not specified", async () => {
		const lines = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];
		const mockResponse = new Response(
			new ReadableStream({
				start(controller) {
					for (const line of lines) {
						controller.enqueue(new TextEncoder().encode(line));
					}
					controller.close();
				},
			}),
			{ status: 200 },
		);
		mockFetch.mockResolvedValue(mockResponse);

		for await (const _ of streamOpenAI(completionsModel, baseContext, {
			apiKey: "k",
		})) {
			// consume events
		}

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, fetchOptions] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(fetchOptions.body);
		expect(body.response_format).toBeUndefined();
	});
});
