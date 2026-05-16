import {
	constants,
	accessSync,
	existsSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { isWindowsRunnableToolboxEntry } from "./linter.js";
import type { LoadedSkill, SkillResource } from "./loader.js";

export interface SkillRuntimeActivation {
	name: string;
	source: LoadedSkill["sourceType"];
	sourcePath?: string;
	profile: {
		argumentHint?: string;
		compatibility?: string;
		isolatedContext?: boolean;
		mode?: string;
		model?: string;
	};
	tools: {
		allowed: string[];
		builtin: string[];
	};
	resources: {
		files: SkillRuntimeResource[];
		directories: SkillRuntimeResourceDirectories;
	};
	toolPackage: {
		toolbox?: SkillRuntimeToolboxActivation;
		mcp?: SkillRuntimeMcpActivation;
	};
}

export interface SkillRuntimeResource {
	name: string;
	path: string;
	type: SkillResource["type"];
}

export interface SkillRuntimeResourceDirectories {
	scripts?: string;
	reference?: string;
	references?: string;
	assets?: string;
	toolbox?: string;
}

export interface SkillRuntimeToolboxActivation {
	directory: string;
	entries: SkillRuntimeToolboxEntry[];
	warnings?: string[];
}

export interface SkillRuntimeToolboxEntry {
	name: string;
	path: string;
}

export interface SkillRuntimeMcpActivation {
	configPath: string;
	servers: SkillRuntimeMcpServer[];
	warnings?: string[];
}

export interface SkillRuntimeMcpServer {
	name: string;
	command?: string;
	includeTools: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDirectory(path: string | undefined): path is string {
	if (!path || !existsSync(path)) {
		return false;
	}
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string | undefined): path is string {
	if (!path || !existsSync(path)) {
		return false;
	}
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

type StringListParseResult =
	| { status: "valid"; values: string[] }
	| { status: "missing"; values: [] }
	| { status: "invalid"; values: [] };

function nonEmptyStringList(value: unknown): StringListParseResult {
	if (!Array.isArray(value)) {
		return { status: "missing", values: [] };
	}
	const values: string[] = [];
	for (const entry of value) {
		const normalized = nonEmptyString(entry);
		if (!normalized) {
			return { status: "invalid", values: [] };
		}
		values.push(normalized);
	}
	return { status: "valid", values };
}

function isRunnableFile(path: string | undefined): path is string {
	if (!isFile(path)) {
		return false;
	}
	if (process.platform === "win32") {
		return isWindowsRunnableToolboxEntry(path);
	}
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function buildResourceDirectories(
	skill: LoadedSkill,
): SkillRuntimeResourceDirectories {
	return {
		...(skill.resourceDirs.scriptsDir
			? { scripts: skill.resourceDirs.scriptsDir }
			: {}),
		...(skill.resourceDirs.referenceDir
			? { reference: skill.resourceDirs.referenceDir }
			: {}),
		...(skill.resourceDirs.referencesDir
			? { references: skill.resourceDirs.referencesDir }
			: {}),
		...(skill.resourceDirs.assetsDir
			? { assets: skill.resourceDirs.assetsDir }
			: {}),
		...(skill.resourceDirs.toolboxDir
			? { toolbox: skill.resourceDirs.toolboxDir }
			: {}),
	};
}

function buildToolboxActivation(
	toolboxDir: string | undefined,
): SkillRuntimeToolboxActivation | undefined {
	if (!isDirectory(toolboxDir)) {
		return undefined;
	}
	let directoryEntries: string[];
	try {
		directoryEntries = readdirSync(toolboxDir);
	} catch (error) {
		return {
			directory: toolboxDir,
			entries: [],
			warnings: [`toolbox directory could not be read: ${errorMessage(error)}`],
		};
	}
	const entries = directoryEntries
		.filter(
			(entry) => !entry.startsWith(".") && entry.toLowerCase() !== "readme.md",
		)
		.map((entry) => ({ name: entry, path: join(toolboxDir, entry) }))
		.filter((entry) => isRunnableFile(entry.path))
		.sort((left, right) => left.name.localeCompare(right.name));

	return {
		directory: toolboxDir,
		entries,
	};
}

function buildMcpActivation(
	mcpJsonPath: string | undefined,
): SkillRuntimeMcpActivation | undefined {
	if (!isFile(mcpJsonPath)) {
		return undefined;
	}

	const warnings: string[] = [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
	} catch (error) {
		warnings.push(`mcp.json could not be parsed: ${errorMessage(error)}`);
		return { configPath: mcpJsonPath, servers: [], warnings };
	}

	if (!isRecord(parsed)) {
		return {
			configPath: mcpJsonPath,
			servers: [],
			warnings: ["mcp.json must be an object keyed by server name."],
		};
	}

	const servers: SkillRuntimeMcpServer[] = [];
	for (const [name, server] of Object.entries(parsed).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (!isRecord(server)) {
			warnings.push(`MCP server '${name}' must be an object.`);
			continue;
		}
		const command = nonEmptyString(server.command);
		if (!command) {
			warnings.push(`MCP server '${name}' requires a non-empty command.`);
			continue;
		}
		const includeTools = nonEmptyStringList(server.includeTools);
		if (includeTools.status === "invalid") {
			warnings.push(
				`MCP server '${name}' includeTools entries must be non-empty strings.`,
			);
			continue;
		}
		if (includeTools.status === "missing" || includeTools.values.length === 0) {
			warnings.push(
				`MCP server '${name}' does not declare bounded includeTools.`,
			);
			continue;
		}
		servers.push({
			name,
			command,
			includeTools: includeTools.values,
		});
	}

	return {
		configPath: mcpJsonPath,
		servers,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

/**
 * Build the runtime-facing activation contract for a loaded skill.
 *
 * This intentionally exposes only scoped resource paths and MCP tool bounds. The
 * raw MCP config remains on disk so runtimes can activate it without copying env
 * values or credentials into agent-visible telemetry.
 */
export function buildSkillRuntimeActivation(
	skill: LoadedSkill,
): SkillRuntimeActivation {
	const toolbox = buildToolboxActivation(skill.resourceDirs.toolboxDir);
	const mcp = buildMcpActivation(skill.resourceDirs.mcpJsonPath);

	return {
		name: skill.name,
		source: skill.sourceType,
		...(skill.sourcePath ? { sourcePath: skill.sourcePath } : {}),
		profile: {
			...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
			...(skill.compatibility ? { compatibility: skill.compatibility } : {}),
			...(skill.isolatedContext !== undefined
				? { isolatedContext: skill.isolatedContext }
				: {}),
			...(skill.mode ? { mode: skill.mode } : {}),
			...(skill.model ? { model: skill.model } : {}),
		},
		tools: {
			allowed: [...(skill.allowedTools ?? [])],
			builtin: [...(skill.builtinTools ?? [])],
		},
		resources: {
			files: skill.resources.map((resource) => ({
				name: resource.name,
				path: resource.path,
				type: resource.type,
			})),
			directories: buildResourceDirectories(skill),
		},
		toolPackage: {
			...(toolbox ? { toolbox } : {}),
			...(mcp ? { mcp } : {}),
		},
	};
}
