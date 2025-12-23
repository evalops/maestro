import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamGoogle } from "../../src/agent/providers/google.js";
import type {
	AssistantMessageEvent,
	Context,
	Model,
} from "../../src/agent/types.js";

const generateContentStream = vi.fn();

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = { generateContentStream };
	}

	return {
		GoogleGenAI,
		FinishReason: { STOP: "STOP" },
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY" },
	};
});

const baseModel: Model<"google-generative-ai"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
};

const baseContext: Context = {
	systemPrompt: "",
	messages: [],
	tools: [],
};

function makeStream(chunks: Array<Record<string, unknown>>) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	};
}

describe("Google streaming", () => {
	beforeEach(() => {
		generateContentStream.mockReset();
	});

	it("parses tool call arguments when args are stringified JSON", async () => {
		generateContentStream.mockResolvedValue(
			makeStream([
				{
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: {
											name: "read",
											args: '{"path": "/tmp/test.txt"}',
										},
									},
								],
							},
						},
					],
				},
			]),
		);

		const events: AssistantMessageEvent[] = [];
		for await (const ev of streamGoogle(baseModel, baseContext, {
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
});
