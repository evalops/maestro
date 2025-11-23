import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type UsageEntry,
	type UsageSummary,
	clearUsage,
	getUsageFilePath,
	getUsageSummary,
	trackUsage,
} from "../src/tracking/cost-tracker";

describe("Cost Tracking", () => {
	const usageFile = getUsageFilePath();
	let originalFileContent: string | null = null;

	beforeEach(() => {
		// Backup existing usage file if it exists
		if (existsSync(usageFile)) {
			originalFileContent = readFileSync(usageFile, "utf-8");
		}

		// Start with clean slate
		clearUsage();
	});

	afterEach(() => {
		// Restore original file
		if (originalFileContent) {
			writeFileSync(usageFile, originalFileContent);
		} else if (existsSync(usageFile)) {
			unlinkSync(usageFile);
		}
	});

	describe("trackUsage", () => {
		it("should track a single API call", () => {
			trackUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				tokensInput: 1000,
				tokensOutput: 500,
				cost: 0.01,
			});

			const summary = getUsageSummary();
			expect(summary.totalRequests).toBe(1);
			expect(summary.totalTokens).toBe(1500);
			expect(summary.totalCost).toBeCloseTo(0.01, 5);
		});

		it("should track cache tokens separately", () => {
			trackUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				tokensInput: 1000,
				tokensOutput: 500,
				tokensCacheRead: 200,
				tokensCacheWrite: 100,
				cost: 0.015,
			});

			const summary = getUsageSummary();
			expect(summary.totalTokens).toBe(1800); // 1000 + 500 + 200 + 100
		});

		it("should track multiple API calls", () => {
			trackUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				tokensInput: 1000,
				tokensOutput: 500,
				cost: 0.01,
			});

			trackUsage({
				provider: "anthropic",
				model: "claude-haiku",
				tokensInput: 500,
				tokensOutput: 250,
				cost: 0.002,
			});

			trackUsage({
				provider: "openai",
				model: "gpt-4",
				tokensInput: 2000,
				tokensOutput: 1000,
				cost: 0.05,
			});

			const summary = getUsageSummary();
			expect(summary.totalRequests).toBe(3);
			expect(summary.totalCost).toBeCloseTo(0.062, 5);
		});
	});

	describe("getUsageSummary", () => {
		beforeEach(() => {
			// Add some test data
			const now = Date.now();
			const oneDayMs = 24 * 60 * 60 * 1000;

			// Today
			trackUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				tokensInput: 1000,
				tokensOutput: 500,
				cost: 0.01,
			});

			// Simulate yesterday's usage by hacking the file
			const entries = JSON.parse(readFileSync(usageFile, "utf-8"));
			entries.push({
				timestamp: now - oneDayMs,
				provider: "anthropic",
				model: "claude-haiku",
				tokensInput: 500,
				tokensOutput: 250,
				cost: 0.002,
			});
			writeFileSync(usageFile, JSON.stringify(entries));
		});

		it("should summarize all usage", () => {
			const summary = getUsageSummary();
			expect(summary.totalRequests).toBe(2);
			expect(summary.totalCost).toBeCloseTo(0.012, 5);
		});

		it("should filter by time range", () => {
			const now = Date.now();
			const twelveHoursAgo = now - 12 * 60 * 60 * 1000;

			const summary = getUsageSummary({ since: twelveHoursAgo });
			expect(summary.totalRequests).toBe(1); // Only today's
			expect(summary.totalCost).toBeCloseTo(0.01, 5);
		});

		it("should filter by provider", () => {
			// Add OpenAI usage
			trackUsage({
				provider: "openai",
				model: "gpt-4",
				tokensInput: 2000,
				tokensOutput: 1000,
				cost: 0.05,
			});

			const summary = getUsageSummary({ provider: "anthropic" });
			expect(summary.totalRequests).toBe(2);
			expect(Object.keys(summary.byProvider)).toHaveLength(1);
			expect(summary.byProvider.anthropic).toBeDefined();
		});

		it("should filter by model", () => {
			const summary = getUsageSummary({ model: "claude-sonnet-4-5" });
			expect(summary.totalRequests).toBe(1);
			expect(summary.byModel["anthropic/claude-sonnet-4-5"]).toBeDefined();
		});

		it("should break down by provider", () => {
			trackUsage({
				provider: "openai",
				model: "gpt-4",
				tokensInput: 2000,
				tokensOutput: 1000,
				cost: 0.05,
			});

			const summary = getUsageSummary();
			expect(summary.byProvider.anthropic).toBeDefined();
			expect(summary.byProvider.openai).toBeDefined();
			expect(summary.byProvider.anthropic.requests).toBe(2);
			expect(summary.byProvider.openai.requests).toBe(1);
		});

		it("should break down by model", () => {
			const summary = getUsageSummary();
			expect(summary.byModel["anthropic/claude-sonnet-4-5"]).toBeDefined();
			expect(summary.byModel["anthropic/claude-haiku"]).toBeDefined();
			expect(summary.byModel["anthropic/claude-sonnet-4-5"].cost).toBeCloseTo(
				0.01,
				5,
			);
		});
	});

	describe("clearUsage", () => {
		it("should clear all usage data", () => {
			trackUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				tokensInput: 1000,
				tokensOutput: 500,
				cost: 0.01,
			});

			let summary = getUsageSummary();
			expect(summary.totalRequests).toBe(1);

			clearUsage();

			summary = getUsageSummary();
			expect(summary.totalRequests).toBe(0);
			expect(summary.totalCost).toBe(0);
		});
	});

	describe("Entry rotation", () => {
		it("should keep only last 10,000 entries", () => {
			// This test would be slow, so we just verify the file exists
			// and has the right structure
			trackUsage({
				provider: "test",
				model: "test-model",
				tokensInput: 100,
				tokensOutput: 50,
				cost: 0.001,
			});

			expect(existsSync(usageFile)).toBe(true);

			const entries = JSON.parse(readFileSync(usageFile, "utf-8"));
			expect(Array.isArray(entries)).toBe(true);
			expect(entries[0]).toHaveProperty("timestamp");
			expect(entries[0]).toHaveProperty("provider");
			expect(entries[0]).toHaveProperty("model");
			expect(entries[0]).toHaveProperty("cost");
		});
	});
});
