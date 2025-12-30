import { existsSync, readFileSync, readdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import yaml from "js-yaml";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import { getBuiltinAgents } from "./builtin.js";
import type {
	AgentMode,
	ComposerConfig,
	ComposerTrigger,
	LoadedComposer,
	PermissionLevel,
	ToolPermissions,
} from "./types.js";

const logger = createLogger("composers:loader");

const PERSONAL_DIR = join(PATHS.COMPOSER_HOME, "composers");
const PROJECT_DIR_NAME = ".composer/composers";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return value;
	}
	if (typeof value === "string") {
		const tokens = value.split(/[\s,]+/).filter(Boolean);
		return tokens.length ? tokens : undefined;
	}
	return undefined;
}

function isPromptMode(value: unknown): value is ComposerConfig["promptMode"] {
	return value === "prepend" || value === "append" || value === "replace";
}

function isAgentMode(value: unknown): value is AgentMode {
	return value === "primary" || value === "subagent" || value === "all";
}

function isThinkingLevel(
	value: unknown,
): value is ComposerConfig["thinkingLevel"] {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "max"
	);
}

function isPermissionLevel(value: unknown): value is PermissionLevel {
	return value === "allow" || value === "ask" || value === "deny";
}

function normalizePermissionMap(
	record: Record<string, unknown> | undefined,
): Record<string, PermissionLevel> | undefined {
	if (!record) return undefined;
	const entries: Array<[string, PermissionLevel]> = [];
	for (const [key, val] of Object.entries(record)) {
		if (isPermissionLevel(val)) {
			entries.push([key, val]);
		}
	}
	return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizePermissions(
	record: Record<string, unknown> | undefined,
): ToolPermissions | undefined {
	if (!record) return undefined;
	const defaultPermission = isPermissionLevel(record.default)
		? record.default
		: undefined;
	const tools = normalizePermissionMap(asRecord(record.tools));
	const bash = normalizePermissionMap(asRecord(record.bash));
	if (!defaultPermission && !tools && !bash) {
		return undefined;
	}
	return {
		default: defaultPermission,
		tools,
		bash,
	};
}

function normalizeTriggers(
	record: Record<string, unknown> | undefined,
): ComposerTrigger | undefined {
	if (!record) return undefined;
	const files = asStringArray(record.files);
	const directories = asStringArray(record.directories);
	const keywords = asStringArray(record.keywords);
	if (!files && !directories && !keywords) {
		return undefined;
	}
	return {
		files,
		directories,
		keywords,
	};
}

function normalizeComposerConfig(
	parsed: Record<string, unknown>,
	filePath: string,
): ComposerConfig {
	const rawName = asString(parsed.name);
	const name =
		rawName && rawName.trim().length > 0
			? rawName
			: basename(filePath, extname(filePath));
	const description =
		asString(parsed.description) ?? `Custom composer: ${name}`;

	return {
		name,
		description,
		systemPrompt: asString(parsed.systemPrompt),
		promptMode: isPromptMode(parsed.promptMode) ? parsed.promptMode : undefined,
		tools: asStringArray(parsed.tools),
		denyTools: asStringArray(parsed.denyTools),
		model: asString(parsed.model),
		triggers: normalizeTriggers(asRecord(parsed.triggers)),
		enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : undefined,
		permissions: normalizePermissions(asRecord(parsed.permissions)),
		mode: isAgentMode(parsed.mode) ? parsed.mode : undefined,
		temperature:
			typeof parsed.temperature === "number" ? parsed.temperature : undefined,
		topP: typeof parsed.topP === "number" ? parsed.topP : undefined,
		thinkingLevel: isThinkingLevel(parsed.thinkingLevel)
			? parsed.thinkingLevel
			: undefined,
		color: asString(parsed.color),
		builtIn: typeof parsed.builtIn === "boolean" ? parsed.builtIn : undefined,
	};
}

function parseYaml(content: string): Record<string, unknown> | null {
	try {
		const parsed = yaml.load(content);
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function parseComposerFile(
	filePath: string,
	source: "project" | "personal",
): LoadedComposer | null {
	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		const ext = extname(filePath).toLowerCase();
		let parsed: Record<string, unknown> | null = null;

		if (ext === ".json") {
			parsed = JSON.parse(content);
		} else if (ext === ".yaml" || ext === ".yml") {
			parsed = parseYaml(content);
		}

		if (!parsed || typeof parsed !== "object") {
			return null;
		}

		const config = normalizeComposerConfig(parsed, filePath);

		return {
			...config,
			source,
			filePath,
		};
	} catch (error) {
		logger.warn("Failed to parse composer file", {
			filePath,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function loadFromDirectory(
	dir: string,
	source: "project" | "personal",
): LoadedComposer[] {
	if (!existsSync(dir)) {
		return [];
	}

	try {
		const files = readdirSync(dir);
		const composers: LoadedComposer[] = [];

		for (const file of files) {
			const ext = extname(file).toLowerCase();
			if (ext !== ".json" && ext !== ".yaml" && ext !== ".yml") {
				continue;
			}

			const filePath = join(dir, file);

			// Prevent path traversal via symlinks
			try {
				const resolvedPath = realpathSync(filePath);
				const resolvedDir = realpathSync(dir);
				const relativePath = relative(resolvedDir, resolvedPath);
				if (
					relativePath === "" ||
					relativePath === ".." ||
					relativePath.startsWith(`..${sep}`) ||
					isAbsolute(relativePath)
				) {
					logger.warn("Rejected path traversal attempt", { file });
					continue;
				}
			} catch {
				// Skip files that can't be resolved (broken symlinks, etc.)
				continue;
			}

			const composer = parseComposerFile(filePath, source);
			if (composer && composer.enabled !== false) {
				composers.push(composer);
			}
		}

		return composers;
	} catch {
		return [];
	}
}

export function loadComposers(
	projectRoot?: string,
	options?: { includeBuiltin?: boolean },
): LoadedComposer[] {
	const includeBuiltin = options?.includeBuiltin ?? true;

	const builtinComposers = includeBuiltin ? getBuiltinAgents() : [];
	const personalComposers = loadFromDirectory(PERSONAL_DIR, "personal");
	const projectComposers = projectRoot
		? loadFromDirectory(join(projectRoot, PROJECT_DIR_NAME), "project")
		: [];

	// Priority: project > personal > builtin (later overrides earlier)
	const composerMap = new Map<string, LoadedComposer>();

	for (const composer of builtinComposers) {
		composerMap.set(composer.name, composer);
	}
	for (const composer of personalComposers) {
		composerMap.set(composer.name, composer);
	}
	for (const composer of projectComposers) {
		composerMap.set(composer.name, composer);
	}

	return Array.from(composerMap.values());
}

export function getComposerByName(
	name: string,
	projectRoot?: string,
): LoadedComposer | undefined {
	const composers = loadComposers(projectRoot);
	return composers.find((c) => c.name === name);
}

export function getComposerDirs(projectRoot?: string): string[] {
	const dirs = [PERSONAL_DIR];
	if (projectRoot) {
		dirs.push(join(projectRoot, PROJECT_DIR_NAME));
	}
	return dirs;
}
