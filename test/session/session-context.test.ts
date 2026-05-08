import type { Stats } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AppMessage } from "../../src/agent/types.js";
import {
	buildSessionContextFromEntries,
	buildSessionFileInfo,
	extractTextFromContent,
	generateEntryId,
	isLikelyCompactionSummary,
} from "../../src/session/session-context.js";
import {
	type SessionEntry,
	tryParseSessionEntry,
} from "../../src/session/types.js";
import { parseSessionWireFixture } from "./session-wire-fixtures.js";

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

const timestamp = "2024-01-15T10:30:00.000Z";

function createTypescriptToolSession(): SessionEntry[] {
	return parseSessionWireFixture("canonical-tool-session.jsonl");
}

describe("session context compatibility", () => {
	it("rebuilds TypeScript-authored tool sessions", () => {
		const entries = createTypescriptToolSession();
		const context = buildSessionContextFromEntries(entries);

		expect(context.thinkingLevel).toBe("medium");
		expect(context.model).toBe("openai/gpt-5.2");
		expect(context.messages).toHaveLength(3);
		expect(context.messages[1]).toMatchObject({
			role: "assistant",
			stopReason: "toolUse",
		});
		expect(context.messageEntries.map((entry) => entry.id)).toEqual([
			"user-1",
			"assistant-1",
			"tool-1",
		]);
	});

	it("summarizes TypeScript-authored tool sessions for catalog search", () => {
		const stats = { birthtime: new Date(timestamp) } as Stats;
		const info = buildSessionFileInfo(createTypescriptToolSession(), stats);

		expect(info?.messageCount).toBe(3);
		expect(info?.firstMessage).toBe("Read README");
		expect(info?.allMessagesText).toContain("[tool call] read");
		expect(info?.allMessagesText).toContain("file contents");
	});

	it("can skip message hydration while preserving message counts", () => {
		const stats = { birthtime: new Date(timestamp) } as Stats;
		const info = buildSessionFileInfo(createTypescriptToolSession(), stats, {
			messagesView: "notLoaded",
		});

		expect(info?.messagesView).toBe("notLoaded");
		expect(info?.messageCount).toBe(3);
		expect(info?.messages).toEqual([]);
	});
});

function parseRustAuthoredToolSession(): SessionEntry[] {
	return parseSessionWireFixture("legacy-rust-tool-session.jsonl");
}

describe("Rust-authored session compatibility", () => {
	it("normalizes legacy Rust snake_case transcript fields at parse time", () => {
		const entries = parseRustAuthoredToolSession();

		expect(entries[0]).toMatchObject({
			type: "session",
			thinkingLevel: "medium",
			systemPrompt: "Persisted system",
			branchedFrom: "parent-session",
			modelMetadata: {
				modelId: "gpt-5.2",
				providerName: "OpenAI",
				baseUrl: "https://example.test",
				contextWindow: 100000,
				maxTokens: 4096,
			},
		});
		expect(entries[2]).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{
						type: "thinking",
						thinking: "Need a file read",
						thinkingSignature: "sig-1",
					},
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { path: "README.md" },
					},
				],
			},
		});
		expect(entries[3]).toMatchObject({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
			},
		});
		expect(entries[4]).toMatchObject({
			type: "model_change",
			modelMetadata: { modelId: "gpt-5.2" },
		});
		expect(entries[5]).toMatchObject({
			type: "thinking_level_change",
			thinkingLevel: "high",
		});
		expect(entries[6]).toMatchObject({
			type: "compaction",
			firstKeptEntryIndex: 0,
			tokensBefore: 1234,
			customInstructions: "keep tool context",
		});
	});

	it("normalizes legacy Rust stop reason values to TypeScript values", () => {
		const stopReasons = [
			["tool_use", "toolUse"],
			["tool_calls", "toolUse"],
			["max_tokens", "length"],
			["end_turn", "stop"],
			["stop_sequence", "stop"],
			["error", "error"],
		] as const;

		for (const [rustStopReason, expected] of stopReasons) {
			const entry = tryParseSessionEntry(
				`{"type":"message","timestamp":"${timestamp}","message":{"role":"assistant","stop_reason":"${rustStopReason}","content":[],"timestamp":1}}`,
			);

			expect(entry).toMatchObject({
				type: "message",
				message: { role: "assistant", stopReason: expected },
			});
		}
	});

	it("leaves prototype-named alias values unchanged", () => {
		const entry = tryParseSessionEntry(
			`{"type":"message","timestamp":"${timestamp}","message":{"role":"assistant","stop_reason":"constructor","content":[{"type":"constructor","text":"kept"}],"timestamp":1}}`,
		);

		expect(entry).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				stopReason: "constructor",
				content: [{ type: "constructor", text: "kept" }],
			},
		});
	});

	it("summarizes legacy Rust tool sessions without losing tool calls", () => {
		const stats = { birthtime: new Date(timestamp) } as Stats;
		const info = buildSessionFileInfo(parseRustAuthoredToolSession(), stats);

		expect(info?.messageCount).toBe(3);
		expect(info?.firstMessage).toBe("Read README");
		expect(info?.allMessagesText).toContain("[thinking] Need a file read");
		expect(info?.allMessagesText).toContain("[tool call] read");
		expect(info?.allMessagesText).toContain("file contents");
	});
});
