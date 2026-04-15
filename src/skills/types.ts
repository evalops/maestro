/**
 * Skills System Types
 *
 * Type definitions for the skills system that enables reusable,
 * shareable capabilities for the agent.
 */

/**
 * A skill definition.
 */
export interface Skill {
	/** Unique skill name (used in .maestro/skills/<name>.md) */
	name: string;
	/** Human-readable description */
	description: string;
	/** The skill's prompt/instructions content */
	content: string;
	/** File path where the skill is defined */
	filePath: string;
	/** Whether this skill is from the global config */
	isGlobal: boolean;
	/** Tags for categorization */
	tags?: string[];
	/** Required tools for this skill */
	requiredTools?: string[];
	/** Whether this skill is currently active in the session */
	active?: boolean;
}

/**
 * Skill metadata parsed from frontmatter.
 */
export interface SkillMetadata {
	/** Skill name override */
	name?: string;
	/** Skill description */
	description?: string;
	/** Tags for categorization */
	tags?: string[];
	/** Required tools */
	tools?: string[];
	/** Trigger patterns (when to auto-activate) */
	triggers?: string[];
}

/**
 * Result of loading skills from a directory.
 */
export interface SkillsLoadResult {
	/** Successfully loaded skills */
	skills: Skill[];
	/** Errors encountered during loading */
	errors: Array<{ file: string; error: string }>;
}

/**
 * Skill execution context.
 */
export interface SkillContext {
	/** Current working directory */
	cwd: string;
	/** Arguments passed to the skill */
	args?: string;
	/** Available tools */
	tools?: string[];
	/** Session ID */
	sessionId?: string;
}

/**
 * Options for skill activation.
 */
export interface SkillActivationOptions {
	/** Arguments to pass to the skill */
	args?: string;
	/** Whether to auto-deactivate after use */
	autoDeactivate?: boolean;
}
