/**
 * Tests for cost-tracker.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostTracker } from "../../packages/slack-agent/src/cost-tracker.js";

describe("CostTracker", () => {
	let testDir: string;
	let tracker: CostTracker;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`cost-tracker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		tracker = new CostTracker(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("record", () => {
		it("calculates estimated cost based on token counts", () => {
			const channelId = "C123";
			mkdirSync(join(testDir, channelId), { recursive: true });

			const record = tracker.record(channelId, {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			// $3/M input + $15/M output
			// 1000 * 3 / 1M = 0.003
			// 500 * 15 / 1M = 0.0075
			expect(record.estimatedCost).toBeCloseTo(0.0105, 4);
		});

		it("includes cache tokens in cost calculation", () => {
			const channelId = "C123";
			mkdirSync(join(testDir, channelId), { recursive: true });

			const record = tracker.record(channelId, {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
				cacheWriteTokens: 2000,
				cacheReadTokens: 5000,
			});

			// Cache write: 2000 * 3.75 / 1M = 0.0075
			// Cache read: 5000 * 0.3 / 1M = 0.0015
			// Total: 0.003 + 0.0075 + 0.0075 + 0.0015 = 0.0195
			expect(record.estimatedCost).toBeCloseTo(0.0195, 4);
		});

		it("uses default pricing for unknown models", () => {
			const channelId = "C123";
			mkdirSync(join(testDir, channelId), { recursive: true });

			const record = tracker.record(channelId, {
				model: "unknown-model",
				inputTokens: 1000000,
				outputTokens: 0,
			});

			// $3/M input
			expect(record.estimatedCost).toBeCloseTo(3.0, 2);
		});

		it("writes to usage.jsonl file", () => {
			const channelId = "C123";
			mkdirSync(join(testDir, channelId), { recursive: true });

			tracker.record(channelId, {
				model: "claude-sonnet-4-20250514",
				inputTokens: 100,
				outputTokens: 50,
			});

			const logPath = join(testDir, channelId, "usage.jsonl");
			expect(existsSync(logPath)).toBe(true);

			const content = readFileSync(logPath, "utf-8");
			const record = JSON.parse(content.trim());

			expect(record.inputTokens).toBe(100);
			expect(record.outputTokens).toBe(50);
			expect(record.model).toBe("claude-sonnet-4-20250514");
		});

		it("appends multiple records to log", () => {
			const channelId = "C123";
			mkdirSync(join(testDir, channelId), { recursive: true });

			tracker.record(channelId, {
				model: "claude-sonnet-4-20250514",
				inputTokens: 100,
				outputTokens: 50,
			});
			tracker.record(channelId, {
				model: "claude-sonnet-4-20250514",
				inputTokens: 200,
				outputTokens: 100,
			});

			const logPath = join(testDir, channelId, "usage.jsonl");
			const lines = readFileSync(logPath, "utf-8").trim().split("\n");

			expect(lines).toHaveLength(2);
		});
	});

	describe("getSummary", () => {
		it("returns zero values for channel with no usage", () => {
			const summary = tracker.getSummary("nonexistent");

			expect(summary.allTime.requestCount).toBe(0);
			expect(summary.allTime.totalCost).toBe(0);
			expect(summary.today.requestCount).toBe(0);
		});

		it("aggregates all-time usage", () => {
			const channelId = "C123";
			mkdirSync(join(testDir, channelId), { recursive: true });

			tracker.record(channelId, {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});
			tracker.record(channelId, {
				model: "claude-sonnet-4-20250514",
				inputTokens: 2000,
				outputTokens: 1000,
			});

			const summary = tracker.getSummary(channelId);

			expect(summary.allTime.requestCount).toBe(2);
			expect(summary.allTime.totalInputTokens).toBe(3000);
			expect(summary.allTime.totalOutputTokens).toBe(1500);
		});

		it("filters today's usage by date", () => {
			const channelId = "C123";
			mkdirSync(join(testDir, channelId), { recursive: true });

			// Record today
			tracker.record(channelId, {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			const summary = tracker.getSummary(channelId);

			expect(summary.today.requestCount).toBe(1);
			expect(summary.today.totalInputTokens).toBe(1000);
		});
	});

	describe("formatSummary", () => {
		it("formats summary for display", () => {
			const channelId = "C123";
			mkdirSync(join(testDir, channelId), { recursive: true });

			tracker.record(channelId, {
				model: "claude-sonnet-4-20250514",
				inputTokens: 10000,
				outputTokens: 5000,
			});

			const summary = tracker.getSummary(channelId);
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("Usage Summary");
			expect(formatted).toContain("Today:");
			expect(formatted).toContain("All Time:");
			expect(formatted).toContain("Requests:");
			expect(formatted).toContain("Cost:");
			expect(formatted).toContain("Tokens:");
		});

		it("formats large token counts with k suffix", () => {
			const channelId = "C123";
			mkdirSync(join(testDir, channelId), { recursive: true });

			tracker.record(channelId, {
				model: "claude-sonnet-4-20250514",
				inputTokens: 150000,
				outputTokens: 50000,
			});

			const summary = tracker.getSummary(channelId);
			const formatted = tracker.formatSummary(summary);

			// Format is "150.0k" for large numbers
			expect(formatted).toMatch(/150\.\dk/);
			expect(formatted).toMatch(/50\.\dk/);
		});
	});
});
