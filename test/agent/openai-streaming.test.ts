import { TextDecoder, TextEncoder } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAI } from "../../src/agent/providers/openai.js";
import type { Context, Model } from "../../src/agent/types.js";

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

const baseContext: Context = { systemPrompt: "", messages: [] } as any;

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
	beforeEach(() => {
		vi.spyOn(global, "fetch");
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
		(global.fetch as any).mockResolvedValue(mockResponse);

		const events: any[] = [];
		for await (const ev of streamOpenAI(responsesModel, baseContext, {
			apiKey: "k",
		})) {
			events.push(ev);
		}

		const start = events.find((e) => e.type === "toolcall_start");
		const end = events.find((e) => e.type === "toolcall_end");
		expect(start).toBeTruthy();
		expect(end).toBeTruthy();
		// ensure sequence
		expect(events.indexOf(start)).toBeLessThan(events.indexOf(end));
	});

	it("handles array content deltas safely (Completions API)", async () => {
		const lines = [
			'data: {"choices":[{"delta":{"content":[{"text":"Hello"}]}}]}\n',
			'data: {"choices":[{"finish_reason":"stop"}]}\n',
			"data: [DONE]\n",
		];

		const mockResponse = new Response(makeStream(lines), { status: 200 });
		(global.fetch as any).mockResolvedValue(mockResponse);

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
