import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { constants, access } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import {
	SKILL_FRONTMATTER_FIELDS,
	findSkillMd,
	parseFrontmatter,
	stringArrayValue,
} from "./loader.js";

export type SkillLintSeverity = "error" | "warning";

export interface SkillLintIssue {
	code: string;
	severity: SkillLintSeverity;
	message: string;
	path: string;
}

export interface SkillLintResult {
	path: string;
	issues: SkillLintIssue[];
}

export interface SkillScaffoldOptions {
	description?: string;
	force?: boolean;
}

export interface SkillScaffoldResult {
	name: string;
	directory: string;
	files: string[];
}

type SkillLintOptions = {
	describeToolbox?: boolean;
	platform?: NodeJS.Platform;
};

export const SKILL_BODY_MAX_LINES = 500;
export const SKILL_BODY_MAX_CHARS = 20_000;

const FIELD_SET = new Set<string>(SKILL_FRONTMATTER_FIELDS);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function issue(
	code: string,
	severity: SkillLintSeverity,
	path: string,
	message: string,
): SkillLintIssue {
	return { code, severity, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSkillName(
	value: unknown,
	dirName: string,
	path: string,
): SkillLintIssue[] {
	if (typeof value !== "string" || value.trim().length === 0) {
		return [
			issue("missing_name", "error", path, "Skill frontmatter requires name."),
		];
	}

	const issues: SkillLintIssue[] = [];
	if (value.length > 64) {
		issues.push(
			issue("name_too_long", "error", path, "Skill name must be <= 64 chars."),
		);
	}
	if (!SKILL_NAME_PATTERN.test(value)) {
		issues.push(
			issue(
				"invalid_name",
				"error",
				path,
				"Skill name must use lowercase letters, numbers, and single hyphens.",
			),
		);
	}
	if (dirName !== "skills" && value !== dirName) {
		issues.push(
			issue(
				"name_mismatch",
				"error",
				path,
				`Skill name '${value}' must match directory '${dirName}'.`,
			),
		);
	}
	return issues;
}

function validateDescription(value: unknown, path: string): SkillLintIssue[] {
	if (typeof value !== "string" || value.trim().length === 0) {
		return [
			issue(
				"missing_description",
				"error",
				path,
				"Skill frontmatter requires description.",
			),
		];
	}

	const issues: SkillLintIssue[] = [];
	if (value.length > 1024) {
		issues.push(
			issue(
				"description_too_long",
				"error",
				path,
				"Skill description must be <= 1024 chars.",
			),
		);
	}
	if (!/\b(use|when)\b/i.test(value)) {
		issues.push(
			issue(
				"description_missing_when",
				"warning",
				path,
				'Description should include when to use the skill, for example "Use when ...".',
			),
		);
	}
	return issues;
}

function validateStringArrayField(
	frontmatter: Record<string, unknown>,
	field: string,
	path: string,
): SkillLintIssue[] {
	const value = frontmatter[field];
	if (value === undefined) return [];
	const normalized = stringArrayValue(value);
	if (!normalized || normalized.length === 0) {
		return [
			issue(
				"invalid_string_list",
				"error",
				path,
				`${field} must be a non-empty string or list of strings.`,
			),
		];
	}
	return [];
}

function isBooleanFrontmatterValue(value: unknown): boolean {
	if (typeof value === "boolean") return true;
	if (typeof value === "string") {
		const normalized = value.toLowerCase();
		return normalized === "true" || normalized === "false";
	}
	return false;
}

function validateBody(body: string, path: string): SkillLintIssue[] {
	const issues: SkillLintIssue[] = [];
	const lines = body.split("\n").length;
	if (lines > SKILL_BODY_MAX_LINES) {
		issues.push(
			issue(
				"skill_oversize",
				"error",
				path,
				`SKILL.md body has ${lines} lines; maximum is ${SKILL_BODY_MAX_LINES}.`,
			),
		);
	}
	if (body.length > SKILL_BODY_MAX_CHARS) {
		issues.push(
			issue(
				"skill_oversize",
				"error",
				path,
				`SKILL.md body has ${body.length} chars; maximum is ${SKILL_BODY_MAX_CHARS}.`,
			),
		);
	}
	return issues;
}

function validateMcpJson(skillDir: string): SkillLintIssue[] {
	const path = join(skillDir, "mcp.json");
	if (!existsSync(path)) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return [
			issue(
				"invalid_mcp_json",
				"error",
				path,
				`mcp.json must be valid JSON: ${
					error instanceof Error ? error.message : String(error)
				}`,
			),
		];
	}

	if (!isRecord(parsed)) {
		return [
			issue(
				"invalid_mcp_json",
				"error",
				path,
				"mcp.json must be an object keyed by server name.",
			),
		];
	}

	const issues: SkillLintIssue[] = [];
	for (const [serverName, server] of Object.entries(parsed)) {
		const serverPath = `${path}#${serverName}`;
		if (!isRecord(server)) {
			issues.push(
				issue(
					"invalid_mcp_server",
					"error",
					serverPath,
					"MCP server config must be an object.",
				),
			);
			continue;
		}
		if (typeof server.command !== "string" || server.command.trim() === "") {
			issues.push(
				issue(
					"invalid_mcp_command",
					"error",
					serverPath,
					"MCP server requires a non-empty command.",
				),
			);
		}
		if (
			!Array.isArray(server.includeTools) ||
			server.includeTools.length === 0
		) {
			issues.push(
				issue(
					"mcp_tools_unfiltered",
					"error",
					serverPath,
					"MCP server must declare includeTools with at least one tool.",
				),
			);
		} else if (
			server.includeTools.some(
				(tool) => typeof tool !== "string" || tool.trim() === "",
			)
		) {
			issues.push(
				issue(
					"invalid_mcp_include_tools",
					"error",
					serverPath,
					"includeTools entries must be non-empty strings.",
				),
			);
		}
		if (
			server.args !== undefined &&
			(!Array.isArray(server.args) ||
				server.args.some((arg) => typeof arg !== "string"))
		) {
			issues.push(
				issue(
					"invalid_mcp_args",
					"error",
					serverPath,
					"MCP args must be a list of strings.",
				),
			);
		}
		if (server.env !== undefined && !isRecord(server.env)) {
			issues.push(
				issue(
					"invalid_mcp_env",
					"error",
					serverPath,
					"MCP env must be an object of string values.",
				),
			);
		}
		if (
			isRecord(server.env) &&
			Object.values(server.env).some((value) => typeof value !== "string")
		) {
			issues.push(
				issue(
					"invalid_mcp_env",
					"error",
					serverPath,
					"MCP env values must be strings.",
				),
			);
		}
	}
	return issues;
}

const DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS = ".COM;.EXE;.BAT;.CMD;.PS1";

function windowsExecutableExtensions(
	pathExt = process.env.PATHEXT,
): Set<string> {
	return new Set(
		(pathExt || DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS)
			.split(";")
			.map((entry) => entry.trim().toUpperCase())
			.filter(Boolean),
	);
}

export function isWindowsRunnableToolboxEntry(
	path: string,
	pathExt = process.env.PATHEXT,
): boolean {
	const extension = extname(path).toUpperCase();
	return Boolean(
		extension && windowsExecutableExtensions(pathExt).has(extension),
	);
}

async function isExecutable(
	path: string,
	platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
	if (platform === "win32") {
		return isWindowsRunnableToolboxEntry(path);
	}
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function validateToolbox(
	skillDir: string,
	options: SkillLintOptions = {},
): Promise<SkillLintIssue[]> {
	const toolboxDir = join(skillDir, "toolbox");
	if (!existsSync(toolboxDir) || !statSync(toolboxDir).isDirectory()) return [];

	const issues: SkillLintIssue[] = [];
	for (const entry of readdirSync(toolboxDir)) {
		if (entry.startsWith(".") || entry.toLowerCase() === "readme.md") continue;
		const path = join(toolboxDir, entry);
		if (!statSync(path).isFile()) continue;
		if (!(await isExecutable(path, options.platform))) {
			issues.push(
				issue(
					"toolbox_not_executable",
					"error",
					path,
					"Toolbox entries must be executable files.",
				),
			);
			continue;
		}
		if (options.describeToolbox) {
			const result = spawnSync(path, {
				env: { ...process.env, MAESTRO_TOOLBOX_ACTION: "describe" },
				encoding: "utf8",
				timeout: 5000,
			});
			if (result.status !== 0) {
				issues.push(
					issue(
						"toolbox_describe_failed",
						"error",
						path,
						`Toolbox describe failed: ${result.stderr || result.stdout || "non-zero exit"}`,
					),
				);
			}
		}
	}
	return issues;
}

export async function lintSkillDirectory(
	skillDir: string,
	options: SkillLintOptions = {},
): Promise<SkillLintResult> {
	const resolvedDir = resolve(skillDir);
	const skillFile = findSkillMd(resolvedDir);
	const issues: SkillLintIssue[] = [];
	if (!skillFile) {
		return {
			path: resolvedDir,
			issues: [
				issue(
					"missing_skill_md",
					"error",
					resolvedDir,
					"Skill package requires SKILL.md.",
				),
			],
		};
	}

	try {
		const { frontmatter, body } = parseFrontmatter(
			readFileSync(skillFile, "utf8"),
		);
		for (const key of Object.keys(frontmatter)) {
			if (!FIELD_SET.has(key)) {
				issues.push(
					issue(
						"unexpected_field",
						"error",
						skillFile,
						`Unexpected frontmatter field '${key}'.`,
					),
				);
			}
		}
		issues.push(
			...validateSkillName(frontmatter.name, basename(resolvedDir), skillFile),
		);
		issues.push(...validateDescription(frontmatter.description, skillFile));
		for (const field of ["allowed-tools", "builtin-tools"]) {
			issues.push(...validateStringArrayField(frontmatter, field, skillFile));
		}
		if (
			frontmatter.compatibility !== undefined &&
			typeof frontmatter.compatibility !== "string"
		) {
			issues.push(
				issue(
					"invalid_compatibility",
					"error",
					skillFile,
					"compatibility must be a string.",
				),
			);
		}
		if (
			frontmatter.isolatedContext !== undefined &&
			!isBooleanFrontmatterValue(frontmatter.isolatedContext)
		) {
			issues.push(
				issue(
					"invalid_isolated_context",
					"error",
					skillFile,
					"isolatedContext must be a boolean.",
				),
			);
		}
		issues.push(...validateBody(body, skillFile));
	} catch (error) {
		issues.push(
			issue(
				"invalid_skill_md",
				"error",
				skillFile,
				error instanceof Error ? error.message : String(error),
			),
		);
	}

	if (
		existsSync(join(resolvedDir, "reference")) &&
		existsSync(join(resolvedDir, "references"))
	) {
		issues.push(
			issue(
				"duplicate_reference_dirs",
				"warning",
				resolvedDir,
				"Use either reference/ or references/; reference/ is preferred.",
			),
		);
	}
	issues.push(...validateMcpJson(resolvedDir));
	issues.push(...(await validateToolbox(resolvedDir, options)));
	return { path: resolvedDir, issues };
}

export async function lintSkillPaths(
	paths: string[],
	options: SkillLintOptions = {},
): Promise<SkillLintResult[]> {
	const results: SkillLintResult[] = [];
	for (const path of paths) {
		const resolved = resolve(path);
		if (!existsSync(resolved)) {
			results.push({
				path: resolved,
				issues: [
					issue(
						"missing_path",
						"error",
						resolved,
						"Skill path does not exist.",
					),
				],
			});
			continue;
		}
		const stat = statSync(resolved);
		if (!stat.isDirectory()) {
			results.push({
				path: resolved,
				issues: [
					issue(
						"invalid_path",
						"error",
						resolved,
						"Skill path must be a directory.",
					),
				],
			});
			continue;
		}
		if (findSkillMd(resolved)) {
			results.push(await lintSkillDirectory(resolved, options));
			continue;
		}
		for (const entry of readdirSync(resolved)) {
			const child = join(resolved, entry);
			if (statSync(child).isDirectory()) {
				results.push(await lintSkillDirectory(child, options));
			}
		}
	}
	return results;
}

export function formatSkillLintText(results: SkillLintResult[]): string {
	const lines: string[] = [];
	let errorCount = 0;
	let warningCount = 0;
	for (const result of results) {
		const issues = result.issues;
		if (issues.length === 0) {
			lines.push(`OK ${result.path}`);
			continue;
		}
		lines.push(result.path);
		for (const item of issues) {
			if (item.severity === "error") errorCount++;
			if (item.severity === "warning") warningCount++;
			lines.push(
				`  ${item.severity.toUpperCase()} ${item.code}: ${item.message}`,
			);
			if (item.path !== result.path) {
				lines.push(`    ${item.path}`);
			}
		}
	}
	lines.push("");
	lines.push(
		`${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${
			warningCount === 1 ? "" : "s"
		}`,
	);
	return lines.join("\n");
}

export function hasSkillLintErrors(results: SkillLintResult[]): boolean {
	return results.some((result) =>
		result.issues.some((item) => item.severity === "error"),
	);
}

export function scaffoldSkill(
	baseDir: string,
	name: string,
	options: SkillScaffoldOptions = {},
): SkillScaffoldResult {
	if (!SKILL_NAME_PATTERN.test(name) || name.length > 64) {
		throw new Error(
			"Skill name must use lowercase letters, numbers, and single hyphens.",
		);
	}
	const directory = resolve(baseDir, name);
	if (existsSync(directory) && !options.force) {
		throw new Error(`Skill already exists at ${directory}`);
	}

	const description =
		options.description ??
		`${name.replace(/-/g, " ")}. Use when a task needs this packaged workflow.`;
	const files: string[] = [];
	mkdirSync(join(directory, "reference"), { recursive: true });
	mkdirSync(join(directory, "scripts"), { recursive: true });
	mkdirSync(join(directory, "toolbox"), { recursive: true });

	const skillMd = join(directory, "SKILL.md");
	const escapedDescription = description
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"');
	writeFileSync(
		skillMd,
		[
			"---",
			`name: ${name}`,
			`description: "${escapedDescription}"`,
			"allowed-tools:",
			"  - read",
			"builtin-tools:",
			"  - read",
			"---",
			"",
			`# ${name}`,
			"",
			"## Workflow",
			"",
			"1. State the task-specific outcome.",
			"2. Load only the reference files needed for the request.",
			"3. Use bundled scripts or toolbox executables when they are more reliable than retyping long commands.",
			"",
			"## References",
			"",
			"- Read `reference/overview.md` when the user asks for implementation detail.",
			"",
		].join("\n"),
	);
	files.push(skillMd);

	const reference = join(directory, "reference", "overview.md");
	writeFileSync(
		reference,
		`# ${name} Reference\n\nAdd deeper examples, protocol notes, and troubleshooting details here. Keep this out of SKILL.md until needed.\n`,
	);
	files.push(reference);

	const scriptsReadme = join(directory, "scripts", "README.md");
	writeFileSync(
		scriptsReadme,
		"# Scripts\n\nPut deterministic helper scripts here. Agents should run these instead of retyping long workflows.\n",
	);
	files.push(scriptsReadme);

	const toolboxReadme = join(directory, "toolbox", "README.md");
	writeFileSync(
		toolboxReadme,
		"# Toolbox\n\nPut executable Toolbox protocol commands here. Each executable should support `MAESTRO_TOOLBOX_ACTION=describe`.\n",
	);
	files.push(toolboxReadme);

	const mcpJson = join(directory, "mcp.json.example");
	writeFileSync(
		mcpJson,
		'{\n  "example-server": {\n    "command": "npx",\n    "args": ["-y", "example-mcp-server"],\n    "includeTools": ["example_tool"]\n  }\n}\n',
	);
	files.push(mcpJson);

	return { name, directory, files };
}
