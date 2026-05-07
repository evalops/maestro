import { resolve } from "node:path";
import {
	DEFAULT_GUARDED_FILE_PATTERNS,
	type GuardedFileDefaultBehavior,
	type GuardedFilePattern,
	type GuardedFilesPolicySettings,
	normalizeGuardedFilesSettings,
} from "@evalops/contracts";
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
	key: string;
	category: string;
	patterns: string[];
}

export interface GuardedFileMatch {
	ruleId: typeof DEFAULT_GUARDED_FILE_RULE_ID;
	key: string;
	category: string;
	pattern: string;
	path: string;
	defaultBehavior: GuardedFileDefaultBehavior;
	mandatory: boolean;
	reason?: string;
	source: "default" | "organization" | "user";
}

export interface GuardedFileMatchOptions {
	cwd?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	policy?: GuardedFilesPolicySettings;
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

function guardedPatternToRule(pattern: GuardedFilePattern): GuardedFileRule {
	return {
		key: pattern.key,
		category: pattern.description,
		patterns: pattern.patterns,
	};
}

export const DEFAULT_GUARDED_FILE_RULES: GuardedFileRule[] =
	DEFAULT_GUARDED_FILE_PATTERNS.map(guardedPatternToRule);

interface EffectiveGuardedFileRule extends GuardedFileRule {
	defaultBehavior: GuardedFileDefaultBehavior;
	reason?: string;
	source: "default" | "organization" | "user";
}

interface NormalizedGuardedFilesPolicy {
	allowlist: string[];
	mandatoryKeys: Set<string>;
	rules: EffectiveGuardedFileRule[];
}

function guardedPatternToEffectiveRule(
	pattern: GuardedFilePattern,
	source: EffectiveGuardedFileRule["source"],
): EffectiveGuardedFileRule {
	return {
		key: pattern.key,
		category: pattern.description,
		patterns: pattern.patterns,
		defaultBehavior: pattern.defaultBehavior,
		...(pattern.reason ? { reason: pattern.reason } : {}),
		source,
	};
}

const DEFAULT_EFFECTIVE_GUARDED_FILE_RULES: EffectiveGuardedFileRule[] =
	DEFAULT_GUARDED_FILE_PATTERNS.map((pattern) =>
		guardedPatternToEffectiveRule(pattern, "default"),
	);

function normalizeGuardedFilesPolicy(
	policy?: GuardedFilesPolicySettings,
): NormalizedGuardedFilesPolicy {
	const organization = normalizeGuardedFilesSettings(policy?.organization);
	const user = normalizeGuardedFilesSettings(policy?.user);
	return {
		allowlist: [...organization.allowlist, ...user.allowlist],
		mandatoryKeys: new Set([
			...organization.mandatoryKeys,
			...user.mandatoryKeys,
		]),
		rules: [
			...DEFAULT_EFFECTIVE_GUARDED_FILE_RULES,
			...organization.rules.map((rule) =>
				guardedPatternToEffectiveRule(rule, "organization"),
			),
			...user.rules.map((rule) => guardedPatternToEffectiveRule(rule, "user")),
		],
	};
}

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

function allowlistEntryMatchesPath(
	entry: string,
	candidates: string[],
	options: Required<Pick<GuardedFileMatchOptions, "cwd" | "homeDir" | "env">>,
): boolean {
	const normalizedEntries = normalizePatternVariants(entry, options);
	return candidates.some((candidate) =>
		normalizedEntries.some((normalizedEntry) =>
			minimatch(candidate, normalizedEntry, {
				dot: true,
				nocase: process.platform === "win32",
			}),
		),
	);
}

function isGuardedMatchAllowlisted(
	match: Pick<GuardedFileMatch, "key" | "mandatory" | "defaultBehavior">,
	candidates: string[],
	policy: NormalizedGuardedFilesPolicy,
	options: Required<Pick<GuardedFileMatchOptions, "cwd" | "homeDir" | "env">>,
): boolean {
	if (match.defaultBehavior === "block") {
		return false;
	}
	if (match.mandatory) {
		return false;
	}
	return policy.allowlist.some((entry) => {
		const trimmed = entry.trim();
		return (
			trimmed === match.key ||
			allowlistEntryMatchesPath(trimmed, candidates, options)
		);
	});
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

export function findGuardedFileMatch(
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
	const policy = normalizeGuardedFilesPolicy(options.policy);
	let firstApprovalMatch: GuardedFileMatch | null = null;

	for (const rule of policy.rules) {
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
				const match: GuardedFileMatch = {
					ruleId: DEFAULT_GUARDED_FILE_RULE_ID,
					key: rule.key,
					category: rule.category,
					pattern,
					path: trimmedPath,
					defaultBehavior: rule.defaultBehavior,
					mandatory: policy.mandatoryKeys.has(rule.key),
					...(rule.reason ? { reason: rule.reason } : {}),
					source: rule.source,
				};
				if (
					isGuardedMatchAllowlisted(match, candidates, policy, requiredOptions)
				) {
					continue;
				}
				if (match.defaultBehavior === "block") {
					return match;
				}
				firstApprovalMatch ??= match;
			}
		}
	}

	return firstApprovalMatch;
}

export function findDefaultGuardedFileMatch(
	path: string,
	options: GuardedFileMatchOptions = {},
): GuardedFileMatch | null {
	return findGuardedFileMatch(path, options);
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

export function findGuardedToolCallMatch(
	toolName: string,
	args: unknown,
	options: GuardedFileMatchOptions = {},
): GuardedFileMatch | null {
	let firstMatch: GuardedFileMatch | null = null;
	for (const path of extractGuardedToolCallPaths(toolName, args)) {
		const match = findGuardedFileMatch(path, options);
		if (match) {
			if (match.defaultBehavior === "block") {
				return match;
			}
			firstMatch ??= match;
		}
	}
	return firstMatch;
}

export function findDefaultGuardedToolCallMatch(
	toolName: string,
	args: unknown,
	options: GuardedFileMatchOptions = {},
): GuardedFileMatch | null {
	return findGuardedToolCallMatch(toolName, args, options);
}

export function describeDefaultGuardedFileMatch(
	match: GuardedFileMatch,
): string {
	const policyReason = match.reason ? ` ${match.reason}` : "";
	const actionDescription =
		match.defaultBehavior === "block"
			? "is blocked by policy"
			: "requires explicit approval";
	return `Guarded file access ${actionDescription}: ${match.category} (${match.pattern}) at ${match.path}.${policyReason}`;
}
