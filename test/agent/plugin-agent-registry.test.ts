import { describe, expect, it } from "vitest";
import { createPluginAgentApi } from "../../src/agent/plugin-agent-api.js";

const policy = {
	allowedModels: ["anthropic/claude-sonnet-4-6"],
	allowedTools: ["read", "search", "todo"],
	maxBudgets: { maxTurns: 20, maxToolCalls: 40, maxCostUsd: 10 },
	approvalMode: "prompt" as const,
	sandboxMode: "workspace-write" as const,
};

const baseConfig = {
	key: "focused-reviewer",
	label: "Focused reviewer",
	description: "Reviews a bounded change",
	systemPrompt: "Review the requested change and report actionable findings.",
	model: "anthropic/claude-sonnet-4-6",
	tools: ["read", "search"] as const,
	budgets: { maxTurns: 10, maxToolCalls: 20, maxCostUsd: 5 },
	approvalMode: "fail" as const,
	sandboxMode: "read-only" as const,
};

function api() {
	return createPluginAgentApi({
		policy,
		metadata: [
			{
				key: "focused-reviewer",
				label: "Focused reviewer",
				entry: "agents/focused-reviewer.js",
			},
		],
	});
}

describe("governed plugin agent registry", () => {
	it("creates immutable handles within host policy", () => {
		const handle = api().createAgent(baseConfig);

		expect(handle).toMatchObject({
			key: "focused-reviewer",
			model: "anthropic/claude-sonnet-4-6",
			tools: ["read", "search"],
			budgets: { maxTurns: 10, maxToolCalls: 20, maxCostUsd: 5 },
		});
		expect(Object.isFrozen(handle)).toBe(true);
		expect(Object.isFrozen(handle.tools)).toBe(true);
	});

	it("registers a validated primary mode", () => {
		const registry = api();
		const handle = registry.createAgent(baseConfig);

		registry.registerAgentMode({
			key: "focused-reviewer",
			label: "Focused reviewer",
			agent: handle,
			primary: true,
		});

		expect(registry.getAgentMode("focused-reviewer")).toMatchObject({
			primary: true,
			agent: handle,
		});
	});

	it("rejects duplicate mode keys atomically", () => {
		const registry = api();
		const handle = registry.createAgent(baseConfig);
		const registration = {
			key: "focused-reviewer",
			label: "Focused reviewer",
			agent: handle,
			primary: false,
		};
		registry.registerAgentMode(registration);

		expect(() => registry.registerAgentMode(registration)).toThrow(
			/duplicate/i,
		);
		expect(registry.listAgentModes()).toHaveLength(1);
	});

	it("rejects unknown tools and disallowed models", () => {
		expect(() => api().createAgent({ ...baseConfig, tools: ["bash"] })).toThrow(
			/tool/i,
		);
		expect(() =>
			api().createAgent({ ...baseConfig, model: "openai/gpt-5.5" }),
		).toThrow(/model/i);
	});

	it("resolves tools all to the host allowlist", () => {
		expect(api().createAgent({ ...baseConfig, tools: "all" }).tools).toEqual([
			"read",
			"search",
			"todo",
		]);
	});

	it("rejects unbounded or excessive budgets", () => {
		expect(() =>
			api().createAgent({
				...baseConfig,
				budgets: { ...baseConfig.budgets, maxTurns: 0 },
			}),
		).toThrow(/budget/i);
		expect(() =>
			api().createAgent({
				...baseConfig,
				budgets: { ...baseConfig.budgets, maxToolCalls: 41 },
			}),
		).toThrow(/budget/i);
		expect(() =>
			api().createAgent({
				...baseConfig,
				budgets: { ...baseConfig.budgets, maxCostUsd: 11 },
			}),
		).toThrow(/budget/i);
	});

	it("rejects metadata mismatches", () => {
		const registry = api();
		const handle = registry.createAgent(baseConfig);

		expect(() =>
			registry.registerAgentMode({
				key: "focused-reviewer",
				label: "Different label",
				agent: handle,
				primary: true,
			}),
		).toThrow(/metadata/i);
		expect(registry.listAgentModes()).toHaveLength(0);
	});

	it("rejects approval and sandbox permission escalation", () => {
		expect(() =>
			api().createAgent({ ...baseConfig, approvalMode: "auto" }),
		).toThrow(/approval/i);
		expect(() =>
			api().createAgent({ ...baseConfig, sandboxMode: "danger-full-access" }),
		).toThrow(/sandbox/i);
	});
});
