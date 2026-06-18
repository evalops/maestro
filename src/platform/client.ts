import {
	EVALOPS_ACCESS_TOKEN_ENV_VARS,
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
} from "../evalops/env-aliases.js";
import { loadOAuthCredentials } from "../oauth/storage.js";
import type { RuntimeEnv } from "../runtime/env.js";
import {
	type DownstreamFailureMode,
	fetchDownstream,
} from "../utils/downstream-http.js";

export const CONNECT_PROTOCOL_VERSION = "1";
export const DEFAULT_PLATFORM_TIMEOUT_MS = 2_000;
export const DEFAULT_PLATFORM_MAX_ATTEMPTS = 2;

export interface PlatformServiceConfig {
	baseUrl: string;
	token?: string;
	organizationId?: string;
	teamId?: string;
	workspaceId?: string;
	timeoutMs: number;
	maxAttempts: number;
}

export interface ResolvePlatformServiceConfigOptions {
	baseUrlEnvVars: readonly string[];
	tokenEnvVars?: readonly string[];
	organizationEnvVars?: readonly string[];
	teamEnvVars?: readonly string[];
	workspaceEnvVars?: readonly string[];
	timeoutEnvVars?: readonly string[];
	maxAttemptsEnvVars?: readonly string[];
	baseUrlSuffixes?: readonly string[];
	defaultTimeoutMs?: number;
	defaultMaxAttempts?: number;
	requireBaseUrl?: boolean;
	requireOrganizationId?: boolean;
	requireToken?: boolean;
	allowOAuthTokenFallback?: boolean;
}

export interface PlatformRequestOptions {
	serviceName: string;
	failureMode: DownstreamFailureMode;
	timeoutMs: number;
	maxAttempts?: number;
	signal?: AbortSignal;
}

const SHARED_PLATFORM_BASE_URL_ENV_VARS = [
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
] as const;

const DEFAULT_TOKEN_ENV_VARS = EVALOPS_ACCESS_TOKEN_ENV_VARS;
const DEFAULT_ORGANIZATION_ENV_VARS = EVALOPS_ORGANIZATION_ID_ENV_VARS;

const DEFAULT_TEAM_ENV_VARS = [
	"MAESTRO_EVALOPS_TEAM_ID",
	"MAESTRO_LLM_GATEWAY_TEAM_ID",
] as const;

