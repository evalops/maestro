import { describe, expect, it } from "vitest";
import {
	type AgentReadinessCriterion,
	BASE_READINESS_CRITERIA,
	EVALOPS_READINESS_CRITERIA,
	criteriaByCategory,
	criteriaByScope,
	criteriaUpToLevel,
	listAllCriteria,
	orderCriteriaByDependencies,
	summarizeCriteria,
} from "../../src/agent/readiness-criteria.js";

describe("agent/readiness-criteria", () => {
	describe("invariants", () => {
		it("ids are unique across the combined rubric", () => {
			const all = listAllCriteria();
			const ids = all.map((c) => c.id);
			expect(new Set(ids).size).toBe(ids.length);
		});

		it("every level is in 1..5", () => {
			for (const c of listAllCriteria()) {
				expect(c.level).toBeGreaterThanOrEqual(1);
				expect(c.level).toBeLessThanOrEqual(5);
			}
		});

		it("every category is one of the known buckets", () => {
			const known = new Set([
				"docs",
				"build",
				"testing",
				"style",
				"debugging",
				"security",
				"product",
			]);
			for (const c of listAllCriteria()) {
				expect(known.has(c.category)).toBe(true);
			}
		});

		it("every scope is application or repository", () => {
			for (const c of listAllCriteria()) {
				expect(["application", "repository"]).toContain(c.scope);
			}
		});

		it("every `requires` reference resolves to a known id", () => {
			const known = new Set(listAllCriteria().map((c) => c.id));
			for (const c of listAllCriteria()) {
				for (const dep of c.requires ?? []) {
					expect(known.has(dep)).toBe(true);
				}
			}
		});

		it("instructions are non-empty and end in a period or close brace", () => {
			for (const c of listAllCriteria()) {
				expect(c.instructions.length).toBeGreaterThan(20);
				expect(c.instructions.trim()).toMatch(/[.)\]]$/);
			}
		});
	});

	describe("criteriaUpToLevel", () => {
		it("returns level-1 only when asked for level 1", () => {
			const onlyOne = criteriaUpToLevel(1);
			expect(onlyOne.every((c) => c.level === 1)).toBe(true);
			expect(onlyOne.length).toBeGreaterThan(0);
		});

		it("includes levels 1 + 2 + 3 when asked for level 3", () => {
			const upTo3 = criteriaUpToLevel(3);
			const levels = new Set(upTo3.map((c) => c.level));
			expect(levels.has(1)).toBe(true);
			expect(levels.has(2)).toBe(true);
			expect(levels.has(3)).toBe(true);
			expect(levels.has(4)).toBe(false);
			expect(levels.has(5)).toBe(false);
		});

		it("accepts a custom source rubric", () => {
			const onlyBase = criteriaUpToLevel(5, BASE_READINESS_CRITERIA);
			for (const c of onlyBase) {
				expect(BASE_READINESS_CRITERIA).toContain(c);
			}
		});
	});

	describe("criteriaByCategory and criteriaByScope", () => {
		it("filters by category", () => {
			const security = criteriaByCategory("security");
			expect(security.length).toBeGreaterThan(0);
			expect(security.every((c) => c.category === "security")).toBe(true);
		});

		it("filters by scope", () => {
			const application = criteriaByScope("application");
			expect(application.length).toBeGreaterThan(0);
			expect(application.every((c) => c.scope === "application")).toBe(true);
		});
	});

	describe("orderCriteriaByDependencies", () => {
		it("places dependents after their prerequisites", () => {
			const ordered = orderCriteriaByDependencies(listAllCriteria());
			const indexById = new Map<string, number>(
				ordered.map((c, i) => [c.id, i]),
			);
			for (const c of ordered) {
				for (const dep of c.requires ?? []) {
					expect(indexById.get(c.id)).toBeGreaterThan(
						indexById.get(dep) ?? Number.POSITIVE_INFINITY,
					);
				}
			}
		});

		it("throws on a missing dependency", () => {
			const broken: AgentReadinessCriterion[] = [
				{
					id: "x",
					name: "X",
					description: "x.",
					category: "docs",
					level: 1,
					scope: "repository",
					instructions: "Instructions for X.",
					requires: ["does-not-exist"],
				},
			];
			expect(() => orderCriteriaByDependencies(broken)).toThrow(
				/Unknown readiness criterion id/,
			);
		});

		it("throws on a dependency cycle", () => {
			const cyclic: AgentReadinessCriterion[] = [
				{
					id: "a",
					name: "A",
					description: "a.",
					category: "docs",
					level: 1,
					scope: "repository",
					instructions: "Instructions for A.",
					requires: ["b"],
				},
				{
					id: "b",
					name: "B",
					description: "b.",
					category: "docs",
					level: 1,
					scope: "repository",
					instructions: "Instructions for B.",
					requires: ["a"],
				},
			];
			expect(() => orderCriteriaByDependencies(cyclic)).toThrow(/Cycle/);
		});
	});

	describe("summarizeCriteria", () => {
		it("returns counts that sum to the input length", () => {
			const summary = summarizeCriteria();
			const levelSum = Object.values(summary.byLevel).reduce(
				(a, b) => a + b,
				0,
			);
			const catSum = Object.values(summary.byCategory).reduce(
				(a, b) => a + b,
				0,
			);
			expect(levelSum).toBe(summary.total);
			expect(catSum).toBe(summary.total);
		});
	});

	describe("EvalOps layer", () => {
		it("ships at least the four anchor criteria", () => {
			const ids = EVALOPS_READINESS_CRITERIA.map((c) => c.id);
			expect(ids).toContain("eval_scenarios_defined");
			expect(ids).toContain("eval_regression_ci");
			expect(ids).toContain("prompt_versioning");
			expect(ids).toContain("model_capability_cards");
		});

		it("doesn't collide with base rubric ids", () => {
			const baseIds = new Set(BASE_READINESS_CRITERIA.map((c) => c.id));
			for (const c of EVALOPS_READINESS_CRITERIA) {
				expect(baseIds.has(c.id)).toBe(false);
			}
		});
	});
});
