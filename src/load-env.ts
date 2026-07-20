import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { ENV_VARS } from "./config/env-vars.js";
import {
	markRuntimeEnvFinalized,
	resetDefaultRuntimeEnv,
} from "./runtime/env.js";

const ENV_FILES = [".env.local", ".env"];

// Keys that must never be sourced from a repo-controlled dotenv file. These are
// stripped immediately at load time so they can never reach process.env.
const BLOCKED_DOTENV_KEYS = new Set([
	"HOME",
	"FACTORY_HOME",
	"MAESTRO_HOME",
	"MAESTRO_CONFIG",
	"MAESTRO_PROFILE",
	"MAESTRO_LLM_GATEWAY_URL",
	"MAESTRO_MODELS_FILE",
	"MAESTRO_TRUST_PROJECT_MODEL_CONFIG",
	"USERPROFILE",
	// Agent-directory overrides decide where the "global" APPEND_SYSTEM.md and
	// other agent-scoped files are loaded from. A repo-controlled value can
	// redirect that fallback back into the workspace, bypassing the
	// untrusted-project gate. See resolveLoadedAppendSystemPromptPath.
	"MAESTRO_AGENT_DIR",
	"PLAYWRIGHT_AGENT_DIR",
	"CODING_AGENT_DIR",
]);

