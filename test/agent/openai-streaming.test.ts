import { TextEncoder } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

	it("emits toolcall_start when only function_call_arguments.done arrives (Responses API)", async () => {
		const lines = [
			'data: {"type":"response.function_call_arguments.done","call_id":"tc1","name":"do","arguments":"{\\"foo\\":1}","output_index":0}\n',
			'data: {"type":"response.done","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":0}}}\n',
			"data: [DONE]\n",
		];

		const mockResponse = new Response(makeStream(lines), { status: 200 });
		mockFetch.mockResolvedValue(mockResponse);

		const events: AssistantMessageEvent[] = [];
		for await (const ev of streamOpenAI(responsesModel, baseContext, {
			apiKey: "k",
		})) {
			events.push(ev);
		}

		const start = events.find((e) => e.type === "toolcall_start");
		const end = events.find((e) => e.type === "toolcall_end");
		expect(start).toBeTruthy();
		expect(end).toBeTruthy();
		// ensure sequence - assertions above ensure these aren't undefined
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(events.indexOf(start!)).toBeLessThan(
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			events.indexOf(end!),
		);
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

	it("streams text content from Responses API", async () => {
		const lines = [
			'data: {"type":"response.output_text.delta","delta":"Hello "}\n',
			'data: {"type":"response.output_text.delta","delta":"world!"}\n',
			'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":2}}}\n',
			"data: [DONE]\n",
		];

		const mockResponse = new Response(makeStream(lines), { status: 200 });
		mockFetch.mockResolvedValue(mockResponse);

		let messageText = "";
		let doneEvent: AssistantMessageEvent | undefined;
		for await (const ev of streamOpenAI(responsesModel, baseContext, {
			apiKey: "k",
		})) {
			if (ev.type === "text_delta") {
				messageText += ev.delta;
			}
			if (ev.type === "done") {
				doneEvent = ev;
			}
		}

		expect(messageText).toBe("Hello world!");
		expect(doneEvent).toBeTruthy();
		expect(doneEvent?.type).toBe("done");
	});

	it("tracks usage from Responses API completed event", async () => {
		const lines = [
			'data: {"type":"response.output_text.delta","delta":"Hi"}\n',
			'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":10}}}}\n',
			"data: [DONE]\n",
		];

		const mockResponse = new Response(makeStream(lines), { status: 200 });
		mockFetch.mockResolvedValue(mockResponse);

		let doneEvent: AssistantMessageEvent | undefined;
		for await (const ev of streamOpenAI(responsesModel, baseContext, {
			apiKey: "k",
		})) {
			if (ev.type === "done") {
				doneEvent = ev;
			}
		}

		expect(doneEvent).toBeTruthy();
		if (doneEvent?.type === "done") {
			// Usage is on the message, not directly on the event
			expect(doneEvent.message.usage.input).toBe(100);
			// Output includes reasoning tokens: 50 + 10 = 60
			expect(doneEvent.message.usage.output).toBe(60);
		}
	});
});

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
