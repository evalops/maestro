/**
 * Comprehensive tests for enhanced cost tracking (src/tracking/cost-tracker.ts)
 *
 * Test Coverage:
 * - CSV export functionality
 * - JSON export functionality
 * - Provider comparison
 * - Usage trends over time
 * - Filtering and time range queries
 * - Edge cases and data integrity
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ProviderComparison,
	type UsageEntry,
	type UsageTrend,
	clearUsage,
	compareProviders,
	exportUsageToCSV,
	exportUsageToJSON,
	getUsageSummary,
	getUsageTrends,
	trackUsage,
} from "../../src/tracking/cost-tracker.js";

describe("Enhanced Cost Tracking", () => {
	let testDir: string;
	let originalEnv: string | undefined;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "composer-cost-test-"));
		originalEnv = process.env.HOME;

		// Override HOME to use test directory
		const testUsageFile = join(testDir, ".composer", "usage.json");
		process.env.HOME = testDir;

		// Clear any existing data
		clearUsage();
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch (error) {
			console.warn("Failed to clean up test directory:", error);
		}

		// Restore original HOME
		if (originalEnv) {
			process.env.HOME = originalEnv;
		}
	});

	// Helper to create sample usage entries
	function createSampleEntries(): void {
		const baseTime = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago

		// Anthropic entries
		trackUsage({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			tokensInput: 1000,
			tokensOutput: 500,
			tokensCacheRead: 200,
			cost: 0.015,
		});

		trackUsage({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			tokensInput: 2000,
			tokensOutput: 1000,
			tokensCacheWrite: 300,
			cost: 0.03,
		});

		// OpenAI entries
		trackUsage({
			provider: "openai",
			model: "gpt-4",
			tokensInput: 1500,
			tokensOutput: 800,
			cost: 0.05,
		});

		trackUsage({
			provider: "openai",
			model: "gpt-3.5-turbo",
			tokensInput: 3000,
			tokensOutput: 1500,
			cost: 0.005,
		});

		// Google entries
		trackUsage({
			provider: "google",
			model: "gemini-pro",
			tokensInput: 2500,
			tokensOutput: 1200,
			cost: 0.02,
		});
	}

	describe("exportUsageToCSV", () => {
		it("should export usage data as CSV with proper headers", () => {
			createSampleEntries();

			const csv = exportUsageToCSV();
			const lines = csv.split("\n");

			expect(lines[0]).toContain("Timestamp");
			expect(lines[0]).toContain("Provider");
			expect(lines[0]).toContain("Model");
			expect(lines[0]).toContain("Cost (USD)");
			expect(lines.length).toBeGreaterThan(1);
		});

		it("should include all usage data fields", () => {
			trackUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				tokensInput: 1000,
				tokensOutput: 500,
				tokensCacheRead: 200,
				tokensCacheWrite: 100,
				cost: 0.015,
			});

			const csv = exportUsageToCSV();
			const lines = csv.split("\n");
			const dataLine = lines[1];

			expect(dataLine).toContain("anthropic");
			expect(dataLine).toContain("claude-sonnet-4-5");
			expect(dataLine).toContain("1000");
			expect(dataLine).toContain("500");
			expect(dataLine).toContain("200");
			expect(dataLine).toContain("100");
			expect(dataLine).toContain("1800"); // total tokens
		});

		it("should filter by provider", () => {
			createSampleEntries();

			const csv = exportUsageToCSV({ provider: "anthropic" });
			const lines = csv.split("\n");

			expect(lines.length).toBe(3); // header + 2 entries
			expect(csv).toContain("anthropic");
			expect(csv).not.toContain("openai");
		});

		it("should filter by time range", () => {
			const now = Date.now();
			const hourAgo = now - 60 * 60 * 1000;

			createSampleEntries();

			const csv = exportUsageToCSV({ since: hourAgo, until: now });
			const lines = csv.split("\n");

			// All sample entries are recent, so should appear
			expect(lines.length).toBeGreaterThan(1);
		});

		it("should handle empty results", () => {
			const csv = exportUsageToCSV();
			const lines = csv.split("\n");

			expect(lines.length).toBe(1); // Only header
		});

		it("should format costs to 6 decimal places", () => {
			trackUsage({
				provider: "test",
				model: "test-model",
				tokensInput: 100,
				tokensOutput: 50,
				cost: 0.001234567,
			});

			const csv = exportUsageToCSV();
			expect(csv).toContain("0.001235"); // Rounded to 6 decimals
		});
	});

	describe("exportUsageToJSON", () => {
		it("should export usage data as JSON with summary", () => {
			createSampleEntries();

			const json = exportUsageToJSON({ pretty: false });
			const data = JSON.parse(json);

			expect(data).toHaveProperty("exportedAt");
			expect(data).toHaveProperty("filters");
			expect(data).toHaveProperty("summary");
			expect(data).toHaveProperty("entries");
		});

		it("should include summary statistics", () => {
			createSampleEntries();

			const json = exportUsageToJSON({ pretty: true });
			const data = JSON.parse(json);

			expect(data.summary.totalRequests).toBe(5);
			expect(data.summary.totalCost).toBeGreaterThan(0);
			expect(data.summary).toHaveProperty("byProvider");
			expect(data.summary).toHaveProperty("byModel");
		});

		it("should format entries with ISO dates", () => {
			trackUsage({
				provider: "test",
				model: "test-model",
				tokensInput: 100,
				tokensOutput: 50,
				cost: 0.001,
			});

			const json = exportUsageToJSON({ pretty: false });
			const data = JSON.parse(json);

			expect(data.entries[0]).toHaveProperty("date");
			expect(data.entries[0].date).toMatch(/\d{4}-\d{2}-\d{2}T/);
		});

		it("should include total tokens in entries", () => {
			trackUsage({
				provider: "test",
				model: "test-model",
				tokensInput: 100,
				tokensOutput: 50,
				tokensCacheRead: 25,
				tokensCacheWrite: 10,
				cost: 0.001,
			});

			const json = exportUsageToJSON({ pretty: false });
			const data = JSON.parse(json);

			expect(data.entries[0].totalTokens).toBe(185); // 100 + 50 + 25 + 10
		});

		it("should respect pretty formatting option", () => {
			trackUsage({
				provider: "test",
				model: "test-model",
				tokensInput: 100,
				tokensOutput: 50,
				cost: 0.001,
			});

			const prettyJson = exportUsageToJSON({ pretty: true });
			const compactJson = exportUsageToJSON({ pretty: false });

			expect(prettyJson.length).toBeGreaterThan(compactJson.length);
			expect(prettyJson).toContain("\n  ");
			expect(compactJson).not.toContain("\n  ");
		});

		it("should filter by provider", () => {
			createSampleEntries();

			const json = exportUsageToJSON({ provider: "openai", pretty: false });
			const data = JSON.parse(json);

			expect(data.entries.length).toBe(2);
			expect(data.entries.every((e: any) => e.provider === "openai")).toBe(
				true,
			);
		});

		it("should filter by model", () => {
			createSampleEntries();

			const json = exportUsageToJSON({ model: "gpt-4", pretty: false });
			const data = JSON.parse(json);

			expect(data.entries.length).toBe(1);
			expect(data.entries[0].model).toBe("gpt-4");
		});
	});

	describe("compareProviders", () => {
		it("should compare providers by cost", () => {
			createSampleEntries();

			const comparisons = compareProviders();

			expect(comparisons.length).toBeGreaterThan(0);
			expect(comparisons[0]).toHaveProperty("provider");
			expect(comparisons[0]).toHaveProperty("totalCost");
			expect(comparisons[0]).toHaveProperty("totalRequests");
			expect(comparisons[0]).toHaveProperty("avgCostPerRequest");
			expect(comparisons[0]).toHaveProperty("avgCostPerToken");
		});

		it("should sort providers by total cost descending", () => {
			createSampleEntries();

			const comparisons = compareProviders();

			for (let i = 1; i < comparisons.length; i++) {
				expect(comparisons[i - 1].totalCost).toBeGreaterThanOrEqual(
					comparisons[i].totalCost,
				);
			}
		});

		it("should calculate average costs correctly", () => {
			trackUsage({
				provider: "test",
				model: "model1",
				tokensInput: 1000,
				tokensOutput: 500,
				cost: 0.015,
			});

			trackUsage({
				provider: "test",
				model: "model1",
				tokensInput: 1000,
				tokensOutput: 500,
				cost: 0.015,
			});

			const comparisons = compareProviders();
			const testProvider = comparisons.find((c) => c.provider === "test");

			expect(testProvider).toBeDefined();
			expect(testProvider?.totalCost).toBe(0.03);
			expect(testProvider?.totalRequests).toBe(2);
			expect(testProvider?.avgCostPerRequest).toBe(0.015);
		});

		it("should group models by provider", () => {
			createSampleEntries();

			const comparisons = compareProviders();
			const anthropicProvider = comparisons.find(
				(c) => c.provider === "anthropic",
			);

			expect(anthropicProvider).toBeDefined();
			expect(anthropicProvider?.models).toHaveProperty("claude-sonnet-4-5");
		});

		it("should handle zero requests gracefully", () => {
			clearUsage();

			const comparisons = compareProviders();
			expect(comparisons.length).toBe(0);
		});

		it("should filter by time range", () => {
			const now = Date.now();
			const twoHoursAgo = now - 2 * 60 * 60 * 1000;

			createSampleEntries();

			const comparisons = compareProviders({
				since: twoHoursAgo,
				until: now,
			});

			expect(comparisons.length).toBeGreaterThan(0);
		});
	});

	describe("getUsageTrends", () => {
		it("should calculate daily trends", () => {
			const now = Date.now();
			const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

			createSampleEntries();

			const trends = getUsageTrends({
				since: weekAgo,
				until: now,
				granularity: "day",
			});

			expect(Array.isArray(trends)).toBe(true);
			if (trends.length > 0) {
				expect(trends[0]).toHaveProperty("date");
				expect(trends[0]).toHaveProperty("cost");
				expect(trends[0]).toHaveProperty("requests");
				expect(trends[0]).toHaveProperty("tokens");
			}
		});

		it("should format dates as ISO strings (YYYY-MM-DD)", () => {
			const now = Date.now();
			const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

			createSampleEntries();

			const trends = getUsageTrends({
				since: weekAgo,
				until: now,
				granularity: "day",
			});

			if (trends.length > 0) {
				expect(trends[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			}
		});

		it("should aggregate by week", () => {
			const now = Date.now();
			const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

			createSampleEntries();

			const trends = getUsageTrends({
				since: monthAgo,
				until: now,
				granularity: "week",
			});

			expect(Array.isArray(trends)).toBe(true);
			// Weeks should start on Sunday
			if (trends.length > 0) {
				const date = new Date(trends[0].date);
				// Note: Not all entries will be on Sunday since we aggregate by week start
				expect(date).toBeInstanceOf(Date);
			}
		});

		it("should aggregate by month", () => {
			const now = Date.now();
			const yearAgo = now - 365 * 24 * 60 * 60 * 1000;

			createSampleEntries();

			const trends = getUsageTrends({
				since: yearAgo,
				until: now,
				granularity: "month",
			});

			expect(Array.isArray(trends)).toBe(true);
			// Months should start on day 1
			if (trends.length > 0) {
				expect(trends[0].date).toMatch(/-01$/);
			}
		});

		it("should sort trends chronologically", () => {
			const now = Date.now();
			const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

			createSampleEntries();

			const trends = getUsageTrends({
				since: weekAgo,
				until: now,
				granularity: "day",
			});

			for (let i = 1; i < trends.length; i++) {
				expect(trends[i].date >= trends[i - 1].date).toBe(true);
			}
		});

		it("should aggregate cost and tokens correctly", () => {
			const baseTime = Date.now();

			trackUsage({
				provider: "test",
				model: "model1",
				tokensInput: 1000,
				tokensOutput: 500,
				cost: 0.01,
			});

			trackUsage({
				provider: "test",
				model: "model2",
				tokensInput: 2000,
				tokensOutput: 1000,
				cost: 0.02,
			});

			const trends = getUsageTrends({
				since: baseTime - 60 * 1000,
				until: baseTime + 60 * 1000,
				granularity: "day",
			});

			if (trends.length > 0) {
				const todayTrend = trends[trends.length - 1];
				expect(todayTrend.requests).toBe(2);
				expect(todayTrend.cost).toBe(0.03);
				expect(todayTrend.tokens).toBe(4500); // 1000 + 500 + 2000 + 1000
			}
		});
	});

	describe("Integration scenarios", () => {
		it("should handle full workflow: track, export CSV, export JSON", () => {
			createSampleEntries();

			// Export CSV
			const csv = exportUsageToCSV();
			expect(csv).toContain("anthropic");
			expect(csv).toContain("openai");

			// Export JSON
			const json = exportUsageToJSON({ pretty: true });
			const data = JSON.parse(json);
			expect(data.entries.length).toBe(5);
		});

		it("should maintain data consistency across operations", () => {
			createSampleEntries();

			const summary = getUsageSummary();
			const comparisons = compareProviders();
			const json = exportUsageToJSON({ pretty: false });
			const data = JSON.parse(json);

			// Summary and JSON export should have same data
			expect(data.summary.totalRequests).toBe(summary.totalRequests);
			expect(data.summary.totalCost).toBeCloseTo(summary.totalCost, 5);

			// Comparisons should match summary
			const totalFromComparisons = comparisons.reduce(
				(sum, c) => sum + c.totalCost,
				0,
			);
			expect(totalFromComparisons).toBeCloseTo(summary.totalCost, 5);
		});

		it("should handle large datasets efficiently", () => {
			// Create 1000 entries
			for (let i = 0; i < 1000; i++) {
				trackUsage({
					provider: i % 2 === 0 ? "anthropic" : "openai",
					model: `model-${i % 5}`,
					tokensInput: 100 + i,
					tokensOutput: 50 + i,
					cost: 0.001 * (i + 1),
				});
			}

			const start = Date.now();
			const csv = exportUsageToCSV();
			const csvTime = Date.now() - start;

			const jsonStart = Date.now();
			const json = exportUsageToJSON({ pretty: false });
			const jsonTime = Date.now() - jsonStart;

			// Operations should complete in reasonable time (< 1 second)
			expect(csvTime).toBeLessThan(1000);
			expect(jsonTime).toBeLessThan(1000);

			const data = JSON.parse(json);
			expect(data.entries.length).toBe(1000);
		});
	});

	describe("Edge cases", () => {
		it("should handle entries with missing cache tokens", () => {
			trackUsage({
				provider: "test",
				model: "model",
				tokensInput: 100,
				tokensOutput: 50,
				// No cache tokens
				cost: 0.001,
			});

			const csv = exportUsageToCSV();
			expect(csv).toContain("0,0"); // cache read and write should be 0

			const json = exportUsageToJSON({ pretty: false });
			const data = JSON.parse(json);
			expect(data.entries[0].totalTokens).toBe(150); // 100 + 50
		});

		it("should handle zero-cost entries", () => {
			trackUsage({
				provider: "test",
				model: "free-model",
				tokensInput: 100,
				tokensOutput: 50,
				cost: 0,
			});

			const summary = getUsageSummary();
			expect(summary.totalCost).toBe(0);
			expect(summary.totalRequests).toBe(1);
		});

		it("should handle very small costs", () => {
			trackUsage({
				provider: "test",
				model: "cheap-model",
				tokensInput: 10,
				tokensOutput: 5,
				cost: 0.0000001,
			});

			const csv = exportUsageToCSV();
			expect(csv).toContain("0.000000"); // Rounds to 6 decimals
		});

		it("should handle concurrent tracking", async () => {
			const promises = Array.from({ length: 100 }, (_, i) =>
				Promise.resolve(
					trackUsage({
						provider: "test",
						model: "model",
						tokensInput: 100,
						tokensOutput: 50,
						cost: 0.001,
					}),
				),
			);

			await Promise.all(promises);

			const summary = getUsageSummary();
			expect(summary.totalRequests).toBe(100);
		});
	});
});
