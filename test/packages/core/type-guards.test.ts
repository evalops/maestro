/**
 * TDD tests for type guards — verify message/content classification.
 * These guards are used throughout the agent loop to safely narrow types.
 */
import { describe, expect, it } from "vitest";

import {
	isAssistantMessage,
	isTextContent,
	isToolCall,
	isToolResultMessage,
	isUserMessage,
} from "../../../packages/core/src/index.js";

describe("Type Guards", () => {
	describe("isUserMessage", () => {
		it("matches user messages", () => {
			expect(isUserMessage({ role: "user", content: [] })).toBe(true);
		});

		it("rejects assistant messages", () => {
			expect(isUserMessage({ role: "assistant", content: [] })).toBe(false);
		});

		it("rejects tool result messages", () => {
			expect(isUserMessage({ role: "tool", content: [] })).toBe(false);
		});

		it("rejects null", () => {
			expect(isUserMessage(null)).toBe(false);
		});

		it("rejects undefined", () => {
			expect(isUserMessage(undefined)).toBe(false);
		});

		it("rejects plain strings", () => {
			expect(isUserMessage("hello")).toBe(false);
		});

		it("rejects objects without role", () => {
			expect(isUserMessage({ content: [] })).toBe(false);
		});
	});

	describe("isAssistantMessage", () => {
		it("matches assistant messages", () => {
			expect(isAssistantMessage({ role: "assistant", content: [] })).toBe(true);
		});

		it("rejects user messages", () => {
			expect(isAssistantMessage({ role: "user", content: [] })).toBe(false);
		});

		it("rejects null/undefined", () => {
			expect(isAssistantMessage(null)).toBe(false);
			expect(isAssistantMessage(undefined)).toBe(false);
		});
	});

	describe("isToolResultMessage", () => {
		it("matches tool result messages", () => {
			expect(isToolResultMessage({ role: "toolResult", content: [] })).toBe(
				true,
			);
		});

		it("rejects user messages", () => {
			expect(isToolResultMessage({ role: "user", content: [] })).toBe(false);
		});

		it("rejects null/undefined", () => {
			expect(isToolResultMessage(null)).toBe(false);
			expect(isToolResultMessage(undefined)).toBe(false);
		});
	});

	describe("isTextContent", () => {
		it("matches text content blocks", () => {
			expect(isTextContent({ type: "text", text: "hello" })).toBe(true);
		});

		it("rejects toolCall content", () => {
			expect(
				isTextContent({
					type: "toolCall",
					id: "1",
					name: "read",
					input: {},
				}),
			).toBe(false);
		});

		it("rejects null/undefined", () => {
			expect(isTextContent(null)).toBe(false);
			expect(isTextContent(undefined)).toBe(false);
		});

		it("rejects plain strings", () => {
			expect(isTextContent("hello")).toBe(false);
		});
	});

	describe("isToolCall", () => {
		it("matches toolCall content blocks", () => {
			expect(
				isToolCall({
					type: "toolCall",
					id: "tc-1",
					name: "read",
					input: { path: "test.ts" },
				}),
			).toBe(true);
		});

		it("rejects text content", () => {
			expect(isToolCall({ type: "text", text: "hello" })).toBe(false);
		});

		it("rejects null/undefined", () => {
			expect(isToolCall(null)).toBe(false);
			expect(isToolCall(undefined)).toBe(false);
		});

		it("rejects objects missing type", () => {
			expect(isToolCall({ id: "1", name: "read" })).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("handles empty objects", () => {
			expect(isUserMessage({})).toBe(false);
			expect(isAssistantMessage({})).toBe(false);
			expect(isTextContent({})).toBe(false);
			expect(isToolCall({})).toBe(false);
		});

		it("handles arrays", () => {
			expect(isUserMessage([])).toBe(false);
			expect(isToolCall([])).toBe(false);
		});

		it("handles numbers", () => {
			expect(isUserMessage(42)).toBe(false);
			expect(isTextContent(0)).toBe(false);
		});
	});
});
