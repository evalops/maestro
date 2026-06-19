/**
 * Skill composition - splice content from one skill into another at activation time.
 *
 * When the agent activates a skill (e.g., `review`), a composer can splice in
 * the body of a companion skill defined in the repo (e.g., `review-guidelines`)
 * so the agent receives a single composed payload instead of having to invoke
 * two skills serially. Composition is opt-in per parent skill - skills without
 * a registered composer pass through unchanged.
 */

import { createHash } from "node:crypto";
import type { LoadedSkill } from "./loader.js";

interface SkillComposer {
	/** Whether this composer applies to the active skill. */
	appliesTo(skill: LoadedSkill): boolean;
	/** Produce a composed skill, or return the input if the partner skill is absent. */
	compose(skill: LoadedSkill, allSkills: LoadedSkill[]): LoadedSkill;
}

/**
 * Compose `review` with a repo-defined `review-guidelines` skill, if present.
 *
 * The guidelines body is appended to the review skill's content under a
 * `## Repository-specific review guidelines` heading. If the repo doesn't
 * define `review-guidelines`, the review skill passes through unchanged.
 */
const REVIEW_COMPOSER: SkillComposer = {
	appliesTo: (skill) => skill.name === "review",
	compose: (skill, allSkills) => {
		const guidelines = allSkills.find((s) => s.name === "review-guidelines");
		if (!guidelines) {
			return skill;
		}
		const composed = [
			skill.content,
			"",
			"## Repository-specific review guidelines",
			"",
			`_The following guidelines are defined by the \`review-guidelines\` skill in this repository (\`${guidelines.sourceType}\`)._`,
			"",
			guidelines.content,
		].join("\n");
		const contentSha = createHash("sha256")
			.update("composed-skill:v1")
			.update("\0parent:")
			.update(skill.contentSha)
			.update("\0partner:")
			.update(guidelines.name)
			.update("\0partner-sha:")
			.update(guidelines.contentSha)
			.update("\0content:")
			.update(composed)
			.digest("hex");
		return { ...skill, content: composed, contentSha };
	},
};

const COMPOSERS: readonly SkillComposer[] = [REVIEW_COMPOSER];

/**
 * Apply any registered composer for the active skill. Returns the input
 * unchanged if no composer matches or the partner skill is absent.
 *
 * Composition preserves `name`, `sourceType`, and other identity fields so
 * activation telemetry keyed on the parent skill remains correct.
 */
export function composeSkill(
	skill: LoadedSkill,
	allSkills: LoadedSkill[],
): LoadedSkill {
	for (const composer of COMPOSERS) {
		if (composer.appliesTo(skill)) {
			return composer.compose(skill, allSkills);
		}
	}
	return skill;
}
