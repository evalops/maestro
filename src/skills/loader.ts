/**
 * Skills Loader - Dynamic skill discovery and loading system.
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
 * - SKILL.md - Main skill file with YAML frontmatter
 * - Optional bundled resources (scripts, templates, etc.)
 *
 * Inspired by Amp's skill system.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("skills:loader");

/**
 * Skill definition from SKILL.md frontmatter.
 */
export interface SkillDefinition {
	/** Unique skill name */
	name: string;
	/** Short description of what the skill does */
	description: string;
	/** Optional tags for categorization */
	tags?: string[];
	/** Optional author */
	author?: string;
	/** Optional version */
	version?: string;
	/** Trigger patterns that suggest this skill should be used */
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
 * Parse YAML frontmatter from markdown content.
 */
function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
	const match = content.match(frontmatterRegex);

	if (!match) {
		return { frontmatter: {}, body: content };
	}

	const [, yamlContent, body] = match;

	// Simple YAML parser for common patterns
	const frontmatter: Record<string, unknown> = {};
	const lines = yamlContent.split("\n");
	let currentKey: string | null = null;
	let currentArray: string[] | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Check for array item
		if (trimmed.startsWith("- ") && currentKey && currentArray) {
			currentArray.push(trimmed.slice(2).trim());
			continue;
		}

		// Save previous array if exists
		if (currentKey && currentArray) {
			frontmatter[currentKey] = currentArray;
			currentArray = null;
		}

		// Parse key: value
		const colonIndex = trimmed.indexOf(":");
		if (colonIndex > 0) {
			const key = trimmed.slice(0, colonIndex).trim();
			const value = trimmed.slice(colonIndex + 1).trim();

			if (value === "") {
				// Start of array or nested object
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
): LoadedSkill | null {
	const skillFile = join(skillDir, "SKILL.md");

	if (!existsSync(skillFile)) {
		logger.debug("No SKILL.md found in directory", { skillDir });
		return null;
	}

	try {
		const rawContent = readFileSync(skillFile, "utf-8");
		const { frontmatter, body } = parseFrontmatter(rawContent);

		// Validate required fields
		if (!frontmatter.name || typeof frontmatter.name !== "string") {
			logger.warn("SKILL.md missing required 'name' field", { skillDir });
			return null;
		}

		if (
			!frontmatter.description ||
			typeof frontmatter.description !== "string"
		) {
			logger.warn("SKILL.md missing required 'description' field", {
				skillDir,
			});
			return null;
		}

		// Discover bundled resources
		const resources: SkillResource[] = [];
		try {
			const files = readdirSync(skillDir);
			for (const file of files) {
				if (file === "SKILL.md") continue;
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
			name: frontmatter.name as string,
			description: frontmatter.description as string,
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
		};

		logger.debug("Loaded skill", {
			name: skill.name,
			sourceType,
			resourceCount: resources.length,
		});

		return skill;
	} catch (err) {
		logger.warn("Error loading skill", {
			skillDir,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Scan a directory for skill subdirectories.
 */
function scanSkillsDirectory(
	dir: string,
	sourceType: "user" | "project",
): LoadedSkill[] {
	if (!existsSync(dir)) {
		return [];
	}

	const skills: LoadedSkill[] = [];

	try {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			const entryPath = join(dir, entry);
			const stat = statSync(entryPath);

			if (stat.isDirectory()) {
				const skill = loadSkillFromDirectory(entryPath, sourceType);
				if (skill) {
					skills.push(skill);
				}
			}
		}
	} catch (err) {
		logger.warn("Error scanning skills directory", {
			dir,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	return skills;
}

/**
 * Load all available skills from user and project directories.
 *
 * @param workspaceDir - The current workspace/project directory
 * @returns Array of loaded skills (project skills override user skills by name)
 */
export function loadSkills(workspaceDir: string): LoadedSkill[] {
	const userSkillsDir = join(homedir(), ".composer", "skills");
	const projectSkillsDir = join(workspaceDir, ".composer", "skills");

	logger.debug("Scanning for skills", { userSkillsDir, projectSkillsDir });

	const userSkills = scanSkillsDirectory(userSkillsDir, "user");
	const projectSkills = scanSkillsDirectory(projectSkillsDir, "project");

	// Project skills override user skills by name
	const skillMap = new Map<string, LoadedSkill>();

	for (const skill of userSkills) {
		skillMap.set(skill.name.toLowerCase(), skill);
	}

	for (const skill of projectSkills) {
		const existing = skillMap.get(skill.name.toLowerCase());
		if (existing) {
			logger.debug("Project skill overrides user skill", { name: skill.name });
		}
		skillMap.set(skill.name.toLowerCase(), skill);
	}

	const allSkills = Array.from(skillMap.values());

	logger.info("Finished loading skills", {
		total: allSkills.length,
		user: userSkills.length,
		project: projectSkills.length,
	});

	return allSkills;
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
