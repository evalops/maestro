import { beforeEach, describe, expect, it } from "vitest";
import {
	ToolLedger,
	createToolLedger,
	formatDuration,
} from "../../src/agent/tool-ledger.js";

describe("agent/tool-ledger", () => {
	describe("ToolLedger", () => {
		let ledger: ToolLedger;

		beforeEach(() => {
			ledger = new ToolLedger();
		});

		describe("recordCall", () => {
			it("records a successful tool call", () => {
				ledger.recordCall("read", { path: "/file.ts" }, true, 100);

				const recent = ledger.getRecentCalls(1);
				expect(recent).toHaveLength(1);
				expect(recent[0].toolName).toBe("read");
				expect(recent[0].success).toBe(true);
				expect(recent[0].durationMs).toBe(100);
			});

			it("records a failed tool call", () => {
				ledger.recordCall("write", { path: "/file.ts" }, false, 50, {
					error: "Permission denied",
				});

				const recent = ledger.getRecentCalls(1);
				expect(recent[0].success).toBe(false);
				expect(recent[0].error).toBe("Permission denied");
			});

			it("records token cost if provided", () => {
				ledger.recordCall("search", { query: "test" }, true, 200, {
					tokenCost: 500,
				});

				const stats = ledger.getToolStats("search");
				expect(stats?.totalTokenCost).toBe(500);
			});

			it("tracks turn number", () => {
				ledger.recordCall("tool1", {}, true, 10);
				ledger.nextTurn();
				ledger.recordCall("tool2", {}, true, 10);

				const calls = ledger.getRecentCalls(2);
				expect(calls[0].turnNumber).toBe(0);
				expect(calls[1].turnNumber).toBe(1);
			});
		});

		describe("nextTurn", () => {
			it("increments turn counter", () => {
				expect(ledger.getCurrentTurn()).toBe(0);
				ledger.nextTurn();
				expect(ledger.getCurrentTurn()).toBe(1);
				ledger.nextTurn();
				expect(ledger.getCurrentTurn()).toBe(2);
			});
		});

		describe("getToolStats", () => {
			it("returns null for unknown tool", () => {
				expect(ledger.getToolStats("unknown")).toBeNull();
			});

			it("returns aggregated stats for a tool", () => {
				ledger.recordCall("bash", { command: "ls" }, true, 100);
				ledger.recordCall("bash", { command: "pwd" }, true, 50);
				ledger.recordCall("bash", { command: "fail" }, false, 30);

				const stats = ledger.getToolStats("bash");
				expect(stats).not.toBeNull();
				expect(stats?.totalCalls).toBe(3);
				expect(stats?.successCount).toBe(2);
				expect(stats?.failureCount).toBe(1);
				expect(stats?.totalDurationMs).toBe(180);
				expect(stats?.avgDurationMs).toBe(60);
			});
		});

		describe("getSessionStats", () => {
			it("returns complete session stats", () => {
				ledger.recordCall("read", {}, true, 100);
				ledger.recordCall("read", {}, true, 50);
				ledger.recordCall("write", {}, true, 200);
				ledger.recordCall("bash", {}, false, 30);

				const stats = ledger.getSessionStats();
				expect(stats.totalCalls).toBe(4);
				expect(stats.successCount).toBe(3);
				expect(stats.failureCount).toBe(1);
				expect(stats.successRate).toBe(0.75);
				expect(stats.totalDurationMs).toBe(380);
			});

			it("returns top tools", () => {
				ledger.recordCall("read", {}, true, 10);
				ledger.recordCall("read", {}, true, 10);
				ledger.recordCall("read", {}, true, 10);
				ledger.recordCall("write", {}, true, 10);
				ledger.recordCall("write", {}, true, 10);
				ledger.recordCall("bash", {}, true, 10);

				const stats = ledger.getSessionStats();
				expect(stats.topTools[0].tool).toBe("read");
				expect(stats.topTools[0].calls).toBe(3);
			});

			it("identifies error-prone tools", () => {
				ledger.recordCall("flaky", {}, false, 10);
				ledger.recordCall("flaky", {}, false, 10);
				ledger.recordCall("flaky", {}, true, 10);
				ledger.recordCall("stable", {}, true, 10);
				ledger.recordCall("stable", {}, true, 10);
				ledger.recordCall("stable", {}, true, 10);

				const stats = ledger.getSessionStats();
				expect(stats.errorProneTools).toHaveLength(1);
				expect(stats.errorProneTools[0].tool).toBe("flaky");
				expect(stats.errorProneTools[0].errorRate).toBeCloseTo(0.67, 1);
			});
		});

		describe("getRecentCalls", () => {
			it("returns last N calls", () => {
				for (let i = 0; i < 20; i++) {
					ledger.recordCall(`tool${i}`, {}, true, 10);
				}

				const recent = ledger.getRecentCalls(5);
				expect(recent).toHaveLength(5);
				expect(recent[0].toolName).toBe("tool15");
				expect(recent[4].toolName).toBe("tool19");
			});
		});

		describe("getCallsForTool", () => {
			it("returns all calls for a specific tool", () => {
				ledger.recordCall("read", { path: "a" }, true, 10);
				ledger.recordCall("write", {}, true, 10);
				ledger.recordCall("read", { path: "b" }, true, 10);

				const calls = ledger.getCallsForTool("read");
				expect(calls).toHaveLength(2);
			});
		});

		describe("detectRepeatedFailures", () => {
			it("returns null when no repeated failures", () => {
				ledger.recordCall("tool", {}, true, 10);
				ledger.recordCall("tool", {}, false, 10);
				ledger.recordCall("tool", {}, true, 10);

				expect(ledger.detectRepeatedFailures()).toBeNull();
			});

			it("detects same tool failing repeatedly", () => {
				ledger.recordCall("bash", {}, false, 10);
				ledger.recordCall("bash", {}, false, 10);
				ledger.recordCall("bash", {}, false, 10);

				const warning = ledger.detectRepeatedFailures();
				expect(warning).toContain("bash");
				expect(warning).toContain("3 times");
			});

			it("detects same error repeated", () => {
				ledger.recordCall("a", {}, false, 10, { error: "Same error" });
				ledger.recordCall("b", {}, false, 10, { error: "Same error" });
				ledger.recordCall("c", {}, false, 10, { error: "Same error" });

				const warning = ledger.detectRepeatedFailures();
				expect(warning).toContain("Same error");
			});
		});

		describe("detectExcessiveUsage", () => {
			it("returns null when usage is reasonable", () => {
				for (let i = 0; i < 5; i++) {
					ledger.recordCall("tool", {}, true, 10);
				}
				expect(ledger.detectExcessiveUsage()).toBeNull();
			});

			it("detects excessive tool calls in a turn", () => {
				for (let i = 0; i < 25; i++) {
					ledger.recordCall("read", {}, true, 10);
				}

				const warning = ledger.detectExcessiveUsage();
				expect(warning).not.toBeNull();
				expect(warning?.tool).toBe("read");
				expect(warning?.count).toBe(25);
			});
		});

		describe("formatStats", () => {
			it("formats stats as readable string", () => {
				ledger.recordCall("read", {}, true, 1000);
				ledger.recordCall("read", {}, true, 500);
				ledger.recordCall("write", {}, false, 200);

				const formatted = ledger.formatStats();
				expect(formatted).toContain("Tool Usage Summary");
				expect(formatted).toContain("Total Calls: 3");
				expect(formatted).toContain("read: 2 calls");
			});
		});

		describe("toJSON", () => {
			it("exports ledger as JSON", () => {
				ledger.recordCall("test", {}, true, 100);

				const json = ledger.toJSON();
				expect(json.records).toHaveLength(1);
				expect(json.stats).toBeDefined();
				expect(json.sessionStart).toBeDefined();
			});
		});

		describe("reset", () => {
			it("clears all data", () => {
				ledger.recordCall("tool", {}, true, 100);
				ledger.nextTurn();

				ledger.reset();

				expect(ledger.getCurrentTurn()).toBe(0);
				expect(ledger.getRecentCalls()).toHaveLength(0);
				expect(ledger.getSessionStats().totalCalls).toBe(0);
			});
		});

		describe("input sanitization", () => {
			it("redacts sensitive input fields", () => {
				ledger.recordCall(
					"test",
					{
						password: "secret123",
						apiKey: "key-abc",
						token: "tok-xyz",
						normal: "visible",
					},
					true,
					10,
				);

				const calls = ledger.getRecentCalls(1);
				expect(calls[0].input.password).toBe("[REDACTED]");
				expect(calls[0].input.apiKey).toBe("[REDACTED]");
				expect(calls[0].input.token).toBe("[REDACTED]");
				expect(calls[0].input.normal).toBe("visible");
			});

			it("truncates long string values", () => {
				const longString = "a".repeat(500);
				ledger.recordCall("test", { content: longString }, true, 10);

				const calls = ledger.getRecentCalls(1);
				expect((calls[0].input.content as string).length).toBeLessThan(250);
				expect(calls[0].input.content).toContain("...");
			});
		});
	});

	describe("createToolLedger", () => {
		it("creates a new ledger instance", () => {
			const ledger = createToolLedger();
			expect(ledger).toBeInstanceOf(ToolLedger);
		});
	});

	describe("formatDuration", () => {
		it("formats milliseconds", () => {
			expect(formatDuration(500)).toBe("500ms");
		});

		it("formats seconds", () => {
			expect(formatDuration(2500)).toBe("2.5s");
		});

		it("formats minutes", () => {
			expect(formatDuration(90000)).toBe("1.5m");
		});
	});
});
