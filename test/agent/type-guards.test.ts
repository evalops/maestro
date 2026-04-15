/**
 * Tests for type guards and utility functions.
 */

import { describe, expect, it } from "vitest";
import type {
	AppMessage,
	AssistantMessage,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "../../src/agent/types.js";

/** Helper to create a minimal Usage object for tests */
function makeUsage(input = 5, output = 5): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
import {
	countMessagesByRole,
	getFirstToolCall,
	getImageContent,
	getLastAssistantMessage,
	getLastUserMessage,
	getTextContent,
	getThinkingContent,
	getToolCalls,
	getUserMessageText,
	hasAttachments,
	hasToolCalls,
	isAssistantMessage,
	isErrorResult,
	isImageContent,
	isLLMMessage,
	isTextContent,
	isThinkingContent,
	isToolCall,
	isToolResultMessage,
	isUserMessage,
} from "../../src/agent/type-guards.js";

describe("type-guards", () => {
	describe("message type guards", () => {
		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "Hello" }],
			timestamp: Date.now(),
		};

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Hi there" },
				{ type: "toolCall", id: "1", name: "test", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3",
			usage: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "1",
			toolName: "test",
			content: [{ type: "text", text: "Result" }],
			isError: false,
			timestamp: Date.now(),
		};

		it("isUserMessage correctly identifies user messages", () => {
			expect(isUserMessage(userMessage)).toBe(true);
			expect(isUserMessage(assistantMessage)).toBe(false);
			expect(isUserMessage(toolResultMessage)).toBe(false);
			expect(isUserMessage(null)).toBe(false);
			expect(isUserMessage(undefined)).toBe(false);
			expect(isUserMessage({})).toBe(false);
		});

		it("isAssistantMessage correctly identifies assistant messages", () => {
			expect(isAssistantMessage(assistantMessage)).toBe(true);
			expect(isAssistantMessage(userMessage)).toBe(false);
			expect(isAssistantMessage(toolResultMessage)).toBe(false);
		});

		it("isToolResultMessage correctly identifies tool results", () => {
			expect(isToolResultMessage(toolResultMessage)).toBe(true);
			expect(isToolResultMessage(userMessage)).toBe(false);
			expect(isToolResultMessage(assistantMessage)).toBe(false);
		});

		it("isLLMMessage identifies core message types", () => {
			expect(isLLMMessage(userMessage)).toBe(true);
			expect(isLLMMessage(assistantMessage)).toBe(true);
			expect(isLLMMessage(toolResultMessage)).toBe(true);
			expect(isLLMMessage({ role: "hookMessage" })).toBe(false);
		});
	});

	describe("content type guards", () => {
		const textContent = { type: "text", text: "Hello" };
		const thinkingContent = { type: "thinking", thinking: "Hmm..." };
		const imageContent = {
			type: "image",
			data: "base64",
			mimeType: "image/png",
		};
		const toolCall = { type: "toolCall", id: "1", name: "test", arguments: {} };

		it("isTextContent correctly identifies text content", () => {
			expect(isTextContent(textContent)).toBe(true);
			expect(isTextContent(thinkingContent)).toBe(false);
			expect(isTextContent(imageContent)).toBe(false);
			expect(isTextContent(toolCall)).toBe(false);
		});

		it("isThinkingContent correctly identifies thinking content", () => {
			expect(isThinkingContent(thinkingContent)).toBe(true);
			expect(isThinkingContent(textContent)).toBe(false);
		});

		it("isImageContent correctly identifies image content", () => {
			expect(isImageContent(imageContent)).toBe(true);
			expect(isImageContent(textContent)).toBe(false);
		});

		it("isToolCall correctly identifies tool calls", () => {
			expect(isToolCall(toolCall)).toBe(true);
			expect(isToolCall(textContent)).toBe(false);
		});
	});

	describe("utility functions", () => {
		const assistantWithTools: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Let me think..." },
				{ type: "text", text: "I will help you." },
				{
					type: "toolCall",
					id: "1",
					name: "read",
					arguments: { path: "/test" },
				},
				{
					type: "toolCall",
					id: "2",
					name: "write",
					arguments: { path: "/out" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3",
			usage: makeUsage(10, 20),
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const assistantTextOnly: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Just text" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3",
			usage: makeUsage(5, 10),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		it("getToolCalls extracts all tool calls", () => {
			const calls = getToolCalls(assistantWithTools);
			expect(calls).toHaveLength(2);
			expect(calls[0]!.name).toBe("read");
			expect(calls[1]!.name).toBe("write");
		});

		it("getToolCalls returns empty array when no tools", () => {
			expect(getToolCalls(assistantTextOnly)).toHaveLength(0);
		});

		it("getFirstToolCall returns first tool call", () => {
			const first = getFirstToolCall(assistantWithTools);
			expect(first).toBeDefined();
			expect(first?.name).toBe("read");
		});

		it("getFirstToolCall returns undefined when no tools", () => {
			expect(getFirstToolCall(assistantTextOnly)).toBeUndefined();
		});

		it("hasToolCalls checks for tool call presence", () => {
			expect(hasToolCalls(assistantWithTools)).toBe(true);
			expect(hasToolCalls(assistantTextOnly)).toBe(false);
		});

		it("getTextContent extracts and joins text", () => {
			expect(getTextContent(assistantWithTools)).toBe("I will help you.");
			expect(getTextContent(assistantTextOnly)).toBe("Just text");
		});

		it("getThinkingContent extracts thinking", () => {
			expect(getThinkingContent(assistantWithTools)).toBe("Let me think...");
			expect(getThinkingContent(assistantTextOnly)).toBe("");
		});

		it("getUserMessageText handles string content", () => {
			const msg: UserMessage = {
				role: "user",
				content: "Plain string",
				timestamp: Date.now(),
			};
			expect(getUserMessageText(msg)).toBe("Plain string");
		});

		it("getUserMessageText handles array content", () => {
			const msg: UserMessage = {
				role: "user",
				content: [
					{ type: "text", text: "Part 1" },
					{ type: "text", text: " Part 2" },
				],
				timestamp: Date.now(),
			};
			expect(getUserMessageText(msg)).toBe("Part 1 Part 2");
		});
	});

	describe("isErrorResult", () => {
		it("returns true for error results", () => {
			const errorResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "1",
				toolName: "test",
				content: [{ type: "text", text: "Error!" }],
				isError: true,
				timestamp: Date.now(),
			};
			expect(isErrorResult(errorResult)).toBe(true);
		});

		it("returns false for success results", () => {
			const successResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "1",
				toolName: "test",
				content: [{ type: "text", text: "Success" }],
				isError: false,
				timestamp: Date.now(),
			};
			expect(isErrorResult(successResult)).toBe(false);
		});
	});

	describe("getLastAssistantMessage", () => {
		it("returns last assistant message", () => {
			const messages: AppMessage[] = [
				{ role: "user", content: "Hi", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "First" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3",
					usage: makeUsage(5, 5),
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "More", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "Last" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3",
					usage: makeUsage(5, 5),
					stopReason: "stop",
					timestamp: Date.now(),
				},
			];
			const last = getLastAssistantMessage(messages);
			expect(last).toBeDefined();
			if (last) {
				expect(getTextContent(last)).toBe("Last");
			}
		});

		it("returns undefined when no assistant messages", () => {
			const messages: AppMessage[] = [
				{ role: "user", content: "Hi", timestamp: Date.now() },
			];
			expect(getLastAssistantMessage(messages)).toBeUndefined();
		});
	});

	describe("getLastUserMessage", () => {
		it("returns last user message", () => {
			const messages: AppMessage[] = [
				{ role: "user", content: "First", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "Response" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3",
					usage: makeUsage(5, 5),
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "Last", timestamp: Date.now() },
			];
			const last = getLastUserMessage(messages);
			expect(last).toBeDefined();
			if (last) {
				expect(getUserMessageText(last)).toBe("Last");
			}
		});
	});

	describe("countMessagesByRole", () => {
		it("counts messages by role", () => {
			const messages: AppMessage[] = [
				{ role: "user", content: "1", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "2" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3",
					usage: makeUsage(5, 5),
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "3", timestamp: Date.now() },
				{
					role: "toolResult",
					toolCallId: "1",
					toolName: "test",
					content: [],
					isError: false,
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "4" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3",
					usage: makeUsage(5, 5),
					stopReason: "stop",
					timestamp: Date.now(),
				},
			];
			const counts = countMessagesByRole(messages);
			expect(counts.user).toBe(2);
			expect(counts.assistant).toBe(2);
			expect(counts.toolResult).toBe(1);
			expect(counts.other).toBe(0);
		});
	});

	describe("hasAttachments", () => {
		it("returns true when attachments present", () => {
			const msg = {
				role: "user" as const,
				content: "Hi",
				timestamp: Date.now(),
				attachments: [{ type: "file" as const, path: "/test" }],
			};
			expect(hasAttachments(msg)).toBe(true);
		});

		it("returns false when no attachments", () => {
			const msg = {
				role: "user" as const,
				content: "Hi",
				timestamp: Date.now(),
			};
			expect(hasAttachments(msg)).toBe(false);
		});

		it("returns false for empty attachments array", () => {
			const msg = {
				role: "user" as const,
				content: "Hi",
				timestamp: Date.now(),
				attachments: [],
			};
			expect(hasAttachments(msg)).toBe(false);
		});
	});

	describe("getImageContent", () => {
		it("extracts image content from array", () => {
			const content = [
				{ type: "text" as const, text: "Hello" },
				{ type: "image" as const, data: "abc", mimeType: "image/png" },
				{ type: "image" as const, data: "def", mimeType: "image/jpeg" },
			];
			const images = getImageContent(content);
			expect(images).toHaveLength(2);
			expect(images[0]!.mimeType).toBe("image/png");
			expect(images[1]!.mimeType).toBe("image/jpeg");
		});

		it("returns empty array when no images", () => {
			const content = [{ type: "text" as const, text: "Hello" }];
			expect(getImageContent(content)).toHaveLength(0);
		});
	});
});
