import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamResponsesApiSdk } from "../../src/agent/providers/openai-responses-sdk.js";
import type {
	AssistantMessageEvent,
	Context,
	Model,
} from "../../src/agent/types.js";

const openaiMock = vi.hoisted(() => {
	let streamFactory: () => AsyncIterable<unknown> = async function* () {};

	return {
		setStream(factory: () => AsyncIterable<unknown>) {
			streamFactory = factory;
		},
		createStream(): AsyncIterable<unknown> {
			return streamFactory();
		},
	};
});

vi.mock("openai", () => ({
	default: class {
		responses = {
			create: () => openaiMock.createStream(),
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
});
