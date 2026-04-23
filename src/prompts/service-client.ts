import {
	type PlatformServiceConfig,
	getEnvValue,
	postPlatformConnect,
	resolveOrganizationId,
	resolvePlatformServiceConfig,
	trimString,
} from "../platform/client.js";
import {
	PLATFORM_CONNECT_METHODS,
	PLATFORM_CONNECT_SERVICES,
	platformConnectMethodPath,
	platformConnectServicePath,
} from "../platform/core-services.js";
import { fetchDownstream } from "../utils/downstream-http.js";
import { createLogger } from "../utils/logger.js";
import type {
	ResolvePromptTemplateInput,
	ResolvedPromptTemplate,
} from "./types.js";

const logger = createLogger("prompts:service");
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const RESOLVE_PROMPT_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.prompts.resolve,
);
const LEGACY_RESOLVE_PROMPT_PATH = "/v1/resolve";
const PROMPTS_BASE_URL_ENV_VARS = [
	"PROMPTS_SERVICE_URL",
	"MAESTRO_PROMPTS_SERVICE_URL",
] as const;
const PROMPTS_TOKEN_ENV_VARS = [
	"PROMPTS_SERVICE_TOKEN",
	"MAESTRO_PROMPTS_SERVICE_TOKEN",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;
const PROMPTS_ORGANIZATION_ENV_VARS = [
	"PROMPTS_SERVICE_ORGANIZATION_ID",
	"MAESTRO_PROMPTS_ORGANIZATION_ID",
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
] as const;

type PromptsTransport = "connect" | "legacy-rest";

type PromptsServiceConfig = PlatformServiceConfig & {
	transport: PromptsTransport;
};

interface ResolveVersionPayload {
	id?: string;
	version?: number;
	content?: string;
}

interface ResolveResponse {
	version?: ResolveVersionPayload;
}

function resolvePromptsTransport(): PromptsTransport {
	const configured = trimString(
		process.env.PROMPTS_SERVICE_TRANSPORT,
	)?.toLowerCase();
	if (configured === "connect" || configured === "platform") {
		return "connect";
	}
	if (configured === "legacy" || configured === "legacy-rest") {
		return "legacy-rest";
	}
	const serviceSpecificBase = getEnvValue(PROMPTS_BASE_URL_ENV_VARS);
	return serviceSpecificBase ? "legacy-rest" : "connect";
}

function hasConfiguredPromptsBaseUrl(): boolean {
	return Boolean(
		getEnvValue([
			...PROMPTS_BASE_URL_ENV_VARS,
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
		]),
	);
}

function warnPromptsServiceMisconfiguration(): void {
	if (!hasConfiguredPromptsBaseUrl()) {
		return;
	}
	if (!resolveOrganizationId(PROMPTS_ORGANIZATION_ENV_VARS)) {
		logger.warn(
			"Prompts service configured without organization id; retaining bundled prompts",
		);
		return;
	}
	logger.warn(
		"Prompts service configured without access token; retaining bundled prompts",
	);
}

async function resolvePromptsServiceConfig(): Promise<PromptsServiceConfig | null> {
	const config = await resolvePlatformServiceConfig({
		baseUrlEnvVars: PROMPTS_BASE_URL_ENV_VARS,
		tokenEnvVars: PROMPTS_TOKEN_ENV_VARS,
		organizationEnvVars: PROMPTS_ORGANIZATION_ENV_VARS,
		timeoutEnvVars: [
			"PROMPTS_SERVICE_TIMEOUT_MS",
			"MAESTRO_PROMPTS_TIMEOUT_MS",
		],
		maxAttemptsEnvVars: [
			"PROMPTS_SERVICE_MAX_ATTEMPTS",
			"MAESTRO_PROMPTS_MAX_ATTEMPTS",
		],
		baseUrlSuffixes: [
			RESOLVE_PROMPT_PATH,
			LEGACY_RESOLVE_PROMPT_PATH,
			platformConnectServicePath(PLATFORM_CONNECT_SERVICES.prompts),
		],
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
		requireOrganizationId: true,
		requireToken: true,
	});
	if (!config) {
		warnPromptsServiceMisconfiguration();
		return null;
	}

	return {
		...config,
		transport: resolvePromptsTransport(),
	};
}

function buildHeaders(config: PromptsServiceConfig): Record<string, string> {
	return {
		...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
		...(config.organizationId
			? { "X-Organization-ID": config.organizationId }
			: {}),
	};
}

function normalizeResolvedPrompt(
	input: ResolvePromptTemplateInput,
	payload: ResolveResponse,
): ResolvedPromptTemplate | null {
	const name = trimString(input.name);
	const versionId = trimString(payload.version?.id);
	const content = trimString(payload.version?.content);
	const version = payload.version?.version;
	if (!name || !versionId || !content || !Number.isFinite(version)) {
		return null;
	}

	return {
		name,
		label: trimString(input.label) ?? "production",
		surface: trimString(input.surface),
		version: Math.round(version!),
		versionId,
		content,
	};
}

async function resolveViaPlatformConnect(
	config: PromptsServiceConfig,
	input: ResolvePromptTemplateInput,
	name: string,
): Promise<ResolveResponse | null> {
	const response = await postPlatformConnect(
		config,
		RESOLVE_PROMPT_PATH,
		{
			name,
			label: trimString(input.label) ?? "production",
		},
		{
			serviceName: "prompts service",
			failureMode: "optional",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`prompts service returned ${response.status}: ${text || response.statusText}`,
		);
	}
	return (await response.json()) as ResolveResponse;
}

async function resolveViaLegacyRest(
	config: PromptsServiceConfig,
	input: ResolvePromptTemplateInput,
	name: string,
): Promise<ResolveResponse | null> {
	const url = new URL(LEGACY_RESOLVE_PROMPT_PATH, config.baseUrl);
	url.searchParams.set("name", name);
	url.searchParams.set("env", trimString(input.label) ?? "production");
	if (trimString(input.surface)) {
		url.searchParams.set("surface", trimString(input.surface)!);
	}

	const response = await fetchDownstream(
		url,
		{
			method: "GET",
			headers: buildHeaders(config),
		},
		{
			serviceName: "prompts service",
			failureMode: "optional",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`prompts service returned ${response.status}: ${text || response.statusText}`,
		);
	}
	return (await response.json()) as ResolveResponse;
}

export async function resolvePromptTemplate(
	input: ResolvePromptTemplateInput,
): Promise<ResolvedPromptTemplate | null> {
	const name = trimString(input.name);
	if (!name) {
		return null;
	}

	try {
		const config = await resolvePromptsServiceConfig();
		if (!config) {
			return null;
		}

		const payload =
			config.transport === "connect"
				? await resolveViaPlatformConnect(config, input, name)
				: await resolveViaLegacyRest(config, input, name);
		if (!payload) {
			return null;
		}

		return normalizeResolvedPrompt(input, payload);
	} catch (error) {
		logger.warn("Failed to resolve prompt template; retaining bundled prompt", {
			error: error instanceof Error ? error.message : String(error),
			name,
			label: trimString(input.label) ?? "production",
			surface: trimString(input.surface),
		});
		return null;
	}
}
