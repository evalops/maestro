/**
 * Skills System - Dynamic skill discovery and loading.
 *
 * Skills are domain-specific instruction sets that can be loaded
 * dynamically by the agent when it recognizes a matching task.
 *
 * ## Progressive Skill Disclosure (#857)
 *
 * Skills use a two-phase loading system for context efficiency:
 *
 * 1. **System Prompt**: Only inject metadata (name + description) using
 *    `formatSkillsForSystemPrompt()` - ~10 tokens per skill
 * 2. **On-Demand**: Agent uses `read` tool to load full SKILL.md when needed
 *    - ~500+ tokens per skill, only when relevant
 *
 * This scales to 20+ skills without degrading conversation quality.
 *
 * @example
 * ```typescript
 * import { loadSkills, formatSkillsForSystemPrompt } from "./skills";
 *
 * // Load all available skills
 * const { skills } = loadSkills(process.cwd());
 *
 * // Get lightweight metadata for system prompt (progressive disclosure)
 * const systemPromptSkills = formatSkillsForSystemPrompt(skills);
 *
 * // Or use legacy full-content approach (not recommended)
 * const summary = getSkillsSummary(skills);
 * ```
 */

export {
	type LoadedSkill,
	type SkillDefinition,
	type SkillResource,
	findSkill,
	findSkillMd,
	formatSkillForInjection,
	formatSkillListItem,
	formatSkillMetadataOnly,
	formatSkillsForSystemPrompt,
	getSkillsSummary,
	loadSkills,
	parseFrontmatter,
	searchSkills,
	skillToDict,
	skillToJson,
	skillsToPrompt,
	stringArrayValue,
} from "./loader.js";

export { createSkillTool, invalidateSkillCache } from "./tool.js";
export {
	type SkillLintIssue,
	type SkillLintOptions,
	type SkillLintResult,
	type SkillScaffoldOptions,
	SKILL_BODY_MAX_CHARS,
	SKILL_BODY_MAX_LINES,
	formatSkillLintText,
	hasSkillLintErrors,
	isWindowsRunnableToolboxEntry,
	lintSkillDirectory,
	lintSkillPaths,
	scaffoldSkill,
	toolboxDescribeSpawnCommand,
	toolboxDescribeSpawnOptions,
} from "./linter.js";

export {
	type SkillEvalAssertion,
	type SkillEvalCase,
	type SkillEvalOutcome,
	type SkillEvalReport,
	type SkillEvalResult,
	evaluateSkillPackages,
	formatSkillEvalText,
	hasSkillEvalFailures,
} from "./eval-harness.js";
