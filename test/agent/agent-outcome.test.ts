import { describe, expect, it } from "vitest";
import {
	normalizeAgentOutcome,
	resolveAdaptiveSubagentDispatch,
	summarizeAgentOutcomes,
} from "../../src/agent/agent-outcome.js";

describe("agent outcome control loop", () => {
	it("summarizes outcomes by subagent and identifies the best proven lane", () => {
		const outcomes = [
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "one",
				subagentType: "coder",
				status: "failed",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "two",
				subagentType: "browser-qa",
				status: "succeeded",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "three",
				subagentType: "browser-qa",
				status: "merged",
			}),
		];

		const summary = summarizeAgentOutcomes(outcomes);

		expect(summary.total).toBe(3);
		expect(summary.successRate).toBe(0.6667);
		expect(summary.bySubagent["browser-qa"]).toMatchObject({
			total: 2,
			successes: 2,
			successRate: 1,
		});
		expect(summary.bestSubagent).toBe("browser-qa");
	});

	it("escalates mode when recent outcomes are poor", () => {
		const outcomes = ["one", "two", "three"].map((taskId) =>
			normalizeAgentOutcome({
				source: "mission",
				taskId,
				subagentType: "coder",
				status: "failed",
			}),
		);

		const dispatch = resolveAdaptiveSubagentDispatch({
			mode: "rush",
			subagentType: "coder",
			outcomes,
		});

		expect(dispatch.mode).toBe("frontier");
		expect(dispatch.adaptation).toBe("escalated-mode");
		expect(dispatch.reasoningEffort).toBe("high");
	});

	it("does not switch subagent lanes based on unrelated wins", () => {
		const outcomes = [
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-one",
				taskType: "browser-qa",
				subagentType: "browser-qa",
				status: "succeeded",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-two",
				taskType: "browser-qa",
				subagentType: "browser-qa",
				status: "merged",
			}),
		];

		const dispatch = resolveAdaptiveSubagentDispatch({
			mode: "smart",
			subagentType: "coder",
			outcomes,
		});

		expect(dispatch.type).toBe("coder");
		expect(dispatch.adaptation).toBe("none");
	});

	it("switches lanes only after current lane failures on comparable work", () => {
		const outcomes = [
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-one",
				taskType: "product-fix",
				subagentType: "coder",
				status: "failed",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-two",
				taskType: "product-fix",
				subagentType: "coder",
				status: "blocked",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-one",
				taskType: "product-fix",
				subagentType: "browser-qa",
				status: "succeeded",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-two",
				taskType: "product-fix",
				subagentType: "browser-qa",
				status: "merged",
			}),
		];

		const dispatch = resolveAdaptiveSubagentDispatch({
			mode: "smart",
			subagentType: "coder",
			outcomes,
		});

		expect(dispatch.type).toBe("browser-qa");
		expect(dispatch.adaptation).toBe("best-known-subagent");
	});

	it("ranks comparable lanes before choosing the adaptive subagent", () => {
		const outcomes = [
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-one",
				taskType: "product-fix",
				subagentType: "coder",
				status: "failed",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-two",
				taskType: "product-fix",
				subagentType: "coder",
				status: "blocked",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-one",
				taskType: "product-fix",
				subagentType: "browser-qa",
				status: "succeeded",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-two",
				taskType: "product-fix",
				subagentType: "browser-qa",
				status: "merged",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "research-one",
				taskType: "docs",
				subagentType: "researcher",
				status: "succeeded",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "research-two",
				taskType: "docs",
				subagentType: "researcher",
				status: "merged",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "research-three",
				taskType: "docs",
				subagentType: "researcher",
				status: "succeeded",
			}),
		];

		expect(summarizeAgentOutcomes(outcomes).bestSubagent).toBe("researcher");

		const dispatch = resolveAdaptiveSubagentDispatch({
			mode: "smart",
			subagentType: "coder",
			outcomes,
		});

		expect(dispatch.type).toBe("browser-qa");
		expect(dispatch.adaptation).toBe("best-known-subagent");
	});

	it("reports when escalation and lane adaptation happen together", () => {
		const outcomes = [
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-one",
				taskType: "product-fix",
				subagentType: "coder",
				status: "failed",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-two",
				taskType: "product-fix",
				subagentType: "coder",
				status: "blocked",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-one",
				taskType: "product-fix",
				subagentType: "browser-qa",
				status: "succeeded",
			}),
		];

		const dispatch = resolveAdaptiveSubagentDispatch({
			mode: "smart",
			subagentType: "coder",
			outcomes,
		});

		expect(dispatch.mode).toBe("frontier");
		expect(dispatch.type).toBe("browser-qa");
		expect(dispatch.adaptation).toBe("escalated-mode-and-best-known-subagent");
	});

	it("compares candidate lanes by success rate on the failed task types", () => {
		const outcomes = [
			...Array.from({ length: 18 }, (_, index) =>
				normalizeAgentOutcome({
					source: "github-agent" as const,
					taskId: `code-docs-${index}`,
					taskType: "docs",
					subagentType: "coder" as const,
					status: "succeeded" as const,
				}),
			),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-product-one",
				taskType: "product-qa",
				subagentType: "coder",
				status: "failed",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-product-two",
				taskType: "product-qa",
				subagentType: "coder",
				status: "blocked",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-product",
				taskType: "product-qa",
				subagentType: "browser-qa",
				status: "succeeded",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-docs",
				taskType: "docs",
				subagentType: "browser-qa",
				status: "failed",
			}),
		];

		expect(summarizeAgentOutcomes(outcomes).bySubagent.coder?.successRate).toBe(
			0.9,
		);
		expect(
			summarizeAgentOutcomes(outcomes).bySubagent["browser-qa"]?.successRate,
		).toBe(0.5);

		const dispatch = resolveAdaptiveSubagentDispatch({
			mode: "smart",
			subagentType: "coder",
			outcomes,
		});

		expect(dispatch.type).toBe("browser-qa");
		expect(dispatch.adaptation).toBe("best-known-subagent");
	});

	it("does not switch lanes when failed current-lane outcomes have no task type", () => {
		const outcomes = [
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-one",
				subagentType: "coder",
				status: "failed",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-two",
				subagentType: "coder",
				status: "blocked",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-one",
				taskType: "browser-qa",
				subagentType: "browser-qa",
				status: "succeeded",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-two",
				taskType: "browser-qa",
				subagentType: "browser-qa",
				status: "merged",
			}),
		];

		const dispatch = resolveAdaptiveSubagentDispatch({
			mode: "smart",
			subagentType: "coder",
			outcomes,
		});

		expect(dispatch.type).toBe("coder");
		expect(dispatch.adaptation).toBe("none");
	});

	it("compares task types from failed current-lane outcomes only", () => {
		const outcomes = [
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-untyped-one",
				subagentType: "coder",
				status: "failed",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-untyped-two",
				subagentType: "coder",
				status: "blocked",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-typed-success",
				taskType: "product-fix",
				subagentType: "coder",
				status: "succeeded",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-one",
				taskType: "product-fix",
				subagentType: "browser-qa",
				status: "succeeded",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-two",
				taskType: "product-fix",
				subagentType: "browser-qa",
				status: "merged",
			}),
		];

		const dispatch = resolveAdaptiveSubagentDispatch({
			mode: "smart",
			subagentType: "coder",
			outcomes,
		});

		expect(dispatch.type).toBe("coder");
		expect(dispatch.adaptation).toBe("none");
	});

	it("does not switch lanes without a successful comparable candidate outcome", () => {
		const outcomes = [
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-one",
				taskType: "product-fix",
				subagentType: "coder",
				status: "failed",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "code-two",
				taskType: "product-fix",
				subagentType: "coder",
				status: "blocked",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-one",
				taskType: "product-fix",
				subagentType: "browser-qa",
				status: "failed",
			}),
			normalizeAgentOutcome({
				source: "github-agent",
				taskId: "qa-two",
				taskType: "product-fix",
				subagentType: "browser-qa",
				status: "blocked",
			}),
		];

		const dispatch = resolveAdaptiveSubagentDispatch({
			mode: "smart",
			subagentType: "coder",
			outcomes,
		});

		expect(dispatch.type).toBe("coder");
		expect(dispatch.adaptation).toBe("escalated-mode");
	});
});