// Security-relevant settings that may legitimately come from a user's real
// shell environment but must not be silently set by a repo-controlled dotenv
// file. These are loaded normally and then scrubbed via
// scrubLoadedSecurityOverrideEnv() once trust has been established.
const DOTENV_SECURITY_OVERRIDE_KEYS = [
	ENV_VARS.PROFILE,
	"MAESTRO_WEB_PROFILE",
	ENV_VARS.APPROVAL_POLICY,
	"MAESTRO_APPROVAL_MODE",
	ENV_VARS.SANDBOX_MODE,
	ENV_VARS.SAFE_MODE,
	"MAESTRO_SAFE_REQUIRE_PLAN",
	"MAESTRO_SAFE_VALIDATORS",
	ENV_VARS.CONTEXT_FIREWALL_BLOCKING,
	"MAESTRO_HOME",
	"MAESTRO_AGENT_DIR",
	"PLAYWRIGHT_AGENT_DIR",
	"CODING_AGENT_DIR",
	"NODE_OPTIONS",
	"MAESTRO_CONFIG",
	"MAESTRO_MODELS_FILE",
	"MAESTRO_NOTIFY_EVENTS",
	"MAESTRO_NOTIFY_PROGRAM",
	"MAESTRO_ENTERPRISE_POLICY_PATH",
	"MAESTRO_POLICY_PATH",
	"MAESTRO_PROMPT_HISTORY_FILE",
	"MAESTRO_TOOL_HISTORY_FILE",
	"MAESTRO_TUI_TIP_HISTORY_FILE",
	"MAESTRO_BASH_HISTORY",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
	// EvalOps identity service URL: native `maestro init` and the OAuth flow
	// honor these aliases before the stored/derived URL. A repo .env
	// could otherwise point identity at an attacker service and capture the
	// user's OAuth bearer during agent bootstrap.
	"MAESTRO_IDENTITY_URL",
	"EVALOPS_IDENTITY_URL",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
	// EvalOps tenant identity aliases: any of these can scope durable-memory
	// writes (`X-Organization-ID`), remote-runner workspace selection, and
	// managed-context lookups. A repo-controlled dotenv must not be able to
	// redirect those tenant identifiers when a real EvalOps token is present.
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"EVALOPS_ORG_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
	"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
	"MAESTRO_EVALOPS_USER_ID",
	"EVALOPS_USER_ID",
	"MAESTRO_USER_ID",
	"EVALOPS_NATS_URL",
	"NATS_URL",
	"NATS_TOKEN",
	"NATS_USER",
	"NATS_PASSWORD",
	"MAESTRO_WEB_REQUIRE_KEY",
	"MAESTRO_WEB_REQUIRE_CSRF",
	"MAESTRO_WEB_REQUIRE_REDIS",
	"MAESTRO_WEB_ROOT",
	// CORS / WebSocket origin policy: a repo-controlled dotenv must not be
	// able to broaden cross-origin browser access to the local API by
	// setting `MAESTRO_WEB_ORIGIN=*` (or an attacker-controlled origin)
	// before the user's real env is checked.
	"MAESTRO_WEB_ORIGIN",
	// Content-Security-Policy override: web-server.ts prefers a non-empty
	// MAESTRO_WEB_CSP over the prod default when building SECURITY_HEADERS,
	// so a repo .env could otherwise weaken the browser policy in any
	// hardened profile.
	"MAESTRO_WEB_CSP",
	"MAESTRO_STRICT_SESSION_ACCESS",
	// Session scoping controls: a repo-controlled dotenv must not be able to
	// collapse authenticated web sessions back to the global file store.
	ENV_VARS.SESSION_SCOPE,
	ENV_VARS.MULTI_USER,
	"MAESTRO_REDIS_URL",
	"MAESTRO_DATABASE_URL",
	"DATABASE_URL",
	"MAESTRO_HOSTED_SESSION_STORAGE",
	"MAESTRO_SESSION_STORAGE",
	"MAESTRO_TRUST_PROXY",
	"MAESTRO_TRUST_PROXY_HOPS",
	// Web/auth secret material: a repo-controlled dotenv must not be able to
	// choose a known API key, CSRF token, JWT signing secret, or shared secret
	// for endpoints that are supposed to require a user-provided credential.
	"MAESTRO_WEB_API_KEY",
	"MAESTRO_WEB_CSRF_TOKEN",
	"MAESTRO_JWT_SECRET",
	// `JWT_SECRET` is the unprefixed fallback honored by src/auth/jwt.ts when
	// `MAESTRO_JWT_SECRET` is not set; a repo-controlled dotenv must not be
	// able to choose the signing key for enterprise auth via this fallback.
	"JWT_SECRET",
	// OAuth credential file overrides: `src/providers/openai-auth.ts:91`
	// binds AUTH_FILE to OPENAI_OAUTH_FILE, and `saveOpenAIOAuthCredential()`
	// then writes access/refresh/ID tokens and the derived API key to that
	// path. A repo .env must not be able to redirect fresh OAuth credentials
	// into the checkout where they can be read on the next install.
	"OPENAI_OAUTH_FILE",
	"MAESTRO_AUTH_SHARED_SECRET",
	"MAESTRO_DEVICE_IDENTITY_HELPER",
	"MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER",
	"MAESTRO_USER_MCP_PATH",
	"MAESTRO_ENTERPRISE_MCP_PATH",
	"MAESTRO_MCP_PROJECT_APPROVALS_FILE",
	"MAESTRO_MCP_WORKSPACE_TRUST_FILE",
	"MAESTRO_PACKAGE_CACHE_DIR",
	"MAESTRO_RUN_SCRIPT_ALLOWLIST",
	"MAESTRO_SCRIPT_RUNNER",
	// Session storage location: a repo-controlled dotenv must not be able to
	// redirect where session transcripts are read from or written to.
	ENV_VARS.SESSION_DIR,
	// Local-state file/dir overrides: a repo-controlled dotenv must not be
	// able to redirect where the todo store or background-task logs are
	// written, which would otherwise let a checkout capture future task
	// content or command output for files that live outside the workspace
	// by default. Same reasoning extends to the web queue store and
	// automations store, which write user prompt/output text to env-selected
	// paths.
	"MAESTRO_TODO_FILE",
	"MAESTRO_BACKGROUND_LOG_DIR",
	"MAESTRO_QUEUE_STATE",
	"MAESTRO_AUTOMATIONS_STATE",
	// Sandbox enforcement opt-out: a repo-controlled dotenv must not be able to
	// enable unsandboxed fallback execution.
	"MAESTRO_ALLOW_UNSANDBOXED_SANDBOX_FALLBACK",
	// Bash guard / shell egress / allowlist controls: a repo-controlled dotenv
	// must not be able to disable command approvals or widen the allowlist.
	"MAESTRO_BASH_GUARD",
	"MAESTRO_ALLOW_EGRESS_SHELL",
	"MAESTRO_FAIL_UNTAGGED_EGRESS",
	"MAESTRO_BACKGROUND_SHELL_DISABLE",
	"MAESTRO_BASH_ALLOWLIST_PATHS",
	"MAESTRO_GUARDIAN",
	"MAESTRO_MARKITDOWN",
	"MAESTRO_EVENT_BUS",
	"MAESTRO_AUDIT_BUS",
	"MAESTRO_TELEMETRY",
	"PLAYWRIGHT_TELEMETRY",
	"MAESTRO_OTEL",
	// Auto-verify custom command: a repo-controlled dotenv must not be able to
	// inject an arbitrary shell command that AutoVerifyService runs after edits.
	"MAESTRO_AUTO_TEST_COMMAND",
] as const;

