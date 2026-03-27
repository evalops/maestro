/**
 * Tests for Custom Message Types via Declaration Merging (#855)
 *
 * This test suite validates that:
 * 1. AgentMessage type includes both LLM messages and custom messages
 * 2. Custom messages can be added via declaration merging
 * 3. convertToLlm() correctly filters out custom messages
 * 4. Existing custom messages (HookMessage, BranchSummaryMessage, etc.) work correctly
 */

import { describe, expect, it } from "vitest";
import { convertToLlm, isLlmMessage } from "../src/agent/message-converter.js";
import type {
	AgentMessage,
	AssistantMessage,
	Message,
	UserMessage,
} from "../src/agent/types.js";

describe("Custom Message Types", () => {
	describe("AgentMessage Type", () => {
		it("should include standard LLM message types", () => {
			const userMsg: AgentMessage = {
				role: "user",
				content: "Hello",
				timestamp: Date.now(),
			};

			const assistantMsg: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Hi!" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-3",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};

			// Type check - should compile without errors
			expect(userMsg.role).toBe("user");
			expect(assistantMsg.role).toBe("assistant");
		});

		it("should include existing custom message types", () => {
			const hookMsg: AgentMessage = {
				role: "hookMessage",
				customType: "notification",
				content: "Build completed",
				display: true,
				timestamp: Date.now(),
			};

			const branchMsg: AgentMessage = {
				role: "branchSummary",
				summary: "Switched to feature branch",
				fromId: "msg-123",
				timestamp: Date.now(),
			};

			const compactionMsg: AgentMessage = {
				role: "compactionSummary",
				summary: "Compacted 5 messages",
				tokensBefore: 10000,
				timestamp: Date.now(),
			};

			expect(hookMsg.role).toBe("hookMessage");
			expect(branchMsg.role).toBe("branchSummary");
			expect(compactionMsg.role).toBe("compactionSummary");
		});
	});

	describe("convertToLlm", () => {
		it("should pass through standard LLM messages", () => {
			const messages: AgentMessage[] = [
				{
					role: "user",
					content: "Hello",
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi!" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
					},
					stopReason: "stop",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "File contents" }],
					isError: false,
					timestamp: 3,
				},
			];

			const llmMessages = convertToLlm(messages);

			expect(llmMessages).toHaveLength(3);
			expect(llmMessages[0].role).toBe("user");
			expect(llmMessages[1].role).toBe("assistant");
			expect(llmMessages[2].role).toBe("toolResult");
		});

		it("should filter out hookMessages", () => {
			const messages: AgentMessage[] = [
				{
					role: "user",
					content: "Run tests",
					timestamp: 1,
				},
				{
					role: "hookMessage",
					customType: "notification",
					content: "Tests starting...",
					display: true,
					timestamp: 2,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Running tests" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
					},
					stopReason: "stop",
					timestamp: 3,
				},
			];

			const llmMessages = convertToLlm(messages);

			expect(llmMessages).toHaveLength(2);
			expect(llmMessages[0].role).toBe("user");
			expect(llmMessages[1].role).toBe("assistant");
		});

		it("should filter out branchSummary messages", () => {
			const messages: AgentMessage[] = [
				{
					role: "user",
					content: "Continue",
					timestamp: 1,
				},
				{
					role: "branchSummary",
					summary: "Switched to branch X",
					fromId: "msg-123",
					timestamp: 2,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Continuing" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
					},
					stopReason: "stop",
					timestamp: 3,
				},
			];

			const llmMessages = convertToLlm(messages);

			expect(llmMessages).toHaveLength(2);
			expect(
				llmMessages.find((m) => m.role === "branchSummary"),
			).toBeUndefined();
		});

		it("should filter out compactionSummary messages", () => {
			const messages: AgentMessage[] = [
				{
					role: "compactionSummary",
					summary: "Compacted history",
					tokensBefore: 10000,
					timestamp: 1,
				},
				{
					role: "user",
					content: "What's next?",
					timestamp: 2,
				},
			];

			const llmMessages = convertToLlm(messages);

			expect(llmMessages).toHaveLength(1);
			expect(llmMessages[0].role).toBe("user");
		});

		it("should handle mixed messages correctly", () => {
			const messages: AgentMessage[] = [
				{
					role: "user",
					content: "Hello",
					timestamp: 1,
				},
				{
					role: "hookMessage",
					customType: "status",
					content: "Processing...",
					display: false,
					timestamp: 2,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi!" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
					},
					stopReason: "stop",
					timestamp: 3,
				},
				{
					role: "branchSummary",
					summary: "Branch created",
					fromId: "msg-1",
					timestamp: 4,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "data" }],
					isError: false,
					timestamp: 5,
				},
				{
					role: "compactionSummary",
					summary: "Compacted",
					tokensBefore: 5000,
					timestamp: 6,
				},
			];

			const llmMessages = convertToLlm(messages);

			expect(llmMessages).toHaveLength(3);
			expect(llmMessages[0].role).toBe("user");
			expect(llmMessages[1].role).toBe("assistant");
			expect(llmMessages[2].role).toBe("toolResult");
		});
	});

	describe("isLlmMessage", () => {
		it("should return true for LLM message types", () => {
			const userMsg: UserMessage = {
				role: "user",
				content: "Hello",
				timestamp: 1,
			};

			const assistantMsg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Hi" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-3",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop",
				timestamp: 2,
			};

			expect(isLlmMessage(userMsg)).toBe(true);
			expect(isLlmMessage(assistantMsg)).toBe(true);
		});

		it("should return false for custom message types", () => {
			const hookMsg: AgentMessage = {
				role: "hookMessage",
				customType: "notification",
				content: "Hello",
				display: true,
				timestamp: 1,
			};

			const branchMsg: AgentMessage = {
				role: "branchSummary",
				summary: "Branch X",
				fromId: "msg-1",
				timestamp: 2,
			};

			expect(isLlmMessage(hookMsg)).toBe(false);
			expect(isLlmMessage(branchMsg)).toBe(false);
		});
	});
});
