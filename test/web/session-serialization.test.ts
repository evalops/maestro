import type { ComposerMessage } from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import type {
	AppMessage,
	AssistantMessage,
	ToolResultMessage,
} from "../src/agent/types.js";
import type { RegisteredModel } from "../src/models/registry.js";
import {
	convertAppMessagesToComposer,
	convertComposerMessagesToApp,
} from "../../src/web/session-serialization.js";

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
		expect(composerMessages[1]).toMatchObject({
			role: "assistant",
			content: "On it",
			thinking: "Plan steps",
			tools: [{ name: "read", args: { path: "package.json" } }],
		});
		expect(composerMessages[2]).toMatchObject({
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
			},
		];

		const appMessages = convertComposerMessagesToApp(
			composerMessages,
			mockModel,
		);

		expect(appMessages).toHaveLength(2);
		expect(appMessages[0].role).toBe("assistant");
		const assistant = appMessages[0] as AssistantMessage;
		expect(assistant.content?.some((part) => part.type === "thinking")).toBe(
			true,
		);
		const toolResult = appMessages[1] as ToolResultMessage;
		expect(toolResult.role).toBe("toolResult");
		expect(toolResult.content[0]).toMatchObject({
			type: "text",
			text: '{"path":"composer.json"}',
		});
	});
});
