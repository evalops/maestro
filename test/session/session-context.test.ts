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
	return [
		{
			type: "session",
			id: "session-1",
			timestamp,
			cwd: "/tmp",
			model: "openai/gpt-5.2",
			thinkingLevel: "medium",
		},
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: "Read README",
				timestamp: 0,
			},
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp,
			message: {
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.2",
				usage: {
					input: 10,
					output: 4,
					cacheRead: 2,
					cacheWrite: 1,
					cost: {
						input: 0.1,
						output: 0.2,
						cacheRead: 0.01,
						cacheWrite: 0.02,
						total: 0.33,
					},
				},
				stopReason: "toolUse",
				timestamp: 1,
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
		},
		{
			type: "message",
			id: "tool-1",
			parentId: "assistant-1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: 2,
			},
		},
	];
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
});

function parseRustAuthoredToolSession(): SessionEntry[] {
	return [
		`{"type":"session","id":"session-1","timestamp":"${timestamp}","cwd":"/tmp","model":"openai/gpt-5.2","model_metadata":{"provider":"openai","model_id":"gpt-5.2","provider_name":"OpenAI","base_url":"https://example.test","context_window":100000,"max_tokens":4096},"thinking_level":"medium"}`,
		`{"type":"message","timestamp":"${timestamp}","message":{"role":"user","content":"Read README","timestamp":0}}`,
		`{"type":"message","timestamp":"${timestamp}","message":{"role":"assistant","api":"openai-responses","provider":"openai","model":"gpt-5.2","usage":{"input":10,"output":4,"cacheRead":2,"cacheWrite":1,"cost":{"input":0.1,"output":0.2,"cacheRead":0.01,"cacheWrite":0.02,"total":0.33}},"stop_reason":"tool_use","timestamp":1,"content":[{"type":"thinking","text":"Need a file read","signature":"sig-1"},{"type":"tool_call","id":"call-1","name":"read","args":{"path":"README.md"}}]}}`,
		`{"type":"message","timestamp":"${timestamp}","message":{"role":"toolResult","tool_call_id":"call-1","tool_name":"read","content":"file contents","is_error":false,"timestamp":2}}`,
		`{"type":"model_change","timestamp":"${timestamp}","model":"openai/gpt-5.2","model_metadata":{"provider":"openai","model_id":"gpt-5.2"}}`,
		`{"type":"thinking_level_change","timestamp":"${timestamp}","thinking_level":"high"}`,
		`{"type":"compaction","timestamp":"${timestamp}","summary":"Kept the useful work","first_kept_entry_index":0,"tokens_before":1234,"auto":true,"custom_instructions":"keep tool context"}`,
	]
		.map((line) => tryParseSessionEntry(line))
		.filter((entry): entry is SessionEntry => Boolean(entry));
}

describe("Rust-authored session compatibility", () => {
	it("normalizes legacy Rust snake_case transcript fields at parse time", () => {
		const entries = parseRustAuthoredToolSession();

		expect(entries[0]).toMatchObject({
			type: "session",
			thinkingLevel: "medium",
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
