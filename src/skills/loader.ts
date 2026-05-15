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
 * - ~/.maestro/skills/ (user skills)
 * - .maestro/skills/ (project skills)
 *
 * Each skill is a directory containing:
 * - SKILL.md or skill.md - Main skill file with YAML frontmatter
 * - Optional: scripts/, references/, assets/ directories
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { PATHS } from "../config/constants.js";
import { loadConfiguredPackageResources } from "../packages/runtime.js";
import { createLogger } from "../utils/logger.js";
import { promptSafeText } from "../utils/prompt-safe-text.js";

const logger = createLogger("skills:loader");

/** Maximum lengths per Agent Skills spec */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

/** Allowed frontmatter fields per Agent Skills spec */
export const SKILL_FRONTMATTER_FIELDS = [
	"name",
	"description",
	"license",
	"compatibility",
	"allowed-tools",
	"argument-hint",
	"builtin-tools",
	"model",
	"mode",
	"isolatedContext",
	"metadata",
	// Legacy fields (deprecated but supported for backwards compatibility)
	"tags",
	"author",
	"version",
	"triggers",
] as const;

/** Allowed frontmatter fields per Agent Skills spec plus Maestro package hints. */
const ALLOWED_FIELDS = new Set<string>(SKILL_FRONTMATTER_FIELDS);

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
	/** Pre-approved MCP/toolbox tools this skill can use */
	allowedTools?: string[];
	/** Built-in Maestro tools this skill needs */
	builtinTools?: string[];
	/** Argument hint shown by authoring surfaces */
	argumentHint?: string;
	/** Preferred model while this skill is active */
	model?: string;
	/** Preferred agent mode while this skill is active */
	mode?: string;
	/** Whether the skill should run in isolated context when supported */
	isolatedContext?: boolean;
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
	/** Source type: 'user', 'project', 'system', or 'service' */
	sourceType: "user" | "project" | "system" | "service";
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
	/** Path to Sourcegraph/Amp-style singular reference directory if it exists */
	referenceDir?: string;
	/** Path to legacy/plural references directory if it exists */
	referencesDir?: string;
	/** Path to assets directory if it exists */
	assetsDir?: string;
	/** Path to toolbox executable directory if it exists */
	toolboxDir?: string;
	/** Path to bundled MCP config if it exists */
	mcpJsonPath?: string;
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

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function stringArrayValue(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const values = value
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter((entry) => entry.length > 0);
		return values.length > 0 ? values : undefined;
	}
	if (typeof value === "string") {
		const values = value
			.split(/[,\s]+/)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		return values.length > 0 ? values : undefined;
	}
	return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return undefined;
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
export function findSkillMd(dir: string): string | null {
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
export function parseFrontmatter(content: string): {
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
	const parsed = loadYaml(yamlContent ?? "") ?? {};
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Frontmatter must be a YAML object");
	}
	const frontmatter = parsed as Record<string, unknown>;

	return { frontmatter, body: body! };
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
	sourceType: "user" | "project" | "system",
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
		const referenceDir = join(skillDir, "reference");
		const referencesDir = join(skillDir, "references");
		const assetsDir = join(skillDir, "assets");
		const toolboxDir = join(skillDir, "toolbox");
		const mcpJsonPath = join(skillDir, "mcp.json");

		if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
			resourceDirs.scriptsDir = scriptsDir;
		}
		if (existsSync(referenceDir) && statSync(referenceDir).isDirectory()) {
			resourceDirs.referenceDir = referenceDir;
		}
		if (existsSync(referencesDir) && statSync(referencesDir).isDirectory()) {
			resourceDirs.referencesDir = referencesDir;
		}
		if (existsSync(assetsDir) && statSync(assetsDir).isDirectory()) {
			resourceDirs.assetsDir = assetsDir;
		}
		if (existsSync(toolboxDir) && statSync(toolboxDir).isDirectory()) {
			resourceDirs.toolboxDir = toolboxDir;
		}
		if (existsSync(mcpJsonPath) && statSync(mcpJsonPath).isFile()) {
			resourceDirs.mcpJsonPath = mcpJsonPath;
		}

		// Discover bundled resources (legacy flat structure)
		const resources: SkillResource[] = [];
		try {
			const files = readdirSync(skillDir);
			for (const file of files) {
				if (file.toLowerCase() === "skill.md") continue;
				if (
					["scripts", "reference", "references", "assets", "toolbox"].includes(
						file,
					)
				) {
					continue;
				}
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
			allowedTools: stringArrayValue(frontmatter["allowed-tools"]),
			builtinTools: stringArrayValue(frontmatter["builtin-tools"]),
			argumentHint: stringValue(frontmatter["argument-hint"]),
			model: stringValue(frontmatter.model),
			mode: stringValue(frontmatter.mode),
			isolatedContext: booleanValue(frontmatter.isolatedContext),
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
	sourceType: "user" | "project" | "system",
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
 * Get the system skills directory bundled with the package.
 *
 * Resolves the `skills/` directory relative to the package root,
 * which works whether running from source (repo) or installed via npm.
 */
function getSystemSkillsDir(): string {
	// Allow explicit override for non-standard packaging layouts
	const override = process.env.MAESTRO_SYSTEM_SKILLS_DIR;
	if (override && existsSync(override)) {
		return override;
	}

	// import.meta.url points to this file — either src/skills/loader.ts (dev)
	// or dist/cli.js (bundled). Walk up to find the package root by looking
	// for a directory that contains both package.json and skills/.
	const thisFile = fileURLToPath(import.meta.url);
	let dir = dirname(thisFile);
	for (let i = 0; i < 5; i++) {
		const skillsDir = join(dir, "skills");
		if (existsSync(join(dir, "package.json")) && existsSync(skillsDir)) {
			return skillsDir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Fallback: assume 3 levels up (src/skills/loader.ts layout)
	const packageRoot = dirname(dirname(dirname(thisFile)));
	return join(packageRoot, "skills");
}

/**
 * Load all available skills from system, user, and project directories.
 *
 * Priority (highest wins): project > user > system.
 * System skills are bundled with the package and provide default capabilities.
 *
 * @param workspaceDir - The current workspace/project directory
 * @returns Object with loaded skills and any errors
 */
export function loadSkills(
	workspaceDir: string,
	options?: { includeSystem?: boolean },
): {
	skills: LoadedSkill[];
	errors: SkillLoadError[];
} {
	const includeSystem = options?.includeSystem ?? true;
	const systemSkillsDir = includeSystem ? getSystemSkillsDir() : null;
	const userSkillsDir = join(PATHS.MAESTRO_HOME, "skills");
	const projectSkillsDir = join(workspaceDir, ".maestro", "skills");
	const packageResources = loadConfiguredPackageResources(workspaceDir);
	const userPackageSkillDirs = packageResources.skills.user;
	const projectPackageSkillDirs = packageResources.skills.project;

	logger.debug("Scanning for skills", {
		systemSkillsDir: systemSkillsDir ?? "(disabled)",
		userSkillsDir,
		projectSkillsDir,
		userPackageSkillDirs,
		projectPackageSkillDirs,
	});

	const systemResult = systemSkillsDir
		? scanSkillsDirectory(systemSkillsDir, "system")
		: { skills: [], errors: [] };
	const userResult = [...userPackageSkillDirs, userSkillsDir].reduce(
		(result, dir) => {
			const next = scanSkillsDirectory(dir, "user");
			result.skills.push(...next.skills);
			result.errors.push(...next.errors);
			return result;
		},
		{ skills: [] as LoadedSkill[], errors: [] as SkillLoadError[] },
	);
	const projectResult = [...projectPackageSkillDirs, projectSkillsDir].reduce(
		(result, dir) => {
			const next = scanSkillsDirectory(dir, "project");
			result.skills.push(...next.skills);
			result.errors.push(...next.errors);
			return result;
		},
		{ skills: [] as LoadedSkill[], errors: [] as SkillLoadError[] },
	);

	// Priority: project > user > system (last writer wins)
	const skillMap = new Map<string, LoadedSkill>();

	for (const skill of systemResult.skills) {
		skillMap.set(skill.name.toLowerCase(), skill);
	}

	for (const skill of userResult.skills) {
		const existing = skillMap.get(skill.name.toLowerCase());
		if (existing) {
			logger.debug("User skill overrides system skill", {
				name: skill.name,
			});
		}
		skillMap.set(skill.name.toLowerCase(), skill);
	}

	for (const skill of projectResult.skills) {
		const existing = skillMap.get(skill.name.toLowerCase());
		if (existing) {
			logger.debug("Project skill overrides existing skill", {
				name: skill.name,
				overridden: existing.sourceType,
			});
		}
		skillMap.set(skill.name.toLowerCase(), skill);
	}

	const allSkills = Array.from(skillMap.values());
	const allErrors = [
		...systemResult.errors,
		...userResult.errors,
		...projectResult.errors,
	];

	logger.info("Finished loading skills", {
		total: allSkills.length,
		errors: allErrors.length,
		system: systemResult.skills.length,
		user: userResult.skills.length,
		project: projectResult.skills.length,
		userPackages: userPackageSkillDirs.length,
		projectPackages: projectPackageSkillDirs.length,
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
): Record<string, string | string[] | boolean | Record<string, string>> {
	const result: Record<
		string,
		string | string[] | boolean | Record<string, string>
	> = {
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
	if (skill.builtinTools) {
		result["builtin-tools"] = skill.builtinTools;
	}
	if (skill.argumentHint) {
		result["argument-hint"] = skill.argumentHint;
	}
	if (skill.model) {
		result.model = skill.model;
	}
	if (skill.mode) {
		result.mode = skill.mode;
	}
	if (skill.isolatedContext !== undefined) {
		result.isolatedContext = skill.isolatedContext;
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
		const description = promptSafeText(
			skill.description,
			MAX_DESCRIPTION_LENGTH,
		);
		lines.push("<skill>");
		lines.push(`  <name>${escapeXml(skill.name)}</name>`);
		lines.push(`  <description>${escapeXml(description ?? "")}</description>`);
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
	const sourceLabels: Record<LoadedSkill["sourceType"], string> = {
		service: "(service)",
		system: "(system)",
		user: "(user)",
		project: "(project)",
	};
	const source = sourceLabels[skill.sourceType];
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
	if (skill.resourceDirs.referenceDir || skill.resourceDirs.referencesDir) {
		lines.push("## Reference Resources");
		lines.push("");
		lines.push("Load detailed references only when needed:");
		if (skill.resourceDirs.referenceDir) {
			lines.push(`- \`${skill.resourceDirs.referenceDir}\``);
		}
		if (skill.resourceDirs.referencesDir) {
			lines.push(`- \`${skill.resourceDirs.referencesDir}\``);
		}
		lines.push("");
	}
	if (skill.resourceDirs.toolboxDir || skill.resourceDirs.mcpJsonPath) {
		lines.push("## Tool Package");
		lines.push("");
		if (skill.resourceDirs.toolboxDir) {
			lines.push(
				`- Toolbox executables are bundled under \`${skill.resourceDirs.toolboxDir}\`.`,
			);
		}
		if (skill.resourceDirs.mcpJsonPath) {
			lines.push(
				`- Bundled MCP config: \`${skill.resourceDirs.mcpJsonPath}\`.`,
			);
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
		const description =
			promptSafeText(skill.description, MAX_DESCRIPTION_LENGTH) ?? "";
		lines.push(`- **${skill.name}**${tags}: ${description}`);
		if (skill.triggers?.length) {
			lines.push(`  - Triggers: ${skill.triggers.join(", ")}`);
		}
	}

	lines.push("");

	return lines.join("\n");
}

/**
 * Progressive Skill Disclosure (#857)
 *
 * Format skill metadata only (name + description) for system prompt injection.
 * The agent can then use the `read` tool to load full SKILL.md content on-demand.
 *
 * Benefits:
 * - Context efficiency: ~10 tokens per skill vs ~500+ for full content
 * - Scalability: 20 skills use ~200 tokens instead of ~10,000
 * - Self-directed: Agent loads what it needs when it needs it
 */

/**
 * Format a single skill's metadata for system prompt (XML format).
 *
 * Returns only name and description in a self-closing XML tag.
 * Follows the Agent Skills specification's progressive disclosure pattern.
 *
 * @param skill - The loaded skill
 * @returns XML-formatted skill metadata
 *
 * @example
 * ```xml
 * <skill name="test-runner" description="Run and debug test suites" />
 * <!-- source: ~/.maestro/skills/test-runner -->
 * ```
 */
export function formatSkillMetadataOnly(skill: LoadedSkill): string {
	// Escape XML special characters
	const escapeName = skill.name
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

	const description = promptSafeText(skill.description, MAX_DESCRIPTION_LENGTH);
	const escapeDesc = (description ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

	// Include source path as XML comment for debugging
	return `<skill name="${escapeName}" description="${escapeDesc}" />\n<!-- source: ${skill.sourcePath} -->`;
}

/**
 * Format multiple skills for system prompt with on-demand loading instructions.
 *
 * Returns XML list of skill metadata plus instructions for the agent to load
 * full skill content using the `read` tool when needed.
 *
 * This is the primary function for progressive skill disclosure.
 *
 * @param skills - Array of loaded skills
 * @returns XML-formatted skills list with loading instructions, or empty string if no skills
 *
 * @example
 * ```xml
 * <available_skills>
 *   <skill name="test-runner" description="..." />
 *   <skill name="git-workflow" description="..." />
 * </available_skills>
 *
 * When a skill is relevant to the user's request, use the `read` tool to load
 * the full skill instructions from the source path shown in the comment.
 * ```
 */
export function formatSkillsForSystemPrompt(skills: LoadedSkill[]): string {
	if (skills.length === 0) {
		return "";
	}

	const lines: string[] = [];

	lines.push("<available_skills>");
	for (const skill of skills) {
		lines.push(`  ${formatSkillMetadataOnly(skill)}`);
	}
	lines.push("</available_skills>");
	lines.push("");
	lines.push(
		"When a skill is relevant to the user's request, use the `read` tool to load " +
			"the full SKILL.md from the skill's source directory (shown in comments above). " +
			"For example: `read ~/.maestro/skills/test-runner/SKILL.md` or " +
			"`read .maestro/skills/custom-skill/SKILL.md`. " +
			"This progressive loading keeps the system prompt lean while making all skill " +
			"capabilities available on-demand.",
	);

	return lines.join("\n");
}
