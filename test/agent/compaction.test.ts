/**
 * Tests for the Context Compaction Module
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	SUMMARIZATION_PROMPT,
	adjustBoundaryForToolResults,
	buildLocalSummary,
	buildSummarizationPrompt,
	calculateContextTokens,
	calculateUsagePercent,
	decorateSummaryText,
	findCutPoint,
	findPreviousSummary,
	getLastAssistantUsage,
	prepareCompaction,
	shouldCompact,
} from "../../src/agent/compaction.js";
import type {
	AppMessage,
	AssistantMessage,
	Usage,
} from "../../src/agent/types.js";

function createUsage(
	input: number,
	output: number,
	cacheRead = 0,
	cacheWrite = 0,
): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(
	usage: Usage,
	stopReason: "stop" | "toolUse" = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-3-5-sonnet",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text = "hello"): AppMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function createToolResultMessage(toolCallId: string): AppMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "Bash",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createAssistantWithToolCall(
	toolCallId: string,
	usage: Usage,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: "Bash",
				arguments: { command: "ls" },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-3-5-sonnet",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("Context Compaction", () => {
	describe("calculateContextTokens", () => {
		it("sums all token types", () => {
			const usage = createUsage(100, 50, 200, 150);
			expect(calculateContextTokens(usage)).toBe(500);
		});

		it("handles zero values", () => {
			const usage = createUsage(0, 0, 0, 0);
			expect(calculateContextTokens(usage)).toBe(0);
		});
	});

	describe("getLastAssistantUsage", () => {
		it("returns usage from last non-aborted assistant", () => {
			const messages: AppMessage[] = [
				createUserMessage(),
				createAssistantMessage(createUsage(100, 50)),
				createUserMessage("followup"),
				createAssistantMessage(createUsage(200, 100)),
			];

			const usage = getLastAssistantUsage(messages);
			expect(usage?.input).toBe(200);
			expect(usage?.output).toBe(100);
		});

		it("skips aborted messages", () => {
			const abortedMessage: AssistantMessage = {
				...createAssistantMessage(createUsage(500, 500)),
				stopReason: "aborted",
			};
			const messages: AppMessage[] = [
				createUserMessage(),
				createAssistantMessage(createUsage(100, 50)),
				createUserMessage("followup"),
				abortedMessage,
			];

			const usage = getLastAssistantUsage(messages);
			expect(usage?.input).toBe(100);
		});

		it("returns null for no assistant messages", () => {
			const messages: AppMessage[] = [createUserMessage()];
			expect(getLastAssistantUsage(messages)).toBeNull();
		});
	});

	describe("shouldCompact", () => {
		it("returns true when context exceeds threshold", () => {
			const settings = { ...DEFAULT_COMPACTION_SETTINGS, enabled: true };
			// Context window is 100k, reserve is 16384, so threshold is ~83616
			expect(shouldCompact(90000, 100000, settings)).toBe(true);
		});

		it("returns false when context is below threshold", () => {
			const settings = { ...DEFAULT_COMPACTION_SETTINGS, enabled: true };
			expect(shouldCompact(50000, 100000, settings)).toBe(false);
		});

		it("returns false when disabled", () => {
			const settings = { ...DEFAULT_COMPACTION_SETTINGS, enabled: false };
			expect(shouldCompact(90000, 100000, settings)).toBe(false);
		});
	});

	describe("calculateUsagePercent", () => {
		it("calculates percentage correctly", () => {
			expect(calculateUsagePercent(50000, 100000)).toBe(50);
			expect(calculateUsagePercent(75000, 100000)).toBe(75);
		});

		it("handles zero context window", () => {
			expect(calculateUsagePercent(50000, 0)).toBe(0);
		});
	});

	describe("findCutPoint", () => {
		it("finds cut point based on token usage", () => {
			const messages: AppMessage[] = [
				createUserMessage("1"),
				createAssistantMessage(createUsage(1000, 500)),
				createUserMessage("2"),
				createAssistantMessage(createUsage(5000, 2500)),
				createUserMessage("3"),
				createAssistantMessage(createUsage(15000, 7500)),
				createUserMessage("4"),
				createAssistantMessage(createUsage(25000, 12000)),
			];

			// keepRecentTokens = 20000, newest usage = 37000
			// Looking for where diff >= 20000
			const cutPoint = findCutPoint(messages, 0, messages.length, 20000);
			expect(cutPoint).toBeGreaterThan(0);
			expect(cutPoint).toBeLessThan(messages.length);
		});

		it("returns start index when no user messages", () => {
			const messages: AppMessage[] = [
				createAssistantMessage(createUsage(1000, 500)),
				createAssistantMessage(createUsage(2000, 1000)),
			];

			expect(findCutPoint(messages, 0, messages.length, 20000)).toBe(0);
		});
	});

	describe("adjustBoundaryForToolResults", () => {
		it("keeps tool call and result together", () => {
			const messages: AppMessage[] = [
				createUserMessage("1"),
				createAssistantWithToolCall("tc1", createUsage(1000, 500)),
				createToolResultMessage("tc1"),
				createUserMessage("2"),
				createAssistantMessage(createUsage(2000, 1000)),
			];

			// Try to cut at index 2 (toolResult) - should adjust to include the assistant
			const adjusted = adjustBoundaryForToolResults(messages, 2);
			expect(adjusted).toBe(1); // Should move back to include toolCall
		});

		it("does not change boundary when tool integrity is maintained", () => {
			const messages: AppMessage[] = [
				createUserMessage("1"),
				createAssistantWithToolCall("tc1", createUsage(1000, 500)),
				createToolResultMessage("tc1"),
				createUserMessage("2"),
				createAssistantMessage(createUsage(2000, 1000)),
			];

			// Cut at index 3 (user message) - tool call/result pair is complete before this
			const adjusted = adjustBoundaryForToolResults(messages, 3);
			expect(adjusted).toBe(3);
		});
	});

	describe("buildSummarizationPrompt", () => {
		it("returns base prompt without custom instructions", () => {
			expect(buildSummarizationPrompt()).toBe(SUMMARIZATION_PROMPT);
		});

		it("appends custom instructions", () => {
			const custom = "Focus on database changes";
			const prompt = buildSummarizationPrompt(custom);
			expect(prompt).toContain(SUMMARIZATION_PROMPT);
			expect(prompt).toContain(custom);
		});
	});

	describe("decorateSummaryText", () => {
		it("adds handoff prefix for model summary", () => {
			const decorated = decorateSummaryText("summary content", 10, true);
			expect(decorated).toContain("Another language model");
			expect(decorated).toContain("summary content");
			expect(decorated).toContain("Compacted 10 messages");
		});

		it("adds local prefix for fallback summary", () => {
			const decorated = decorateSummaryText("local summary", 5, false);
			expect(decorated).toContain("Local summary");
			expect(decorated).toContain("local summary");
			expect(decorated).toContain("Compacted 5 messages");
		});
	});

	describe("buildLocalSummary", () => {
		it("creates bullet point summary", () => {
			const messages: AppMessage[] = [
				createUserMessage("First question"),
				createAssistantMessage(createUsage(100, 50)),
				createUserMessage("Second question"),
				createAssistantMessage(createUsage(200, 100)),
			];

			const summary = buildLocalSummary(messages);
			expect(summary).toContain("User 1");
			expect(summary).toContain("User 2");
		});

		it("handles empty messages", () => {
			const summary = buildLocalSummary([]);
			expect(summary).toContain("placeholder");
		});
	});

	describe("findPreviousSummary", () => {
		it("finds previous compaction summary", () => {
			const compactionMessage: AssistantMessage = {
				...createAssistantMessage(createUsage(100, 50)),
				content: [
					{
						type: "text",
						text: "Another language model started to solve this problem...",
					},
				],
			};
			const messages: AppMessage[] = [
				compactionMessage,
				createUserMessage(),
				createAssistantMessage(createUsage(200, 100)),
			];

			const summary = findPreviousSummary(messages);
			expect(summary).toContain("Another language model");
		});

		it("returns undefined when no summary exists", () => {
			const messages: AppMessage[] = [
				createUserMessage(),
				createAssistantMessage(createUsage(200, 100)),
			];

			expect(findPreviousSummary(messages)).toBeUndefined();
		});
	});

	describe("prepareCompaction", () => {
		it("returns null when not enough messages", () => {
			const messages: AppMessage[] = [
				createUserMessage(),
				createAssistantMessage(createUsage(100, 50)),
			];

			expect(
				prepareCompaction(messages, DEFAULT_COMPACTION_SETTINGS),
			).toBeNull();
		});

		it("splits messages correctly", () => {
			const messages: AppMessage[] = [];
			for (let i = 0; i < 10; i++) {
				messages.push(createUserMessage(`message ${i}`));
				messages.push(
					createAssistantMessage(createUsage(100 * (i + 1), 50 * (i + 1))),
				);
			}

			const result = prepareCompaction(messages, DEFAULT_COMPACTION_SETTINGS);
			expect(result).not.toBeNull();
			expect(result?.keptMessages.length).toBeGreaterThan(0);
			expect(result?.messagesToSummarize.length).toBeGreaterThan(0);
			expect(result?.cutIndex).toBeGreaterThan(0);
		});
	});

	describe("DEFAULT_COMPACTION_SETTINGS", () => {
		it("has expected defaults", () => {
			expect(DEFAULT_COMPACTION_SETTINGS.enabled).toBe(true);
			expect(DEFAULT_COMPACTION_SETTINGS.reserveTokens).toBe(16384);
			expect(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens).toBe(20000);
		});
	});
});
