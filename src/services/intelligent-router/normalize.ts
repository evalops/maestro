import {
	type ModelPerformanceMetricInput,
	ROUTING_STRATEGIES,
	type RoutingModelCandidate,
	type RoutingOverrideInput,
	type RoutingRequest,
	type RoutingRequestInput,
	type RoutingStrategy,
} from "./types.js";

export class IntelligentRouterValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IntelligentRouterValidationError";
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
		throw new IntelligentRouterValidationError(`${label} is required.`);
	}
	return trimmed;
}

function parseFiniteNumber(value: unknown, label: string): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		throw new IntelligentRouterValidationError(`${label} must be a number.`);
	}
	return parsed;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	throw new IntelligentRouterValidationError("success must be a boolean.");
}

function parseOptionalDate(value: unknown, label: string): Date | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = value instanceof Date ? value : new Date(String(value));
	if (Number.isNaN(parsed.getTime())) {
		throw new IntelligentRouterValidationError(
			`${label} must be a valid date.`,
		);
	}
	return parsed;
}

export function parseRoutingStrategy(value: unknown): RoutingStrategy {
	const normalized = cleanOptionalString(value)?.toLowerCase() ?? "balanced";
	if (ROUTING_STRATEGIES.includes(normalized as RoutingStrategy)) {
		return normalized as RoutingStrategy;
	}
	throw new IntelligentRouterValidationError(
		"Invalid routing strategy. Use balanced, quality, cost, or latency.",
	);
}

function normalizeUnavailableModels(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}
	if (!Array.isArray(value)) {
		throw new IntelligentRouterValidationError(
			"unavailableModels must be an array or comma-separated string.",
		);
	}
	return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function normalizeAvailableModels(value: unknown): RoutingModelCandidate[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw new IntelligentRouterValidationError(
			"availableModels must be an array.",
		);
	}
	return value.filter(isRecord).map((entry) => {
		const provider = cleanRequiredString(entry.provider, "provider");
		const model = cleanRequiredString(entry.model, "model");
		const name = cleanOptionalString(entry.name);
		const available =
			typeof entry.available === "boolean" ? entry.available : undefined;
		const cost = (() => {
			if (!isRecord(entry.cost)) return undefined;
			const input = parseFiniteNumber(entry.cost.input, "cost.input");
			const output = parseFiniteNumber(entry.cost.output, "cost.output");
			const cacheRead = parseFiniteNumber(
				entry.cost.cacheRead,
				"cost.cacheRead",
			);
			const cacheWrite = parseFiniteNumber(
				entry.cost.cacheWrite,
				"cost.cacheWrite",
			);
			return {
				...(input !== undefined ? { input } : {}),
				...(output !== undefined ? { output } : {}),
				...(cacheRead !== undefined ? { cacheRead } : {}),
				...(cacheWrite !== undefined ? { cacheWrite } : {}),
			};
		})();
		return {
			provider,
			model,
			...(name ? { name } : {}),
			...(cost && Object.keys(cost).length > 0 ? { cost } : {}),
			...(available !== undefined ? { available } : {}),
		};
	});
}

export function normalizeRoutingRequest(
	input: RoutingRequestInput,
	defaultAvailableModels: RoutingModelCandidate[],
): RoutingRequest {
	if (!isRecord(input)) {
		throw new IntelligentRouterValidationError(
			"Routing request must be an object.",
		);
	}
	const requestInput = input as RoutingRequestInput;
	const taskType = cleanOptionalString(requestInput.taskType) ?? "chat";
	const modelHint =
		cleanOptionalString(requestInput.modelHint) ??
		cleanOptionalString(requestInput.model_hint);
	const unavailableModels = normalizeUnavailableModels(
		requestInput.unavailableModels ?? requestInput.unavailable_models,
	);
	const availableModels = normalizeAvailableModels(
		requestInput.availableModels,
	);
	return {
		taskType,
		strategy: parseRoutingStrategy(requestInput.strategy),
		unavailableModels,
		availableModels:
			availableModels.length > 0 ? availableModels : defaultAvailableModels,
		...(modelHint ? { modelHint } : {}),
	};
}

export function normalizePerformanceMetricInput(
	input: ModelPerformanceMetricInput,
): Required<ModelPerformanceMetricInput> {
	if (!isRecord(input)) {
		throw new IntelligentRouterValidationError("Metric must be an object.");
	}
	const metricInput = input as ModelPerformanceMetricInput;
	const latencyMs = parseFiniteNumber(metricInput.latencyMs, "latencyMs") ?? 0;
	const costUsd = parseFiniteNumber(metricInput.costUsd, "costUsd") ?? 0;
	const qualityScore =
		parseFiniteNumber(metricInput.qualityScore, "qualityScore") ?? 0.5;
	if (latencyMs < 0) {
		throw new IntelligentRouterValidationError("latencyMs cannot be negative.");
	}
	if (costUsd < 0) {
		throw new IntelligentRouterValidationError("costUsd cannot be negative.");
	}
	return {
		taskType: cleanRequiredString(metricInput.taskType, "taskType"),
		provider: cleanRequiredString(metricInput.provider, "provider"),
		model: cleanRequiredString(metricInput.model, "model"),
		latencyMs,
		success: parseOptionalBoolean(metricInput.success) ?? true,
		costUsd,
		qualityScore: Math.max(0, Math.min(1, qualityScore)),
		occurredAt:
			parseOptionalDate(metricInput.occurredAt, "occurredAt") ?? new Date(),
	};
}

export function normalizeRoutingOverrideInput(
	input: RoutingOverrideInput,
): RoutingOverrideInput {
	if (!isRecord(input)) {
		throw new IntelligentRouterValidationError("Override must be an object.");
	}
	const overrideInput = input as RoutingOverrideInput;
	const reason = cleanOptionalString(overrideInput.reason);
	const expiresAt = parseOptionalDate(overrideInput.expiresAt, "expiresAt");
	return {
		taskType: cleanRequiredString(overrideInput.taskType, "taskType"),
		provider: cleanRequiredString(overrideInput.provider, "provider"),
		model: cleanRequiredString(overrideInput.model, "model"),
		...(reason ? { reason } : {}),
		...(expiresAt ? { expiresAt } : {}),
	};
}
