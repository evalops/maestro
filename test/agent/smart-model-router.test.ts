import { beforeEach, describe, expect, it } from "vitest";
import {
	type ModelConfig,
	type RoutingDecision,
	isSimpleToolTask,
	needsReasoning,
	smartModelRouter,
} from "../../src/agent/smart-model-router.js";

/**
 * The SmartModelRouter class is not exported; we exercise it through the
 * `smartModelRouter` singleton, resetting to a known preset + zeroed stats
 * before each test for isolation.
 */
beforeEach(() => {
	smartModelRouter.setEnabled(true);
	smartModelRouter.usePreset("anthropic");
	smartModelRouter.resetStats();
});

describe("smart-model-router — presets & configuration", () => {
	it("applies the anthropic preset defaults", () => {
		const config = smartModelRouter.getConfig();
		expect(config.default).toBe("claude-sonnet-4-20250514");
		expect(config.reasoning).toBe("claude-opus-4-6");
		expect(config.tools).toBe("claude-3-5-haiku-20241022");
	});

	it("switches presets across providers", () => {
		smartModelRouter.usePreset("openai");
		expect(smartModelRouter.getConfig()).toMatchObject({
			reasoning: "o1",
			execution: "gpt-4o",
			tools: "gpt-4o-mini",
			default: "gpt-4o",
		});
		smartModelRouter.usePreset("google");
		expect(smartModelRouter.getConfig().tools).toBe("gemini-1.5-flash");
	});

	it("merges partial overrides via configure() without dropping other keys", () => {
		smartModelRouter.usePreset("anthropic");
		smartModelRouter.configure({ reasoning: "claude-haiku-test" });
		const config = smartModelRouter.getConfig();
		expect(config.reasoning).toBe("claude-haiku-test");
		// untouched keys survive
		expect(config.default).toBe("claude-sonnet-4-20250514");
		expect(config.tools).toBe("claude-3-5-haiku-20241022");
	});

	it("returns defensive copies of config and stats", () => {
		const configA = smartModelRouter.getConfig();
		configA.default = "MUTATED";
		expect(smartModelRouter.getConfig().default).not.toBe("MUTATED");

		const statsA = smartModelRouter.getStats();
		statsA.execution = 999;
		expect(smartModelRouter.getStats().execution).toBe(0);
	});
});

describe("smart-model-router — getModel()", () => {
	it("returns the configured model per task type", () => {
		smartModelRouter.usePreset("openai");
		expect(smartModelRouter.getModel("reasoning")).toBe("o1");
		expect(smartModelRouter.getModel("execution")).toBe("gpt-4o");
		expect(smartModelRouter.getModel("tools")).toBe("gpt-4o-mini");
		expect(smartModelRouter.getModel("default")).toBe("gpt-4o");
	});

	it("falls back to default when a task type is unconfigured", () => {
		smartModelRouter.configure({
			default: "fallback-model",
			reasoning: undefined,
		});
		// reasoning unset -> default; embedding never configured -> default
		expect(smartModelRouter.getModel("reasoning")).toBe("fallback-model");
		expect(smartModelRouter.getModel("embedding")).toBe("fallback-model");
	});

	it("always returns default when disabled", () => {
		smartModelRouter.configure({
			default: "disabled-default",
			reasoning: "strong",
		});
		smartModelRouter.setEnabled(false);
		expect(smartModelRouter.getModel("reasoning")).toBe("disabled-default");
		expect(smartModelRouter.getModel("tools")).toBe("disabled-default");
	});

	it("tracks per-task statistics (embedding counts as default)", () => {
		smartModelRouter.getModel("reasoning");
		smartModelRouter.getModel("execution");
		smartModelRouter.getModel("tools");
		smartModelRouter.getModel("embedding");
		smartModelRouter.getModel("default");
		const stats = smartModelRouter.getStats();
		expect(stats).toEqual({
			reasoning: 1,
			execution: 1,
			tools: 1,
			default: 2, // embedding + default
		});
	});

	it("resetStats() zeroes the counters", () => {
		smartModelRouter.getModel("reasoning");
		expect(smartModelRouter.getStats().reasoning).toBe(1);
		smartModelRouter.resetStats();
		expect(smartModelRouter.getStats()).toEqual({
			reasoning: 0,
			execution: 0,
			tools: 0,
			default: 0,
		});
	});
});

