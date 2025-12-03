/**
 * Skills System - Dynamic skill discovery and loading.
 *
 * Skills are domain-specific instruction sets that can be loaded
 * dynamically by the agent when it recognizes a matching task.
 *
 * @example
 * ```typescript
 * import { loadSkills, createSkillTool, getSkillsSummary } from "./skills";
 *
 * // Load all available skills
 * const skills = loadSkills(process.cwd());
 *
 * // Create the Skill tool for the agent
 * const skillTool = createSkillTool(process.cwd());
 *
 * // Get skill summary for system prompt
 * const summary = getSkillsSummary(skills);
 * ```
 */

export {
	type LoadedSkill,
	type SkillDefinition,
	type SkillResource,
	findSkill,
	formatSkillForInjection,
	formatSkillListItem,
	getSkillsSummary,
	loadSkills,
	searchSkills,
} from "./loader.js";

export { createSkillTool, invalidateSkillCache } from "./tool.js";
