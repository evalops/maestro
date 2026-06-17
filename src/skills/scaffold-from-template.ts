/**
 * Skill template → scaffolder converter
 *
 * Builds on the scaffolder primitive (part 1 of #2665, merged as
 * #2674) and the skill template registry (part 2, merged as #2700).
 * Pure helper that adapts a `SkillTemplate` to the
 * `ScaffoldSkillOptions` shape `scaffoldSkillWithBody` consumes — so
 * callers (e.g. the `/setup-*` slash commands, repo-init scripts)
 * don't duplicate the field-mapping logic.
 *
 * No I/O. The actual disk write still lives in
 * `scaffoldSkillWithBody`; this module just builds the input.
 */

import type { ScaffoldSkillOptions } from "./scaffolder.js";
import { type SkillTemplate, findSkillTemplate } from "./skill-templates.js";

/** Options that an `/setup-*` command can override at call time. */
export interface ScaffoldFromTemplateOverrides {
	/** Overrides the template's `body`. Useful when the user pre-supplied content. */
	body?: string;
	/** Overrides the template's `description`. */
	description?: string;
	/** Replace the template's `allowedTools` whitelist. */
	allowedTools?: string[];
	/** Replace the template's `builtinTools` list. */
	builtinTools?: string[];
	/**
	 * Extra metadata. Merged onto the template's metadata (overrides
	 * win on key collisions). Merge instead of replace so a template
	 * can ship a default metadata block + the caller can splice extras
	 * without restating the defaults.
	 */
	metadata?: Record<string, string>;
	/** Overwrite an existing skill directory. Defaults to false. */
	force?: boolean;
}

/** Resulting shape: name + scaffolder options ready to hand to the writer. */
export interface ScaffoldFromTemplateResult {
	name: string;
	options: ScaffoldSkillOptions;
}

/**
 * Convert a `SkillTemplate` (plus optional overrides) into the
 * argument shape `scaffoldSkillWithBody` consumes. Pure.
 *
 * The template's `tags` field is preserved on the helper's input but
 * doesn't make it into `ScaffoldSkillOptions` (the scaffolder doesn't
 * model tags). Callers that want to record tags should add them to
 * `metadata` via the overrides.
 */
export function scaffoldOptionsFromTemplate(
	template: SkillTemplate,
	overrides: ScaffoldFromTemplateOverrides = {},
): ScaffoldFromTemplateResult {
	const description = overrides.description ?? template.description;
	if (!description.trim()) {
		throw new Error(
			"scaffoldOptionsFromTemplate: description is required (template or override must supply one)",
		);
	}
	const body = overrides.body ?? template.body;
	if (!body.trim()) {
		throw new Error(
			"scaffoldOptionsFromTemplate: body is required (template or override must supply one)",
		);
	}
	const options: ScaffoldSkillOptions = {
		description,
		body,
	};
	const allowedTools = overrides.allowedTools ?? template.allowedTools;
	if (allowedTools !== undefined) {
		options.allowedTools = allowedTools;
	}
	const builtinTools = overrides.builtinTools ?? template.builtinTools;
	if (builtinTools !== undefined) {
		options.builtinTools = builtinTools;
	}
	const metadata = mergeMetadata(template.metadata, overrides.metadata);
	if (metadata !== undefined) {
		options.metadata = metadata;
	}
	if (overrides.force !== undefined) {
		options.force = overrides.force;
	}
	return { name: template.name, options };
}

/**
 * Convenience: look up a template by name and convert it in one step.
 * Throws when no template matches — `/setup-foo` commands generally
 * shouldn't reach this path with an unknown name, but we surface a
 * clear error so misconfiguration is loud.
 */
export function scaffoldOptionsForTemplateName(
	name: string,
	overrides: ScaffoldFromTemplateOverrides = {},
): ScaffoldFromTemplateResult {
	const template = findSkillTemplate(name);
	if (!template) {
		throw new Error(
			`scaffoldOptionsForTemplateName: no template named "${name}" in the canonical registry`,
		);
	}
	return scaffoldOptionsFromTemplate(template, overrides);
}

function mergeMetadata(
	base: Record<string, string> | undefined,
	overrides: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!base && !overrides) return undefined;
	return { ...(base ?? {}), ...(overrides ?? {}) };
}
