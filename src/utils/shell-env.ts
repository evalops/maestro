/**
 * Shell Environment Policy - Filtered environment for user-command execution
 *
 * Applies a configurable policy to the process environment before passing it
 * to shell-based tools (bash/background tasks/sandboxed exec).
 *
 * By default, variables containing KEY/SECRET/TOKEN are excluded to reduce
 * accidental credential leakage into arbitrary commands. Use
 * `shell_environment_policy.ignore_default_excludes = true` to opt out.
 */

import { minimatch } from "minimatch";
import { type ShellEnvironmentPolicy, loadConfig } from "../config/index.js";

const CORE_ENV_VARS = [
	"HOME",
	"LOGNAME",
	"PATH",
	"SHELL",
	"USER",
	"USERNAME",
	"TMPDIR",
	"TEMP",
	"TMP",
];

const DEFAULT_EXCLUDES = ["*KEY*", "*SECRET*", "*TOKEN*"];

export interface ResolveShellEnvironmentOptions {
	baseEnv?: NodeJS.ProcessEnv;
	workspaceDir?: string;
	policy?: ShellEnvironmentPolicy;
}

function matchesAny(name: string, patterns: string[]): boolean {
	return patterns.some((pattern) =>
		minimatch(name, pattern, { nocase: true, dot: true }),
	);
}

function coerceEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") {
			result[key] = value;
		}
	}
	return result;
}

/**
 * Apply a ShellEnvironmentPolicy to a base environment map.
 */
export function applyShellEnvironmentPolicy(
	baseEnv: NodeJS.ProcessEnv,
	policy?: ShellEnvironmentPolicy,
): Record<string, string> {
	const resolvedPolicy: ShellEnvironmentPolicy = policy ?? {
		inherit: "all",
		ignore_default_excludes: false,
	};
	const inherit = resolvedPolicy.inherit ?? "all";
	const ignoreDefaultExcludes = resolvedPolicy.ignore_default_excludes ?? false;

	const base = coerceEnv(baseEnv);
	let env: Record<string, string> = {};

	if (inherit === "core") {
		const coreSet = new Set(CORE_ENV_VARS.map((name) => name.toUpperCase()));
		for (const [key, value] of Object.entries(base)) {
			if (coreSet.has(key.toUpperCase())) {
				env[key] = value;
			}
		}
	} else if (inherit === "none") {
		env = {};
	} else {
		env = { ...base };
	}

	if (!ignoreDefaultExcludes) {
		for (const key of Object.keys(env)) {
			if (matchesAny(key, DEFAULT_EXCLUDES)) {
				delete env[key];
			}
		}
	}

	if (resolvedPolicy.exclude?.length) {
		for (const key of Object.keys(env)) {
			if (matchesAny(key, resolvedPolicy.exclude)) {
				delete env[key];
			}
		}
	}

	if (resolvedPolicy.set) {
		for (const [key, value] of Object.entries(resolvedPolicy.set)) {
			env[key] = value;
		}
	}

	if (resolvedPolicy.include_only?.length) {
		for (const key of Object.keys(env)) {
			if (!matchesAny(key, resolvedPolicy.include_only)) {
				delete env[key];
			}
		}
	}

	return env;
}

/**
 * Resolve the effective shell environment for a command.
 *
 * Applies config policy, then merges explicit overrides (always win).
 */
export function resolveShellEnvironment(
	overrides?: Record<string, string | undefined>,
	options: ResolveShellEnvironmentOptions = {},
): Record<string, string> {
	const workspaceDir = options.workspaceDir ?? process.cwd();
	const configPolicy =
		options.policy ?? loadConfig(workspaceDir).shell_environment_policy;
	const env = applyShellEnvironmentPolicy(
		options.baseEnv ?? process.env,
		configPolicy,
	);
	if (overrides) {
		for (const [key, value] of Object.entries(overrides)) {
			if (typeof value === "string") {
				env[key] = value;
			}
		}
	}
	return env;
}