const normalizeEnvKey = (key: string) => key.toUpperCase();
const DOTENV_SECURITY_OVERRIDE_KEY_SET = new Set<string>(
	DOTENV_SECURITY_OVERRIDE_KEYS.map(normalizeEnvKey),
);
const DOTENV_SECURITY_OVERRIDE_PREFIXES = [
	"APPROVALS_SERVICE_",
	"MAESTRO_ARTIFACT_ACCESS_",
	"MAESTRO_APPROVALS_",
	"MAESTRO_AGENT_MCP_",
	"MAESTRO_BEACON_",
	"MAESTRO_CEREBRO_MCP_",
	"MAESTRO_EVENT_BUS_",
	"MAESTRO_EVALOPS_AGENT_MCP_",
	"GOVERNANCE_SERVICE_",
	"MAESTRO_GOVERNANCE_",
	// Internal service clients must not accept repo-selected endpoints while
	// falling back to user-provided bearer tokens or tenant headers.
	"PIPELINE_",
	"MAESTRO_AGENT_REGISTRY_",
	"AGENT_REGISTRY_",
	"PLATFORM_AGENT_REGISTRY_",
	"MAESTRO_PLATFORM_A2A_",
	"MAESTRO_A2A_",
	"MAESTRO_AGENT_RUNTIME_",
	"AGENT_RUNTIME_",
	"PLATFORM_AGENT_RUNTIME_",
	// Platform tool-execution bridge: a repo .env must not be able to point
	// the Connect endpoint, auth token, or tenant identifiers at an
	// attacker-controlled service, or bash/MCP tool args and observation
	// output get posted there with the user's real credentials.
	"TOOL_EXECUTION_SERVICE_",
	"MAESTRO_TOOL_EXECUTION_",
	"MAESTRO_GUARDIAN_",
	"MAESTRO_HISTORY_",
	"MAESTRO_HOOKS_",
	"MAESTRO_JWT_",
	"MAESTRO_MARKITDOWN_",
	"MAESTRO_MEMORY_",
	"MAESTRO_OTEL_",
	// Web rate-limit controls: `session-rate-limit.ts` and
	// `session-share-store.ts` read these at module load when web-server.ts
	// imports its handlers. A repo .env could otherwise weaken per-session
	// or share rate limits even in a hardened web profile.
	"MAESTRO_RATE_LIMIT_",
	"MAESTRO_SHARE_RATE_LIMIT_",
	"MAESTRO_PLATFORM_MCP_",
	// Prompt-service controls: these can redirect system prompt resolution and
	// credential-bearing service calls to a repo-selected endpoint.
	"PROMPTS_SERVICE_",
	"MAESTRO_PROMPTS_",
	"MAESTRO_SAFE_",
	"MAESTRO_SCENARIO_",
	"MAESTRO_SESSION_BACKUP_",
	"MAESTRO_SESSION_RECOVERY_",
	"MAESTRO_SHARED_MEMORY_",
	"MAESTRO_TELEMETRY_",
	"OTEL_",
	"PLAYWRIGHT_TELEMETRY_",
	"SENTRY_",
] as const;
const isDotenvSecurityOverrideKey = (key: string): boolean => {
	const normalizedKey = normalizeEnvKey(key);
	return (
		DOTENV_SECURITY_OVERRIDE_KEY_SET.has(normalizedKey) ||
		DOTENV_SECURITY_OVERRIDE_PREFIXES.some((prefix) =>
			normalizedKey.startsWith(prefix),
		)
	);
};
const loadedEnvKeys = new Set<string>();

