import type {
	WorkspaceConfig,
	WorkspaceConfigInput,
	WorkspaceConfigListQuery,
	WorkspaceConfigPatchInput,
	WorkspaceModelPreferences,
	WorkspaceRateLimits,
	WorkspaceSafetyRules,
} from "./types.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

export class WorkspaceConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceConfigValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanRequiredString(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new WorkspaceConfigValidationError(`${label} is required.`);
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new WorkspaceConfigValidationError(`${label} is required.`);
	}
	return trimmed;
}

export function normalizeWorkspaceConfigId(
	workspaceId: unknown,
	label = "workspaceId",
): string {
	return cleanRequiredString(workspaceId, label);
}

function cleanOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function cleanStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(
			value
				.map((entry) => cleanOptionalString(entry))
				.filter((entry): entry is string => Boolean(entry)),
		),
	);
}

function cleanOptionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function cleanOptionalPositiveInteger(
	value: unknown,
	label: string,
): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new WorkspaceConfigValidationError(
			`${label} must be a finite number.`,
		);
	}
	if (value < 1) {
		throw new WorkspaceConfigValidationError(
			`${label} must be a positive integer.`,
		);
	}
	return Math.floor(value);
}

export function normalizeModelPreferences(
	value: unknown,
): WorkspaceModelPreferences {
	const input = isRecord(value) ? value : {};
	const defaultModel = cleanOptionalString(input.defaultModel);
	const preferredProvider = cleanOptionalString(input.preferredProvider);
	return {
		allowedModels: cleanStringList(input.allowedModels),
		blockedModels: cleanStringList(input.blockedModels),
		...(defaultModel ? { defaultModel } : {}),
		...(preferredProvider ? { preferredProvider } : {}),
	};
}

export function normalizeSafetyRules(value: unknown): WorkspaceSafetyRules {
	const input = isRecord(value) ? value : {};
	const requireApprovals = cleanOptionalBoolean(input.requireApprovals);
	const maxTokensPerSession = cleanOptionalPositiveInteger(
		input.maxTokensPerSession,
		"safetyRules.maxTokensPerSession",
	);
	return {
		allowedTools: cleanStringList(input.allowedTools),
		blockedTools: cleanStringList(input.blockedTools),
		requiredSkills: cleanStringList(input.requiredSkills),
		fileBoundaries: cleanStringList(input.fileBoundaries),
		...(requireApprovals !== undefined ? { requireApprovals } : {}),
		...(maxTokensPerSession ? { maxTokensPerSession } : {}),
	};
}

export function normalizeRateLimits(value: unknown): WorkspaceRateLimits {
	const input = isRecord(value) ? value : {};
	const requestsPerMinute = cleanOptionalPositiveInteger(
		input.requestsPerMinute,
		"rateLimits.requestsPerMinute",
	);
	const tokensPerMinute = cleanOptionalPositiveInteger(
		input.tokensPerMinute,
		"rateLimits.tokensPerMinute",
	);
	const maxConcurrentSessions = cleanOptionalPositiveInteger(
		input.maxConcurrentSessions,
		"rateLimits.maxConcurrentSessions",
	);
	const maxTokensPerSession = cleanOptionalPositiveInteger(
		input.maxTokensPerSession,
		"rateLimits.maxTokensPerSession",
	);
	return {
		...(requestsPerMinute ? { requestsPerMinute } : {}),
		...(tokensPerMinute ? { tokensPerMinute } : {}),
		...(maxConcurrentSessions ? { maxConcurrentSessions } : {}),
		...(maxTokensPerSession ? { maxTokensPerSession } : {}),
	};
}

export function normalizeWorkspaceConfigInput(
	input: WorkspaceConfigInput,
	now = new Date(),
): WorkspaceConfig {
	if (!isRecord(input)) {
		throw new WorkspaceConfigValidationError(
			"Workspace config must be an object.",
		);
	}
	return {
		workspaceId: cleanRequiredString(input.workspaceId, "workspaceId"),
		modelPreferences: normalizeModelPreferences(input.modelPreferences),
		safetyRules: normalizeSafetyRules(input.safetyRules),
		rateLimits: normalizeRateLimits(input.rateLimits),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	};
}

export function normalizeWorkspaceConfigPatchInput(
	workspaceId: string,
	input: WorkspaceConfigPatchInput,
	existing: WorkspaceConfig | null,
	now = new Date(),
): WorkspaceConfig {
	if (!isRecord(input)) {
		throw new WorkspaceConfigValidationError(
			"Workspace config must be an object.",
		);
	}
	return {
		workspaceId: cleanRequiredString(workspaceId, "workspaceId"),
		modelPreferences: normalizeModelPreferences({
			...(existing?.modelPreferences ?? {}),
			...(isRecord(input.modelPreferences) ? input.modelPreferences : {}),
		}),
		safetyRules: normalizeSafetyRules({
			...(existing?.safetyRules ?? {}),
			...(isRecord(input.safetyRules) ? input.safetyRules : {}),
		}),
		rateLimits: normalizeRateLimits({
			...(existing?.rateLimits ?? {}),
			...(isRecord(input.rateLimits) ? input.rateLimits : {}),
		}),
		createdAt: existing?.createdAt ?? now.toISOString(),
		updatedAt: now.toISOString(),
	};
}

export function parseWorkspaceConfigLimit(value: string | null): number {
	if (!value) return DEFAULT_LIST_LIMIT;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new WorkspaceConfigValidationError(
			"limit must be a positive integer.",
		);
	}
	return Math.min(parsed, MAX_LIST_LIMIT);
}

export function parseWorkspaceConfigOffset(value: string | null): number {
	if (!value) return 0;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new WorkspaceConfigValidationError(
			"offset must be a non-negative integer.",
		);
	}
	return parsed;
}

export function normalizeWorkspaceConfigListQuery(params: {
	limit?: string | null;
	offset?: string | null;
}): WorkspaceConfigListQuery {
	return {
		limit: parseWorkspaceConfigLimit(params.limit ?? null),
		offset: parseWorkspaceConfigOffset(params.offset ?? null),
	};
}
