import { describe, expect, it } from "vitest";
import {
	createSessionState,
	getContextWindowForModel,
	getSessionDuration,
	getSessionSummary,
	getTokenTotals,
	incrementTurnCount,
	recordAPIDuration,
	recordLinesChanged,
	recordModelUsage,
	recordSubagentCompletion,
	recordToolDuration,
	resetSessionStats,
	setBypassPermissionsMode,
	setPlanModeExited,
} from "../../src/tracking/session-state.js";

describe("session-state", () => {
	describe("createSessionState", () => {
		it("creates state with defaults", () => {
			const state = createSessionState({
				sessionId: "test-session",
				cwd: "/test/dir",
			});

			expect(state.sessionId).toBe("test-session");
			expect(state.cwd).toBe("/test/dir");
			expect(state.originalCwd).toBe("/test/dir");
			expect(state.isInteractive).toBe(true);
			expect(state.clientType).toBe("cli");
			expect(state.totalCostUSD).toBe(0);
			expect(state.turnCount).toBe(0);
			expect(state.subagentCount).toBe(0);
		});

		it("accepts custom options", () => {
			const state = createSessionState({
				sessionId: "test-session",
				cwd: "/test/dir",
				isInteractive: false,
				clientType: "api",
			});

			expect(state.isInteractive).toBe(false);
			expect(state.clientType).toBe("api");
		});
	});

	describe("getContextWindowForModel", () => {
		it("returns 1M for 1m models", () => {
			expect(getContextWindowForModel("claude-3-5-sonnet-1m")).toBe(1_000_000);
			expect(getContextWindowForModel("model-with-1M-context")).toBe(1_000_000);
		});

		it("returns 200K for standard models", () => {
			expect(getContextWindowForModel("claude-3-5-sonnet")).toBe(200_000);
			expect(getContextWindowForModel("claude-opus-4")).toBe(200_000);
		});
	});

	describe("recordModelUsage", () => {
		it("records usage for a new model", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordModelUsage(state, "claude-3-5-sonnet", {
				inputTokens: 1000,
				outputTokens: 500,
				costUSD: 0.01,
			});

			expect(state.modelUsage["claude-3-5-sonnet"]).toBeDefined();
			expect(state.modelUsage["claude-3-5-sonnet"].inputTokens).toBe(1000);
			expect(state.modelUsage["claude-3-5-sonnet"].outputTokens).toBe(500);
			expect(state.modelUsage["claude-3-5-sonnet"].costUSD).toBe(0.01);
			expect(state.totalCostUSD).toBe(0.01);
		});

		it("accumulates usage for existing model", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordModelUsage(state, "claude-3-5-sonnet", {
				inputTokens: 1000,
				outputTokens: 500,
				costUSD: 0.01,
			});

			recordModelUsage(state, "claude-3-5-sonnet", {
				inputTokens: 500,
				outputTokens: 250,
				cacheReadInputTokens: 100,
				webSearchRequests: 2,
				costUSD: 0.005,
			});

			expect(state.modelUsage["claude-3-5-sonnet"].inputTokens).toBe(1500);
			expect(state.modelUsage["claude-3-5-sonnet"].outputTokens).toBe(750);
			expect(state.modelUsage["claude-3-5-sonnet"].cacheReadInputTokens).toBe(
				100,
			);
			expect(state.modelUsage["claude-3-5-sonnet"].webSearchRequests).toBe(2);
			expect(state.totalCostUSD).toBe(0.015);
		});

		it("tracks multiple models separately", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordModelUsage(state, "claude-3-5-sonnet", {
				inputTokens: 1000,
				outputTokens: 500,
				costUSD: 0.01,
			});

			recordModelUsage(state, "claude-opus-4", {
				inputTokens: 2000,
				outputTokens: 1000,
				costUSD: 0.05,
			});

			expect(Object.keys(state.modelUsage)).toHaveLength(2);
			expect(state.modelUsage["claude-3-5-sonnet"].inputTokens).toBe(1000);
			expect(state.modelUsage["claude-opus-4"].inputTokens).toBe(2000);
			expect(state.totalCostUSD).toBeCloseTo(0.06);
		});
	});

	describe("recordToolDuration", () => {
		it("accumulates tool duration", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordToolDuration(state, 100);
			recordToolDuration(state, 200);

			expect(state.totalToolDuration).toBe(300);
		});
	});

	describe("recordAPIDuration", () => {
		it("records API duration", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordAPIDuration(state, 500);

			expect(state.totalAPIDuration).toBe(500);
			expect(state.totalAPIDurationWithoutRetries).toBe(500);
		});

		it("excludes retries from non-retry total", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordAPIDuration(state, 500);
			recordAPIDuration(state, 300, true); // retry

			expect(state.totalAPIDuration).toBe(800);
			expect(state.totalAPIDurationWithoutRetries).toBe(500);
		});
	});

	describe("recordLinesChanged", () => {
		it("accumulates lines added and removed", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordLinesChanged(state, 100, 50);
			recordLinesChanged(state, 25, 10);

			expect(state.totalLinesAdded).toBe(125);
			expect(state.totalLinesRemoved).toBe(60);
		});
	});

	describe("recordSubagentCompletion", () => {
		it("tracks subagent count and duration", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordSubagentCompletion(state, 5000);
			recordSubagentCompletion(state, 3000);

			expect(state.subagentCount).toBe(2);
			expect(state.subagentDurationMs).toBe(8000);
		});
	});

	describe("incrementTurnCount", () => {
		it("increments turn count", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			incrementTurnCount(state);
			incrementTurnCount(state);
			incrementTurnCount(state);

			expect(state.turnCount).toBe(3);
		});
	});

	describe("setPlanModeExited", () => {
		it("sets plan mode exited state", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			expect(state.hasExitedPlanMode).toBe(false);

			setPlanModeExited(state, true);
			expect(state.hasExitedPlanMode).toBe(true);

			setPlanModeExited(state, false);
			expect(state.hasExitedPlanMode).toBe(false);
		});
	});

	describe("setBypassPermissionsMode", () => {
		it("sets bypass permissions mode", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			expect(state.sessionBypassPermissionsMode).toBe(false);

			setBypassPermissionsMode(state, true);
			expect(state.sessionBypassPermissionsMode).toBe(true);
		});
	});

	describe("getSessionDuration", () => {
		it("returns duration since start", async () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			// Wait a tiny bit - use slightly longer wait to avoid CI timing flakiness
			await new Promise((resolve) => setTimeout(resolve, 15));

			const duration = getSessionDuration(state);
			// Relax assertion slightly to account for CI timing variations
			expect(duration).toBeGreaterThanOrEqual(5);
		});
	});

	describe("getTokenTotals", () => {
		it("aggregates tokens across models", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordModelUsage(state, "claude-3-5-sonnet", {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 100,
				webSearchRequests: 1,
				costUSD: 0.01,
			});

			recordModelUsage(state, "claude-opus-4", {
				inputTokens: 2000,
				outputTokens: 1000,
				cacheCreationInputTokens: 50,
				webSearchRequests: 2,
				costUSD: 0.05,
			});

			const totals = getTokenTotals(state);

			expect(totals.inputTokens).toBe(3000);
			expect(totals.outputTokens).toBe(1500);
			expect(totals.cacheReadInputTokens).toBe(100);
			expect(totals.cacheCreationInputTokens).toBe(50);
			expect(totals.webSearchRequests).toBe(3);
		});

		it("returns zeros for empty state", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			const totals = getTokenTotals(state);

			expect(totals.inputTokens).toBe(0);
			expect(totals.outputTokens).toBe(0);
			expect(totals.webSearchRequests).toBe(0);
		});
	});

	describe("getSessionSummary", () => {
		it("returns formatted summary", () => {
			const state = createSessionState({
				sessionId: "test-123",
				cwd: "/test",
			});

			recordModelUsage(state, "claude-3-5-sonnet", {
				inputTokens: 1000,
				outputTokens: 500,
				costUSD: 0.05,
			});
			recordLinesChanged(state, 100, 25);
			incrementTurnCount(state);
			incrementTurnCount(state);
			recordSubagentCompletion(state, 5000);

			const summary = getSessionSummary(state);

			expect(summary.sessionId).toBe("test-123");
			expect(summary.totalCostUSD).toBe(0.05);
			expect(summary.totalCostFormatted).toBe("$0.05");
			expect(summary.turnCount).toBe(2);
			expect(summary.linesChanged.added).toBe(100);
			expect(summary.linesChanged.removed).toBe(25);
			expect(summary.tokens.inputTokens).toBe(1000);
			expect(summary.modelCount).toBe(1);
			expect(summary.subagentStats.count).toBe(1);
			expect(summary.subagentStats.durationMs).toBe(5000);
		});

		it("formats small costs with more precision", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordModelUsage(state, "claude-haiku", {
				inputTokens: 100,
				outputTokens: 50,
				costUSD: 0.0005,
			});

			const summary = getSessionSummary(state);
			expect(summary.totalCostFormatted).toBe("$0.0005");
		});

		it("formats duration appropriately", async () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			// Just test that it doesn't throw
			const summary = getSessionSummary(state);
			expect(summary.durationFormatted).toMatch(/^\d+s$/);
		});
	});

	describe("resetSessionStats", () => {
		it("resets all statistics", () => {
			const state = createSessionState({
				sessionId: "test",
				cwd: "/test",
			});

			recordModelUsage(state, "claude-3-5-sonnet", {
				inputTokens: 1000,
				outputTokens: 500,
				costUSD: 0.05,
			});
			recordLinesChanged(state, 100, 25);
			incrementTurnCount(state);
			recordSubagentCompletion(state, 5000);

			resetSessionStats(state);

			expect(state.totalCostUSD).toBe(0);
			expect(state.totalLinesAdded).toBe(0);
			expect(state.totalLinesRemoved).toBe(0);
			expect(state.turnCount).toBe(0);
			expect(state.subagentCount).toBe(0);
			expect(Object.keys(state.modelUsage)).toHaveLength(0);
			// Session ID and cwd should be preserved
			expect(state.sessionId).toBe("test");
			expect(state.cwd).toBe("/test");
		});
	});
});
