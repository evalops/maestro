import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ConversationTurn,
	formatSummarizedContext,
	summarizeContext,
} from "../src/context-summarizer.js";

describe("summarizeContext", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(tmpdir(), `slack-agent-summarizer-${Date.now()}`);
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	function createTurn(
		index: number,
		isBot = false,
		text?: string,
	): ConversationTurn {
		return {
			date: `2025-01-${String(index + 1).padStart(2, "0")}T12:00:00Z`,
			user: isBot ? "bot" : `user${index % 3}`,
			text: text || `Message ${index}`,
			isBot,
		};
	}

	it("returns all turns when below threshold", () => {
		const turns = Array.from({ length: 10 }, (_, i) => createTurn(i));

		const result = summarizeContext(turns, testDir, {
			minTurnsForSummary: 15,
		});

		expect(result.summarizedTurnCount).toBe(0);
		expect(result.summary).toBeUndefined();
		expect(result.recentTurns).toHaveLength(10);
	});

	it("summarizes older turns when above threshold", () => {
		const turns = Array.from({ length: 20 }, (_, i) => createTurn(i));

		const result = summarizeContext(turns, testDir, {
			minTurnsForSummary: 15,
			recentTurnCount: 10,
		});

		expect(result.summarizedTurnCount).toBe(10);
		expect(result.summary).toBeTruthy();
		expect(result.recentTurns).toHaveLength(10);
	});

	it("keeps specified number of recent turns", () => {
		const turns = Array.from({ length: 25 }, (_, i) => createTurn(i));

		const result = summarizeContext(turns, testDir, {
			minTurnsForSummary: 15,
			recentTurnCount: 5,
		});

		expect(result.recentTurns).toHaveLength(5);
		// Should be the last 5 turns
		expect(result.recentTurns[0].text).toBe("Message 20");
		expect(result.recentTurns[4].text).toBe("Message 24");
	});

	it("caches summaries to disk", async () => {
		const turns = Array.from({ length: 20 }, (_, i) => createTurn(i));

		summarizeContext(turns, testDir, {
			minTurnsForSummary: 15,
			recentTurnCount: 10,
		});

		// Check cache file exists
		const cachePath = join(testDir, "context_summary.json");
		const cacheContent = await readFile(cachePath, "utf-8");
		const cached = JSON.parse(cacheContent);

		expect(cached.hash).toBeTruthy();
		expect(cached.summary).toBeTruthy();
		expect(cached.turnCount).toBe(10);
		expect(cached.createdAt).toBeTruthy();
	});

	it("uses cached summary when hash matches", async () => {
		const turns = Array.from({ length: 20 }, (_, i) => createTurn(i));

		// Create initial summary
		const result1 = summarizeContext(turns, testDir, {
			minTurnsForSummary: 15,
			recentTurnCount: 10,
		});

		// Modify cache to detect if it's being reused
		const cachePath = join(testDir, "context_summary.json");
		const cacheContent = await readFile(cachePath, "utf-8");
		const cached = JSON.parse(cacheContent);
		cached.summary = "CACHED_MARKER";
		await writeFile(cachePath, JSON.stringify(cached));

		// Call again with same turns
		const result2 = summarizeContext(turns, testDir, {
			minTurnsForSummary: 15,
			recentTurnCount: 10,
		});

		expect(result2.summary).toBe("CACHED_MARKER");
	});

	it("regenerates summary when hash changes", async () => {
		const turns = Array.from({ length: 20 }, (_, i) => createTurn(i));

		// Create initial summary
		summarizeContext(turns, testDir, {
			minTurnsForSummary: 15,
			recentTurnCount: 10,
		});

		// Modify cache with old hash
		const cachePath = join(testDir, "context_summary.json");
		const cacheContent = await readFile(cachePath, "utf-8");
		const cached = JSON.parse(cacheContent);
		cached.hash = "old_hash";
		cached.summary = "OLD_SUMMARY";
		await writeFile(cachePath, JSON.stringify(cached));

		// Call again - should regenerate
		const result = summarizeContext(turns, testDir, {
			minTurnsForSummary: 15,
			recentTurnCount: 10,
		});

		expect(result.summary).not.toBe("OLD_SUMMARY");
	});

	describe("summary content", () => {
		it("includes date range", () => {
			const turns = Array.from({ length: 20 }, (_, i) => createTurn(i));

			const result = summarizeContext(turns, testDir, {
				minTurnsForSummary: 15,
				recentTurnCount: 10,
			});

			expect(result.summary).toContain("Conversation");
			expect(result.summary).toContain("2025-01");
		});

		it("includes participant info", () => {
			const turns = Array.from({ length: 20 }, (_, i) => createTurn(i));

			const result = summarizeContext(turns, testDir, {
				minTurnsForSummary: 15,
				recentTurnCount: 10,
			});

			expect(result.summary).toContain("Participants");
		});

		it("includes message count", () => {
			const turns = Array.from({ length: 20 }, (_, i) => createTurn(i));

			const result = summarizeContext(turns, testDir, {
				minTurnsForSummary: 15,
				recentTurnCount: 10,
			});

			expect(result.summary).toContain("messages exchanged");
		});

		it("extracts file mentions", () => {
			const turns = Array.from({ length: 20 }, (_, i) =>
				createTurn(i, false, "Check out src/app.ts and config.json"),
			);

			const result = summarizeContext(turns, testDir, {
				minTurnsForSummary: 15,
				recentTurnCount: 10,
			});

			expect(result.summary).toContain("Files discussed");
			expect(result.summary).toContain("app.ts");
		});

		it("extracts bot actions", () => {
			const turns: ConversationTurn[] = [];
			for (let i = 0; i < 20; i++) {
				turns.push(createTurn(i, false, "Please create a file"));
				turns.push(createTurn(i, true, "I created the file successfully"));
			}

			const result = summarizeContext(turns, testDir, {
				minTurnsForSummary: 15,
				recentTurnCount: 10,
			});

			expect(result.summary).toContain("Actions");
			expect(result.summary).toContain("created files");
		});

		it("respects maxSummaryChars", () => {
			const turns = Array.from({ length: 100 }, (_, i) =>
				createTurn(
					i,
					false,
					`This is a very long message with lots of content about file${i}.ts and more stuff`,
				),
			);

			const result = summarizeContext(turns, testDir, {
				minTurnsForSummary: 15,
				recentTurnCount: 10,
				maxSummaryChars: 100,
			});

			expect(result.summary?.length).toBeLessThanOrEqual(100);
		});
	});
});

