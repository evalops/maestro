/**
 * Tests for the context summarizer
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ConversationTurn,
	formatSummarizedContext,
	summarizeContext,
} from "../../packages/slack-agent/src/context-summarizer.js";

describe("context-summarizer", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`context-summarizer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("summarizeContext", () => {
		it("returns all turns when below threshold", () => {
			const turns: ConversationTurn[] = [
				{
					date: "2024-01-15T10:00:00Z",
					user: "alice",
					text: "Hello",
					isBot: false,
				},
				{
					date: "2024-01-15T10:01:00Z",
					user: "bot",
					text: "Hi there!",
					isBot: true,
				},
				{
					date: "2024-01-15T10:02:00Z",
					user: "alice",
					text: "Help me",
					isBot: false,
				},
			];

			const result = summarizeContext(turns, testDir, {
				recentTurnCount: 10,
				minTurnsForSummary: 15,
				maxSummaryChars: 2000,
			});

			expect(result.summarizedTurnCount).toBe(0);
			expect(result.summary).toBeUndefined();
			expect(result.recentTurns).toHaveLength(3);
		});

		it("summarizes when above threshold", () => {
			// Create 20 turns
			const turns: ConversationTurn[] = [];
			for (let i = 0; i < 20; i++) {
				turns.push({
					date: `2024-01-15T${10 + Math.floor(i / 60)}:${(i % 60).toString().padStart(2, "0")}:00Z`,
					user: i % 2 === 0 ? "alice" : "bot",
					text: `Message ${i}`,
					isBot: i % 2 === 1,
				});
			}

			const result = summarizeContext(turns, testDir, {
				recentTurnCount: 10,
				minTurnsForSummary: 15,
				maxSummaryChars: 2000,
			});

			expect(result.summarizedTurnCount).toBe(10);
			expect(result.summary).toBeDefined();
			expect(result.recentTurns).toHaveLength(10);
		});

		it("caches summaries for repeated calls", () => {
			const turns: ConversationTurn[] = [];
			for (let i = 0; i < 20; i++) {
				turns.push({
					date: "2024-01-15T10:00:00Z",
					user: i % 2 === 0 ? "alice" : "bot",
					text: `Message ${i}`,
					isBot: i % 2 === 1,
				});
			}

			// First call
			const result1 = summarizeContext(turns, testDir, {
				recentTurnCount: 10,
				minTurnsForSummary: 15,
				maxSummaryChars: 2000,
			});

			// Check cache file exists
			const cachePath = join(testDir, "context_summary.json");
			expect(existsSync(cachePath)).toBe(true);

			// Second call should use cache
			const result2 = summarizeContext(turns, testDir, {
				recentTurnCount: 10,
				minTurnsForSummary: 15,
				maxSummaryChars: 2000,
			});

			expect(result1.summary).toBe(result2.summary);
		});

		it("extracts file mentions in summary", () => {
			const turns: ConversationTurn[] = [];
			for (let i = 0; i < 20; i++) {
				turns.push({
					date: "2024-01-15T10:00:00Z",
					user: i % 2 === 0 ? "alice" : "bot",
					text: i === 5 ? "Check the file src/index.ts" : `Message ${i}`,
					isBot: i % 2 === 1,
				});
			}

			const result = summarizeContext(turns, testDir, {
				recentTurnCount: 10,
				minTurnsForSummary: 15,
				maxSummaryChars: 2000,
			});

			expect(result.summary).toContain("src/index.ts");
		});

		it("extracts action keywords in summary", () => {
			const turns: ConversationTurn[] = [];
			for (let i = 0; i < 20; i++) {
				const isBot = i % 2 === 1;
				let text = `Message ${i}`;
				if (isBot && i === 7) {
					text = "I fixed the bug in the authentication module";
				}
				turns.push({
					date: "2024-01-15T10:00:00Z",
					user: isBot ? "bot" : "alice",
					text,
					isBot,
				});
			}

			const result = summarizeContext(turns, testDir, {
				recentTurnCount: 10,
				minTurnsForSummary: 15,
				maxSummaryChars: 2000,
			});

			expect(result.summary).toContain("fixed issues");
		});
	});

	describe("formatSummarizedContext", () => {
		it("formats without summary when not needed", () => {
			const context = {
				summarizedTurnCount: 0,
				recentTurns: [
					{
						date: "2024-01-15T10:00:00Z",
						user: "alice",
						text: "Hello",
						isBot: false,
					},
					{
						date: "2024-01-15T10:01:00Z",
						user: "bot",
						text: "Hi!",
						isBot: true,
					},
				],
			};

			const formatted = formatSummarizedContext(context);

			expect(formatted).not.toContain("Summary");
			expect(formatted).toContain("alice");
			expect(formatted).toContain("Hello");
		});

		it("formats with summary header when summarized", () => {
			const context = {
				summary: "Discussed deployment issues on 2024-01-15",
				summarizedTurnCount: 15,
				recentTurns: [
					{
						date: "2024-01-15T10:00:00Z",
						user: "alice",
						text: "Ready?",
						isBot: false,
					},
				],
			};

			const formatted = formatSummarizedContext(context);

			expect(formatted).toContain("Earlier Conversation Summary (15 messages)");
			expect(formatted).toContain("deployment issues");
			expect(formatted).toContain("Recent Messages (1 messages)");
		});

		it("includes thread replies in formatted output", () => {
			const context = {
				summarizedTurnCount: 0,
				recentTurns: [
					{
						date: "2024-01-15T10:00:00Z",
						user: "alice",
						text: "Main message",
						isBot: false,
						threadReplies: [
							{ date: "2024-01-15T10:01:00Z", user: "bob", text: "Reply 1" },
							{
								date: "2024-01-15T10:02:00Z",
								user: "charlie",
								text: "Reply 2",
							},
						],
					},
				],
			};

			const formatted = formatSummarizedContext(context);

			expect(formatted).toContain("Main message");
			expect(formatted).toContain("↳ bob");
			expect(formatted).toContain("Reply 1");
			expect(formatted).toContain("↳ charlie");
		});

		it("includes attachments in formatted output", () => {
			const context = {
				summarizedTurnCount: 0,
				recentTurns: [
					{
						date: "2024-01-15T10:00:00Z",
						user: "alice",
						text: "Here's the file",
						isBot: false,
						attachments: ["attachments/report.pdf"],
					},
				],
			};

			const formatted = formatSummarizedContext(context);

			expect(formatted).toContain("report.pdf");
		});
	});
});
