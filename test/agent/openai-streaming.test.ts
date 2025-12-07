import { TextEncoder } from "node:util";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
		expect(result[0].name).toBe("valid");
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
		expect(result[0].name).toBe("simple");
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
		const [, fetchOptions] = mockFetch.mock.calls[0];
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
		const [, fetchOptions] = mockFetch.mock.calls[0];
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
		const [, fetchOptions] = mockFetch.mock.calls[0];
		const body = JSON.parse(fetchOptions.body);
		expect(body.tool_choice).toBeUndefined();
	});
});
