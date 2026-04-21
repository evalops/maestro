import {
	type PlatformServiceConfig,
	buildPlatformJsonHeaders,
	getEnvValue,
	postPlatformConnect,
	resolvePlatformServiceConfig,
	trimString,
} from "../platform/client.js";
import { createLogger } from "../utils/logger.js";
import type {
	ResolvePromptTemplateInput,
	ResolvedPromptTemplate,
} from "./types.js";

const logger = createLogger("prompts:service");
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const RESOLVE_PROMPT_PATH = "/prompts.v1.PromptService/Resolve";
const LEGACY_RESOLVE_PROMPT_PATH = "/v1/resolve";

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
	const serviceSpecificBase = getEnvValue([
		"PROMPTS_SERVICE_URL",
		"MAESTRO_PROMPTS_SERVICE_URL",
	]);
	return serviceSpecificBase ? "legacy-rest" : "connect";
}

async function resolvePromptsServiceConfig(): Promise<PromptsServiceConfig | null> {
	const config = await resolvePlatformServiceConfig({
		baseUrlEnvVars: ["PROMPTS_SERVICE_URL", "MAESTRO_PROMPTS_SERVICE_URL"],
		tokenEnvVars: [
			"PROMPTS_SERVICE_TOKEN",
			"MAESTRO_PROMPTS_SERVICE_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
		],
		organizationEnvVars: [
			"PROMPTS_SERVICE_ORGANIZATION_ID",
			"MAESTRO_PROMPTS_ORGANIZATION_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
		],
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
			"/prompts.v1.PromptService",
		],
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
		requireOrganizationId: true,
		requireToken: true,
	});
	if (!config) {
		return null;
	}

	return {
		...config,
		transport: resolvePromptsTransport(),
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

	const response = await fetch(url, {
		method: "GET",
		headers: buildPlatformJsonHeaders(config),
		signal: AbortSignal.timeout(config.timeoutMs),
	});
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
