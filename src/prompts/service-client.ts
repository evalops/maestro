import { getOAuthToken } from "../oauth/index.js";
import { loadOAuthCredentials } from "../oauth/storage.js";
import { createLogger } from "../utils/logger.js";
import type {
	ResolvePromptTemplateInput,
	ResolvedPromptTemplate,
} from "./types.js";

const logger = createLogger("prompts:service");
const DEFAULT_TIMEOUT_MS = 2_000;

interface PromptsServiceConfig {
	serviceUrl: string;
	serviceToken?: string;
	organizationId: string;
	timeoutMs: number;
}

interface ResolveVersionPayload {
	id?: string;
	version?: number;
	content?: string;
}

interface ResolveResponse {
	version?: ResolveVersionPayload;
}

function trimString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function resolveOrganizationId(): string | undefined {
	const envOrgId =
		trimString(process.env.PROMPTS_SERVICE_ORGANIZATION_ID) ??
		trimString(process.env.MAESTRO_EVALOPS_ORG_ID) ??
		trimString(process.env.EVALOPS_ORGANIZATION_ID) ??
		trimString(process.env.MAESTRO_ENTERPRISE_ORG_ID);
	if (envOrgId) {
		return envOrgId;
	}
	const stored = loadOAuthCredentials("evalops")?.metadata?.organizationId;
	return typeof stored === "string" && stored.trim().length > 0
		? stored.trim()
		: undefined;
}

async function resolvePromptsServiceConfig(): Promise<PromptsServiceConfig | null> {
	const serviceUrl = trimString(process.env.PROMPTS_SERVICE_URL);
	if (!serviceUrl) {
		return null;
	}

	const organizationId = resolveOrganizationId();
	if (!organizationId) {
		logger.warn(
			"Prompts service configured without organization id; retaining bundled system prompt",
		);
		return null;
	}

	const serviceToken =
		trimString(process.env.PROMPTS_SERVICE_TOKEN) ??
		trimString(process.env.MAESTRO_EVALOPS_ACCESS_TOKEN) ??
		(await getOAuthToken("evalops"));
	if (!serviceToken) {
		logger.warn(
			"Prompts service configured without access token; retaining bundled system prompt",
		);
		return null;
	}

	const timeoutMs = Number.parseInt(
		process.env.PROMPTS_SERVICE_TIMEOUT_MS ?? "",
		10,
	);

	return {
		serviceUrl: normalizeBaseUrl(serviceUrl),
		serviceToken,
		organizationId,
		timeoutMs:
			Number.isFinite(timeoutMs) && timeoutMs > 0
				? timeoutMs
				: DEFAULT_TIMEOUT_MS,
	};
}

function buildHeaders(config: PromptsServiceConfig): Record<string, string> {
	return {
		Authorization: `Bearer ${config.serviceToken}`,
		"X-Organization-ID": config.organizationId,
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

		const url = new URL("/v1/resolve", config.serviceUrl);
		url.searchParams.set("name", name);
		url.searchParams.set("env", trimString(input.label) ?? "production");
		if (trimString(input.surface)) {
			url.searchParams.set("surface", trimString(input.surface)!);
		}

		const response = await fetch(url, {
			method: "GET",
			headers: buildHeaders(config),
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

		return normalizeResolvedPrompt(
			input,
			(await response.json()) as ResolveResponse,
		);
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
