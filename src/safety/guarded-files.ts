import { resolve } from "node:path";
import { minimatch } from "minimatch";
import {
	expandTildePathWithHomeDir,
	getOsHomeDir,
} from "../utils/path-expansion.js";
import { tokenizeSimple, unwrapShellCommand } from "./bash-safety-analyzer.js";

export const DEFAULT_GUARDED_FILE_RULE_ID = "default-guarded-file";
export const GUARDED_FILES_BLOCK_POLICY_ID = "guardedFiles_block";

export type GuardedFileAccessAction = "read" | "write" | "execute" | "unknown";

export interface GuardedFileRule {
	category: string;
	patterns: string[];
}

export interface GuardedFileMatch {
	ruleId: typeof DEFAULT_GUARDED_FILE_RULE_ID;
	category: string;
	pattern: string;
	path: string;
}

export interface GuardedFileMatchOptions {
	cwd?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
}

export function classifyGuardedFileAccessAction(
	toolName: string,
): GuardedFileAccessAction {
	const normalizedToolName = toolName.toLowerCase();
	if (
		["write", "edit", "delete_file", "move_file", "copy_file"].includes(
			normalizedToolName,
		)
	) {
		return "write";
	}
	if (
		[
			"read",
			"list",
			"find",
			"search",
			"parallel_ripgrep",
			"diff",
			"status",
		].includes(normalizedToolName)
	) {
		return "read";
	}
	if (["bash", "background_tasks"].includes(normalizedToolName)) {
		return "execute";
	}
	return "unknown";
}

export const DEFAULT_GUARDED_FILE_RULES: GuardedFileRule[] = [
	{
		category: "Cursor configuration",
		patterns: [
			"**/.cursor/**",
			"~/.cursor/**",
			"~/Library/Application Support/Cursor/**",
			"~/.config/Cursor/**",
			"%APPDATA%/Cursor/**",
		],
	},
	{
		category: "Windsurf configuration",
		patterns: [
			"**/.windsurf/**",
			"~/.codeium/windsurf/**",
			"~/Library/Application Support/Windsurf/**",
			"~/.config/Windsurf/**",
			"%APPDATA%/Windsurf/**",
			"/Library/Application Support/Windsurf/**",
			"/etc/windsurf/**",
			"%ProgramData%/Windsurf/**",
		],
	},
	{
		category: "Antigravity configuration",
		patterns: ["~/.gemini/**"],
	},
	{
		category: "JetBrains application configuration",
		patterns: [
			"~/Library/Application Support/JetBrains/**",
			"~/.config/JetBrains/**",
			"~/.local/share/JetBrains/**",
			"%APPDATA%/JetBrains/**",
			"%LOCALAPPDATA%/JetBrains/**",
		],
	},
	{
		category: "JetBrains project configuration",
		patterns: ["**/.idea/**"],
	},
	{
		category: "Neovim configuration",
		patterns: [
			"~/.config/nvim/**",
			"~/.local/share/nvim/**",
			"~/.local/state/nvim/**",
		],
	},
	{
		category: "Amp settings",
		patterns: ["**/amp.json", "**/.amp/**"],
	},
	{
		category: "Shell configuration",
		patterns: [
			"~/.bashrc",
			"~/.zshrc",
			"~/.config/fish/config.fish",
			"~/.config/fish/conf.d/**",
			"~/.cshrc",
			"~/.tcshrc",
		],
	},
	{
		category: "SSH and GPG keys",
		patterns: ["**/.ssh/**", "~/.ssh/**", "**/.gnupg/**", "~/.gnupg/**"],
	},
];

const ENV_TOKEN_PATTERN = /%([A-Z0-9_()]+)%/gi;
const SHELL_ENV_TOKEN_PATTERN =
	/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function normalizeForGlob(value: string): string {
	return value.replace(/\\/g, "/");
}

