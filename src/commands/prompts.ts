/**
 * Custom Prompts System - User-definable slash commands from Markdown files.
 *
 * Inspired by OpenAI Codex's prompts system. Prompts are discovered from:
 * - ~/.composer/prompts/*.md (user prompts)
 * - .composer/prompts/*.md (project prompts)
 *
 * Additionally, Composer treats Markdown files in `.composer/commands/*.md` and
 * `~/.composer/commands/*.md` as prompts. This lets teams colocate "prompt-like"
 * commands alongside other command templates.
 *
 * Each prompt is a Markdown file with optional YAML frontmatter:
 *
 * ```markdown
 * ---
 * description: Request a concise git diff review
 * argument-hint: FILE=<path> [FOCUS=<section>]
 * ---
 *
 * Review the code in $FILE. Pay special attention to $FOCUS.
 * ```
 *
 * Placeholders:
 * - Positional: $1, $2, ..., $9 (from space-separated args)
 * - $ARGUMENTS: All positional arguments joined by space
 * - Named: $FILE, $TICKET_ID (from KEY=value pairs)
 * - Escape: $$ produces a literal $
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("commands:prompts");

function resolveHomeDirectory(): string {
	// Prefer env vars so tests (and some shells) can override HOME reliably.
	return process.env.HOME || process.env.USERPROFILE || homedir();
}

/**
 * Prompt definition from YAML frontmatter.
 */
export interface PromptDefinition {
	/** Unique prompt name (derived from filename) */
	name: string;
	/** Short description shown in slash popup */
	description?: string;
	/** Alternative names for this prompt */
	aliases?: string[];
	/** Hint for expected arguments */
	argumentHint?: string;
	/** Full markdown body (content after frontmatter) */
	body: string;
	/** Source file path */
	sourcePath: string;
	/** Source type: 'user' or 'project' */
	sourceType: "user" | "project";
	/** Named placeholders found in the body */
	namedPlaceholders: string[];
	/** Whether body uses positional placeholders */
	hasPositionalPlaceholders: boolean;
}

/**
 * Result of parsing prompt arguments.
 */
export interface ParsedPromptArgs {
	/** Positional arguments ($1, $2, etc.) */
	positional: string[];
	/** Named arguments (KEY=value) */
	named: Record<string, string>;
}

/**
 * Parse YAML frontmatter from markdown content.
 */
function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
	const match = content.match(frontmatterRegex);

	if (!match) {
		return { frontmatter: {}, body: content };
	}

	const [, yamlContent, body] = match;
	const frontmatter: Record<string, unknown> = {};

	// Simple YAML parser for common patterns (key: value and arrays)
	const lines = yamlContent.split("\n");
	let currentKey: string | null = null;
	let currentArray: string[] | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Array item
		if (trimmed.startsWith("- ") && currentKey && currentArray) {
			currentArray.push(trimmed.slice(2).trim());
			continue;
		}

		// Save previous array
		if (currentKey && currentArray) {
			frontmatter[currentKey] = currentArray;
			currentKey = null;
			currentArray = null;
		}

		const colonIndex = trimmed.indexOf(":");
		if (colonIndex <= 0) continue;
		const key = trimmed.slice(0, colonIndex).trim();
		let value = trimmed.slice(colonIndex + 1).trim();

		if (value === "") {
			currentKey = key;
			currentArray = [];
			continue;
		}

		// Remove surrounding quotes if present
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		frontmatter[key] = value;
	}

	// Save trailing array
	if (currentKey && currentArray) {
		frontmatter[currentKey] = currentArray;
	}

	return { frontmatter, body };
}

function isValidPromptName(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value);
}

function parseAliases(raw: unknown): string[] | undefined {
	const values: string[] = [];

	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (typeof item === "string") values.push(item);
		}
	} else if (typeof raw === "string") {
		// Accept simple comma-separated strings as well.
		values.push(
			...raw
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean),
		);
	}

	const normalized = new Set<string>();
	const cleaned: string[] = [];
	for (const value of values) {
		if (!isValidPromptName(value)) continue;
		const key = value.toLowerCase();
		if (normalized.has(key)) continue;
		normalized.add(key);
		cleaned.push(value);
	}

	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Extract named placeholders from prompt body.
 * Named placeholders are $UPPERCASE_IDENTIFIERS (not $1-$9 or $$).
 */
function extractNamedPlaceholders(body: string): string[] {
	const pattern = /\$([A-Z][A-Z0-9_]*)/g;
	const placeholders = new Set<string>();

	for (const match of body.matchAll(pattern)) {
		const name = match[1];
		// Skip special placeholders
		if (name === "ARGUMENTS") continue;
		placeholders.add(name);
	}

	return Array.from(placeholders).sort();
}

