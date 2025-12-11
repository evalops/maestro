import { describe, expect, it } from "vitest";
import { transformMessages } from "../../src/agent/providers/transform-messages.js";
import type {
	AssistantMessage,
	Message,
	Model,
} from "../../src/agent/types.js";

// Helper to create a mock model
function createModel(
	provider: string,
	api: string,
): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "Test Model",
		provider,
		api: api as "anthropic-messages",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		maxTokens: 4096,
	};
}

// Helper to create an assistant message
function createAssistantMessage(
	content: AssistantMessage["content"],
	provider = "anthropic",
	api = "anthropic-messages",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		provider,
		api: api as "anthropic-messages",
		model: "test-model",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("transformMessages", () => {
	describe("thinking block transformation", () => {
		it("preserves thinking blocks when same provider", () => {
			const messages: Message[] = [
				createAssistantMessage(
					[
						{ type: "thinking", thinking: "Let me think about this..." },
						{ type: "text", text: "Here is my response" },
					],
					"anthropic",
					"anthropic-messages",
				),
			];

			const model = createModel("anthropic", "anthropic-messages");
			const result = transformMessages(messages, model);

			expect(result[0].role).toBe("assistant");
			const content = (result[0] as AssistantMessage).content;
			expect(content).toHaveLength(2);
			expect(content[0].type).toBe("thinking");
		});

		it("converts thinking blocks to text when crossing providers", () => {
			const messages: Message[] = [
				createAssistantMessage(
					[
						{ type: "thinking", thinking: "Deep reasoning here" },
						{ type: "text", text: "Final answer" },
					],
					"anthropic",
					"anthropic-messages",
				),
			];

			const model = createModel("openai", "openai-completions");
			const result = transformMessages(messages, model);

			expect(result[0].role).toBe("assistant");
			const content = (result[0] as AssistantMessage).content;
			expect(content).toHaveLength(2);
			expect(content[0].type).toBe("text");
			expect((content[0] as { type: "text"; text: string }).text).toContain(
				"<thinking>",
			);
			expect((content[0] as { type: "text"; text: string }).text).toContain(
				"Deep reasoning here",
			);
		});

		it("converts thinking blocks when switching API within same provider", () => {
			const messages: Message[] = [
				createAssistantMessage(
					[{ type: "thinking", thinking: "Reasoning" }],
					"openai",
					"openai-completions",
				),
			];

			const model = createModel("openai", "openai-responses");
			const result = transformMessages(messages, model);

			const content = (result[0] as AssistantMessage).content;
			expect(content[0].type).toBe("text");
		});
	});

	describe("orphaned tool call filtering", () => {
		it("keeps tool calls with matching results", () => {
			const messages: Message[] = [
				createAssistantMessage([
					{ type: "text", text: "Let me read that file" },
					{
						type: "toolCall",
						id: "call_123",
						name: "read",
						arguments: { path: "/tmp/test.txt" },
					},
				]),
				{
					role: "toolResult",
					toolCallId: "call_123",
					toolName: "read",
					content: [{ type: "text", text: "file contents here" }],
					isError: false,
					timestamp: Date.now(),
				},
			];

			const model = createModel("anthropic", "anthropic-messages");
			const result = transformMessages(messages, model);

			const assistantContent = (result[0] as AssistantMessage).content;
			expect(assistantContent).toHaveLength(2);
			expect(assistantContent[1].type).toBe("toolCall");
		});

		it("filters out tool calls without results", () => {
			const messages: Message[] = [
				createAssistantMessage([
					{ type: "text", text: "Let me read that file" },
					{
						type: "toolCall",
						id: "call_123",
						name: "read",
						arguments: { path: "/tmp/test.txt" },
					},
				]),
				// No tool result follows - simulating aborted execution
				createAssistantMessage([{ type: "text", text: "Never mind" }]),
			];

			const model = createModel("anthropic", "anthropic-messages");
			const result = transformMessages(messages, model);

			const firstContent = (result[0] as AssistantMessage).content;
			expect(firstContent).toHaveLength(1);
			expect(firstContent[0].type).toBe("text");
		});

		it("keeps tool calls in the last message (ongoing turn)", () => {
			const messages: Message[] = [
				createAssistantMessage([
					{
						type: "toolCall",
						id: "call_pending",
						name: "bash",
						arguments: { command: "ls" },
					},
				]),
			];

			const model = createModel("anthropic", "anthropic-messages");
			const result = transformMessages(messages, model);

			const content = (result[0] as AssistantMessage).content;
			expect(content).toHaveLength(1);
			expect(content[0].type).toBe("toolCall");
		});

		it("handles multiple tool calls with partial results", () => {
			const messages: Message[] = [
				createAssistantMessage([
					{
						type: "toolCall",
						id: "call_1",
						name: "read",
						arguments: { path: "a.txt" },
					},
					{
						type: "toolCall",
						id: "call_2",
						name: "read",
						arguments: { path: "b.txt" },
					},
					{
						type: "toolCall",
						id: "call_3",
						name: "read",
						arguments: { path: "c.txt" },
					},
				]),
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "content a" }],
					isError: false,
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "call_3",
					toolName: "read",
					content: [{ type: "text", text: "content c" }],
					isError: false,
					timestamp: Date.now(),
				},
				// call_2 has no result - should be filtered
				createAssistantMessage([{ type: "text", text: "Done" }]),
			];

			const model = createModel("anthropic", "anthropic-messages");
			const result = transformMessages(messages, model);

			const firstContent = (result[0] as AssistantMessage).content;
			const toolCalls = firstContent.filter((b) => b.type === "toolCall");
			expect(toolCalls).toHaveLength(2);

			const toolCallIds = toolCalls.map(
				(t) => (t as { type: "toolCall"; id: string }).id,
			);
			expect(toolCallIds).toContain("call_1");
			expect(toolCallIds).toContain("call_3");
			expect(toolCallIds).not.toContain("call_2");
		});
	});

	describe("user and toolResult passthrough", () => {
		it("passes user messages unchanged", () => {
			const messages: Message[] = [
				{
					role: "user",
					content: [{ type: "text", text: "Hello" }],
					timestamp: Date.now(),
				},
			];

			const model = createModel("openai", "openai-completions");
			const result = transformMessages(messages, model);

			expect(result[0]).toEqual(messages[0]);
		});

		it("passes toolResult messages unchanged", () => {
			const messages: Message[] = [
				{
					role: "toolResult",
					toolCallId: "call_123",
					toolName: "test_tool",
					content: [{ type: "text", text: "result data" }],
					isError: false,
					timestamp: Date.now(),
				},
			];

			const model = createModel("anthropic", "anthropic-messages");
			const result = transformMessages(messages, model);

			expect(result[0]).toEqual(messages[0]);
		});
	});
});