export function trimString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function getEnvValue(names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = trimString(process.env[name]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

export function parsePositiveInt(
	value: string | undefined,
	fallback: number,
): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeBaseUrl(
	baseUrl: string,
	suffixes: readonly string[] = [],
): string {
	let normalized = baseUrl.trim().replace(/\/+$/u, "");
	for (const suffix of suffixes) {
		if (normalized.endsWith(suffix)) {
			normalized = normalized.slice(0, -suffix.length).replace(/\/+$/u, "");
		}
	}
	return normalized;
}

/**
 * Read the EvalOps org id from a `RuntimeEnv` snapshot. This is the
 * substrate-typed path — the alias list (MAESTRO_EVALOPS_ORG_ID,
 * EVALOPS_ORGANIZATION_ID, EVALOPS_ORG_ID, MAESTRO_ENTERPRISE_ORG_ID) has
 * already been walked at snapshot construction time, so callers cannot
 * be tripped up by CI runner env leaking a missed alias.
 */
export function resolveOrganizationIdFromEnv(
	env: RuntimeEnv,
): string | undefined {
	return env.evalopsOrgId ?? undefined;
}

/**
 * Read the EvalOps org id from the OAuth credentials stored on disk via
 * `loadOAuthCredentials("evalops")`. Substrate callers that want the
 * full env-then-OAuth resolution compose this with
 * `resolveOrganizationIdFromEnv`:
 *
 *   const orgId =
 *     resolveOrganizationIdFromEnv(env) ??
 *     resolveOrganizationIdFromOAuthCredentials();
 *
 * Splitting the env-side from the disk-side is preparation for the
 * Settings substrate (Week 2) which will absorb the OAuth-disk source
 * into the same hierarchical resolver.
 */
export function resolveOrganizationIdFromOAuthCredentials():
	| string
	| undefined {
	const stored = loadOAuthCredentials("evalops")?.metadata?.organizationId;
	return typeof stored === "string" ? trimString(stored) : undefined;
}

export function resolveOrganizationId(
	envVars: readonly string[] = DEFAULT_ORGANIZATION_ENV_VARS,
): string | undefined {
	// Legacy entry point — preserves the alias-list-walking behavior for
	// scoped callers like meter (`MAESTRO_METER_ORGANIZATION_ID` first) and
	// memory (`MAESTRO_MEMORY_ORGANIZATION_ID` first). For the unscoped
	// default-list case, the new substrate-typed primitive
	// `resolveOrganizationIdFromEnv(env)` should be preferred — it
	// resolves the same aliases without re-reading `process.env`.
	const envOrgId = getEnvValue(envVars);
	if (envOrgId) {
		return envOrgId;
	}
	return resolveOrganizationIdFromOAuthCredentials();
}

export function resolveTeamId(
	envVars: readonly string[] = DEFAULT_TEAM_ENV_VARS,
): string | undefined {
	return getEnvValue(envVars);
}

export function resolveWorkspaceId(
	envVars: readonly string[] = DEFAULT_ORGANIZATION_ENV_VARS,
): string | undefined {
	return getEnvValue(envVars) ?? resolveOrganizationId();
}

export function resolveConfiguredToken(
	envVars: readonly string[] = DEFAULT_TOKEN_ENV_VARS,
): string | undefined {
	const envToken = getEnvValue(envVars);
	if (envToken) {
		return envToken;
	}
	const stored = loadOAuthCredentials("evalops")?.access;
	return typeof stored === "string" ? trimString(stored) : undefined;
}

export async function resolvePlatformToken(
	envVars: readonly string[] = DEFAULT_TOKEN_ENV_VARS,
): Promise<string | undefined> {
	const envToken = getEnvValue(envVars);
	if (envToken) {
		return envToken;
	}
	const { getOAuthToken } = await import("../oauth/index.js");
	return (await getOAuthToken("evalops")) ?? undefined;
}

export async function resolvePlatformServiceConfig(
	options: ResolvePlatformServiceConfigOptions,
): Promise<PlatformServiceConfig | null> {
	const baseUrl = getEnvValue([
		...options.baseUrlEnvVars,
		...SHARED_PLATFORM_BASE_URL_ENV_VARS,
	]);
	if (!baseUrl && options.requireBaseUrl !== false) {
		return null;
	}

	const organizationId = resolveOrganizationId(options.organizationEnvVars);
	if (!organizationId && options.requireOrganizationId !== false) {
		return null;
	}

	const token =
		options.allowOAuthTokenFallback === false
			? getEnvValue(options.tokenEnvVars ?? [])
			: await resolvePlatformToken(options.tokenEnvVars);
	if (!token && options.requireToken !== false) {
		return null;
	}

	const workspaceId = options.workspaceEnvVars
		? resolveWorkspaceId(options.workspaceEnvVars)
		: organizationId;

	return {
		baseUrl: normalizeBaseUrl(baseUrl ?? "", options.baseUrlSuffixes),
		...(token ? { token } : {}),
		...(organizationId ? { organizationId } : {}),
		teamId: resolveTeamId(options.teamEnvVars),
		...(workspaceId ? { workspaceId } : {}),
		timeoutMs: parsePositiveInt(
			getEnvValue(options.timeoutEnvVars ?? []),
			options.defaultTimeoutMs ?? DEFAULT_PLATFORM_TIMEOUT_MS,
		),
		maxAttempts: parsePositiveInt(
			getEnvValue(options.maxAttemptsEnvVars ?? []),
			options.defaultMaxAttempts ?? DEFAULT_PLATFORM_MAX_ATTEMPTS,
		),
	};
}

export function buildPlatformJsonHeaders(
	config: Pick<PlatformServiceConfig, "organizationId" | "token">,
	extraHeaders?: Record<string, string | undefined>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries({
			...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
			"Content-Type": "application/json",
			...(config.organizationId
				? { "X-Organization-ID": config.organizationId }
				: {}),
			...(extraHeaders ?? {}),
		}).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" && entry[1].trim().length > 0,
		),
	);
}

export function buildPlatformConnectHeaders(
	config: Pick<PlatformServiceConfig, "organizationId" | "token">,
	extraHeaders?: Record<string, string | undefined>,
): Record<string, string> {
	return buildPlatformJsonHeaders(config, {
		"Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
		...(extraHeaders ?? {}),
	});
}

export async function postPlatformConnect(
	config: PlatformServiceConfig,
	path: string,
	body: Record<string, unknown>,
	options: PlatformRequestOptions,
	headers?: Record<string, string | undefined>,
): Promise<Response> {
	return fetchDownstream(
		`${config.baseUrl}${path}`,
		{
			method: "POST",
			headers: buildPlatformConnectHeaders(config, headers),
			body: JSON.stringify(body),
			signal: options.signal,
		},
		{
			serviceName: options.serviceName,
			failureMode: options.failureMode,
			timeoutMs: options.timeoutMs,
			maxAttempts: options.maxAttempts,
		},
	);
}
