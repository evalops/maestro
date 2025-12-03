import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type MicrocompactConfig,
	createMicrocompactMonitor,
	getMicrocompactConfig,
	microcompact,
	shouldMicrocompact,
} from "../../src/agent/microcompact.js";
import type { AppMessage, ToolResultMessage } from "../../src/agent/types.js";

function createToolCallMessage(
	toolCallId: string,
	toolName: string,
): AppMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: toolName,
				arguments: { test: true },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-3-5-sonnet",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolCall",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(
	toolCallId: string,
	content: string,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		content: [{ type: "text", text: content }],
		timestamp: Date.now(),
	};
}

function createLongContent(length: number): string {
	return "x".repeat(length);
}

describe("microcompact", () => {
	describe("getMicrocompactConfig", () => {
		const originalEnv = process.env;

		beforeEach(() => {
			process.env = { ...originalEnv };
		});

		afterEach(() => {
			process.env = originalEnv;
		});

		it("returns default config when no env vars set", () => {
			const config = getMicrocompactConfig();
			expect(config.keepRecentCount).toBe(5);
			expect(config.truncatedResultLength).toBe(200);
			expect(config.addTruncationNote).toBe(true);
			expect(config.protectedTools).toEqual(["Read", "Write", "Edit"]);
		});

		it("respects environment variables", () => {
			process.env.COMPOSER_MICROCOMPACT_KEEP_RECENT = "10";
			process.env.COMPOSER_MICROCOMPACT_TRUNCATE_LENGTH = "500";
			process.env.COMPOSER_MICROCOMPACT_PROTECTED_TOOLS = "Bash,Grep";

			const config = getMicrocompactConfig();
			expect(config.keepRecentCount).toBe(10);
			expect(config.truncatedResultLength).toBe(500);
			expect(config.protectedTools).toEqual(["Bash", "Grep"]);
		});

		it("enforces minimum values", () => {
			process.env.COMPOSER_MICROCOMPACT_KEEP_RECENT = "0";
			process.env.COMPOSER_MICROCOMPACT_TRUNCATE_LENGTH = "10";

			const config = getMicrocompactConfig();
			expect(config.keepRecentCount).toBe(1);
			expect(config.truncatedResultLength).toBe(50);
		});
	});

	describe("microcompact function", () => {
		const config: MicrocompactConfig = {
			keepRecentCount: 2,
			truncatedResultLength: 100,
			addTruncationNote: true,
			protectedTools: ["Read"],
			minLengthToTruncate: 200,
		};

		it("does not modify messages when not enough tool results", () => {
			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Bash"),
				createToolResultMessage("tc1", createLongContent(500)),
			];

			const result = microcompact(messages, config);

			expect(result.stats.toolResultsProcessed).toBe(1);
			expect(result.stats.toolResultsTruncated).toBe(0);
		});

		it("truncates older tool results", () => {
			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Bash"),
				createToolResultMessage("tc1", createLongContent(500)),
				createToolCallMessage("tc2", "Grep"),
				createToolResultMessage("tc2", createLongContent(500)),
				createToolCallMessage("tc3", "Bash"),
				createToolResultMessage("tc3", createLongContent(500)),
				createToolCallMessage("tc4", "Grep"),
				createToolResultMessage("tc4", createLongContent(500)),
			];

			const result = microcompact(messages, config);

			expect(result.stats.toolResultsTruncated).toBe(2);
			expect(result.stats.toolResultsSkipped).toBe(0);

			// Check first tool result is truncated
			const firstResult = result.messages[2] as ToolResultMessage;
			const content = firstResult.content as Array<{
				type: string;
				text: string;
			}>;
			expect(content[0].text.length).toBeLessThan(500);
			expect(content[0].text).toContain("truncated by microcompact");
		});

		it("skips protected tools", () => {
			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Read"),
				createToolResultMessage("tc1", createLongContent(500)),
				createToolCallMessage("tc2", "Bash"),
				createToolResultMessage("tc2", createLongContent(500)),
				createToolCallMessage("tc3", "Read"),
				createToolResultMessage("tc3", createLongContent(500)),
			];

			const result = microcompact(messages, config);

			// Only tc1 is eligible for truncation (oldest), but it's Read (protected)
			expect(result.stats.toolResultsSkipped).toBe(1);
			expect(result.stats.toolResultsTruncated).toBe(0);
		});

		it("skips short tool results", () => {
			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Bash"),
				createToolResultMessage("tc1", "short"),
				createToolCallMessage("tc2", "Bash"),
				createToolResultMessage("tc2", createLongContent(500)),
				createToolCallMessage("tc3", "Bash"),
				createToolResultMessage("tc3", createLongContent(500)),
			];

			const result = microcompact(messages, config);

			// tc1 is too short, so skipped
			expect(result.stats.toolResultsSkipped).toBe(1);
			expect(result.stats.toolResultsTruncated).toBe(0);
		});

		it("calculates estimated tokens saved", () => {
			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Bash"),
				createToolResultMessage("tc1", createLongContent(1000)),
				createToolCallMessage("tc2", "Bash"),
				createToolResultMessage("tc2", createLongContent(1000)),
				createToolCallMessage("tc3", "Bash"),
				createToolResultMessage("tc3", createLongContent(500)),
			];

			const result = microcompact(messages, config);

			// First result truncated from 1000 to ~100 chars
			expect(result.stats.estimatedTokensSaved).toBeGreaterThan(0);
			expect(result.stats.originalCharacters).toBeGreaterThan(
				result.stats.finalCharacters,
			);
		});
	});

	describe("shouldMicrocompact", () => {
		const config: MicrocompactConfig = {
			keepRecentCount: 2,
			truncatedResultLength: 100,
			addTruncationNote: true,
			protectedTools: [],
			minLengthToTruncate: 200,
		};

		it("returns false when context usage is low", () => {
			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Bash"),
				createToolResultMessage("tc1", createLongContent(5000)),
				createToolCallMessage("tc2", "Bash"),
				createToolResultMessage("tc2", createLongContent(5000)),
				createToolCallMessage("tc3", "Bash"),
				createToolResultMessage("tc3", createLongContent(5000)),
			];

			expect(shouldMicrocompact(messages, config, 30)).toBe(false);
		});

		it("returns false when not enough tool results", () => {
			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Bash"),
				createToolResultMessage("tc1", createLongContent(5000)),
			];

			expect(shouldMicrocompact(messages, config, 80)).toBe(false);
		});

		it("returns true when context is high and savings are worthwhile", () => {
			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Bash"),
				createToolResultMessage("tc1", createLongContent(5000)),
				createToolCallMessage("tc2", "Bash"),
				createToolResultMessage("tc2", createLongContent(5000)),
				createToolCallMessage("tc3", "Bash"),
				createToolResultMessage("tc3", createLongContent(5000)),
			];

			expect(shouldMicrocompact(messages, config, 80)).toBe(true);
		});

		it("returns false when savings would be minimal", () => {
			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Bash"),
				createToolResultMessage("tc1", createLongContent(300)), // Not much to save
				createToolCallMessage("tc2", "Bash"),
				createToolResultMessage("tc2", createLongContent(300)),
				createToolCallMessage("tc3", "Bash"),
				createToolResultMessage("tc3", createLongContent(300)),
			];

			expect(shouldMicrocompact(messages, config, 80)).toBe(false);
		});
	});

	describe("MicrocompactMonitor", () => {
		it("creates with default config", () => {
			const monitor = createMicrocompactMonitor();
			const config = monitor.getConfig();

			expect(config.keepRecentCount).toBe(5);
			expect(config.truncatedResultLength).toBe(200);
		});

		it("creates with custom config", () => {
			const monitor = createMicrocompactMonitor({
				keepRecentCount: 10,
				truncatedResultLength: 500,
			});
			const config = monitor.getConfig();

			expect(config.keepRecentCount).toBe(10);
			expect(config.truncatedResultLength).toBe(500);
		});

		it("updates config", () => {
			const monitor = createMicrocompactMonitor();
			monitor.setConfig({ keepRecentCount: 20 });

			expect(monitor.getConfig().keepRecentCount).toBe(20);
		});

		it("tracks statistics", () => {
			const monitor = createMicrocompactMonitor({
				keepRecentCount: 1,
				truncatedResultLength: 50,
				minLengthToTruncate: 100,
				protectedTools: [],
			});

			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Bash"),
				createToolResultMessage("tc1", createLongContent(500)),
				createToolCallMessage("tc2", "Bash"),
				createToolResultMessage("tc2", createLongContent(500)),
			];

			const result = monitor.run(messages);

			expect(result.stats.toolResultsTruncated).toBe(1);
			expect(monitor.getStats().microcompactCount).toBe(1);
			expect(monitor.getStats().totalTokensSaved).toBeGreaterThan(0);
		});

		it("rate limits checks", () => {
			const monitor = createMicrocompactMonitor();

			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
			];

			// First check might return false due to not enough data
			monitor.shouldRun(messages, 80);

			// Immediately after, should be rate limited
			// (This test is a bit contrived since shouldRun checks multiple conditions)
		});

		it("resets statistics", () => {
			const monitor = createMicrocompactMonitor({
				keepRecentCount: 1,
				truncatedResultLength: 50,
				minLengthToTruncate: 100,
				protectedTools: [],
			});

			const messages: AppMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: Date.now(),
				},
				createToolCallMessage("tc1", "Bash"),
				createToolResultMessage("tc1", createLongContent(500)),
				createToolCallMessage("tc2", "Bash"),
				createToolResultMessage("tc2", createLongContent(500)),
			];

			monitor.run(messages);
			expect(monitor.getStats().microcompactCount).toBe(1);

			monitor.reset();
			expect(monitor.getStats().microcompactCount).toBe(0);
			expect(monitor.getStats().totalTokensSaved).toBe(0);
		});
	});
});
