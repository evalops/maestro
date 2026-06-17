/**
 * Skill composer diagnostics
 *
 * Builds on the skill composition hook (part 1 of #2671, merged as
 * #2671). The composer module decides at activation time whether to
 * splice a partner skill's body into the active skill. When something
 * unexpected happens — a guidelines partner is missing, a composer
 * silently passes through — there's no good way to inspect *why*.
 *
 * This module owns the "why" report. Given a skill + all available
 * skills, return a structured `SkillCompositionDiagnostic` that lists:
 *
 *   - whether composition applied
 *   - which partner the composer looked for
 *   - what the verdict was (applied / partner-missing / no-composer)
 *
 * Pure function over the loader types. No I/O, no activation side
 * effects. The `/skills diagnose` slash command surface comes in a
 * follow-up PR that consumes this.
 */

import type { LoadedSkill } from "./loader.js";

/** Per-skill registry of known compositions. Mirrors `composer.ts`. */
interface CompositionRule {
	/** Parent skill name that triggers this rule. */
	parent: string;
	/** Partner skill name the composer splices in when present. */
	partner: string;
	/**
	 * Human-readable explanation of what splicing produces. Surfaced
	 * verbatim in the diagnostic, so reviewers reading
	 * `/skills diagnose <name>` immediately know what changed.
	 */
	effect: string;
}

const RULES: readonly CompositionRule[] = [
	{
		parent: "review",
		partner: "review-guidelines",
		effect:
			"appends repo-specific review guidelines under a `## Repository-specific review guidelines` heading",
	},
];

/** Possible verdicts for a composition diagnostic. */
export type CompositionVerdict = "applied" | "partner-missing" | "no-composer";

/** Outcome of a single composition rule against the input skill. */
export interface SkillCompositionDiagnostic {
	/** Parent skill name evaluated. */
	skillName: string;
	/** Verdict for this skill. */
	verdict: CompositionVerdict;
	/** Partner skill name the rule was looking for; absent for `no-composer`. */
	expectedPartner?: string;
	/** Human-readable explanation of what would have spliced in. */
	effect?: string;
}

/**
 * Diagnose what `composeSkill` would do for `skill` given the
 * available skills. Returns a structured verdict instead of mutating
 * the input. Mirrors the composer module's matching logic.
 */
export function diagnoseSkillComposition(
	skill: LoadedSkill,
	allSkills: readonly LoadedSkill[],
): SkillCompositionDiagnostic {
	const rule = RULES.find((r) => r.parent === skill.name);
	if (!rule) {
		return { skillName: skill.name, verdict: "no-composer" };
	}
	const hasPartner = allSkills.some((s) => s.name === rule.partner);
	if (!hasPartner) {
		return {
			skillName: skill.name,
			verdict: "partner-missing",
			expectedPartner: rule.partner,
			effect: rule.effect,
		};
	}
	return {
		skillName: skill.name,
		verdict: "applied",
		expectedPartner: rule.partner,
		effect: rule.effect,
	};
}

/**
 * Diagnose every skill in `allSkills`. Sorted by parent skill name
 * ascending for stable output. Skills without a registered composer
 * are included (verdict `no-composer`) so reviewers can see at a
 * glance which surface had no special handling.
 */
export function diagnoseAllSkillCompositions(
	allSkills: readonly LoadedSkill[],
): SkillCompositionDiagnostic[] {
	return [...allSkills]
		.map((skill) => diagnoseSkillComposition(skill, allSkills))
		.sort((a, b) => {
			if (a.skillName === b.skillName) return 0;
			return a.skillName < b.skillName ? -1 : 1;
		});
}

/**
 * List the parent → partner rules the composer module currently
 * knows about. Useful for `/skills diagnose --rules` to surface what
 * composers are wired even when no skill triggers them in the
 * current repo.
 */
export function listCompositionRules(): readonly CompositionRule[] {
	return RULES;
}