function hasGlob(pattern: string): boolean {
	return /[*?{\[]/.test(pattern);
}

function expandEnvTokens(
	pattern: string,
	env: NodeJS.ProcessEnv,
): string | null {
	let missingToken = false;
	const expanded = pattern.replace(
		ENV_TOKEN_PATTERN,
		(_token, name: string) => {
			const value = env[name] ?? env[name.toUpperCase()];
			if (!value?.trim()) {
				missingToken = true;
				return "";
			}
			return value;
		},
	);
	return missingToken ? null : expanded;
}

function normalizePattern(
	pattern: string,
	options: Required<Pick<GuardedFileMatchOptions, "cwd" | "homeDir" | "env">>,
): string | null {
	const envExpanded = expandEnvTokens(pattern, options.env);
	if (envExpanded === null) {
		return null;
	}
	const homeExpanded = expandTildePathWithHomeDir(envExpanded, options.homeDir);
	if (hasGlob(homeExpanded)) {
		return normalizeForGlob(homeExpanded);
	}
	return normalizeForGlob(resolve(options.cwd, homeExpanded));
}

function normalizePatternVariants(
	pattern: string,
	options: Required<Pick<GuardedFileMatchOptions, "cwd" | "homeDir" | "env">>,
): string[] {
	const variants = [pattern];
	if (pattern.endsWith("/**")) {
		variants.push(pattern.slice(0, -3));
	}
	return variants.flatMap((variant) => {
		const normalized = normalizePattern(variant, options);
		return normalized ? [normalized] : [];
	});
}

function buildCandidatePaths(
	path: string,
	options: Required<Pick<GuardedFileMatchOptions, "cwd" | "homeDir" | "env">>,
): string[] {
	const homeExpanded = expandTildePathWithHomeDir(path, options.homeDir);
	const shellEnvExpanded = expandShellEnvTokens(path, options);
	const profileEnvExpanded = expandEnvTokens(path, options.env);
	const candidates = [path, homeExpanded];
	if (shellEnvExpanded) {
		candidates.push(shellEnvExpanded);
	}
	if (profileEnvExpanded) {
		candidates.push(profileEnvExpanded);
	}
	for (const candidate of [...candidates]) {
		candidates.push(resolve(options.cwd, candidate));
	}
	return Array.from(new Set(candidates.map(normalizeForGlob)));
}

function expandShellEnvTokens(
	path: string,
	options: Required<Pick<GuardedFileMatchOptions, "homeDir" | "env">>,
): string | null {
	let expandedAny = false;
	let missingToken = false;
	const expanded = path.replace(
		SHELL_ENV_TOKEN_PATTERN,
		(_token, bracedName: string | undefined, bareName: string | undefined) => {
			const name = bracedName ?? bareName;
			if (!name) {
				return "";
			}
			const value =
				name === "HOME"
					? options.homeDir
					: (options.env[name] ?? options.env[name.toUpperCase()]);
			if (!value?.trim()) {
				missingToken = true;
				return "";
			}
			expandedAny = true;
			return value;
		},
	);
	return expandedAny && !missingToken ? expanded : null;
}

export function findDefaultGuardedFileMatch(
	path: string,
	options: GuardedFileMatchOptions = {},
): GuardedFileMatch | null {
	const trimmedPath = path.trim();
	if (!trimmedPath) {
		return null;
	}
	const requiredOptions = {
		cwd: options.cwd ?? process.cwd(),
		homeDir: options.homeDir ?? getOsHomeDir(),
		env: options.env ?? process.env,
	};
	const candidates = buildCandidatePaths(trimmedPath, requiredOptions);

	for (const rule of DEFAULT_GUARDED_FILE_RULES) {
		for (const pattern of rule.patterns) {
			const normalizedPatterns = normalizePatternVariants(
				pattern,
				requiredOptions,
			);
			const matches = candidates.some((candidate) =>
				normalizedPatterns.some((normalizedPattern) =>
					minimatch(candidate, normalizedPattern, {
						dot: true,
						nocase: process.platform === "win32",
					}),
				),
			);
			if (matches) {
				return {
					ruleId: DEFAULT_GUARDED_FILE_RULE_ID,
					category: rule.category,
					pattern,
					path: trimmedPath,
				};
			}
		}
	}

	return null;
}

function getArgsObject(args: unknown): Record<string, unknown> | null {
	return args && typeof args === "object"
		? (args as Record<string, unknown>)
		: null;
}

function getStringArg(
	args: Record<string, unknown>,
	key: string,
): string | null {
	const value = args[key];
	return typeof value === "string" ? value : null;
}

function getStringListArg(
	args: Record<string, unknown>,
	key: string,
): string[] {
	const value = args[key];
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	return [];
}

function addStringArgs(
	paths: string[],
	args: Record<string, unknown>,
	keys: string[],
) {
	for (const key of keys) {
		paths.push(...getStringListArg(args, key));
	}
}

function isAnchoredPath(path: string): boolean {
	const trimmed = path.trim();
	return (
		trimmed.startsWith("/") ||
		trimmed.startsWith("~") ||
		trimmed.startsWith("$") ||
		/^[A-Za-z]:[\\/]/.test(trimmed) ||
		/^%[^%]+%[\\/]/.test(trimmed)
	);
}

function combineRelativePathWithCwd(cwd: string, path: string): string {
	if (isAnchoredPath(path) || !cwd.trim()) {
		return path;
	}
	const trimmedCwd = cwd.trim().replace(/[\\/]+$/, "");
	const trimmedPath = path.trim().replace(/^[\\/]+/, "");
	return `${trimmedCwd}/${trimmedPath}`;
}

function addStringArgsWithCwd(
	paths: string[],
	args: Record<string, unknown>,
	keys: string[],
	cwd: string | null,
) {
	const values = keys.flatMap((key) => getStringListArg(args, key));
	paths.push(...values);
	if (cwd) {
		paths.push(...values.map((path) => combineRelativePathWithCwd(cwd, path)));
	}
}

function stripShellTokenQuotes(token: string): string {
	const trimmed = token.trim();
	if (trimmed.length < 2) {
		return trimmed;
	}
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function extractGuardedShellCommandPaths(command: string): string[] {
	const unwrapped = unwrapShellCommand(command) ?? command;
	return tokenizeSimple(unwrapped)
		.map(stripShellTokenQuotes)
		.filter((token) => token.length > 0 && !token.startsWith("-"));
}

function extractGuardedToolCallPaths(
	toolName: string,
	args: unknown,
): string[] {
	const argsObject = getArgsObject(args);
	if (!argsObject) {
		return [];
	}
	const paths: string[] = [];
	const normalizedToolName = toolName.toLowerCase();
	if (["read", "write", "edit"].includes(normalizedToolName)) {
		const path =
			getStringArg(argsObject, "file_path") || getStringArg(argsObject, "path");
		if (path) {
			paths.push(path);
		}
	}
	if (normalizedToolName === "delete_file") {
		const path =
			getStringArg(argsObject, "file_path") ||
			getStringArg(argsObject, "target_file");
		if (path) {
			paths.push(path);
		}
	}
	if (
		normalizedToolName === "move_file" ||
		normalizedToolName === "copy_file"
	) {
		const source =
			getStringArg(argsObject, "source") ||
			getStringArg(argsObject, "source_path") ||
			getStringArg(argsObject, "from");
		const destination =
			getStringArg(argsObject, "destination") ||
			getStringArg(argsObject, "destination_path") ||
			getStringArg(argsObject, "dest") ||
			getStringArg(argsObject, "to");
		if (source) {
			paths.push(source);
		}
		if (destination) {
			paths.push(destination);
		}
	}
	if (["list", "find"].includes(normalizedToolName)) {
		addStringArgs(paths, argsObject, ["path"]);
	}
	if (
		["search", "parallel_ripgrep", "diff", "status"].includes(
			normalizedToolName,
		)
	) {
		addStringArgsWithCwd(
			paths,
			argsObject,
			["paths"],
			getStringArg(argsObject, "cwd"),
		);
	}
	if (["search", "parallel_ripgrep", "diff"].includes(normalizedToolName)) {
		addStringArgs(paths, argsObject, ["cwd"]);
	}
	if (
		normalizedToolName === "bash" ||
		normalizedToolName === "background_tasks"
	) {
		const command = getStringArg(argsObject, "command");
		const cwd = getStringArg(argsObject, "cwd");
		if (cwd) {
			paths.push(cwd);
		}
		if (command) {
			const shellPaths = extractGuardedShellCommandPaths(command);
			paths.push(...shellPaths);
			if (cwd) {
				paths.push(
					...shellPaths.map((path) => combineRelativePathWithCwd(cwd, path)),
				);
			}
		}
	}
	return paths;
}

export function findDefaultGuardedToolCallMatch(
	toolName: string,
	args: unknown,
	options: GuardedFileMatchOptions = {},
): GuardedFileMatch | null {
	for (const path of extractGuardedToolCallPaths(toolName, args)) {
		const match = findDefaultGuardedFileMatch(path, options);
		if (match) {
			return match;
		}
	}
	return null;
}

export function describeDefaultGuardedFileMatch(
	match: GuardedFileMatch,
): string {
	return `Guarded file access requires explicit approval: ${match.category} (${match.pattern}) at ${match.path}.`;
}
