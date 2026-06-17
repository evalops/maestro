import { describe, expect, it } from "vitest";
import {
	diagnoseAllSkillCompositions,
	diagnoseSkillComposition,
	listCompositionRules,
} from "../../src/skills/composer-diagnostics.js";
import type { LoadedSkill } from "../../src/skills/loader.js";

function makeSkill(
	name: string,
	overrides: Partial<LoadedSkill> = {},
): LoadedSkill {
	return {
		name,
		description: `${name} skill`,
		sourcePath: `/tmp/${name}`,
		sourceType: "project",
		content: `# ${name}`,
		contentSha:
			"0000000000000000000000000000000000000000000000000000000000000000",
		resources: [],
		resourceDirs: {},
		...overrides,
	};
}

describe("skills/composer-diagnostics", () => {
	describe("diagnoseSkillComposition", () => {
		it("returns no-composer for a skill with no registered rule", () => {
			const diag = diagnoseSkillComposition(makeSkill("test"), []);
			expect(diag).toEqual({
				skillName: "test",
				verdict: "no-composer",
			});
		});

		it("returns partner-missing when the rule's partner isn't loaded", () => {
			const diag = diagnoseSkillComposition(makeSkill("review"), [
				makeSkill("review"),
			]);
			expect(diag).toMatchObject({
				skillName: "review",
				verdict: "partner-missing",
				expectedPartner: "review-guidelines",
			});
			expect(diag.effect).toMatch(/review guidelines/);
		});

		it("returns applied when the partner is loaded", () => {
			const diag = diagnoseSkillComposition(makeSkill("review"), [
				makeSkill("review"),
				makeSkill("review-guidelines"),
			]);
			expect(diag).toMatchObject({
				skillName: "review",
				verdict: "applied",
				expectedPartner: "review-guidelines",
			});
		});

		it("returns no-composer for the partner skill itself (partner has no own rule)", () => {
			const diag = diagnoseSkillComposition(makeSkill("review-guidelines"), [
				makeSkill("review"),
				makeSkill("review-guidelines"),
			]);
			expect(diag.verdict).toBe("no-composer");
		});
	});

	describe("diagnoseAllSkillCompositions", () => {
		it("returns one diagnostic per skill, sorted by skill name ascending", () => {
			const result = diagnoseAllSkillCompositions([
				makeSkill("zsh-tools"),
				makeSkill("review"),
				makeSkill("alpha"),
				makeSkill("review-guidelines"),
			]);
			expect(result.map((d) => d.skillName)).toEqual([
				"alpha",
				"review",
				"review-guidelines",
				"zsh-tools",
			]);
		});

		it("reports applied for the parent when the partner is present elsewhere in the list", () => {
			const result = diagnoseAllSkillCompositions([
				makeSkill("review"),
				makeSkill("review-guidelines"),
			]);
			const review = result.find((d) => d.skillName === "review");
			expect(review?.verdict).toBe("applied");
		});

		it("reports partner-missing when only the parent is loaded", () => {
			const result = diagnoseAllSkillCompositions([makeSkill("review")]);
			expect(result[0]?.verdict).toBe("partner-missing");
		});

		it("returns an empty list for an empty input", () => {
			expect(diagnoseAllSkillCompositions([])).toEqual([]);
		});
	});

	describe("listCompositionRules", () => {
		it("exposes the registered parent/partner rules", () => {
			const rules = listCompositionRules();
			expect(rules.length).toBeGreaterThan(0);
			expect(rules.some((r) => r.parent === "review")).toBe(true);
			for (const rule of rules) {
				expect(rule.parent.trim()).not.toBe("");
				expect(rule.partner.trim()).not.toBe("");
				expect(rule.effect.trim()).not.toBe("");
			}
		});
	});
});
