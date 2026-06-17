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

/**
 * Default denylist of env-var name patterns that almost always carry
 * credentials. This is a defense-in-depth pattern — not a complete
 * secret blocker (denylists never are). Operators handling untrusted
 * code should set `shell_environment_policy.inherit = "core"` plus an
 * explicit `include_only` allowlist; see SECURITY.md.
 *
 * Widened in #2471 from the original 3-pattern list (`KEY`, `SECRET`,
 * `TOKEN`) to also cover:
 *
 *   - common credential nouns (`PASSWORD`, `PASSWD`, `CREDENTIAL`,
 *     `PRIVATE`, `PAT`, `AUTH`, `SESSION`)
 *   - DSN/connection-string vars whose value embeds creds even when
 *     the name doesn't (`DATABASE_URL`, `*_DSN`, `CONNECTION_STRING`)
 *   - common provider prefixes that hold long-lived creds
 *     (`AWS_*`, `AZURE_*`, `GCP_*`, `GOOGLE_*`, `OPENAI_*`,
 *     `ANTHROPIC_*`, `GH_*`, `GITHUB_*`, `STRIPE_*`, `TWILIO_*`,
 *     `SLACK_*`, `OP_*` for 1Password CLI)
 */
const DEFAULT_EXCLUDES = [
	// Original triad — broad credential nouns
	"*KEY*",
	"*SECRET*",
	"*TOKEN*",
	// Additional credential nouns (#2471)
	"*PASSWORD*",
	"*PASSWD*",
	"*CREDENTIAL*",
	"*PRIVATE*",
	"*_PAT", // GITHUB_PAT, GH_PAT, etc. (tighter than *PAT* which would catch PATH)
	"PAT_*",
	"*_AUTH",
	"*_AUTH_*",
	"AUTH_*",
	// DSN / connection-string env vars — name doesn't say "secret"
	// but the value embeds inline creds.
	"DATABASE_URL",
	"*_DATABASE_URL",
	"DB_URL",
	"*_DB_URL",
	"*_DSN",
	"CONNECTION_STRING",
	"*_CONNECTION_STRING",
	// Provider prefixes whose * is almost always a credential. We
	// deliberately exclude GITHUB_*/GH_* here because CI commonly
	// sets non-secret vars (`GITHUB_REPOSITORY`, `GH_PAGER`) under
	// these prefixes; the secret-shaped ones still get caught by
	// *TOKEN*/*_PAT/*KEY*.
	"AWS_*",
	"AZURE_*",
	"GCP_*",
	"OPENAI_*",
	"ANTHROPIC_*",
	"STRIPE_*",
	"TWILIO_*",
	"SLACK_*",
	"OP_*", // 1Password CLI session vars
];
const PLATFORM_WORKER_SURFACE = "platform-agent-runtime";
const PLATFORM_TRUSTED_TOOL_ENV_FLAG = "MAESTRO_PLATFORM_TRUSTED_TOOL_ENV";
const PLATFORM_TRUSTED_TOOL_ENV_ALLOWLIST = [
	"CODEX_WORKER_GIT_USERNAME",
	"GIT_ASKPASS",
	"GIT_TERMINAL_PROMPT",
	"MAESTRO_PLATFORM_A2A_ENABLED",
	"MAESTRO_AGENT_RUNTIME_A2A_ENABLED",
	"MAESTRO_PLATFORM_A2A_EXTENSIONS",
	"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
	"MAESTRO_PLATFORM_A2A_URL",
	"MAESTRO_AGENT_REGISTRY_SERVICE_URL",
	"MAESTRO_AGENT_RUNTIME_ORG_ID",
	"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
];

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

function isTruthyEnv(value?: string): boolean {
	if (!value) {
		return false;
	}
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function restorePlatformTrustedToolEnv(
	env: Record<string, string>,
	base: Record<string, string>,
	policy: ShellEnvironmentPolicy,
): void {
	if (base.MAESTRO_SURFACE !== PLATFORM_WORKER_SURFACE) {
		return;
	}
	if (!isTruthyEnv(base[PLATFORM_TRUSTED_TOOL_ENV_FLAG])) {
		return;
	}
	const inherit = policy.inherit ?? "all";
	const coreSet = new Set(CORE_ENV_VARS.map((name) => name.toUpperCase()));
	for (const key of PLATFORM_TRUSTED_TOOL_ENV_ALLOWLIST) {
		if (inherit === "none") {
			continue;
		}
		if (inherit === "core" && !coreSet.has(key.toUpperCase())) {
			continue;
		}
		if (policy.exclude?.length && matchesAny(key, policy.exclude)) {
			continue;
		}
		if (policy.include_only?.length && !matchesAny(key, policy.include_only)) {
			continue;
		}
		if (policy.set && Object.prototype.hasOwnProperty.call(policy.set, key)) {
			continue;
		}
		const value = base[key];
		if (typeof value === "string") {
			env[key] = value;
		}
	}
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

	restorePlatformTrustedToolEnv(env, base, resolvedPolicy);

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
