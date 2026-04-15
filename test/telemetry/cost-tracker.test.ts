import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type BudgetAlert,
	costTracker,
	estimateCost,
} from "../../src/telemetry/cost-tracker.js";

describe("cost-tracker", () => {
	beforeEach(() => {
		costTracker.reset();
		// Clear any budget from previous tests
		costTracker.setBudget({});
	});

	afterEach(() => {
		costTracker.reset();
		costTracker.setBudget({});
	});

	describe("calculateCost", () => {
		it("calculates cost for known model", () => {
			const cost = costTracker.calculateCost({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
			});

			// $3/M input + $15/M output = $18
			expect(cost).toBe(18);
		});

		it("calculates cost with cached tokens", () => {
			const cost = costTracker.calculateCost({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 500_000,
				outputTokens: 500_000,
				cachedTokens: 500_000,
			});

			// $1.50 input + $7.50 output + $0.15 cached = $9.15
			expect(cost).toBe(9.15);
		});

		it("uses default pricing for unknown model", () => {
			const cost = costTracker.calculateCost({
				provider: "unknown",
				model: "unknown-model-xyz",
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
			});

			// Default: $5/M input + $15/M output = $20
			expect(cost).toBe(20);
		});

		it("handles zero tokens", () => {
			const cost = costTracker.calculateCost({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 0,
				outputTokens: 0,
			});

			expect(cost).toBe(0);
		});

		it("calculates fractional token costs correctly", () => {
			const cost = costTracker.calculateCost({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000, // 0.001M tokens
				outputTokens: 500,
			});

			// $0.003 input + $0.0075 output = $0.0105
			expect(cost).toBeCloseTo(0.0105, 4);
		});
	});

	describe("getPricing", () => {
		it("returns exact match pricing", () => {
			const pricing = costTracker.getPricing("claude-sonnet-4-20250514");
			expect(pricing.inputPerMillion).toBe(3);
			expect(pricing.outputPerMillion).toBe(15);
			expect(pricing.cachedInputPerMillion).toBe(0.3);
		});

		it("returns partial match pricing", () => {
			// claude-3-opus-20240229 should match "claude-3-opus"
			const pricing = costTracker.getPricing("claude-3-opus");
			expect(pricing.inputPerMillion).toBe(15);
			expect(pricing.outputPerMillion).toBe(75);
		});

		it("returns default pricing for unknown model", () => {
			const pricing = costTracker.getPricing("totally-unknown-model");
			expect(pricing.inputPerMillion).toBe(5);
			expect(pricing.outputPerMillion).toBe(15);
			expect(pricing.cachedInputPerMillion).toBeUndefined();
		});

		it("handles case-insensitive matching", () => {
			const pricing = costTracker.getPricing("GPT-4O");
			expect(pricing.inputPerMillion).toBe(2.5);
			expect(pricing.outputPerMillion).toBe(10);
		});

		it("does not confuse prefix-related models", () => {
			// gpt-4o must not resolve to gpt-4o-mini
			const gpt4o = costTracker.getPricing("gpt-4o");
			expect(gpt4o.inputPerMillion).toBe(2.5);
			expect(gpt4o.outputPerMillion).toBe(10);

			const gpt4oMini = costTracker.getPricing("gpt-4o-mini");
			expect(gpt4oMini.inputPerMillion).toBe(0.15);

			// o3 must not resolve to o3-mini
			const o3 = costTracker.getPricing("o3");
			expect(o3.inputPerMillion).toBe(2);
			expect(o3.outputPerMillion).toBe(8);

			const o3mini = costTracker.getPricing("o3-mini");
			expect(o3mini.inputPerMillion).toBe(1.1);
		});
	});

	describe("recordUsage", () => {
		it("records usage and returns cost", () => {
			const cost = costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			expect(cost).toBeGreaterThan(0);
			expect(costTracker.getTotalCost()).toBe(cost);
		});

		it("accumulates multiple usage records", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			const stats = costTracker.getStats();
			expect(stats.totalRequests).toBe(2);
			expect(stats.totalInputTokens).toBe(2000);
			expect(stats.totalOutputTokens).toBe(1000);
		});

		it("triggers per-request alert when exceeded", () => {
			const alerts: BudgetAlert[] = [];
			costTracker.setBudget({
				perRequestLimit: 0.001, // Very low limit
				onAlert: (alert) => alerts.push(alert),
			});

			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 10000, // Will exceed limit
				outputTokens: 5000,
			});

			expect(alerts).toHaveLength(1);
			expect(alerts[0]?.type).toBe("per_request_exceeded");
		});

		it("adds timestamp if not provided", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			// Record should be added even without explicit timestamp
			const stats = costTracker.getStats();
			expect(stats.totalRequests).toBe(1);
		});
	});

	describe("budget limits", () => {
		it("detects hard limit exceeded", () => {
			const alerts: BudgetAlert[] = [];
			costTracker.setBudget({
				hardLimit: 0.01,
				onAlert: (alert) => alerts.push(alert),
			});

			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 100000, // Will exceed $0.01
				outputTokens: 50000,
			});

			expect(alerts.some((a) => a.type === "hard_limit_exceeded")).toBe(true);
			expect(costTracker.isUnderBudget()).toBe(false);
		});

		it("detects hard limit approaching (90%)", () => {
			const alerts: BudgetAlert[] = [];
			costTracker.setBudget({
				hardLimit: 1.0,
				onAlert: (alert) => alerts.push(alert),
			});

			// Record usage that's ~94.5% of budget (between 90% and 100%)
			// 300,000 input tokens at $3/M = $0.90
			// 3,000 output tokens at $15/M = $0.045
			// Total = $0.945 (94.5% of $1.00)
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 300000,
				outputTokens: 3000,
			});

			expect(alerts.some((a) => a.type === "hard_limit_approaching")).toBe(
				true,
			);
		});

		it("detects soft limit exceeded", () => {
			const alerts: BudgetAlert[] = [];
			costTracker.setBudget({
				softLimit: 0.01,
				onAlert: (alert) => alerts.push(alert),
			});

			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 100000,
				outputTokens: 50000,
			});

			expect(alerts.some((a) => a.type === "soft_limit_exceeded")).toBe(true);
		});

		it("detects soft limit approaching (80%)", () => {
			const alerts: BudgetAlert[] = [];
			costTracker.setBudget({
				softLimit: 1.0,
				onAlert: (alert) => alerts.push(alert),
			});

			// Record usage that's ~85% of soft limit
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 250000, // ~$0.75
				outputTokens: 7000, // ~$0.105
			});

			expect(alerts.some((a) => a.type === "soft_limit_approaching")).toBe(
				true,
			);
		});

		it("sends each alert type only once", () => {
			const alerts: BudgetAlert[] = [];
			costTracker.setBudget({
				hardLimit: 0.01,
				onAlert: (alert) => alerts.push(alert),
			});

			// Exceed limit twice
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 100000,
				outputTokens: 50000,
			});

			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 100000,
				outputTokens: 50000,
			});

			// Should only have one hard_limit_exceeded alert
			const hardLimitAlerts = alerts.filter(
				(a) => a.type === "hard_limit_exceeded",
			);
			expect(hardLimitAlerts).toHaveLength(1);
		});

		it("clears alerts when budget is reset", () => {
			const alerts: BudgetAlert[] = [];
			costTracker.setBudget({
				hardLimit: 0.01,
				onAlert: (alert) => alerts.push(alert),
			});

			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 100000,
				outputTokens: 50000,
			});

			// Reset budget
			costTracker.setBudget({
				hardLimit: 0.01,
				onAlert: (alert) => alerts.push(alert),
			});

			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 100000,
				outputTokens: 50000,
			});

			// Should have two hard_limit_exceeded alerts (one before reset, one after)
			const hardLimitAlerts = alerts.filter(
				(a) => a.type === "hard_limit_exceeded",
			);
			expect(hardLimitAlerts).toHaveLength(2);
		});
	});

	describe("isUnderBudget", () => {
		it("returns true when no hard limit set", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 10000000,
				outputTokens: 10000000,
			});

			expect(costTracker.isUnderBudget()).toBe(true);
		});

		it("returns true when under hard limit", () => {
			costTracker.setBudget({ hardLimit: 100 });
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			expect(costTracker.isUnderBudget()).toBe(true);
		});

		it("returns false when at or over hard limit", () => {
			costTracker.setBudget({ hardLimit: 0.001 });
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 10000,
				outputTokens: 5000,
			});

			expect(costTracker.isUnderBudget()).toBe(false);
		});
	});

	describe("getRemainingBudget", () => {
		it("returns null when no hard limit set", () => {
			expect(costTracker.getRemainingBudget()).toBeNull();
		});

		it("returns remaining budget", () => {
			costTracker.setBudget({ hardLimit: 10 });
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1_000_000,
				outputTokens: 0,
			});

			// Hard limit $10, spent $3, remaining $7
			expect(costTracker.getRemainingBudget()).toBe(7);
		});

		it("returns 0 when over budget (not negative)", () => {
			costTracker.setBudget({ hardLimit: 1 });
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
			});

			// Spent $18, limit $1, should return 0 not -17
			expect(costTracker.getRemainingBudget()).toBe(0);
		});
	});

	describe("getBreakdown", () => {
		it("breaks down by provider", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});
			costTracker.recordUsage({
				provider: "openai",
				model: "gpt-4o",
				inputTokens: 1000,
				outputTokens: 500,
			});

			const breakdown = costTracker.getBreakdown();
			expect(Object.keys(breakdown.byProvider)).toHaveLength(2);
			expect(breakdown.byProvider.anthropic).toBeGreaterThan(0);
			expect(breakdown.byProvider.openai).toBeGreaterThan(0);
		});

		it("breaks down by model", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-3-haiku-20240307",
				inputTokens: 1000,
				outputTokens: 500,
			});

			const breakdown = costTracker.getBreakdown();
			expect(Object.keys(breakdown.byModel)).toHaveLength(2);
		});

		it("breaks down by tool", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
				tool: "search",
			});
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
				tool: "edit",
			});

			const breakdown = costTracker.getBreakdown();
			expect(Object.keys(breakdown.byTool)).toHaveLength(2);
			expect(breakdown.byTool.search).toBeGreaterThan(0);
			expect(breakdown.byTool.edit).toBeGreaterThan(0);
		});

		it("calculates input/output cost split", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
			});

			const breakdown = costTracker.getBreakdown();
			expect(breakdown.inputCost).toBe(3); // $3/M * 1M
			expect(breakdown.outputCost).toBe(15); // $15/M * 1M
		});

		it("calculates cached savings", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 0,
				outputTokens: 0,
				cachedTokens: 1_000_000,
			});

			const breakdown = costTracker.getBreakdown();
			// Full cost would be $3, cached cost is $0.30, savings = $2.70
			expect(breakdown.cachedSavings).toBe(2.7);
		});
	});

	describe("getStats", () => {
		it("returns correct statistics", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
				cachedTokens: 200,
			});
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 2000,
				outputTokens: 1000,
				cachedTokens: 300,
			});

			const stats = costTracker.getStats();
			expect(stats.totalRequests).toBe(2);
			expect(stats.totalInputTokens).toBe(3000);
			expect(stats.totalOutputTokens).toBe(1500);
			expect(stats.totalCachedTokens).toBe(500);
			expect(stats.avgCostPerRequest).toBe(stats.totalCost / 2);
		});

		it("handles empty records", () => {
			const stats = costTracker.getStats();
			expect(stats.totalRequests).toBe(0);
			expect(stats.totalInputTokens).toBe(0);
			expect(stats.totalOutputTokens).toBe(0);
			expect(stats.totalCachedTokens).toBe(0);
			expect(stats.totalCost).toBe(0);
			expect(stats.avgCostPerRequest).toBe(0);
		});
	});

	describe("formatSummary", () => {
		it("formats summary with basic info", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			const summary = costTracker.formatSummary();
			expect(summary).toContain("Session Cost:");
			expect(summary).toContain("Requests: 1");
			expect(summary).toContain("Tokens:");
		});

		it("includes cached info when present", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
				cachedTokens: 500,
			});

			const summary = costTracker.formatSummary();
			expect(summary).toContain("Cached:");
			expect(summary).toContain("saved");
		});

		it("includes budget info when set", () => {
			costTracker.setBudget({ hardLimit: 10 });
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			const summary = costTracker.formatSummary();
			expect(summary).toContain("Budget:");
			expect(summary).toContain("remaining");
		});
	});

	describe("reset", () => {
		it("clears all records", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});

			costTracker.reset();

			expect(costTracker.getTotalCost()).toBe(0);
			expect(costTracker.getStats().totalRequests).toBe(0);
		});

		it("clears alert history", () => {
			const alerts: BudgetAlert[] = [];
			costTracker.setBudget({
				hardLimit: 0.01,
				onAlert: (alert) => alerts.push(alert),
			});

			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 100000,
				outputTokens: 50000,
			});

			costTracker.reset();

			// Re-set budget after reset
			costTracker.setBudget({
				hardLimit: 0.01,
				onAlert: (alert) => alerts.push(alert),
			});

			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 100000,
				outputTokens: 50000,
			});

			// Should have alerts from both runs
			expect(alerts.length).toBeGreaterThan(1);
		});
	});

	describe("estimateCost", () => {
		it("estimates cost for known model", () => {
			const cost = estimateCost("claude-sonnet-4-20250514", 1_000_000, 500_000);
			// $3 input + $7.50 output = $10.50
			expect(cost).toBe(10.5);
		});

		it("estimates cost for unknown model with defaults", () => {
			const cost = estimateCost("unknown-model", 1_000_000, 1_000_000);
			// Default: $5 input + $15 output = $20
			expect(cost).toBe(20);
		});
	});

	describe("edge cases", () => {
		it("handles very large token counts", () => {
			const cost = costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 100_000_000, // 100M tokens
				outputTokens: 50_000_000, // 50M tokens
			});

			// $300 input + $750 output = $1050
			expect(cost).toBe(1050);
		});

		it("handles multiple providers in same session", () => {
			costTracker.recordUsage({
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				inputTokens: 1000,
				outputTokens: 500,
			});
			costTracker.recordUsage({
				provider: "openai",
				model: "gpt-4o",
				inputTokens: 1000,
				outputTokens: 500,
			});
			costTracker.recordUsage({
				provider: "google",
				model: "gemini-1.5-pro",
				inputTokens: 1000,
				outputTokens: 500,
			});

			const breakdown = costTracker.getBreakdown();
			expect(Object.keys(breakdown.byProvider)).toHaveLength(3);
		});

		it("handles model without cached pricing", () => {
			// gpt-4o doesn't have cachedInputPerMillion
			const cost = costTracker.calculateCost({
				provider: "openai",
				model: "gpt-4o",
				inputTokens: 1000,
				outputTokens: 500,
				cachedTokens: 500, // This should be ignored
			});

			// Only input + output cost, no cached cost
			// $0.0025 input + $0.005 output = $0.0075
			expect(cost).toBeCloseTo(0.0075, 4);
		});
	});
});
