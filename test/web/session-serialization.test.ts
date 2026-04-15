import type { ComposerMessage } from "@evalops/contracts";
import { isComposerMessage } from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import type {
	AppMessage,
	AssistantMessage,
	ToolCall,
	ToolResultMessage,
} from "../../src/agent/types.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import {
	SessionSerializationError,
	convertAppMessageToComposer,
	convertAppMessagesToComposer,
	convertComposerMessageToApp,
	convertComposerMessagesToApp,
} from "../../src/server/session-serialization.js";

const mockUsage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const mockModel: RegisteredModel = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com/v1/messages",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
	providerName: "Anthropic",
	source: "builtin",
	isLocal: false,
};

const mockOpenAiModel: RegisteredModel = {
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1/chat/completions",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
	providerName: "OpenAI",
	source: "builtin",
	isLocal: false,
};

describe("session serialization", () => {
	it("converts app messages with thinking and tools to composer format", () => {
		const userMessage: AppMessage = {
			role: "user",
			content: [{ type: "text", text: "Read file" }],
			timestamp: 1732067400000,
		};

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Plan steps" },
				{ type: "text", text: "On it" },
				{
					type: "toolCall",
					id: "tool-1",
					name: "read",
					arguments: { path: "package.json" },
				},
			],
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			usage: mockUsage(),
			stopReason: "stop",
			timestamp: 1732067405000,
		};

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: '{"path":"package.json"}' }],
			isError: false,
			timestamp: 1732067406000,
		};

		const composerMessages = convertAppMessagesToComposer([
			userMessage,
			assistantMessage,
			toolResult,
		]);

		expect(composerMessages).toHaveLength(3);
		expect(composerMessages.every((msg) => isComposerMessage(msg))).toBe(true);
		expect(composerMessages[1]!).toMatchObject({
			role: "assistant",
			content: "On it",
			thinking: "Plan steps",
			tools: [{ name: "read", args: { path: "package.json" } }],
		});
		expect(composerMessages[2]!).toMatchObject({
			role: "tool",
			toolName: "read",
			content: '{"path":"package.json"}',
		});
	});

	it("converts composer messages back to app messages with tool results", () => {
		const composerMessages: ComposerMessage[] = [
			{
				role: "assistant",
				content: "Completed",
				thinking: "Read file",
				timestamp: new Date(1732067500000).toISOString(),
				tools: [
					{
						name: "read",
						status: "completed",
						args: { path: "composer.json" },
						toolCallId: "tool-2",
					},
				],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 1,
					cacheWrite: 0,
					cost: { input: 0.01, output: 0.02, cacheRead: 0.001, total: 0.031 },
				},
			},
		];

		const appMessages = convertComposerMessagesToApp(
			composerMessages,
			mockModel,
		);

		expect(appMessages).toHaveLength(2);
		expect(appMessages[0]!.role).toBe("assistant");
		const assistant = appMessages[0] as AssistantMessage;
		expect(assistant.usage?.input).toBe(10);
		expect(assistant.usage?.cost.total).toBeCloseTo(0.031);
		expect(
			assistant.content?.some(
				(part: AssistantMessage["content"][number]) => part.type === "thinking",
			),
		).toBe(true);
		const toolResult = appMessages[1] as ToolResultMessage;
		expect(toolResult.role).toBe("toolResult");
		expect(toolResult.content[0]).toMatchObject({
			type: "text",
			text: '{"path":"composer.json"}',
		});
	});

	it("preserves tool call IDs when content includes tool calls", () => {
		const composerMessage: ComposerMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Running tool" },
				{
					type: "toolCall",
					id: "tool-42",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			timestamp: new Date(1732067600000).toISOString(),
			tools: [
				{
					name: "read",
					status: "completed",
					args: { path: "README.md" },
					toolCallId: "tool-42",
				},
			],
		};

		const appMessages = convertComposerMessageToApp(composerMessage, mockModel);
		expect(appMessages).toHaveLength(2);
		const toolResult = appMessages[1] as ToolResultMessage;
		expect(toolResult.toolCallId).toBe("tool-42");
	});

	it("summarizes image content when converting app messages", () => {
		const userMessage: AppMessage = {
			role: "user",
			content: [
				{
					type: "image",
					data: "base64",
					mimeType: "image/png",
				},
			],
			timestamp: Date.now(),
		};

		const composerMessage = convertAppMessageToComposer(userMessage);
		expect(composerMessage.content).toContain("[image:image/png]");
	});

	it("round-trips assistant usage and preserves tool order", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Reasoning" },
				{ type: "text", text: "First" },
				{
					type: "toolCall",
					id: "tool-abc",
					name: "alpha",
					arguments: { a: 1 },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 111,
				output: 222,
				cacheRead: 3,
				cacheWrite: 4,
				cost: {
					input: 0.01,
					output: 0.02,
					cacheRead: 0.001,
					cacheWrite: 0.002,
					total: 0.033,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const composer = convertAppMessagesToComposer([assistant]);
		expect(composer[0]!.usage?.input).toBe(111);

		const roundTrip = convertComposerMessagesToApp(composer, mockModel);
		const roundAssistant = roundTrip[0] as AssistantMessage;
		expect(roundAssistant.usage?.output).toBe(222);
		const contentTypes = roundAssistant.content?.map(
			(p: AssistantMessage["content"][number]) => p.type,
		);
		expect(contentTypes).toEqual(["thinking", "text", "toolCall"]);
	});

	it("preserves assistant provenance when hydrating across providers", () => {
		const composerMessages: ComposerMessage[] = [
			{
				role: "assistant",
				content: "Hello",
				thinking: "Reasoning",
				provider: "anthropic",
				api: "anthropic-messages",
				model: "claude-sonnet-4-5",
				timestamp: new Date().toISOString(),
			},
		];

		const appMessages = convertComposerMessagesToApp(
			composerMessages,
			mockOpenAiModel,
		);

		const assistant = appMessages[0] as AssistantMessage;
		expect(assistant.provider).toBe("anthropic");
		expect(assistant.api).toBe("anthropic-messages");
		expect(assistant.model).toBe("claude-sonnet-4-5");
		expect(assistant.content.some((part) => part.type === "thinking")).toBe(
			true,
		);
	});

	it("throws descriptive errors for invalid composer timestamps", () => {
		const composerMessage: ComposerMessage = {
			role: "user",
			content: "hello",
			timestamp: "invalid-date",
		};

		expect(() =>
			convertComposerMessageToApp(composerMessage, mockModel),
		).toThrow(SessionSerializationError);
	});

	it("normalizes missing tool metadata when round-tripping", () => {
		const composerMessage: ComposerMessage = {
			role: "assistant",
			content: "Tool work",
			timestamp: new Date().toISOString(),
			tools: [
				{
					name: "",
					status: "completed",
				},
			],
		};

		const appMessages = convertComposerMessageToApp(composerMessage, mockModel);
		expect(appMessages).toHaveLength(2);
		const assistant = appMessages[0] as AssistantMessage;
		const toolCall = assistant.content.find(
			(part): part is ToolCall => part.type === "toolCall",
		);
		expect(toolCall?.name).toMatch(/tool_/);
		expect(toolCall?.id).toMatch(/web-tool/);
		const toolResult = appMessages[1] as ToolResultMessage;
		expect(toolResult.toolName).toEqual(toolCall?.name);
	});
});
