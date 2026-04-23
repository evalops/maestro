import {
	ATTRIBUTION_MODELS,
	type AttributionJsonValue,
	type AttributionModel,
	type NormalizedRevenueOutcome,
	type RevenueAttributionRoiQuery,
	type RevenueOutcomeInput,
} from "./types.js";

export class RevenueAttributionValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RevenueAttributionValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function cleanRequiredString(value: unknown, label: string): string {
	const trimmed = cleanOptionalString(value);
	if (!trimmed) {
		throw new RevenueAttributionValidationError(`${label} is required.`);
	}
	return trimmed;
}

function parseDate(value: unknown, label: string): Date | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = value instanceof Date ? value : new Date(String(value));
	if (Number.isNaN(parsed.getTime())) {
		throw new RevenueAttributionValidationError(
			`${label} must be a valid date.`,
		);
	}
	return parsed;
}

function parseNumber(value: unknown, label: string): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		throw new RevenueAttributionValidationError(`${label} must be a number.`);
	}
	return parsed;
}

function nonNegativeNumber(value: unknown, label: string): number {
	const parsed = parseNumber(value, label) ?? 0;
	if (parsed < 0) {
		throw new RevenueAttributionValidationError(`${label} cannot be negative.`);
	}
	return parsed;
}

function toUsdMicros(value: unknown, label: string): number {
	return Math.round(nonNegativeNumber(value, label) * 1_000_000);
}

function parseDurationMs(value: unknown): number {
	return Math.floor(nonNegativeNumber(value, "durationMs"));
}

function parseAttributionModel(value: unknown): AttributionModel {
	const normalized = cleanOptionalString(value)?.toLowerCase() ?? "direct";
	if (ATTRIBUTION_MODELS.includes(normalized as AttributionModel)) {
		return normalized as AttributionModel;
	}
	throw new RevenueAttributionValidationError(
		"Invalid attributionModel. Use direct, assisted, influenced, or custom.",
	);
}

function parseAttributionWeightBps(input: RevenueOutcomeInput): number {
	const explicitBps = parseNumber(
		input.attributionWeightBps,
		"attributionWeightBps",
	);
	if (explicitBps !== undefined) {
		if (explicitBps < 0 || explicitBps > 10000) {
			throw new RevenueAttributionValidationError(
				"attributionWeightBps must be between 0 and 10000.",
			);
		}
		return Math.round(explicitBps);
	}
	const weight = parseNumber(input.attributionWeight, "attributionWeight");
	if (weight === undefined) return 10000;
	if (weight < 0 || weight > 1) {
		throw new RevenueAttributionValidationError(
			"attributionWeight must be between 0 and 1.",
		);
	}
	return Math.round(weight * 10000);
}

function sanitizeJsonValue(
	value: unknown,
	depth = 0,
): AttributionJsonValue | undefined {
	if (depth > 12) return String(value);
	if (value === null) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		return value
			.map((item) => sanitizeJsonValue(item, depth + 1))
			.filter((item): item is AttributionJsonValue => item !== undefined);
	}
	if (isRecord(value)) {
		const result: Record<string, AttributionJsonValue> = {};
		for (const [key, nestedValue] of Object.entries(value)) {
			const sanitized = sanitizeJsonValue(nestedValue, depth + 1);
			if (sanitized !== undefined) {
				result[key] = sanitized;
			}
		}
		return result;
	}
	return undefined;
}

function sanitizeMetadata(
	value: Record<string, unknown> | undefined,
): Record<string, AttributionJsonValue> {
	if (!value) return {};
	const sanitized = sanitizeJsonValue(value);
	return isRecord(sanitized)
		? (sanitized as Record<string, AttributionJsonValue>)
		: {};
}

export function normalizeRevenueOutcomeInput(
	input: RevenueOutcomeInput,
): NormalizedRevenueOutcome {
	if (!isRecord(input)) {
		throw new RevenueAttributionValidationError("Outcome must be an object.");
	}
	const outcomeInput = input as RevenueOutcomeInput;
	const actionId = cleanOptionalString(outcomeInput.actionId);
	const traceId = cleanOptionalString(outcomeInput.traceId);
	return {
		workspaceId: cleanRequiredString(outcomeInput.workspaceId, "workspaceId"),
		agentId: cleanRequiredString(outcomeInput.agentId, "agentId"),
		outcomeId: cleanRequiredString(outcomeInput.outcomeId, "outcomeId"),
		outcomeType: cleanRequiredString(
			outcomeInput.outcomeType,
			"outcomeType",
		).toLowerCase(),
		attributionModel: parseAttributionModel(outcomeInput.attributionModel),
		attributionWeightBps: parseAttributionWeightBps(outcomeInput),
		revenueUsdMicros: toUsdMicros(outcomeInput.revenueUsd, "revenueUsd"),
		pipelineValueUsdMicros: toUsdMicros(
			outcomeInput.pipelineValueUsd,
			"pipelineValueUsd",
		),
		costUsdMicros: toUsdMicros(outcomeInput.costUsd, "costUsd"),
		durationMs: parseDurationMs(outcomeInput.durationMs),
		occurredAt: parseDate(outcomeInput.occurredAt, "occurredAt") ?? new Date(),
		metadata: sanitizeMetadata(outcomeInput.metadata),
		...(actionId ? { actionId } : {}),
		...(traceId ? { traceId } : {}),
	};
}

export function normalizeRevenueAttributionRoiQuery(input: {
	agentId?: unknown;
	workspaceId?: unknown;
	from?: unknown;
	to?: unknown;
}): RevenueAttributionRoiQuery {
	const from = parseDate(input.from, "from");
	const to = parseDate(input.to, "to");
	if (from && to && from.getTime() > to.getTime()) {
		throw new RevenueAttributionValidationError(
			"from must be before or equal to to.",
		);
	}
	const workspaceId = cleanOptionalString(input.workspaceId);
	return {
		agentId: cleanRequiredString(input.agentId, "agentId"),
		...(workspaceId ? { workspaceId } : {}),
		...(from ? { from } : {}),
		...(to ? { to } : {}),
	};
}

export function usdFromMicros(micros: number): number {
	return micros / 1_000_000;
}
