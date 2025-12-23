import { TextEncoder } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamAnthropic } from "../../src/agent/providers/anthropic.js";
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

const baseModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com/v1/messages",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
};

const baseContext: Context = {
	systemPrompt: "",
	messages: [],
	tools: [],
};

function sse(event: string, data: Record<string, unknown>): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("Anthropic streaming", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses tool_use arguments from input_json_delta", async () => {
		const lines = [
			sse("message_start", {
				type: "message_start",
				message: {
					id: "msg_01",
					type: "message",
					role: "assistant",
					content: [],
					model: "claude-test",
					stop_reason: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			}),
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_1",
					name: "read",
				},
			}),
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: '{"path": "/tmp',
				},
			}),
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: '/test.txt"}',
				},
			}),
			sse("content_block_stop", { type: "content_block_stop", index: 0 }),
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 5 },
			}),
			sse("message_stop", { type: "message_stop" }),
		];

		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(makeStream(lines), { status: 200 }),
		);

		const events: AssistantMessageEvent[] = [];
		for await (const ev of streamAnthropic(baseModel, baseContext, {
			apiKey: "test-key",
		})) {
			events.push(ev);
		}

		const toolEnd = events.find((ev) => ev.type === "toolcall_end") as Extract<
			AssistantMessageEvent,
			{ type: "toolcall_end" }
		>;
		expect(toolEnd.toolCall.arguments).toEqual({ path: "/tmp/test.txt" });
	});

	it("accepts tool_use input object at block start", async () => {
		const lines = [
			sse("message_start", {
				type: "message_start",
				message: {
					id: "msg_02",
					type: "message",
					role: "assistant",
					content: [],
					model: "claude-test",
					stop_reason: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			}),
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_2",
					name: "read",
					input: { path: "/tmp/object.txt" },
				},
			}),
			sse("content_block_stop", { type: "content_block_stop", index: 0 }),
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 5 },
			}),
			sse("message_stop", { type: "message_stop" }),
		];

		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(makeStream(lines), { status: 200 }),
		);

		const events: AssistantMessageEvent[] = [];
		for await (const ev of streamAnthropic(baseModel, baseContext, {
			apiKey: "test-key",
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
