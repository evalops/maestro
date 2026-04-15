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
});
