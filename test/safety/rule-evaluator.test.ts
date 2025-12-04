import { describe, expect, it } from "vitest";

import { type Rule, evaluateRules } from "../../src/safety/rule-evaluator.js";

interface Ctx {
	value: number;
}

describe("rule-evaluator", () => {
	it("returns first denial with reason fallback", () => {
		const rules: Rule<Ctx>[] = [
			{
				name: "always-allow",
				evaluate: () => ({ allowed: true }),
			},
			{
				name: "deny-mid",
				evaluate: (ctx) =>
					ctx.value >= 5 && ctx.value < 10
						? { allowed: false }
						: { allowed: true },
			},
			{
				name: "allow-rest",
				evaluate: () => ({ allowed: true }),
			},
		];

		const result = evaluateRules(rules, { value: 7 });
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('Rule "deny-mid" denied');
	});

	it("propagates provided reasons and last allow", () => {
		const rules: Rule<Ctx>[] = [
			{
				name: "allow",
				evaluate: () => ({ allowed: true, reason: "ok" }),
			},
		];

		const result = evaluateRules(rules, { value: 1 });
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("ok");
	});

	it("allows by default when no rules are provided", () => {
		const result = evaluateRules([], { value: 0 });
		expect(result.allowed).toBe(true);
		expect(result.reason).toBeUndefined();
	});
});