describe("formatSummarizedContext", () => {
	function createTurn(index: number): ConversationTurn {
		return {
			date: `2025-01-${String(index + 1).padStart(2, "0")}T12:00:00Z`,
			user: `user${index}`,
			text: `Message ${index}`,
			isBot: false,
		};
	}

	it("formats context without summary", () => {
		const result = formatSummarizedContext({
			summarizedTurnCount: 0,
			recentTurns: [createTurn(0), createTurn(1)],
		});

		expect(result).toContain("user0");
		expect(result).toContain("Message 0");
		expect(result).toContain("Message 1");
		expect(result).not.toContain("Summary");
	});

	it("formats context with summary", () => {
		const result = formatSummarizedContext({
			summary: "Earlier discussion about coding",
			summarizedTurnCount: 15,
			recentTurns: [createTurn(0), createTurn(1)],
		});

		expect(result).toContain("Earlier Conversation Summary (15 messages)");
		expect(result).toContain("Earlier discussion about coding");
		expect(result).toContain("Recent Messages (2 messages)");
	});

	it("formats turns with tab separators", () => {
		const result = formatSummarizedContext({
			summarizedTurnCount: 0,
			recentTurns: [createTurn(0)],
		});

		// Format: date\tuser\ttext\tattachments
		const lines = result.split("\n");
		const parts = lines[0].split("\t");
		expect(parts).toHaveLength(4);
	});

	it("includes attachments", () => {
		const turn: ConversationTurn = {
			date: "2025-01-01T12:00:00Z",
			user: "user1",
			text: "Check this file",
			isBot: false,
			attachments: ["file1.txt", "file2.png"],
		};

		const result = formatSummarizedContext({
			summarizedTurnCount: 0,
			recentTurns: [turn],
		});

		expect(result).toContain("file1.txt,file2.png");
	});

	it("includes thread replies", () => {
		const turn: ConversationTurn = {
			date: "2025-01-01T12:00:00Z",
			user: "user1",
			text: "Original message",
			isBot: false,
			threadReplies: [
				{ date: "2025-01-01T12:05:00Z", user: "user2", text: "Reply 1" },
				{ date: "2025-01-01T12:10:00Z", user: "user3", text: "Reply 2" },
			],
		};

		const result = formatSummarizedContext({
			summarizedTurnCount: 0,
			recentTurns: [turn],
		});

		expect(result).toContain("↳ user2");
		expect(result).toContain("Reply 1");
		expect(result).toContain("↳ user3");
		expect(result).toContain("Reply 2");
	});

	it("truncates date to 19 characters", () => {
		const result = formatSummarizedContext({
			summarizedTurnCount: 0,
			recentTurns: [
				{
					date: "2025-01-01T12:00:00.123Z",
					user: "user1",
					text: "Test",
					isBot: false,
				},
			],
		});

		expect(result).toContain("2025-01-01T12:00:00");
		expect(result).not.toContain(".123Z");
	});
});
