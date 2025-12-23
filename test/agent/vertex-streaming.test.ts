import { TextEncoder } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamVertex } from "../../src/agent/providers/vertex.js";
import type {
	AssistantMessageEvent,
	Context,
	Model,
} from "../../src/agent/types.js";

vi.mock("google-auth-library", () => {
	return {
		GoogleAuth: class {
			async getAccessToken() {
				return "test-token";
			}
		},
	};
});

const encoder = new TextEncoder();

function makeStream(chunks: string[]): ReadableStream {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

const baseModel: Model<"vertex-ai"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "vertex-ai",
	provider: "vertex",
	baseUrl: "https://vertex.example.com",
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

describe("Vertex streaming", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses tool call arguments when args are stringified JSON", async () => {
		const payload =
			'[{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":"{\\"path\\":\\"/tmp/test.txt\\"}"}}]}}]}]';

		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(makeStream([payload]), { status: 200 }),
		);

		const events: AssistantMessageEvent[] = [];
		for await (const ev of streamVertex(baseModel, baseContext, {
			projectId: "test-project",
			location: "us-central1",
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
