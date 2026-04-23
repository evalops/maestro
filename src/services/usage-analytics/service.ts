import { type SQL, sql } from "drizzle-orm";
import { type DbClient, getDb, isDatabaseConfigured } from "../../db/client.js";
import { usageMetrics } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";
import {
	createUsageAnalyticsReport,
	normalizeUsageMetricInput,
} from "./aggregation.js";
import type {
	UsageAnalyticsBucket,
	UsageAnalyticsQuery,
	UsageAnalyticsRecordResult,
	UsageMetricInput,
} from "./types.js";

const logger = createLogger("usage-analytics");

export class UsageAnalyticsUnavailableError extends Error {
	constructor() {
		super("Usage analytics database is not configured.");
		this.name = "UsageAnalyticsUnavailableError";
	}
}

function costUsdFromMicros(micros: number): number {
	return micros / 1_000_000;
}

function readNumber(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

function readString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	return typeof value === "string" ? value : "";
}

function readDateIso(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return new Date(value).toISOString();
	return new Date(0).toISOString();
}

function periodUnit(
	period: UsageAnalyticsQuery["period"],
): "day" | "week" | "month" {
	if (period === "weekly") return "week";
	if (period === "monthly") return "month";
	return "day";
}

function buildFilters(query: UsageAnalyticsQuery): SQL[] {
	const filters: SQL[] = [];
	if (query.workspaceId) {
		filters.push(sql`workspace_id = ${query.workspaceId}`);
	}
	if (query.agentId) {
		filters.push(sql`agent_id = ${query.agentId}`);
	}
	if (query.provider) {
		filters.push(sql`provider = ${query.provider}`);
	}
	if (query.model) {
		filters.push(sql`model = ${query.model}`);
	}
	if (query.from) {
		filters.push(sql`bucket_start >= ${query.from}`);
	}
	if (query.to) {
		filters.push(sql`bucket_start <= ${query.to}`);
	}
	return filters;
}

function queryFiltersForResponse(query: UsageAnalyticsQuery) {
	return {
		...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
		...(query.agentId ? { agentId: query.agentId } : {}),
		...(query.provider ? { provider: query.provider } : {}),
		...(query.model ? { model: query.model } : {}),
		...(query.from ? { from: query.from.toISOString() } : {}),
		...(query.to ? { to: query.to.toISOString() } : {}),
	};
}

export class UsageAnalyticsService {
	constructor(
		private readonly getDatabase: () => DbClient = getDb,
		private readonly databaseConfigured: () => boolean = isDatabaseConfigured,
	) {}

	async recordLlmCall(
		input: UsageMetricInput,
	): Promise<UsageAnalyticsRecordResult> {
		if (!this.databaseConfigured()) {
			return { recorded: false, reason: "database_unconfigured" };
		}

		const normalized = normalizeUsageMetricInput(input);
		const db = this.getDatabase();
		const now = new Date();

		try {
			await db
				.insert(usageMetrics)
				.values({
					workspaceId: normalized.workspaceId,
					agentId: normalized.agentId,
					lastSessionId: normalized.sessionId,
					provider: normalized.provider,
					model: normalized.model,
					bucketStart: normalized.bucketStart,
					callCount: normalized.callCount,
					inputTokens: normalized.inputTokens,
					outputTokens: normalized.outputTokens,
					cacheReadTokens: normalized.cacheReadTokens,
					cacheWriteTokens: normalized.cacheWriteTokens,
					totalTokens: normalized.totalTokens,
					costUsdMicros: normalized.costUsdMicros,
					firstSeenAt: normalized.occurredAt,
					lastSeenAt: normalized.occurredAt,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [
						usageMetrics.workspaceId,
						usageMetrics.agentId,
						usageMetrics.provider,
						usageMetrics.model,
						usageMetrics.bucketStart,
					],
					set: {
						lastSessionId:
							normalized.sessionId ?? sql`${usageMetrics.lastSessionId}`,
						callCount: sql`${usageMetrics.callCount} + 1`,
						inputTokens: sql`${usageMetrics.inputTokens} + ${normalized.inputTokens}`,
						outputTokens: sql`${usageMetrics.outputTokens} + ${normalized.outputTokens}`,
						cacheReadTokens: sql`${usageMetrics.cacheReadTokens} + ${normalized.cacheReadTokens}`,
						cacheWriteTokens: sql`${usageMetrics.cacheWriteTokens} + ${normalized.cacheWriteTokens}`,
						totalTokens: sql`${usageMetrics.totalTokens} + ${normalized.totalTokens}`,
						costUsdMicros: sql`${usageMetrics.costUsdMicros} + ${normalized.costUsdMicros}`,
						firstSeenAt: sql`LEAST(${usageMetrics.firstSeenAt}, ${normalized.occurredAt})`,
						lastSeenAt: sql`GREATEST(${usageMetrics.lastSeenAt}, ${normalized.occurredAt})`,
						updatedAt: now,
					},
				});
			return { recorded: true };
		} catch (error) {
			logger.warn("Failed to record usage analytics", {
				error: error instanceof Error ? error.message : String(error),
				workspaceId: normalized.workspaceId,
				agentId: normalized.agentId,
				provider: normalized.provider,
				model: normalized.model,
			});
			throw error;
		}
	}

	async queryUsage(query: UsageAnalyticsQuery) {
		if (!this.databaseConfigured()) {
			throw new UsageAnalyticsUnavailableError();
		}

		const filters = buildFilters(query);
		const where =
			filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
		const unit = periodUnit(query.period);
		const db = this.getDatabase();
		const result = await db.execute(sql`
			SELECT
				date_trunc(${unit}, bucket_start) AS bucket_start,
				workspace_id,
				agent_id,
				provider,
				model,
				COALESCE(SUM(call_count), 0) AS calls,
				COALESCE(SUM(input_tokens), 0) AS input_tokens,
				COALESCE(SUM(output_tokens), 0) AS output_tokens,
				COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
				COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
				COALESCE(SUM(total_tokens), 0) AS total_tokens,
				COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros
			FROM usage_metrics
			${where}
			GROUP BY 1, workspace_id, agent_id, provider, model
			ORDER BY 1 ASC, workspace_id ASC, agent_id ASC, provider ASC, model ASC
		`);

		const buckets: UsageAnalyticsBucket[] = (
			Array.from(result) as Array<Record<string, unknown>>
		).map((row) => {
			const costUsdMicros = readNumber(row, "cost_usd_micros");
			return {
				bucketStart: readDateIso(row, "bucket_start"),
				workspaceId: readString(row, "workspace_id"),
				agentId: readString(row, "agent_id"),
				provider: readString(row, "provider"),
				model: readString(row, "model"),
				calls: readNumber(row, "calls"),
				tokens: {
					input: readNumber(row, "input_tokens"),
					output: readNumber(row, "output_tokens"),
					cacheRead: readNumber(row, "cache_read_tokens"),
					cacheWrite: readNumber(row, "cache_write_tokens"),
					total: readNumber(row, "total_tokens"),
				},
				costUsd: costUsdFromMicros(costUsdMicros),
			};
		});

		return createUsageAnalyticsReport({
			period: query.period,
			filters: queryFiltersForResponse(query),
			buckets,
		});
	}
}

let defaultUsageAnalyticsService: UsageAnalyticsService | null = null;

export function getUsageAnalyticsService(): UsageAnalyticsService {
	defaultUsageAnalyticsService ??= new UsageAnalyticsService();
	return defaultUsageAnalyticsService;
}

export function setUsageAnalyticsServiceForTest(
	service: UsageAnalyticsService | null,
): void {
	defaultUsageAnalyticsService = service;
}