export function loadEnv(): string[] {
	const newlyLoadedKeys = new Set<string>();
	for (const file of ENV_FILES) {
		const resolved = join(process.cwd(), file);
		if (existsSync(resolved)) {
			const before = new Set(Object.keys(process.env));
			const beforeNormalized = new Set([...before].map(normalizeEnvKey));
			const result = config({ path: resolved, override: false });
			const after = new Set(Object.keys(process.env));
			for (const key of Object.keys(result.parsed ?? {})) {
				const normalizedKey = normalizeEnvKey(key);
				const wasLoadedByDotenv = !before.has(key) && after.has(key);
				if (!wasLoadedByDotenv) {
					continue;
				}
				if (BLOCKED_DOTENV_KEYS.has(normalizedKey)) {
					Reflect.deleteProperty(process.env, key);
					continue;
				}
				// Track newly loaded keys so they can be scrubbed later. For
				// security override keys we record the exact dotenv-loaded key even
				// when a differently cased variant already existed in the real
				// environment: env names are case-sensitive on POSIX, so dotenv can
				// create a distinct uppercase `MAESTRO_PROFILE` alongside a user's
				// `maestro_profile`, and that repo-controlled value must still be
				// scrubbed rather than survive due to the normalized collision.
				if (
					!beforeNormalized.has(normalizedKey) ||
					isDotenvSecurityOverrideKey(normalizedKey)
				) {
					newlyLoadedKeys.add(key);
					loadedEnvKeys.add(key);
				}
			}
		}
	}
	return [...newlyLoadedKeys];
}

export function getLoadedEnvKeys(): string[] {
	return [...loadedEnvKeys];
}

export function scrubLoadedSecurityOverrideEnv(): string[] {
	const scrubbed: string[] = [];
	for (const key of DOTENV_SECURITY_OVERRIDE_KEYS) {
		const matchingLoadedKeys = [...loadedEnvKeys].filter(
			(loadedKey) => normalizeEnvKey(loadedKey) === normalizeEnvKey(key),
		);
		if (matchingLoadedKeys.length === 0) {
			continue;
		}
		for (const loadedKey of matchingLoadedKeys) {
			Reflect.deleteProperty(process.env, loadedKey);
			loadedEnvKeys.delete(loadedKey);
			scrubbed.push(loadedKey);
		}
	}
	for (const loadedKey of [...loadedEnvKeys]) {
		if (!isDotenvSecurityOverrideKey(loadedKey)) {
			continue;
		}
		Reflect.deleteProperty(process.env, loadedKey);
		loadedEnvKeys.delete(loadedKey);
		scrubbed.push(loadedKey);
	}
	return scrubbed;
}

export interface FinalizedEnvLoad {
	loadedEnvKeys: string[];
	scrubbedEnvKeys: string[];
}

/**
 * Finish dotenv bootstrap after any trust-sensitive keys have been loaded.
 *
 * The order is load -> scrub -> reset RuntimeEnv. Resetting before the scrub
 * can preserve repo-controlled security overrides in the cached runtime
 * snapshot, which is exactly the bug class closed by the OTel follow-up.
 */
export function finalizeLoadedEnv(
	loadedEnvKeys: string[] = [],
): FinalizedEnvLoad {
	const scrubbedEnvKeys = scrubLoadedSecurityOverrideEnv();
	resetDefaultRuntimeEnv();
	markRuntimeEnvFinalized();
	return { loadedEnvKeys, scrubbedEnvKeys };
}

export function loadAndFinalizeEnv(): FinalizedEnvLoad {
	return finalizeLoadedEnv(loadEnv());
}
