import { loadOAuthCredentials } from "../oauth/storage.js";
import {
	type DownstreamFailureMode as DownstreamHttpFailureMode,
	fetchDownstream,
} from "../utils/downstream-http.js";
import * as downstream from "../utils/downstream.js";
import type { LoadedSkill } from "./loader.js";

const CONNECT_PROTOCOL_VERSION = "1";
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_SURFACE = "maestro";
const DEFAULT_TIMEOUT_MS = 2_000;
const LIST_SKILLS_PATH = "/skills.v1.SkillService/List";

export const SKILLS_CALL_FAILURE_MODES = {
	listSkills: {
		optional: downstream.FailOpen,
		required: downstream.FailClosed,
	},
} as const;

type SkillsCall = keyof typeof SKILLS_CALL_FAILURE_MODES;

export interface SkillsServiceConfig {
	baseUrl?: string;
	token?: string;
	workspaceId?: string;
	surface?: string;
	entityId?: string;
	limit?: number;
	timeoutMs?: number;
	maxAttempts?: number;
	circuitFailureThreshold?: number;
	circuitResetTimeoutMs?: number;
	circuitSuccessThreshold?: number;
	required?: boolean;
}

export interface ResolvedSkillsServiceConfig {
	baseUrl: string;
	token?: string;
	workspaceId: string;
	surface: string;
	entityId?: string;
	limit: number;
	timeoutMs: number;
	maxAttempts: number;
	circuitFailureThreshold: number;
	circuitResetTimeoutMs: number;
	circuitSuccessThreshold: number;
	failureMode: DownstreamHttpFailureMode;
}

interface SkillsServiceSkill {
	id?: string;
	workspaceId?: string;
	ownerId?: string;
	name?: string;
	description?: string;
	scope?: string | number;
	content?: string;
	currentVersion?: number;
	tags?: string[];
}

interface ListSkillsResponse {
	skills?: SkillsServiceSkill[];
	total?: number;
}

const downstreamClients = new Map<string, downstream.DownstreamClient>();

