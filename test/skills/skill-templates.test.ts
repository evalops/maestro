import { describe, expect, it } from "vitest";
import {
	SKILL_TEMPLATES,
	type SkillTemplate,
	findSkillTemplate,
	findSkillTemplates,
	makeSkillTemplateLookup,
} from "../../src/skills/skill-templates.js";

describe("skills/skill-templates", () => {
	describe("SKILL_TEMPLATES (canonical registry)", () => {
		it("ships the expected anchor templates", () => {
			const names = SKILL_TEMPLATES.map((t) => t.name);
			expect(names).toContain("review");
			expect(names).toContain("review-guidelines");
			expect(names).toContain("lint");
			expect(names).toContain("test");
		});

		it("has unique names across the canonical set", () => {
			const names = SKILL_TEMPLATES.map((t) => t.name);
			expect(new Set(names).size).toBe(names.length);
		});

		it("every template has a non-empty description + body + at least one tag", () => {
			for (const template of SKILL_TEMPLATES) {
				expect(template.description.trim()).not.toBe("");
				expect(template.body.trim()).not.toBe("");
				expect(template.tags.length).toBeGreaterThan(0);
			}
		});
	});

	describe("findSkillTemplate", () => {
		it("returns the template that matches by name", () => {
			expect(findSkillTemplate("review")?.name).toBe("review");
			expect(findSkillTemplate("lint")?.name).toBe("lint");
		});

		it("returns undefined for an unknown name", () => {
			expect(findSkillTemplate("ghost")).toBeUndefined();
		});

		it("returns undefined for blank / non-string input", () => {
			expect(findSkillTemplate("   ")).toBeUndefined();
			expect(findSkillTemplate(undefined as unknown as string)).toBeUndefined();
			expect(findSkillTemplate(42 as unknown as string)).toBeUndefined();
		});
	});

	describe("findSkillTemplates", () => {
		it("returns the full registry with no filters", () => {
			expect(findSkillTemplates().length).toBe(SKILL_TEMPLATES.length);
		});

		it("filters by tag (must match all requested tags)", () => {
			const reviewTagged = findSkillTemplates({ tags: ["review"] });
			expect(reviewTagged.map((t) => t.name)).toEqual([
				"review",
				"review-guidelines",
			]);
			const anchorReview = findSkillTemplates({
				tags: ["review", "anchor"],
			});
			expect(anchorReview.map((t) => t.name)).toEqual(["review"]);
		});

		it("ignores blank tag entries", () => {
			expect(findSkillTemplates({ tags: [""] }).length).toBe(
				SKILL_TEMPLATES.length,
			);
		});

		it("filters by case-insensitive search across name + description", () => {
			const matchesByDesc = findSkillTemplates({ search: "linter" });
			expect(matchesByDesc.some((t) => t.name === "lint")).toBe(true);
			const matchesByName = findSkillTemplates({ search: "RELEASE" });
			expect(matchesByName.map((t) => t.name)).toEqual(["release-notes"]);
		});

		it("combines tag + search filters (AND semantics)", () => {
			expect(
				findSkillTemplates({
					tags: ["tooling"],
					search: "linter",
				}).map((t) => t.name),
			).toEqual(["lint"]);
		});

		it("preserves registry declaration order", () => {
			const all = findSkillTemplates();
			expect(all.map((t) => t.name)).toEqual(
				SKILL_TEMPLATES.map((t) => t.name),
			);
		});
	});

	describe("makeSkillTemplateLookup", () => {
		it("returns a lookup that resolves templates by name", () => {
			const lookup = makeSkillTemplateLookup(SKILL_TEMPLATES);
			expect(lookup.byName("lint")?.name).toBe("lint");
			expect(lookup.byName("ghost")).toBeUndefined();
		});

		it("list() returns a defensive copy", () => {
			const lookup = makeSkillTemplateLookup(SKILL_TEMPLATES);
			const list = lookup.list();
			list.pop();
			expect(lookup.list().length).toBe(SKILL_TEMPLATES.length);
		});

		it("throws on duplicate template names", () => {
			const dup: SkillTemplate = {
				name: "dup",
				description: "x",
				body: "x",
				tags: ["x"],
			};
			expect(() => makeSkillTemplateLookup([dup, dup])).toThrow(
				/duplicate template name "dup"/,
			);
		});

		it("can build a lookup over a custom subset", () => {
			const custom = SKILL_TEMPLATES.slice(0, 2);
			const lookup = makeSkillTemplateLookup(custom);
			expect(lookup.list().map((t) => t.name)).toEqual(
				custom.map((t) => t.name),
			);
		});
	});
});
