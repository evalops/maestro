import { TextEncoder } from "node:util";
import { Type } from "@sinclair/typebox";
import {
	type MockInstance,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { streamAnthropic } from "../../src/agent/providers/anthropic.js";
import type { AgentTool, Context, Model } from "../../src/agent/types.js";

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

const baseTool: AgentTool = {
	name: "test_tool",
	description: "A test tool",
	parameters: Type.Object({ input: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
};

describe("Anthropic advanced tool features", () => {
	let fetchSpy: MockInstance<typeof fetch>;
	let capturedHeaders: Record<string, string> = {};

	beforeEach(() => {
		capturedHeaders = {};
		fetchSpy = vi
			.spyOn(global, "fetch")
			.mockImplementation(async (...args: Parameters<typeof fetch>) => {
				const [, init] = args;
				capturedHeaders = (init?.headers as Record<string, string>) || {};
				const lines = [
					'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
					'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
					'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
					'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
					'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
					'event: message_stop\ndata: {"type":"message_stop"}\n\n',
				];
				return new Response(makeStream(lines), { status: 200 });
			});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("adds advanced-tool-use beta header when tool has deferApiDefinition", async () => {
		const toolWithDefer: AgentTool = {
			...baseTool,
			deferApiDefinition: true,
		};

		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [toolWithDefer],
		};

		const events: unknown[] = [];
		for await (const ev of streamAnthropic(baseModel, context, {
			apiKey: "test-key",
		})) {
			events.push(ev);
		}

		expect(capturedHeaders["anthropic-beta"]).toContain(
			"advanced-tool-use-2025-11-20",
		);
	});

	it("adds advanced-tool-use beta header when tool has inputExamples", async () => {
		const toolWithExamples: AgentTool = {
			...baseTool,
			inputExamples: [{ input: "example" }],
		};

		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [toolWithExamples],
		};

		const events: unknown[] = [];
		for await (const ev of streamAnthropic(baseModel, context, {
			apiKey: "test-key",
		})) {
			events.push(ev);
		}

		expect(capturedHeaders["anthropic-beta"]).toContain(
			"advanced-tool-use-2025-11-20",
		);
	});

	it("adds advanced-tool-use beta header when tool has allowedCallers", async () => {
		const toolWithCallers: AgentTool = {
			...baseTool,
			allowedCallers: ["other_tool"],
		};

		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [toolWithCallers],
		};

		const events: unknown[] = [];
		for await (const ev of streamAnthropic(baseModel, context, {
			apiKey: "test-key",
		})) {
			events.push(ev);
		}

		expect(capturedHeaders["anthropic-beta"]).toContain(
			"advanced-tool-use-2025-11-20",
		);
	});

	it("adds advanced-tool-use beta header when tool has toolType", async () => {
		const toolWithType: AgentTool = {
			...baseTool,
			toolType: "custom",
		};

		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [toolWithType],
		};

		const events: unknown[] = [];
		for await (const ev of streamAnthropic(baseModel, context, {
			apiKey: "test-key",
		})) {
			events.push(ev);
		}

		expect(capturedHeaders["anthropic-beta"]).toContain(
			"advanced-tool-use-2025-11-20",
		);
	});

	it("does not add advanced-tool-use beta header for basic tools", async () => {
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [baseTool],
		};

		const events: unknown[] = [];
		for await (const ev of streamAnthropic(baseModel, context, {
			apiKey: "test-key",
		})) {
			events.push(ev);
		}

		expect(capturedHeaders["anthropic-beta"]).not.toContain(
			"advanced-tool-use-2025-11-20",
		);
	});

	it("does not add advanced-tool-use beta header for empty inputExamples array", async () => {
		const toolWithEmptyExamples: AgentTool = {
			...baseTool,
			inputExamples: [],
		};

		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [toolWithEmptyExamples],
		};

		const events: unknown[] = [];
		for await (const ev of streamAnthropic(baseModel, context, {
			apiKey: "test-key",
		})) {
			events.push(ev);
		}

		expect(capturedHeaders["anthropic-beta"]).not.toContain(
			"advanced-tool-use-2025-11-20",
		);
	});

	it("does not add advanced-tool-use beta header for empty allowedCallers array", async () => {
		const toolWithEmptyCallers: AgentTool = {
			...baseTool,
			allowedCallers: [],
		};

		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [toolWithEmptyCallers],
		};

		const events: unknown[] = [];
		for await (const ev of streamAnthropic(baseModel, context, {
			apiKey: "test-key",
		})) {
			events.push(ev);
		}

		expect(capturedHeaders["anthropic-beta"]).not.toContain(
			"advanced-tool-use-2025-11-20",
		);
	});

	it("adds header when at least one tool has advanced features among multiple tools", async () => {
		const advancedTool: AgentTool = {
			...baseTool,
			name: "advanced_tool",
			deferApiDefinition: true,
		};

		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [baseTool, advancedTool],
		};

		const events: unknown[] = [];
		for await (const ev of streamAnthropic(baseModel, context, {
			apiKey: "test-key",
		})) {
			events.push(ev);
		}

		expect(capturedHeaders["anthropic-beta"]).toContain(
			"advanced-tool-use-2025-11-20",
		);
	});
});
