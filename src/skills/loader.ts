/**
 * Skills Loader - Dynamic skill discovery and loading system.
 *
 * Implements the Agent Skills specification (https://agentskills.io/specification).
 *
 * Skills are domain-specific instruction sets that provide:
 * - Detailed workflows and procedures
 * - Access to bundled resources (scripts, templates, references)
 * - Domain expertise for specialized tasks
 *
 * Skills are discovered from:
 * - ~/.composer/skills/ (user skills)
 * - .composer/skills/ (project skills)
 *
 * Each skill is a directory containing:
 * - SKILL.md or skill.md - Main skill file with YAML frontmatter
 * - Optional: scripts/, references/, assets/ directories
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("skills:loader");

/** Maximum lengths per Agent Skills spec */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

/** Allowed frontmatter fields per Agent Skills spec */
const ALLOWED_FIELDS = new Set([
	"name",
	"description",
	"license",
	"compatibility",
	"allowed-tools",
	"metadata",
	// Legacy fields (deprecated but supported for backwards compatibility)
	"tags",
	"author",
	"version",
	"triggers",
]);

/**
 * Skill definition from SKILL.md frontmatter (per Agent Skills spec).
 */
export interface SkillDefinition {
	/** Skill name (1-64 chars, lowercase alphanumeric + hyphens) */
	name: string;
	/** Description of what the skill does (1-1024 chars) */
	description: string;
	/** License identifier */
	license?: string;
	/** Compatibility/environment requirements (max 500 chars) */
	compatibility?: string;
	/** Space-delimited list of pre-approved tools */
	allowedTools?: string;
	/** Additional key-value metadata */
	metadata?: Record<string, string>;
	/** @deprecated Use metadata instead */
	tags?: string[];
	/** @deprecated Use metadata.author instead */
	author?: string;
	/** @deprecated Use metadata.version instead */
	version?: string;
	/** @deprecated Use description for trigger keywords instead */
	triggers?: string[];
}

/**
 * Loaded skill with full content.
 */
export interface LoadedSkill extends SkillDefinition {
	/** Source directory path */
	sourcePath: string;
	/** Source type: 'user' or 'project' */
	sourceType: "user" | "project";
	/** Full markdown content (without frontmatter) */
	content: string;
	/** List of bundled resource files */
	resources: SkillResource[];
	/** Resource directories */
	resourceDirs: SkillResourceDirs;
}

/**
 * Resource directories per Agent Skills spec.
 */
export interface SkillResourceDirs {
	/** Path to scripts directory if it exists */
	scriptsDir?: string;
	/** Path to references directory if it exists */
	referencesDir?: string;
	/** Path to assets directory if it exists */
	assetsDir?: string;
}

/**
 * A bundled resource file within a skill.
 */
export interface SkillResource {
	/** Resource file name */
	name: string;
	/** Full path to the resource */
	path: string;
	/** Resource type based on extension */
	type: "script" | "template" | "reference" | "other";
}

/**
 * Skill loading error.
 */
export class SkillLoadError extends Error {
	constructor(
		message: string,
		public readonly path: string,
		public readonly code:
			| "MISSING_FRONTMATTER"
			| "INVALID_YAML"
			| "INVALID_NAME"
			| "INVALID_DESCRIPTION"
			| "INVALID_COMPATIBILITY"
			| "UNEXPECTED_FIELDS"
			| "NAME_MISMATCH"
			| "READ_ERROR",
	) {
		super(message);
		this.name = "SkillLoadError";
	}
}

/**
 * Validate skill name per Agent Skills spec.
 */