function trimString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function getEnvValue(names: string[]): string | undefined {
	for (const name of names) {
		const value = trimString(process.env[name]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(baseUrl: string): string {
	let normalized = baseUrl.trim();
	for (const suffix of [LIST_SKILLS_PATH, "/skills.v1.SkillService"]) {
		if (normalized.endsWith(suffix)) {
			normalized = normalized.slice(0, -suffix.length);
		}
	}
	return normalized.replace(/\/+$/, "");
}

function resolveWorkspaceId(
	config: SkillsServiceConfig | undefined,
): string | undefined {
	const configuredWorkspaceId = trimString(config?.workspaceId);
	const envWorkspaceId = getEnvValue([
		"SKILLS_SERVICE_WORKSPACE_ID",
		"MAESTRO_SKILLS_WORKSPACE_ID",
		"MAESTRO_EVALOPS_ORG_ID",
		"EVALOPS_ORGANIZATION_ID",
		"MAESTRO_ENTERPRISE_ORG_ID",
	]);
	if (configuredWorkspaceId ?? envWorkspaceId) {
		return configuredWorkspaceId ?? envWorkspaceId;
	}
	const stored = loadOAuthCredentials("evalops")?.metadata?.organizationId;
	return typeof stored === "string" && stored.trim().length > 0
		? stored.trim()
		: undefined;
}

function normalizeLimit(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_LIMIT;
	}
	return Math.max(1, Math.min(500, Math.trunc(value)));
}

export function resolveSkillsServiceConfig(
	config: SkillsServiceConfig | false | undefined,
): ResolvedSkillsServiceConfig | null {
	if (config === false) {
		return null;
	}

	const baseUrl =
		trimString(config?.baseUrl) ??
		getEnvValue(["SKILLS_SERVICE_URL", "MAESTRO_SKILLS_SERVICE_URL"]);
	if (!baseUrl) {
		return null;
	}

	const workspaceId = resolveWorkspaceId(config);
	if (!workspaceId) {
		return null;
	}

	const storedToken = trimString(loadOAuthCredentials("evalops")?.access);
	const token =
		trimString(config?.token) ??
		getEnvValue([
			"SKILLS_SERVICE_TOKEN",
			"MAESTRO_SKILLS_SERVICE_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]) ??
		storedToken;

	const required =
		config?.required ??
		getEnvValue([
			"SKILLS_SERVICE_REQUIRED",
			"MAESTRO_SKILLS_SERVICE_REQUIRED",
		]) === "1";

	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		circuitFailureThreshold:
			config?.circuitFailureThreshold ??
			parsePositiveInt(
				getEnvValue([
					"SKILLS_SERVICE_CIRCUIT_FAILURE_THRESHOLD",
					"MAESTRO_SKILLS_SERVICE_CIRCUIT_FAILURE_THRESHOLD",
				]),
				5,
			),
		circuitResetTimeoutMs:
			config?.circuitResetTimeoutMs ??
			parsePositiveInt(
				getEnvValue([
					"SKILLS_SERVICE_CIRCUIT_RESET_TIMEOUT_MS",
					"MAESTRO_SKILLS_SERVICE_CIRCUIT_RESET_TIMEOUT_MS",
				]),
				30_000,
			),
		circuitSuccessThreshold:
			config?.circuitSuccessThreshold ??
			parsePositiveInt(
				getEnvValue([
					"SKILLS_SERVICE_CIRCUIT_SUCCESS_THRESHOLD",
					"MAESTRO_SKILLS_SERVICE_CIRCUIT_SUCCESS_THRESHOLD",
				]),
				2,
			),
		entityId:
			trimString(config?.entityId) ??
			getEnvValue(["SKILLS_SERVICE_ENTITY_ID", "MAESTRO_SKILLS_ENTITY_ID"]),
		failureMode: required ? "required" : "optional",
		limit:
			config?.limit ??
			parsePositiveInt(
				getEnvValue(["SKILLS_SERVICE_LIMIT", "MAESTRO_SKILLS_SERVICE_LIMIT"]),
				DEFAULT_LIMIT,
			),
		maxAttempts:
			config?.maxAttempts ??
			parsePositiveInt(
				getEnvValue([
					"SKILLS_SERVICE_MAX_ATTEMPTS",
					"MAESTRO_SKILLS_SERVICE_MAX_ATTEMPTS",
				]),
				DEFAULT_MAX_ATTEMPTS,
			),
		surface:
			trimString(config?.surface) ??
			getEnvValue(["SKILLS_SERVICE_SURFACE"]) ??
			DEFAULT_SURFACE,
		timeoutMs:
			config?.timeoutMs ??
			parsePositiveInt(
				getEnvValue([
					"SKILLS_SERVICE_TIMEOUT_MS",
					"MAESTRO_SKILLS_SERVICE_TIMEOUT_MS",
				]),
				DEFAULT_TIMEOUT_MS,
			),
		token,
		workspaceId,
	};
}

function getDownstreamClient(
	config: ResolvedSkillsServiceConfig,
	op: SkillsCall,
): downstream.DownstreamClient {
	const failureMode = SKILLS_CALL_FAILURE_MODES[op][config.failureMode];
	const key = JSON.stringify({
		baseUrl: config.baseUrl,
		failureMode,
		op,
		reset: config.circuitResetTimeoutMs,
		success: config.circuitSuccessThreshold,
		threshold: config.circuitFailureThreshold,
	});
	const cached = downstreamClients.get(key);
	if (cached) {
		return cached;
	}
	const client = downstream.New(`skills.${op}`, {
		failureMode,
		breaker: {
			failureThreshold: config.circuitFailureThreshold,
			resetTimeoutMs: config.circuitResetTimeoutMs,
			successThreshold: config.circuitSuccessThreshold,
			toolName: `skills.${op}`,
		},
	});
	downstreamClients.set(key, client);
	return client;
}

function toHttpFailureMode(
	client: downstream.DownstreamClient,
): DownstreamHttpFailureMode {
	return client.failureMode === downstream.FailClosed ? "required" : "optional";
}

function buildHeaders(
	config: ResolvedSkillsServiceConfig,
): Record<string, string> {
	return {
		...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
		"Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
		"Content-Type": "application/json",
		"X-Surface": config.surface,
		...(config.entityId ? { "X-Entity-ID": config.entityId } : {}),
	};
}

function normalizeScope(
	scope: string | number | undefined,
): string | undefined {
	switch (scope) {
		case "SKILL_SCOPE_GLOBAL":
		case "global":
		case 1:
			return "global";
		case "SKILL_SCOPE_WORKSPACE":
		case "workspace":
		case 2:
			return "workspace";
		case "SKILL_SCOPE_PERSONAL":
		case "personal":
		case 3:
			return "personal";
		default:
			return undefined;
	}
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
	const normalized = Array.isArray(tags)
		? tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)
		: [];
	return normalized.length > 0 ? normalized : undefined;
}

function toLoadedSkill(skill: SkillsServiceSkill): LoadedSkill | null {
	const id = trimString(skill.id);
	const name = trimString(skill.name);
	const content = trimString(skill.content);
	if (!id || !name || !content) {
		return null;
	}

	const scope = normalizeScope(skill.scope);
	const metadata: Record<string, string> = {
		skillServiceId: id,
		...(trimString(skill.workspaceId)
			? { workspaceId: trimString(skill.workspaceId)! }
			: {}),
		...(trimString(skill.ownerId)
			? { ownerId: trimString(skill.ownerId)! }
			: {}),
		...(typeof skill.currentVersion === "number" &&
		Number.isFinite(skill.currentVersion)
			? { currentVersion: String(Math.trunc(skill.currentVersion)) }
			: {}),
		...(scope ? { scope } : {}),
	};

	return {
		name,
		description: trimString(skill.description) ?? "Skill from skills service",
		content,
		metadata,
		tags: normalizeTags(skill.tags),
		sourcePath: `skills-service://${id}`,
		sourceType: "service",
		resources: [],
		resourceDirs: {},
	};
}

export async function loadSkillsFromService(
	config: ResolvedSkillsServiceConfig,
	options?: { signal?: AbortSignal },
): Promise<LoadedSkill[]> {
	const client = getDownstreamClient(config, "listSkills");
	return downstream.CallOp(
		client,
		"listSkills",
		async () => {
			const response = await fetchDownstream(
				`${config.baseUrl}${LIST_SKILLS_PATH}`,
				{
					method: "POST",
					headers: buildHeaders(config),
					signal: options?.signal,
					body: JSON.stringify({
						workspaceId: config.workspaceId,
						limit: normalizeLimit(config.limit),
						offset: 0,
					}),
				},
				{
					serviceName: "skills service",
					failureMode: toHttpFailureMode(client),
					timeoutMs: config.timeoutMs,
					maxAttempts: config.maxAttempts,
				},
			);
			if (!response.ok) {
				const text = await response.text();
				throw new Error(
					`skills service returned ${response.status}: ${
						text || response.statusText
					}`,
				);
			}

			const payload = (await response.json()) as ListSkillsResponse;
			return (payload.skills ?? [])
				.map(toLoadedSkill)
				.filter((skill): skill is LoadedSkill => skill !== null);
		},
		() => [],
	);
}

export function resetSkillsDownstreamForTests(): void {
	downstreamClients.clear();
}
