import { getOAuthToken } from "../oauth/index.js";
import { loadOAuthCredentials } from "../oauth/storage.js";

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
}

export interface PlatformRequestOptions {
	serviceName: string;
	timeoutMs: number;
	maxAttempts?: number;
	signal?: AbortSignal;
}

const SHARED_PLATFORM_BASE_URL_ENV_VARS = [
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
] as const;

const DEFAULT_TOKEN_ENV_VARS = [
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;

const DEFAULT_ORGANIZATION_ENV_VARS = [
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
] as const;

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

export function resolveOrganizationId(
	envVars: readonly string[] = DEFAULT_ORGANIZATION_ENV_VARS,
): string | undefined {
	const envOrgId = getEnvValue(envVars);
	if (envOrgId) {
		return envOrgId;
	}
	const stored = loadOAuthCredentials("evalops")?.metadata?.organizationId;
	return typeof stored === "string" ? trimString(stored) : undefined;
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
	return getEnvValue(envVars) ?? (await getOAuthToken("evalops")) ?? undefined;
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

	const token = await resolvePlatformToken(options.tokenEnvVars);
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

export async function fetchWithRetry(
	url: string,
	init: RequestInit,
	options: PlatformRequestOptions,
): Promise<Response> {
	const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const response = await fetch(url, {
				...init,
				signal:
					options.signal ?? AbortSignal.timeout(Math.max(1, options.timeoutMs)),
			});
			if (response.status < 500 || attempt === maxAttempts) {
				return response;
			}
		} catch (error) {
			lastError = error;
			if (attempt === maxAttempts) {
				break;
			}
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error(`${options.serviceName} request failed`);
}

export async function postPlatformConnect(
	config: PlatformServiceConfig,
	path: string,
	body: Record<string, unknown>,
	options: PlatformRequestOptions,
	headers?: Record<string, string | undefined>,
): Promise<Response> {
	return fetchWithRetry(
		`${config.baseUrl}${path}`,
		{
			method: "POST",
			headers: buildPlatformConnectHeaders(config, headers),
			body: JSON.stringify(body),
		},
		options,
	);
}
