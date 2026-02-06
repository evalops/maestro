/**
 * Tests for performCompaction() — the consolidated compaction function.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type CompactionAgent,
	type CompactionSessionManager,
	performCompaction,
} from "../../src/agent/compaction.js";
import type {
	AppMessage,
	AssistantMessage,
	Usage,
} from "../../src/agent/types.js";

function createUsage(input = 0, output = 0): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text = "hello"): AppMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(
	text = "response",
	usage = createUsage(100, 50),
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-3-5-sonnet",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Build a conversation with the given number of turn pairs (user + assistant). */
function buildConversation(turns: number): AppMessage[] {
	const messages: AppMessage[] = [];
	for (let i = 0; i < turns; i++) {
		messages.push(createUserMessage(`message ${i}`));
		messages.push(
			createAssistantMessage(`response ${i}`, createUsage(100 * (i + 1), 50)),
		);
	}
	return messages;
}

function createMockAgent(messages: AppMessage[]): CompactionAgent {
	return {
		state: {
			messages,
			model: {
				api: "anthropic-messages",
				provider: "anthropic",
				id: "claude-3-5-sonnet",
			},
		},
		generateSummary: vi
			.fn()
			.mockResolvedValue(createAssistantMessage("LLM summary of conversation")),
		replaceMessages: vi.fn(),
	};
}

function createMockSessionManager(): CompactionSessionManager {
	return {
		buildSessionContext: vi.fn().mockReturnValue({
			messageEntries: Array.from({ length: 50 }, (_, i) => ({
				id: `entry-${i}`,
			})),
		}),
		saveCompaction: vi.fn(),
		saveMessage: vi.fn(),
	};
}

/** Extract the messages passed to replaceMessages from the mock. */
function getReplacedMessages(agent: CompactionAgent): AppMessage[] {
	const mock = agent.replaceMessages as ReturnType<typeof vi.fn>;
	const call = mock.mock.calls[0] as [AppMessage[]] | undefined;
	return call?.[0] ?? [];
}

describe("performCompaction", () => {
	it("returns failure when too few messages", async () => {
		const messages = buildConversation(2); // 4 messages, below keepCount+1=7
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Not enough history");
	});

	it("compacts successfully with sufficient messages", async () => {
		const messages = buildConversation(10); // 20 messages
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		expect(result.compactedCount).toBeGreaterThan(0);
		expect(result.summary).toBeDefined();
		expect(typeof result.summary).toBe("string");
		expect(result.firstKeptEntryIndex).toBeGreaterThan(0);
		expect(typeof result.tokensBefore).toBe("number");
		expect(agent.replaceMessages).toHaveBeenCalledOnce();
		expect(sessionManager.saveCompaction).toHaveBeenCalledOnce();
		// Should save summary + resume messages
		expect(sessionManager.saveMessage).toHaveBeenCalledTimes(2);
	});

	it("replaced messages start with summary and resume then kept messages", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({ agent, sessionManager });

		const replaced = getReplacedMessages(agent);
		// First message is the summary (assistant)
		expect(replaced[0]?.role).toBe("assistant");
		// Second message is the resume prompt (user)
		expect(replaced[1]?.role).toBe("user");
		// Must contain some kept messages from the end
		expect(replaced.length).toBeGreaterThan(2);
	});

	it("uses renderSummaryText callback when provided", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();
		const renderSummaryText = vi.fn().mockReturnValue("custom rendered text");

		await performCompaction({
			agent,
			sessionManager,
			renderSummaryText,
		});

		expect(renderSummaryText).toHaveBeenCalledOnce();
		const replaced = getReplacedMessages(agent);
		const summary = replaced[0] as AssistantMessage;
		const firstBlock = summary.content[0] as { type: string; text: string };
		expect(firstBlock.text).toContain("custom rendered text");
	});

	it("falls back to local summary when LLM fails", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		(agent.generateSummary as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("API failure"),
		);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });

		expect(result.success).toBe(true);
		const replaced = getReplacedMessages(agent);
		const summary = replaced[0] as AssistantMessage;
		const firstBlock = summary.content[0] as { type: string; text: string };
		expect(firstBlock.text).toContain("Local summary");
	});

	it("passes auto and customInstructions to saveCompaction", async () => {
		const messages = buildConversation(10);
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		await performCompaction({
			agent,
			sessionManager,
			auto: true,
			customInstructions: "Focus on database changes",
		});

		expect(sessionManager.saveCompaction).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Number),
			expect.any(Number),
			expect.objectContaining({
				auto: true,
				customInstructions: "Focus on database changes",
			}),
		);
	});

	it("handles edge case where boundary leaves no older messages", async () => {
		// 16 messages with very high token counts — boundary may be pushed high
		const messages: AppMessage[] = [];
		for (let i = 0; i < 8; i++) {
			messages.push(createUserMessage(`msg ${i}`));
			messages.push(
				createAssistantMessage(
					`resp ${i}`,
					createUsage(50000 * (i + 1), 25000),
				),
			);
		}
		const agent = createMockAgent(messages);
		const sessionManager = createMockSessionManager();

		const result = await performCompaction({ agent, sessionManager });
		// Either succeeds or fails gracefully — no throws
		expect(typeof result.success).toBe("boolean");
	});
});
