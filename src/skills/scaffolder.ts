/**
 * Scaffold-a-skill primitive: persist a fully-formed skill into the repo.
 *
 * The existing `scaffoldSkill` helper (in `./linter.ts`) creates an empty
 * skeleton suitable for `maestro skill new <name>`. This module solves a
 * different problem: an interactive `/setup-*` command has already
 * collected the user's answers and wants to bake them into a skill file
 * the agent will auto-load in future sessions.
 *
 * The first consumer is `/setup-incident-response` — the user names
 * their runbook location, paging policy, and severity definitions; we
 * write an `incident-guidelines` skill so the next incident-response
 * session loads those answers without re-asking.
 *
 * ## What this module is
 *
 * One primitive — `scaffoldSkillWithBody` — that:
 * - Validates the skill name against the project's skill-name pattern.
 * - Refuses to escape `baseDir` even when called with `..` or symlinks.
 * - Emits valid YAML frontmatter with the supplied description, optional
 *   tool whitelists, and free-form metadata.
 * - Writes the supplied body as the SKILL.md content.
 * - Reports back the directory, files written, and final SKILL.md path.
 *
 * ## What this module isn't
 *
 * - No interactive UI; that lives in the `/setup-*` slash commands.
 * - No round-trip parse; the rendered YAML is one-way.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeTextFileAtomic } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("skills:scaffolder");

/**
 * Same pattern as the existing skill linter: lowercase, digits, single
 * hyphens between words. Kept in sync rather than imported so callers
 * who pull just this module don't drag the linter in.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX_LENGTH = 64;
const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export interface ScaffoldSkillOptions {
	/** One-line description used in YAML frontmatter + skill listings. */
	description: string;
	/** Full markdown body (without frontmatter delimiters). */
	body: string;
	/** Optional `allowed-tools` whitelist serialized as a YAML list. */
	allowedTools?: string[];
	/** Optional `builtin-tools` list (Maestro-provided tools). */
	builtinTools?: string[];
	/**
	 * Additional simple key/value metadata nested under the `metadata`
	 * frontmatter field. Values are emitted as quoted YAML strings so
	 * user input can't break the frontmatter parser.
	 */
	metadata?: Record<string, string>;
	/** Overwrite an existing skill directory. Defaults to false. */
	force?: boolean;
}

export interface ScaffoldSkillResult {
	/** The skill name (matches the directory). */
	name: string;
	/** Absolute path to the skill directory. */
	directory: string;
	/** Absolute path to the SKILL.md inside the directory. */
	skillMdPath: string;
	/** Files written, relative to the skill directory. */
	files: string[];
}

/**
 * Write a `SKILL.md` (with frontmatter built from `options`) into
 * `<baseDir>/<name>/SKILL.md`. Throws on name violations, path escapes,
 * or pre-existing skills when `force` is false. Caller is responsible
 * for ensuring `baseDir` is the configured skills directory.
 */
export function scaffoldSkillWithBody(
	baseDir: string,
	name: string,
	options: ScaffoldSkillOptions,
): ScaffoldSkillResult {
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new Error(
			`Skill name "${name}" must use lowercase letters, numbers, and single hyphens between words`,
		);
	}
	if (name.length > SKILL_NAME_MAX_LENGTH) {
		throw new Error(
			`Skill name "${name}" exceeds the ${SKILL_NAME_MAX_LENGTH}-character limit`,
		);
	}
	const description = options.description.trim();
	if (!description) {
		throw new Error("Skill description is required");
	}
	// Match the skill loader's frontmatter cap. Scaffolding a longer
	// description would persist a SKILL.md the loader rejects with
	// invalid-description even though the scaffold succeeded.
	if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
		throw new Error(
			`Skill description exceeds the ${SKILL_DESCRIPTION_MAX_LENGTH}-character limit (got ${description.length})`,
		);
	}
	const body = options.body;
	if (!body || !body.trim()) {
		throw new Error("Skill body is required");
	}

	const directory = resolve(baseDir, name);
	if (!isPathWithinDirectory(directory, baseDir)) {
		// Defensive: SKILL_NAME_PATTERN already rejects "..", "/", "\", but
		// keep the explicit check so caller-supplied baseDir can't accidentally
		// resolve outside itself via symlinks or other path tricks.
		throw new Error(
			`Refusing to scaffold skill "${name}" outside the configured skills directory`,
		);
	}
	if (existsSync(directory) && !options.force) {
		throw new Error(
			`Skill "${name}" already exists at ${directory}; pass force: true to overwrite`,
		);
	}

	const skillMdPath = join(directory, "SKILL.md");
	const content = renderSkillMarkdown(name, description, body, options);
	mkdirSync(directory, { recursive: true });
	writeTextFileAtomic(skillMdPath, content);
	logger.info("Scaffolded skill", {
		name,
		directory,
		bodyLength: body.length,
	});

	return {
		name,
		directory,
		skillMdPath,
		files: ["SKILL.md"],
	};
}