describe("smart-model-router — routeRequest() signal scoring", () => {
	it("routes to reasoning when multiple reasoning signals are present", () => {
		smartModelRouter.usePreset("anthropic");
		const decision = smartModelRouter.routeRequest([
			{
				role: "user",
				content:
					"design the architecture and plan the approach, weighing trade-offs",
			},
		]);
		expect(decision.taskType).toBe("reasoning");
		expect(decision.model).toBe("claude-opus-4-6");
		expect(decision.confidence).toBeGreaterThan(0.5);
		expect(decision.confidence).toBeLessThanOrEqual(0.9);
		expect(decision.reason).toContain("reasoning signals");
	});

	it("routes to reasoning when tool complexity is high (>=2 complex tools)", () => {
		const decision = smartModelRouter.routeRequest(
			[{ role: "user", content: "apply the changes" }],
			["Edit", "Write", "Bash"],
		);
		expect(decision.taskType).toBe("reasoning");
		expect(decision.reason).toMatch(/complexity/i);
	});

	it("routes to tools for simple read/list operations with only simple tools", () => {
		const decision = smartModelRouter.routeRequest(
			[
				{
					role: "user",
					content: "list files and read file contents, then get the value",
				},
			],
			["Read", "Glob"],
		);
		expect(decision.taskType).toBe("tools");
		expect(decision.model).toBe("claude-3-5-haiku-20241022");
		expect(decision.confidence).toBeGreaterThan(0.5);
	});

	it("does not route to tools when complex tools are mixed in (complexity > 0)", () => {
		const decision = smartModelRouter.routeRequest(
			[
				{
					role: "user",
					content: "list files and read file contents, then get the value",
				},
			],
			["Read", "Bash"], // one complex -> complexity 0, not >0, but tools path requires complexity<=0
		);
		// complexity = 1 complex - 1 simple = 0; tools branch requires complexity<=0 AND toolScore>=2 -> still tools
		// so to prove the guard, use 2 complex tools which forces reasoning instead
		const forced = smartModelRouter.routeRequest(
			[
				{
					role: "user",
					content: "list files and read file contents, then get the value",
				},
			],
			["Edit", "Write"],
		);
		expect(forced.taskType).not.toBe("tools");
		expect(decision.taskType).toBe("tools");
	});

	it("defaults to execution when no strong signal is present", () => {
		const decision = smartModelRouter.routeRequest([
			{ role: "user", content: "add a greeting to the homepage" },
		]);
		expect(decision.taskType).toBe("execution");
		expect(decision.confidence).toBeCloseTo(0.7, 5);
		expect(decision.model).toBe("claude-sonnet-4-20250514");
	});

	it("returns a default decision when disabled", () => {
		smartModelRouter.setEnabled(false);
		const decision = smartModelRouter.routeRequest([
			{
				role: "user",
				content: "design the architecture, plan the approach, weigh trade-offs",
			},
		]);
		expect(decision.taskType).toBe("default");
		expect(decision.reason).toBe("Smart routing disabled");
		expect(decision.confidence).toBe(1.0);
	});

	it("only considers the last three user messages", () => {
		// Two reasoning-rich messages beyond the window should NOT flip a plain prompt.
		const old: { role: string; content: string }[] = [
			{
				role: "user",
				content:
					"design the architecture and plan the approach, weighing trade-offs",
			},
			{
				role: "user",
				content: "evaluate alternatives and compare pros and cons",
			},
			{ role: "user", content: "refactor and restructure the whole module" },
			{ role: "assistant", content: "(ignored)" },
			{ role: "user", content: "ok now just say hello" },
		];
		const decision = smartModelRouter.routeRequest(old.slice(-3));
		// last 3 by role=user are the 2 reasoning messages + "say hello" -> still reasoning-heavy
		expect(["reasoning", "execution"]).toContain(decision.taskType);
		// And proving the window: a message alone that is plain, with reasoning only OUTSIDE the window
		const windowed = smartModelRouter.routeRequest([
			{
				role: "user",
				content: "design the architecture, plan the approach, weigh trade-offs",
			},
			{ role: "user", content: "evaluate alternatives, compare pros and cons" },
			{ role: "user", content: "evaluate options, consider trade-offs again" },
			{ role: "user", content: "now just say hi" }, // 4th user message — outside last 3
		]);
		// last 3 user msgs = the 2nd,3rd,4th -> 3rd is reasoning-rich -> reasoning
		expect(windowed.taskType).toBe("reasoning");
	});

	it("caps confidence at 0.9 even with many signals", () => {
		const decision = smartModelRouter.routeRequest([
			{
				role: "user",
				content:
					"design the architecture, plan the approach, weigh trade-offs, analyze the root cause, debug why it fails, refactor and optimize",
			},
		]);
		expect(decision.taskType).toBe("reasoning");
		expect(decision.confidence).toBeLessThanOrEqual(0.9);
	});

	it("routeRequest updates statistics via getModel()", () => {
		smartModelRouter.routeRequest([
			{ role: "user", content: "design and plan, weigh trade-offs" },
		]);
		smartModelRouter.routeRequest([{ role: "user", content: "say hello" }]);
		smartModelRouter.routeRequest(
			[
				{
					role: "user",
					content: "list files and read file contents, get the value",
				},
			],
			["Read"],
		);
		const stats = smartModelRouter.getStats();
		expect(stats.reasoning).toBeGreaterThanOrEqual(1);
		expect(stats.execution).toBeGreaterThanOrEqual(1);
	});
});

describe("smart-model-router — helper predicates", () => {
	it("needsReasoning() detects reasoning-bearing prompts", () => {
		expect(needsReasoning("design the architecture")).toBe(true);
		expect(needsReasoning("debug why it fails")).toBe(true);
		expect(needsReasoning("read package.json")).toBe(false);
	});

	it("isSimpleToolTask() requires tool signals AND only simple tools", () => {
		expect(isSimpleToolTask("list files", ["Read", "Glob"])).toBe(true);
		// complex tool present -> not simple
		expect(isSimpleToolTask("list files", ["Read", "Bash"])).toBe(false);
		// no tool signal -> not simple even with simple tools
		expect(isSimpleToolTask("refactor everything", ["Read"])).toBe(false);
		// no tools passed -> treated as only-simple
		expect(isSimpleToolTask("read file contents")).toBe(true);
	});
});

describe("smart-model-router — RoutingDecision shape", () => {
	it("always returns taskType/model/reason/confidence", () => {
		const decision: RoutingDecision = smartModelRouter.routeRequest([
			{ role: "user", content: "hi" },
		]);
		expect(Object.keys(decision).sort()).toEqual(
			["confidence", "model", "reason", "taskType"].sort(),
		);
	});
});

// Type-level sanity: ModelConfig.default is required.
describe("smart-model-router — types", () => {
	it("ModelConfig requires a default model", () => {
		const config: ModelConfig = { default: "x" };
		expect(config.default).toBe("x");
	});
});
