import { describe, expect, it } from "vitest";

import type { AppMessage } from "../../src/agent/types.js";
import {
	extractTextFromContent,
	generateEntryId,
	isLikelyCompactionSummary,
} from "../../src/session/session-context.js";

describe("extractTextFromContent", () => {
	it("returns string content as-is", () => {
		expect(extractTextFromContent("hello world")).toBe("hello world");
	});

	it("extracts text from content blocks", () => {
		const content = [
			{ type: "text", text: "first" },
			{ type: "image" },
			{ type: "text", text: "second" },
		];
		expect(extractTextFromContent(content)).toBe("first second");
	});

	it("returns empty string for empty array", () => {
		expect(extractTextFromContent([])).toBe("");
	});

	it("skips non-text blocks", () => {
		const content = [{ type: "toolCall" }, { type: "text", text: "only this" }];
		expect(extractTextFromContent(content)).toBe("only this");
	});
});

describe("isLikelyCompactionSummary", () => {
	it("detects compaction summary with standard marker", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "Some text (Compacted from 50 messages)" },
			],
		} as unknown as AppMessage;
		expect(isLikelyCompactionSummary(message)).toBe(true);
	});

	it("detects language model handoff marker", () => {
		const message = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Another language model started to solve this problem and here is the context.",
				},
			],
		} as unknown as AppMessage;
		expect(isLikelyCompactionSummary(message)).toBe(true);
	});

	it("detects local summary marker", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "_Local summary of prior discussion_" }],
		} as unknown as AppMessage;
		expect(isLikelyCompactionSummary(message)).toBe(true);
	});

	it("returns false for regular assistant messages", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "Here is my response to your question." },
			],
		} as unknown as AppMessage;
		expect(isLikelyCompactionSummary(message)).toBe(false);
	});

	it("returns false for user messages", () => {
		const message = {
			role: "user",
			content: "(Compacted from 50 messages)",
		} as unknown as AppMessage;
		expect(isLikelyCompactionSummary(message)).toBe(false);
	});

	it("returns false for empty content", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
		} as unknown as AppMessage;
		expect(isLikelyCompactionSummary(message)).toBe(false);
	});
});

describe("generateEntryId", () => {
	it("generates an 8-char id", () => {
		const id = generateEntryId(new Set());
		expect(id).toHaveLength(8);
	});

	it("avoids collisions with existing ids", () => {
		const existing = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const id = generateEntryId(existing);
			expect(existing.has(id)).toBe(false);
			existing.add(id);
		}
	});
});
