import {
	type NormalizedUsageMetric,
	USAGE_ANALYTICS_PERIODS,
	type UsageAnalyticsBucket,
	type UsageAnalyticsPeriod,
	type UsageAnalyticsReport,
	type UsageAnalyticsTotals,
	type UsageMetricInput,
} from "./types.js";

export class UsageAnalyticsValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageAnalyticsValidationError";
	}
}

export function isUsageAnalyticsPeriod(
	value: string,
): value is UsageAnalyticsPeriod {
	return USAGE_ANALYTICS_PERIODS.includes(value as UsageAnalyticsPeriod);
}

export function parseUsageAnalyticsPeriod(
	value: string | null | undefined,
): UsageAnalyticsPeriod {
	const normalized = value?.trim().toLowerCase() || "daily";
	if (isUsageAnalyticsPeriod(normalized)) {
		return normalized;
	}
	throw new UsageAnalyticsValidationError(
		"Invalid usage analytics period. Use daily, weekly, or monthly.",
	);
}

export function parseOptionalDate(
	value: string | null | undefined,
	label: string,
): Date | undefined {
	if (!value) return undefined;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new UsageAnalyticsValidationError(`Invalid ${label} date.`);
	}
	return parsed;
}

export function startOfDay(date: Date): Date {
	return new Date(
		Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth(),
			date.getUTCDate(),
			0,
			0,
			0,
			0,
		),
	);
}

function startOfWeek(date: Date): Date {
	const dayStart = startOfDay(date);
	const day = dayStart.getUTCDay();
	const daysSinceMonday = (day + 6) % 7;
	dayStart.setUTCDate(dayStart.getUTCDate() - daysSinceMonday);
	return dayStart;
}

function startOfMonth(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function bucketStartForPeriod(
	date: Date,
	period: UsageAnalyticsPeriod,
): Date {
	if (period === "weekly") return startOfWeek(date);
	if (period === "monthly") return startOfMonth(date);
	return startOfDay(date);
}

function cleanRequiredString(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new UsageAnalyticsValidationError(`${label} is required.`);
	}
	return trimmed;
}

function cleanOptionalString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function nonNegativeInteger(value: number | undefined): number {
	if (value === undefined) return 0;
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

export function normalizeUsageMetricInput(
	input: UsageMetricInput,
): NormalizedUsageMetric {
	const occurredAt = input.occurredAt ?? new Date();
	if (Number.isNaN(occurredAt.getTime())) {
		throw new UsageAnalyticsValidationError("occurredAt must be a valid date.");
	}

	const inputTokens = nonNegativeInteger(input.inputTokens);
	const outputTokens = nonNegativeInteger(input.outputTokens);
	const cacheReadTokens = nonNegativeInteger(input.cacheReadTokens);
	const cacheWriteTokens = nonNegativeInteger(input.cacheWriteTokens);
	const totalTokens = inputTokens + outputTokens;
	const costUsd = input.costUsd;
	const costUsdMicros =
		costUsd && Number.isFinite(costUsd) && costUsd > 0
			? Math.round(costUsd * 1_000_000)
			: 0;

	return {
		workspaceId: cleanRequiredString(input.workspaceId, "workspaceId"),
		agentId: cleanRequiredString(input.agentId, "agentId"),
		sessionId: cleanOptionalString(input.sessionId),
		provider: cleanRequiredString(input.provider, "provider"),
		model: cleanRequiredString(input.model, "model"),
		bucketStart: startOfDay(occurredAt),
		occurredAt,
		callCount: 1,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		costUsdMicros,
	};
}

export function emptyUsageTotals(): UsageAnalyticsTotals {
	return {
		calls: 0,
		tokens: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
		costUsd: 0,
	};
}

export function summarizeUsageBuckets(
	buckets: UsageAnalyticsBucket[],
): UsageAnalyticsTotals {
	const totals = emptyUsageTotals();
	for (const bucket of buckets) {
		totals.calls += bucket.calls;
		totals.tokens.input += bucket.tokens.input;
		totals.tokens.output += bucket.tokens.output;
		totals.tokens.cacheRead += bucket.tokens.cacheRead;
		totals.tokens.cacheWrite += bucket.tokens.cacheWrite;
		totals.tokens.total += bucket.tokens.total;
		totals.costUsd += bucket.costUsd;
	}
	return totals;
}

export function createUsageAnalyticsReport(params: {
	period: UsageAnalyticsPeriod;
	filters: UsageAnalyticsReport["filters"];
	buckets: UsageAnalyticsBucket[];
}): UsageAnalyticsReport {
	return {
		period: params.period,
		filters: params.filters,
		totals: summarizeUsageBuckets(params.buckets),
		buckets: params.buckets,
	};
}