/**
 * Check if body uses positional placeholders ($1-$9 or $ARGUMENTS).
 */
function hasPositionalPlaceholders(body: string): boolean {
	return /\$[1-9]|\$ARGUMENTS/.test(body);
}

/**
 * Load a single prompt from a markdown file.
 */
function loadPromptFromFile(
	filePath: string,
	sourceType: "user" | "project",
): PromptDefinition | null {
	try {
		const content = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);

		// Derive name from filename (without .md extension), but allow override.
		const fileName = basename(filePath, ".md");
		const frontmatterName =
			typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const nameCandidate = frontmatterName || fileName;
		const name = isValidPromptName(nameCandidate) ? nameCandidate : fileName;

		if (!name || name.startsWith(".")) {
			logger.debug("Skipping hidden or invalid prompt file", { filePath });
			return null;
		}

		const aliases = parseAliases(frontmatter.aliases);
		const filteredAliases = aliases?.filter(
			(alias) => alias.toLowerCase() !== name.toLowerCase(),
		);

		const prompt: PromptDefinition = {
			name,
			description:
				typeof frontmatter.description === "string"
					? frontmatter.description
					: undefined,
			aliases: filteredAliases?.length ? filteredAliases : undefined,
			argumentHint:
				typeof frontmatter["argument-hint"] === "string"
					? frontmatter["argument-hint"]
					: typeof frontmatter.argument_hint === "string"
						? frontmatter.argument_hint
						: undefined,
			body: body.trim(),
			sourcePath: filePath,
			sourceType,
			namedPlaceholders: extractNamedPlaceholders(body),
			hasPositionalPlaceholders: hasPositionalPlaceholders(body),
		};

		logger.debug("Loaded prompt", {
			name: prompt.name,
			sourceType,
			namedPlaceholders: prompt.namedPlaceholders,
		});

		return prompt;
	} catch (err) {
		logger.warn("Error loading prompt", {
			filePath,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Scan a directory for prompt markdown files.
 */
function scanPromptsDirectory(
	dir: string,
	sourceType: "user" | "project",
): PromptDefinition[] {
	if (!existsSync(dir)) {
		return [];
	}

	const prompts: PromptDefinition[] = [];

	try {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;

			const entryPath = join(dir, entry);
			try {
				const stat = statSync(entryPath);
				if (!stat.isFile() && !stat.isSymbolicLink()) continue;

				const prompt = loadPromptFromFile(entryPath, sourceType);
				if (prompt) {
					prompts.push(prompt);
				}
			} catch {
				// Skip inaccessible files
			}
		}
	} catch (err) {
		logger.warn("Error scanning prompts directory", {
			dir,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	return prompts;
}

/**
 * Load all available prompts from user and project directories.
 *
 * @param workspaceDir - The current workspace/project directory
 * @returns Array of loaded prompts (project prompts override user prompts by name)
 */
export function loadPrompts(workspaceDir: string): PromptDefinition[] {
	const homeDir = resolveHomeDirectory();
	const userPromptsDir = join(homeDir, ".composer", "prompts");
	const userCommandsDir = join(homeDir, ".composer", "commands");
	const projectPromptsDir = join(workspaceDir, ".composer", "prompts");
	const projectCommandsDir = join(workspaceDir, ".composer", "commands");

	logger.debug("Scanning for prompts", {
		userPromptsDir,
		projectPromptsDir,
		userCommandsDir,
		projectCommandsDir,
	});

	// Commands dir first, prompts dir second (prompts override commands by name).
	const userPrompts = [
		...scanPromptsDirectory(userCommandsDir, "user"),
		...scanPromptsDirectory(userPromptsDir, "user"),
	];
	const projectPrompts = [
		...scanPromptsDirectory(projectCommandsDir, "project"),
		...scanPromptsDirectory(projectPromptsDir, "project"),
	];

	// Project prompts override user prompts by name
	const promptMap = new Map<string, PromptDefinition>();

	for (const prompt of userPrompts) {
		promptMap.set(prompt.name.toLowerCase(), prompt);
	}

	for (const prompt of projectPrompts) {
		const existing = promptMap.get(prompt.name.toLowerCase());
		if (existing) {
			logger.debug("Project prompt overrides user prompt", {
				name: prompt.name,
			});
		}
		promptMap.set(prompt.name.toLowerCase(), prompt);
	}

	const allPrompts = Array.from(promptMap.values());

	// Sort by name for consistent ordering
	allPrompts.sort((a, b) => a.name.localeCompare(b.name));

	logger.info("Finished loading prompts", {
		total: allPrompts.length,
		user: userPrompts.length,
		project: projectPrompts.length,
	});

	return allPrompts;
}

/**
 * Find a prompt by name (case-insensitive).
 */
export function findPrompt(
	prompts: PromptDefinition[],
	name: string,
): PromptDefinition | undefined {
	const normalizedName = name.toLowerCase();
	return prompts.find((p) => {
		if (p.name.toLowerCase() === normalizedName) return true;
		return p.aliases?.some((alias) => alias.toLowerCase() === normalizedName);
	});
}

/**
 * Parse arguments from a command invocation.
 *
 * Supports:
 * - Positional args: separated by whitespace
 * - Named args: KEY=value or KEY="value with spaces"
 *
 * @param argString - The argument string after the command name
 * @returns Parsed positional and named arguments
 */
export function parsePromptArgs(argString: string): ParsedPromptArgs {
	const positional: string[] = [];
	const named: Record<string, string> = {};

	if (!argString.trim()) {
		return { positional, named };
	}

	// Tokenize respecting quoted strings
	const tokens: string[] = [];
	let current = "";
	let inQuotes = false;
	let quoteChar = "";

	for (let i = 0; i < argString.length; i++) {
		const char = argString[i];

		if (!inQuotes && (char === '"' || char === "'")) {
			inQuotes = true;
			quoteChar = char;
			continue;
		}

		if (inQuotes && char === quoteChar) {
			inQuotes = false;
			quoteChar = "";
			continue;
		}

		if (!inQuotes && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) {
		tokens.push(current);
	}

	// Separate named and positional arguments
	for (const token of tokens) {
		const eqIndex = token.indexOf("=");
		if (eqIndex > 0 && /^[A-Z][A-Z0-9_]*$/.test(token.slice(0, eqIndex))) {
			// Named argument (KEY=value)
			const key = token.slice(0, eqIndex);
			const value = token.slice(eqIndex + 1);
			named[key] = value;
		} else {
			// Positional argument
			positional.push(token);
		}
	}

	return { positional, named };
}

/**
 * Validate that all required named placeholders are provided.
 *
 * @returns Error message if validation fails, null if valid
 */
export function validatePromptArgs(
	prompt: PromptDefinition,
	args: ParsedPromptArgs,
): string | null {
	const missing: string[] = [];

	for (const placeholder of prompt.namedPlaceholders) {
		if (!(placeholder in args.named)) {
			missing.push(placeholder);
		}
	}

	if (missing.length > 0) {
		return `Missing required arguments: ${missing.join(", ")}`;
	}

	return null;
}

/**
 * Render a prompt with the given arguments.
 *
 * Substitutes:
 * - $1, $2, ..., $9 with positional arguments
 * - $ARGUMENTS with all positional arguments joined by space
 * - $NAME with named argument values
 * - $$ with a literal $
 */
export function renderPrompt(
	prompt: PromptDefinition,
	args: ParsedPromptArgs,
): string {
	let result = prompt.body;

	// First, escape $$ to a placeholder
	const escapeMarker = "\x00DOLLAR\x00";
	result = result.replace(/\$\$/g, escapeMarker);

	// Substitute $ARGUMENTS
	result = result.replace(/\$ARGUMENTS/g, args.positional.join(" "));

	// Substitute positional arguments $1-$9
	for (let i = 1; i <= 9; i++) {
		const pattern = new RegExp(`\\$${i}`, "g");
		const value = args.positional[i - 1] ?? "";
		result = result.replace(pattern, value);
	}

	// Substitute named arguments
	for (const [key, value] of Object.entries(args.named)) {
		const pattern = new RegExp(`\\$${key}`, "g");
		result = result.replace(pattern, value);
	}

	// Restore escaped dollars
	result = result.replace(new RegExp(escapeMarker, "g"), "$");

	return result;
}

/**
 * Format prompt for display in a list.
 */
export function formatPromptListItem(prompt: PromptDefinition): string {
	const source = prompt.sourceType === "user" ? "(user)" : "(project)";
	const desc = prompt.description ?? "(no description)";
	const aliases = prompt.aliases?.length
		? ` (aliases: ${prompt.aliases.join(", ")})`
		: "";
	return `${prompt.name}${aliases} ${source} - ${desc}`;
}

/**
 * Get usage hint for a prompt.
 */
export function getPromptUsageHint(prompt: PromptDefinition): string {
	const parts: string[] = [`/prompts:${prompt.name}`];

	if (prompt.argumentHint) {
		parts.push(prompt.argumentHint);
	} else if (prompt.namedPlaceholders.length > 0) {
		parts.push(prompt.namedPlaceholders.map((p) => `${p}=<value>`).join(" "));
	} else if (prompt.hasPositionalPlaceholders) {
		parts.push("<args...>");
	}

	return parts.join(" ");
}
