import { describe, expect, it } from "vitest";
import {
	checkTokenBudget,
	createTokenBudgetTracker,
	getBudgetContinuationPrompt,
	parseTokenBudget,
} from "../../src/agent/token-budget.js";

describe("token budget", () => {
	describe("parseTokenBudget", () => {
		it("parses shorthand budgets at the start of the prompt", () => {
			expect(parseTokenBudget("+500k continue until done")).toBe(500_000);
		});

		it("parses shorthand budgets at the end of the prompt", () => {
			expect(parseTokenBudget("keep going +2m")).toBe(2_000_000);
		});

		it("parses verbose budget requests", () => {
			expect(parseTokenBudget("use 1.5B tokens on this")).toBe(1_500_000_000);
		});

		it("returns null when no explicit budget is present", () => {
			expect(parseTokenBudget("finish the bug fix")).toBeNull();
		});
	});

	describe("checkTokenBudget", () => {
		it("continues until the turn approaches the explicit budget", () => {
			const tracker = createTokenBudgetTracker();

			const first = checkTokenBudget(tracker, 1_000, 200);
			expect(first).toMatchObject({
				action: "continue",
				continuationCount: 1,
				pct: 20,
				turnOutputTokens: 200,
				budget: 1_000,
			});

			const second = checkTokenBudget(tracker, 1_000, 950);
			expect(second).toEqual({
				action: "stop",
				completion: {
					continuationCount: 1,
					pct: 95,
					turnOutputTokens: 950,
					budget: 1_000,
					diminishingReturns: false,
					durationMs: expect.any(Number),
				},
			});
		});

		it("stops early after diminishing token gains", () => {
			const tracker = createTokenBudgetTracker();

			expect(checkTokenBudget(tracker, 10_000, 4_000)).toMatchObject({
				action: "continue",
				continuationCount: 1,
			});
			expect(checkTokenBudget(tracker, 10_000, 4_200)).toMatchObject({
				action: "continue",
				continuationCount: 2,
			});
			expect(checkTokenBudget(tracker, 10_000, 4_300)).toMatchObject({
				action: "continue",
				continuationCount: 3,
			});

			expect(checkTokenBudget(tracker, 10_000, 4_350)).toEqual({
				action: "stop",
				completion: {
					continuationCount: 3,
					pct: 44,
					turnOutputTokens: 4_350,
					budget: 10_000,
					diminishingReturns: true,
					durationMs: expect.any(Number),
				},
			});
		});
	});

	it("formats continuation prompts with human-readable token counts", () => {
		expect(getBudgetContinuationPrompt(25, 250_000, 1_000_000)).toBe(
			"Stopped at 25% of token target (250,000 / 1,000,000). Keep working - do not summarize.",
		);
	});
});
