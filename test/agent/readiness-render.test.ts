import { describe, expect, it } from "vitest";
import {
	type AgentReadinessCriterion,
	BASE_READINESS_CRITERIA,
} from "../../src/agent/readiness-criteria.js";
import {
	renderCriterion,
	renderReadinessCriteria,
} from "../../src/agent/readiness-render.js";

function makeCriterion(
	overrides: Partial<AgentReadinessCriterion> = {},
): AgentReadinessCriterion {
	return {
		id: "x",
		name: "Sample criterion",
		description: "What this measures.",
		category: "docs",
		level: 1,
		scope: "repository",
		instructions: "How the auditor evaluates this.",
		...overrides,
	};
}

describe("agent/readiness-render", () => {
	describe("renderReadinessCriteria", () => {
		it("emits a title + summary + grouped sections by default", () => {
			const out = renderReadinessCriteria([
				makeCriterion({ id: "readme", category: "docs", level: 1 }),
				makeCriterion({ id: "ci", category: "build", level: 2 }),
			]);
			expect(out).toContain("# Agent readiness criteria");
			expect(out).toContain("_2 criteria — L1: 1 · L2: 1_");
			expect(out).toContain("## Docs");
			expect(out).toContain("## Build & tooling");
		});

		it("accepts a custom title", () => {
			const out = renderReadinessCriteria([makeCriterion()], {
				title: "Floor checks",
			});
			expect(out).toContain("# Floor checks");
			expect(out).not.toContain("# Agent readiness criteria");
		});

		it("escapes markdown metacharacters in a custom title", () => {
			const out = renderReadinessCriteria([makeCriterion()], {
				title: "Floor `checks`\n## not-a-heading",
			});
			expect(out).toContain("# Floor \\`checks\\` ## not-a-heading");
			expect(out).not.toContain("\n## not-a-heading");
		});

		it("omits the heading entirely when title is null", () => {
			const out = renderReadinessCriteria([makeCriterion()], { title: null });
			expect(out.startsWith("#")).toBe(false);
		});

		it("renders empty-result placeholder when filters exclude everything", () => {
			const out = renderReadinessCriteria([makeCriterion({ level: 3 })], {
				maxLevel: 1,
			});
			expect(out).toContain("_No criteria match the requested filter._");
		});

		it("renders an empty-catalog placeholder when no criteria are defined", () => {
			const out = renderReadinessCriteria([]);
			expect(out).toContain("_No readiness criteria are defined._");
			expect(out).not.toContain("_No criteria match the requested filter._");
		});

		it("filters by maxLevel inclusively", () => {
			const out = renderReadinessCriteria(
				[
					makeCriterion({ id: "low", level: 1 }),
					makeCriterion({ id: "mid", level: 3 }),
					makeCriterion({ id: "high", level: 5 }),
				],
				{ maxLevel: 3 },
			);
			expect(out).toContain("`low`");
			expect(out).toContain("`mid`");
			expect(out).not.toContain("`high`");
		});

		it("filters by scope", () => {
			const out = renderReadinessCriteria(
				[
					makeCriterion({ id: "repo", scope: "repository" }),
					makeCriterion({ id: "app", scope: "application" }),
				],
				{ scope: "application" },
			);
			expect(out).toContain("`app`");
			expect(out).not.toContain("`repo`");
		});

		it("emits no section header for categories with zero criteria", () => {
			const out = renderReadinessCriteria(
				[makeCriterion({ id: "x", category: "docs" })],
				{},
			);
			expect(out).toContain("## Docs");
			expect(out).not.toContain("## Build & tooling");
			expect(out).not.toContain("## Testing");
		});

		it("sorts within a category by level ascending, then id ascending", () => {
			const out = renderReadinessCriteria([
				makeCriterion({ id: "z-id", category: "docs", level: 3 }),
				makeCriterion({ id: "a-id", category: "docs", level: 3 }),
				makeCriterion({ id: "m-id", category: "docs", level: 1 }),
			]);
			const aIdx = out.indexOf("`a-id`");
			const mIdx = out.indexOf("`m-id`");
			const zIdx = out.indexOf("`z-id`");
			// m (L1) before a (L3) before z (L3, same level but later id).
			expect(mIdx).toBeLessThan(aIdx);
			expect(aIdx).toBeLessThan(zIdx);
		});

		it("renders the BASE catalog without throwing and includes all categories that have entries", () => {
			expect(() =>
				renderReadinessCriteria(BASE_READINESS_CRITERIA),
			).not.toThrow();
			const out = renderReadinessCriteria(BASE_READINESS_CRITERIA);
			expect(out).toContain("## Docs");
		});
	});

	describe("renderCriterion", () => {
		it("renders id, name, level, scope, and description", () => {
			const out = renderCriterion(
				makeCriterion({
					id: "readme",
					name: "Has a README",
					level: 1,
					scope: "repository",
					description: "Project ships a README at the root.",
				}),
				false,
			);
			expect(out).toContain("**`readme`** — Has a README _(L1, repository)_");
			expect(out).toContain("Project ships a README at the root.");
		});

		it("annotates skippable criteria inline", () => {
			const out = renderCriterion(
				makeCriterion({ id: "node-engines", isSkippable: true }),
				false,
			);
			expect(out).toContain("· skippable");
		});

		it("lists `requires` ids on a Depends on line", () => {
			const out = renderCriterion(
				makeCriterion({
					id: "agents_md_validation",
					requires: ["agents_md", "frontmatter"],
				}),
				false,
			);
			expect(out).toContain("**Depends on:** `agents_md`, `frontmatter`");
		});

		it("uses GFM checkboxes when asChecklist=true", () => {
			const out = renderCriterion(makeCriterion(), true);
			expect(out.startsWith("- [ ] **")).toBe(true);
		});

		it("escapes markdown metacharacters in name + description", () => {
			const out = renderCriterion(
				makeCriterion({
					name: "`unsafe` *escape* test",
					description: "Has `inline` code _and_ emphasis",
				}),
				false,
			);
			expect(out).toContain("\\`unsafe\\`");
			expect(out).toContain("\\*escape\\*");
			expect(out).toContain("\\_and\\_");
		});

		it("renders ids and dependencies as safe inline code spans", () => {
			const out = renderCriterion(
				makeCriterion({
					id: "criterion`\n## not-a-heading",
					requires: ["dep`\n- not-a-bullet"],
				}),
				false,
			);
			expect(out).toContain("**``criterion` ## not-a-heading``**");
			expect(out).toContain("**Depends on:** ``dep` - not-a-bullet``");
			expect(out).not.toContain("\n## not-a-heading");
			expect(out).not.toContain("\n- not-a-bullet");
		});

		it("keeps markdown metacharacters in id literal inside the code span", () => {
			// Inside a code span CommonMark treats *, _, `, etc. as
			// literal — no need to escapeMd them, and a backslash would
			// render as a literal backslash. We just confirm metachars
			// stay intact and don't bleed out into surrounding markdown.
			const out = renderCriterion(
				makeCriterion({
					id: "*emph*_under_~strike~",
					requires: ["**bold**"],
				}),
				false,
			);
			expect(out).toContain("`*emph*_under_~strike~`");
			expect(out).toContain("`**bold**`");
			// No accidental italic / bold rendering outside the span.
			expect(out).not.toMatch(/\*\*emph[^`]/);
		});

		it("flattens embedded newlines so one criterion stays one list item", () => {
			const out = renderCriterion(
				makeCriterion({
					name: "Line one\n## not-a-heading",
					description: "First line\n- not another bullet",
				}),
				false,
			);
			expect(out).toContain("Line one ## not-a-heading");
			expect(out).toContain("First line - not another bullet");
			expect(out).not.toContain("\n## not-a-heading");
			expect(out).not.toContain("\n- not another bullet");
		});
	});
});