function validateName(name: string, dirName: string): string | null {
	if (!name || typeof name !== "string") {
		return "Name must be a non-empty string";
	}

	if (name.length > MAX_NAME_LENGTH) {
		return `Name exceeds ${MAX_NAME_LENGTH} characters (got ${name.length})`;
	}

	if (name !== name.toLowerCase()) {
		return "Name must be lowercase";
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		return "Name cannot start or end with a hyphen";
	}

	if (name.includes("--")) {
		return "Name cannot contain consecutive hyphens";
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		return "Name can only contain lowercase letters, numbers, and hyphens";
	}

	// Directory name must match skill name (skip for 'skills' root dir)
	if (dirName !== "skills" && dirName !== name) {
		return `Directory name '${dirName}' must match skill name '${name}'`;
	}

	return null;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string): string | null {
	if (!description || typeof description !== "string") {
		return "Description must be a non-empty string";
	}

	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters (got ${description.length})`;
	}

	return null;
}

/**
 * Validate compatibility per Agent Skills spec.
 */
function validateCompatibility(compatibility: string): string | null {
	if (typeof compatibility !== "string") {
		return "Compatibility must be a string";
	}

	if (compatibility.length > MAX_COMPATIBILITY_LENGTH) {
		return `Compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} characters (got ${compatibility.length})`;
	}

	return null;
}

/**
 * Check for unexpected fields in frontmatter.
 */
function validateFields(frontmatter: Record<string, unknown>): string[] {
	const unexpected: string[] = [];

	for (const key of Object.keys(frontmatter)) {
		if (!ALLOWED_FIELDS.has(key)) {
			unexpected.push(key);
		}
	}

	return unexpected;
}

/**
 * Find SKILL.md file (case-insensitive per spec).
 */
function findSkillMd(dir: string): string | null {
	// Prefer uppercase
	const uppercase = join(dir, "SKILL.md");
	if (existsSync(uppercase)) {
		return uppercase;
	}

	// Fall back to lowercase
	const lowercase = join(dir, "skill.md");
	if (existsSync(lowercase)) {
		return lowercase;
	}

	return null;
}

/**
 * Parse YAML frontmatter from markdown content.
 */
function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	if (!content.trimStart().startsWith("---")) {
		throw new Error("Missing frontmatter delimiters");
	}

	const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
	const match = content.match(frontmatterRegex);

	if (!match) {
		throw new Error("Frontmatter not properly closed");
	}

	const [, yamlContent, body] = match;

	// Simple YAML parser for common patterns
	const frontmatter: Record<string, unknown> = {};
	const lines = yamlContent.split("\n");
	let currentKey: string | null = null;
	let currentArray: string[] | null = null;
	let inMetadata = false;
	let metadataObj: Record<string, string> = {};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Check for array item
		if (trimmed.startsWith("- ") && currentKey && currentArray) {
			currentArray.push(trimmed.slice(2).trim());
			continue;
		}

		// Check for metadata nested key
		if (inMetadata && line.startsWith("  ") && !trimmed.startsWith("-")) {
			const colonIndex = trimmed.indexOf(":");
			if (colonIndex > 0) {
				const key = trimmed.slice(0, colonIndex).trim();
				const value = trimmed
					.slice(colonIndex + 1)
					.trim()
					.replace(/^["']|["']$/g, "");
				metadataObj[key] = value;
				continue;
			}
		}

		// Save previous array if exists
		if (currentKey && currentArray) {
			frontmatter[currentKey] = currentArray;
			currentArray = null;
		}

		// End metadata block
		if (inMetadata && !line.startsWith("  ")) {
			frontmatter.metadata = metadataObj;
			inMetadata = false;
			metadataObj = {};
		}

		// Parse key: value
		const colonIndex = trimmed.indexOf(":");
		if (colonIndex > 0) {
			const key = trimmed.slice(0, colonIndex).trim();
			const value = trimmed.slice(colonIndex + 1).trim();

			if (key === "metadata" && value === "") {
				inMetadata = true;
				currentKey = null;
			} else if (value === "") {
				// Start of array
				currentKey = key;
				currentArray = [];
			} else {
				// Simple value - remove quotes if present
				frontmatter[key] = value.replace(/^["']|["']$/g, "");
				currentKey = null;
			}
		}
	}

	// Save final array if exists
	if (currentKey && currentArray) {
		frontmatter[currentKey] = currentArray;
	}

	// Save metadata if still in block
	if (inMetadata && Object.keys(metadataObj).length > 0) {
		frontmatter.metadata = metadataObj;
	}

	return { frontmatter, body };
}

/**
 * Determine resource type from file extension.
 */
function getResourceType(
	filename: string,
): "script" | "template" | "reference" | "other" {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";

	const scriptExtensions = ["sh", "bash", "py", "js", "ts", "rb", "pl"];
	const templateExtensions = ["hbs", "ejs", "mustache", "j2", "jinja", "tmpl"];
	const referenceExtensions = ["md", "txt", "json", "yaml", "yml", "toml"];

	if (scriptExtensions.includes(ext)) return "script";
	if (templateExtensions.includes(ext)) return "template";
	if (referenceExtensions.includes(ext)) return "reference";
	return "other";
}

/**
 * Load a single skill from a directory.
 */
function loadSkillFromDirectory(
	skillDir: string,
	sourceType: "user" | "project",
): LoadedSkill | SkillLoadError {
	const skillFile = findSkillMd(skillDir);
	const dirName = basename(skillDir);

	if (!skillFile) {
		return new SkillLoadError(
			`No SKILL.md found in ${skillDir}`,
			skillDir,
			"READ_ERROR",
		);
	}

	try {
		const rawContent = readFileSync(skillFile, "utf-8");
		let frontmatter: Record<string, unknown>;
		let body: string;

		try {
			({ frontmatter, body } = parseFrontmatter(rawContent));
		} catch (err) {
			return new SkillLoadError(
				`Invalid frontmatter: ${err instanceof Error ? err.message : String(err)}`,
				skillFile,
				"INVALID_YAML",
			);
		}

		// Check for unexpected fields (per Agent Skills spec)
		const unexpectedFields = validateFields(frontmatter);
		if (unexpectedFields.length > 0) {
			return new SkillLoadError(
				`Unexpected fields: ${unexpectedFields.join(", ")}. Only ${Array.from(ALLOWED_FIELDS).join(", ")} are allowed.`,
				skillFile,
				"UNEXPECTED_FIELDS",
			);
		}

		// Validate name
		const name = frontmatter.name as string;
		const nameError = validateName(name, dirName);
		if (nameError) {
			return new SkillLoadError(nameError, skillFile, "INVALID_NAME");
		}

		// Validate description
		const description = frontmatter.description as string;
		const descError = validateDescription(description);
		if (descError) {
			return new SkillLoadError(descError, skillFile, "INVALID_DESCRIPTION");
		}

		// Validate compatibility if present
		if (frontmatter.compatibility) {
			const compatError = validateCompatibility(
				frontmatter.compatibility as string,
			);
			if (compatError) {
				return new SkillLoadError(
					compatError,
					skillFile,
					"INVALID_COMPATIBILITY",
				);
			}
		}

		// Discover resource directories
		const resourceDirs: SkillResourceDirs = {};
		const scriptsDir = join(skillDir, "scripts");
		const referencesDir = join(skillDir, "references");
		const assetsDir = join(skillDir, "assets");

		if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
			resourceDirs.scriptsDir = scriptsDir;
		}
		if (existsSync(referencesDir) && statSync(referencesDir).isDirectory()) {
			resourceDirs.referencesDir = referencesDir;
		}
		if (existsSync(assetsDir) && statSync(assetsDir).isDirectory()) {
			resourceDirs.assetsDir = assetsDir;
		}

		// Discover bundled resources (legacy flat structure)
		const resources: SkillResource[] = [];
		try {
			const files = readdirSync(skillDir);
			for (const file of files) {
				if (file.toLowerCase() === "skill.md") continue;
				if (["scripts", "references", "assets"].includes(file)) continue;
				const filePath = join(skillDir, file);
				const stat = statSync(filePath);
				if (stat.isFile()) {
					resources.push({
						name: file,
						path: filePath,
						type: getResourceType(file),
					});
				}
			}
		} catch (err) {
			logger.debug("Error scanning skill resources", {
				skillDir,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		const skill: LoadedSkill = {
			name,
			description,
			license: frontmatter.license as string | undefined,
			compatibility: frontmatter.compatibility as string | undefined,
			allowedTools: frontmatter["allowed-tools"] as string | undefined,
			metadata: frontmatter.metadata as Record<string, string> | undefined,
			// Legacy fields for backwards compatibility
			tags: Array.isArray(frontmatter.tags)
				? (frontmatter.tags as string[])
				: undefined,
			author:
				typeof frontmatter.author === "string" ? frontmatter.author : undefined,
			version:
				typeof frontmatter.version === "string"
					? frontmatter.version
					: undefined,
			triggers: Array.isArray(frontmatter.triggers)
				? (frontmatter.triggers as string[])
				: undefined,
			sourcePath: skillDir,
			sourceType,
			content: body.trim(),
			resources,
			resourceDirs,
		};

		logger.debug("Loaded skill", {
			name: skill.name,
			sourceType,
			resourceCount: resources.length,
		});

		return skill;
	} catch (err) {
		return new SkillLoadError(
			`Error loading skill: ${err instanceof Error ? err.message : String(err)}`,
			skillDir,
			"READ_ERROR",
		);
	}
}

/**
 * Scan a directory for skill subdirectories.
 */
function scanSkillsDirectory(
	dir: string,
	sourceType: "user" | "project",
): { skills: LoadedSkill[]; errors: SkillLoadError[] } {
	if (!existsSync(dir)) {
		return { skills: [], errors: [] };
	}

	const skills: LoadedSkill[] = [];
	const errors: SkillLoadError[] = [];

	try {
		// Check for SKILL.md in root (single skill in skills dir)
		const rootSkillFile = findSkillMd(dir);
		if (rootSkillFile) {
			const result = loadSkillFromDirectory(dir, sourceType);
			if (result instanceof SkillLoadError) {
				errors.push(result);
			} else {
				skills.push(result);
			}
		}

		// Check subdirectories
		const entries = readdirSync(dir);
		for (const entry of entries) {
			const entryPath = join(dir, entry);
			const stat = statSync(entryPath);

			if (stat.isDirectory()) {
				const result = loadSkillFromDirectory(entryPath, sourceType);
				if (result instanceof SkillLoadError) {
					errors.push(result);
				} else {
					skills.push(result);
				}
			}
		}
	} catch (err) {
		logger.warn("Error scanning skills directory", {
			dir,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	return { skills, errors };
}

/**
 * Load all available skills from user and project directories.
 *
 * @param workspaceDir - The current workspace/project directory
 * @returns Object with loaded skills and any errors
 */
export function loadSkills(workspaceDir: string): {
	skills: LoadedSkill[];
	errors: SkillLoadError[];
} {
	const userSkillsDir = join(PATHS.COMPOSER_HOME, "skills");
	const projectSkillsDir = join(workspaceDir, ".composer", "skills");

	logger.debug("Scanning for skills", { userSkillsDir, projectSkillsDir });

	const userResult = scanSkillsDirectory(userSkillsDir, "user");
	const projectResult = scanSkillsDirectory(projectSkillsDir, "project");

	// Project skills override user skills by name
	const skillMap = new Map<string, LoadedSkill>();

	for (const skill of userResult.skills) {
		skillMap.set(skill.name.toLowerCase(), skill);
	}

	for (const skill of projectResult.skills) {
		const existing = skillMap.get(skill.name.toLowerCase());
		if (existing) {
			logger.debug("Project skill overrides user skill", { name: skill.name });
		}
		skillMap.set(skill.name.toLowerCase(), skill);
	}

	const allSkills = Array.from(skillMap.values());
	const allErrors = [...userResult.errors, ...projectResult.errors];

	logger.info("Finished loading skills", {
		total: allSkills.length,
		errors: allErrors.length,
		user: userResult.skills.length,
		project: projectResult.skills.length,
	});

	return { skills: allSkills, errors: allErrors };
}

/**
 * Find a skill by name (case-insensitive).
 */
export function findSkill(
	skills: LoadedSkill[],
	name: string,
): LoadedSkill | undefined {
	const normalizedName = name.toLowerCase();
	return skills.find((s) => s.name.toLowerCase() === normalizedName);
}

/**
 * Find skills that match a given query (checks name, description, tags, triggers).
 */
export function searchSkills(
	skills: LoadedSkill[],
	query: string,
): LoadedSkill[] {
	const normalizedQuery = query.toLowerCase();

	return skills.filter((skill) => {
		// Check name
		if (skill.name.toLowerCase().includes(normalizedQuery)) return true;

		// Check description
		if (skill.description.toLowerCase().includes(normalizedQuery)) return true;

		// Check tags
		if (skill.tags?.some((t) => t.toLowerCase().includes(normalizedQuery))) {
			return true;
		}

		// Check triggers
		if (
			skill.triggers?.some((t) => t.toLowerCase().includes(normalizedQuery))
		) {
			return true;
		}

		return false;
	});
}

/**
 * Convert skill to dictionary (per Agent Skills SDK).
 * Excludes undefined values.
 */
export function skillToDict(
	skill: LoadedSkill,
): Record<string, string | Record<string, string>> {
	const result: Record<string, string | Record<string, string>> = {
		name: skill.name,
		description: skill.description,
	};

	if (skill.license) {
		result.license = skill.license;
	}

	if (skill.compatibility) {
		result.compatibility = skill.compatibility;
	}

	if (skill.allowedTools) {
		result["allowed-tools"] = skill.allowedTools;
	}

	if (skill.metadata && Object.keys(skill.metadata).length > 0) {
		result.metadata = skill.metadata;
	}

	return result;
}

/**
 * Convert skill to JSON string.
 */
export function skillToJson(skill: LoadedSkill): string {
	return JSON.stringify(skillToDict(skill), null, 2);
}

/**
 * Escape XML special characters.
 */
function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Generate XML prompt block for available skills (per Agent Skills SDK).
 *
 * This generates the <available_skills> XML block that should be included
 * in system prompts to make skills discoverable by the agent.
 */
export function skillsToPrompt(skills: LoadedSkill[]): string {
	if (skills.length === 0) {
		return "<available_skills>\n</available_skills>";
	}

	const lines: string[] = ["<available_skills>"];

	for (const skill of skills) {
		lines.push("<skill>");
		lines.push(`  <name>${escapeXml(skill.name)}</name>`);
		lines.push(`  <description>${escapeXml(skill.description)}</description>`);
		lines.push(
			`  <location>${escapeXml(join(skill.sourcePath, "SKILL.md"))}</location>`,
		);
		lines.push("</skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

/**
 * Format skill for display in a list.
 */
export function formatSkillListItem(skill: LoadedSkill): string {
	const source = skill.sourceType === "user" ? "(user)" : "(project)";
	const tags = skill.tags?.length ? ` [${skill.tags.join(", ")}]` : "";
	return `${skill.name} ${source}${tags} - ${skill.description}`;
}

/**
 * Format skill content for injection into conversation.
 */
export function formatSkillForInjection(skill: LoadedSkill): string {
	const lines: string[] = [];

	lines.push(`# Skill: ${skill.name}`);
	lines.push("");
	lines.push(`> ${skill.description}`);
	lines.push("");

	if (skill.tags?.length) {
		lines.push(`**Tags:** ${skill.tags.join(", ")}`);
		lines.push("");
	}

	if (skill.resources.length > 0) {
		lines.push("## Bundled Resources");
		lines.push("");
		lines.push("You can access these bundled resources using the Read tool:");
		lines.push("");
		for (const resource of skill.resources) {
			lines.push(`- \`${resource.path}\` (${resource.type})`);
		}
		lines.push("");
	}

	lines.push("## Instructions");
	lines.push("");
	lines.push(skill.content);

	return lines.join("\n");
}

/**
 * Get skill summary for system prompt (lists available skills).
 * @deprecated Use skillsToPrompt for XML format per Agent Skills SDK
 */
export function getSkillsSummary(skills: LoadedSkill[]): string {
	if (skills.length === 0) {
		return "";
	}

	const lines: string[] = [];
	lines.push("## Available Skills");
	lines.push("");
	lines.push(
		"When you recognize that a task matches one of the available skills listed below, " +
			"use the Skill tool to load the full skill instructions.",
	);
	lines.push("");

	for (const skill of skills) {
		const tags = skill.tags?.length ? ` [${skill.tags.join(", ")}]` : "";
		lines.push(`- **${skill.name}**${tags}: ${skill.description}`);
		if (skill.triggers?.length) {
			lines.push(`  - Triggers: ${skill.triggers.join(", ")}`);
		}
	}

	lines.push("");

	return lines.join("\n");
}
