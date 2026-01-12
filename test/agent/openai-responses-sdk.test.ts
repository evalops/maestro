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

	return {
		setStream(factory: () => AsyncIterable<unknown>) {
			streamFactory = factory;
		},
		createStream(params?: unknown): AsyncIterable<unknown> {
			lastParams = params;
			return streamFactory();
		},
		getLastParams() {
			return lastParams;
		},
		reset() {
			lastParams = undefined;
		},
	};
});

vi.mock("openai", () => ({
	default: class {
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
});
