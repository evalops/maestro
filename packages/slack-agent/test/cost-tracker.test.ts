import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostTracker } from "../src/cost-tracker.js";

describe("CostTracker", () => {
	let dir: string;
	let tracker: CostTracker;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-cost-"));
		tracker = new CostTracker(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("record", () => {
		it("calculates cost for input/output tokens", async () => {
			// Create channel directory
			await mkdir(join(dir, "C123"));

			const record = tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			// Input: 1000 tokens * $3/million = $0.003
			// Output: 500 tokens * $15/million = $0.0075
			// Total: $0.0105
			expect(record.estimatedCost).toBeCloseTo(0.0105, 5);
			expect(record.inputTokens).toBe(1000);
			expect(record.outputTokens).toBe(500);
			expect(record.model).toBe("claude-sonnet-4-20250514");
			expect(record.timestamp).toBeDefined();
		});

		it("calculates cost including cache tokens", async () => {
			await mkdir(join(dir, "C123"));

			const record = tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
				cacheWriteTokens: 2000,
				cacheReadTokens: 3000,
			});

			// Input: 1000 * $3/M = $0.003
			// Output: 500 * $15/M = $0.0075
			// Cache Write: 2000 * $3.75/M = $0.0075
			// Cache Read: 3000 * $0.30/M = $0.0009
			// Total: $0.0189
			expect(record.estimatedCost).toBeCloseTo(0.0189, 5);
			expect(record.cacheWriteTokens).toBe(2000);
			expect(record.cacheReadTokens).toBe(3000);
		});

		it("uses default pricing for unknown models", async () => {
			await mkdir(join(dir, "C123"));

			const record = tracker.record("C123", {
				model: "unknown-model",
				inputTokens: 1000,
				outputTokens: 500,
			});

			// Should use default pricing (same as Sonnet 4)
			expect(record.estimatedCost).toBeCloseTo(0.0105, 5);
		});

		it("persists record to JSONL file", async () => {
			await mkdir(join(dir, "C123"));

			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			const logPath = join(dir, "C123", "usage.jsonl");
			const content = await readFile(logPath, "utf-8");
			const record = JSON.parse(content.trim());

			expect(record.inputTokens).toBe(1000);
			expect(record.outputTokens).toBe(500);
		});

		it("appends multiple records", async () => {
			await mkdir(join(dir, "C123"));

			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 100,
				outputTokens: 50,
			});

			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 200,
				outputTokens: 100,
			});

			const logPath = join(dir, "C123", "usage.jsonl");
			const content = await readFile(logPath, "utf-8");
			const lines = content.trim().split("\n");

			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0]).inputTokens).toBe(100);
			expect(JSON.parse(lines[1]).inputTokens).toBe(200);
		});
	});

	describe("getSummary", () => {
		it("returns empty summary for new channel", () => {
			const summary = tracker.getSummary("C123");

			expect(summary.today.requestCount).toBe(0);
			expect(summary.today.totalCost).toBe(0);
			expect(summary.allTime.requestCount).toBe(0);
			expect(summary.allTime.totalCost).toBe(0);
		});

		it("aggregates multiple records", async () => {
			await mkdir(join(dir, "C123"));

			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 2000,
				outputTokens: 1000,
			});

			const summary = tracker.getSummary("C123");

			expect(summary.allTime.requestCount).toBe(2);
			expect(summary.allTime.totalInputTokens).toBe(3000);
			expect(summary.allTime.totalOutputTokens).toBe(1500);
			// Cost: (3000 * $3 + 1500 * $15) / 1M = $0.0315
			expect(summary.allTime.totalCost).toBeCloseTo(0.0315, 5);
		});

		it("separates today and all-time", async () => {
			await mkdir(join(dir, "C123"));

			// Record today
			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			const summary = tracker.getSummary("C123");

			// Today should match all-time since we just recorded
			expect(summary.today.requestCount).toBe(1);
			expect(summary.allTime.requestCount).toBe(1);
		});

		it("includes cache tokens in summary", async () => {
			await mkdir(join(dir, "C123"));

			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
				cacheWriteTokens: 100,
				cacheReadTokens: 200,
			});

			const summary = tracker.getSummary("C123");

			expect(summary.allTime.totalCacheWriteTokens).toBe(100);
			expect(summary.allTime.totalCacheReadTokens).toBe(200);
		});
	});

	describe("formatSummary", () => {
		it("formats empty summary", () => {
			const summary = tracker.getSummary("C123");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("Usage Summary");
			expect(formatted).toContain("Today:");
			expect(formatted).toContain("All Time:");
			expect(formatted).toContain("Requests: 0");
			expect(formatted).toContain("$0.0000");
		});

		it("formats tokens as k for large numbers", async () => {
			await mkdir(join(dir, "C123"));

			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 5000,
				outputTokens: 2500,
			});

			const summary = tracker.getSummary("C123");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("5.0k in");
			expect(formatted).toContain("2.5k out");
		});

		it("shows small token counts without k suffix", async () => {
			await mkdir(join(dir, "C123"));

			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 500,
				outputTokens: 250,
			});

			const summary = tracker.getSummary("C123");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("500 in");
			expect(formatted).toContain("250 out");
		});

		it("formats cost with 4 decimal places", async () => {
			await mkdir(join(dir, "C123"));

			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			const summary = tracker.getSummary("C123");
			const formatted = tracker.formatSummary(summary);

			// Cost should be $0.0105
			expect(formatted).toContain("$0.0105");
		});
	});

	describe("multiple channels", () => {
		it("tracks channels independently", async () => {
			await mkdir(join(dir, "C123"));
			await mkdir(join(dir, "C456"));

			tracker.record("C123", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			tracker.record("C456", {
				model: "claude-sonnet-4-20250514",
				inputTokens: 2000,
				outputTokens: 1000,
			});

			const summary123 = tracker.getSummary("C123");
			const summary456 = tracker.getSummary("C456");

			expect(summary123.allTime.totalInputTokens).toBe(1000);
			expect(summary456.allTime.totalInputTokens).toBe(2000);
		});
	});
});