function renderSkillMarkdown(
	name: string,
	description: string,
	body: string,
	options: ScaffoldSkillOptions,
): string {
	// Quote name even though SKILL_NAME_PATTERN restricts the character set:
	// YAML 1.1 still interprets unquoted "true", "false", "null", "yes", "no",
	// "off", and numeric-shaped strings as booleans/null/numbers, so the
	// loader would reject scaffolds named e.g. "true".
	const lines: string[] = ["---", `name: ${quoteYamlString(name)}`];
	lines.push(`description: ${quoteYamlString(description)}`);
	if (options.allowedTools && options.allowedTools.length > 0) {
		assertNonEmptyToolEntries("allowed-tools", options.allowedTools);
		lines.push("allowed-tools:");
		for (const tool of options.allowedTools) {
			lines.push(`  - ${quoteYamlString(tool)}`);
		}
	}
	if (options.builtinTools && options.builtinTools.length > 0) {
		assertNonEmptyToolEntries("builtin-tools", options.builtinTools);
		lines.push("builtin-tools:");
		for (const tool of options.builtinTools) {
			lines.push(`  - ${quoteYamlString(tool)}`);
		}
	}
	const metadataEntries = options.metadata
		? Object.entries(options.metadata)
		: [];
	if (metadataEntries.length > 0) {
		lines.push("metadata:");
		for (const [key, value] of metadataEntries) {
			if (!isValidFrontmatterKey(key)) {
				throw new Error(
					`Skill frontmatter key "${key}" must start with a lowercase letter and then use letters, numbers, hyphens, or underscores`,
				);
			}
			lines.push(`  ${quoteYamlString(key)}: ${quoteYamlString(value)}`);
		}
	}
	lines.push("---", "", body.trimEnd(), "");
	return lines.join("\n");
}

/**
 * Emit a YAML scalar safely as a double-quoted string. We always quote
 * to dodge YAML's edge cases (booleans, numbers, leading whitespace,
 * special characters); escaping is minimal (backslashes + double quotes
 * + newlines).
 */
function quoteYamlString(value: string): string {
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n");
	return `"${escaped}"`;
}

/**
 * The skill loader rejects allowed-tools / builtin-tools entries that
 * are empty or whitespace-only via `validateStringArrayField`. Mirror
 * that contract at scaffold time so we never produce a SKILL.md the
 * loader will refuse.
 */
function assertNonEmptyToolEntries(field: string, entries: string[]): void {
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		if (typeof entry !== "string" || entry.trim() === "") {
			throw new Error(`Skill ${field}[${i}] must be a non-empty string`);
		}
	}
}

function isValidFrontmatterKey(key: string): boolean {
	return /^[a-z][A-Za-z0-9_-]*$/.test(key);
}

function isPathWithinDirectory(
	candidatePath: string,
	directoryPath: string,
): boolean {
	const normalizedDir = `${resolve(directoryPath)}${sep}`;
	const normalizedCandidate = resolve(candidatePath);
	return normalizedCandidate.startsWith(normalizedDir);
}
