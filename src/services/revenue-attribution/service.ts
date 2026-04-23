import { randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import { type DbClient, getDb, isDatabaseConfigured } from "../../db/client.js";
import { revenueAttribution } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";
import {
	normalizeRevenueAttributionRoiQuery,
	normalizeRevenueOutcomeInput,
	usdFromMicros,
} from "./normalize.js";
import type {
	AttributionModel,
	RevenueAttributionOutcomeSummary,
	RevenueAttributionRecord,
	RevenueAttributionRoiQuery,
	RevenueAttributionRoiReport,
	RevenueOutcomeInput,
} from "./types.js";

const logger = createLogger("revenue-attribution");

type RevenueAttributionRow = typeof revenueAttribution.$inferSelect;

export class RevenueAttributionUnavailableError extends Error {
	constructor() {
		super("Revenue attribution database is not configured.");
		this.name = "RevenueAttributionUnavailableError";
	}
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

function dateIso(value: Date | string): string {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString();
}

function parseAttributionModel(value: string): AttributionModel {
	if (
		value === "direct" ||
		value === "assisted" ||
		value === "influenced" ||
		value === "custom"
	) {
		return value;
	}
	return "custom";
}

function recordFromRow(row: RevenueAttributionRow): RevenueAttributionRecord {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		agentId: row.agentId,
		outcomeId: row.outcomeId,
		outcomeType: row.outcomeType,
		attributionModel: parseAttributionModel(row.attributionModel),
		attributionWeightBps: row.attributionWeightBps,
		revenueUsd: usdFromMicros(row.revenueUsdMicros),
		pipelineValueUsd: usdFromMicros(row.pipelineValueUsdMicros),
		costUsd: usdFromMicros(row.costUsdMicros),
		durationMs: row.durationMs,
		occurredAt: dateIso(row.occurredAt),
		createdAt: dateIso(row.createdAt),
		updatedAt: dateIso(row.updatedAt),
		metadata:
			row.metadata &&
			typeof row.metadata === "object" &&
			!Array.isArray(row.metadata)
				? (row.metadata as RevenueAttributionRecord["metadata"])
				: {},
		...(row.actionId ? { actionId: row.actionId } : {}),
		...(row.traceId ? { traceId: row.traceId } : {}),
	};
}

function buildFilters(query: RevenueAttributionRoiQuery): SQL[] {
	const filters: SQL[] = [sql`agent_id = ${query.agentId}`];
	if (query.workspaceId) {
		filters.push(sql`workspace_id = ${query.workspaceId}`);
	}
	if (query.from) {
		filters.push(sql`occurred_at >= ${query.from}`);
	}
	if (query.to) {
		filters.push(sql`occurred_at <= ${query.to}`);
	}
	return filters;
}

function periodForReport(query: RevenueAttributionRoiQuery) {
	return {
		...(query.from ? { from: query.from.toISOString() } : {}),
		...(query.to ? { to: query.to.toISOString() } : {}),
	};
}

function roiValue(revenueUsd: number, costUsd: number): number | null {
	return costUsd > 0 ? revenueUsd / costUsd : null;
}

function costPerOutcome(costUsd: number, outcomeCount: number): number | null {
	return outcomeCount > 0 ? costUsd / outcomeCount : null;
}

export function createRevenueAttributionRoiReport(params: {
	query: RevenueAttributionRoiQuery;
	totalsRow?: Record<string, unknown>;
	outcomeRows?: Array<Record<string, unknown>>;
}): RevenueAttributionRoiReport {
	const totals = params.totalsRow ?? {};
	const revenueUsd = usdFromMicros(readNumber(totals, "revenue_usd_micros"));
	const pipelineValueUsd = usdFromMicros(
		readNumber(totals, "pipeline_value_usd_micros"),
	);
	const costUsd = usdFromMicros(readNumber(totals, "cost_usd_micros"));
	const outcomeCount = readNumber(totals, "outcome_count");
	const byOutcomeType: RevenueAttributionOutcomeSummary[] = (
		params.outcomeRows ?? []
	).map((row) => ({
		outcomeType: readString(row, "outcome_type"),
		outcomeCount: readNumber(row, "outcome_count"),
		revenueUsd: usdFromMicros(readNumber(row, "revenue_usd_micros")),
		pipelineValueUsd: usdFromMicros(
			readNumber(row, "pipeline_value_usd_micros"),
		),
		costUsd: usdFromMicros(readNumber(row, "cost_usd_micros")),
	}));
	return {
		agentId: params.query.agentId,
		period: periodForReport(params.query),
		attribution: {
			outcomeCount,
			actionCount: readNumber(totals, "action_count"),
			traceCount: readNumber(totals, "trace_count"),
			revenueUsd,
			pipelineValueUsd,
		},
		cost: {
			costUsd,
			totalDurationMs: readNumber(totals, "duration_ms"),
		},
		roi: {
			revenuePerDollarSpent: roiValue(revenueUsd, costUsd),
			netRevenueUsd: revenueUsd - costUsd,
			costPerOutcome: costPerOutcome(costUsd, outcomeCount),
		},
		byOutcomeType,
		...(params.query.workspaceId
			? { workspaceId: params.query.workspaceId }
			: {}),
	};
}

export class RevenueAttributionService {
	constructor(
		private readonly getDatabase: () => DbClient = getDb,
		private readonly databaseConfigured: () => boolean = isDatabaseConfigured,
	) {}

	private requireDatabase(): DbClient {
		if (!this.databaseConfigured()) {
			throw new RevenueAttributionUnavailableError();
		}
		return this.getDatabase();
	}

	async recordOutcome(
		input: RevenueOutcomeInput,
	): Promise<RevenueAttributionRecord> {
		const outcome = normalizeRevenueOutcomeInput(input);
		const db = this.requireDatabase();
		const now = new Date();

		try {
			const [row] = await db
				.insert(revenueAttribution)
				.values({
					workspaceId: outcome.workspaceId,
					agentId: outcome.agentId,
					actionId: outcome.actionId,
					traceId: outcome.traceId,
					outcomeId: outcome.outcomeId,
					outcomeType: outcome.outcomeType,
					attributionModel: outcome.attributionModel,
					attributionWeightBps: outcome.attributionWeightBps,
					revenueUsdMicros: outcome.revenueUsdMicros,
					pipelineValueUsdMicros: outcome.pipelineValueUsdMicros,
					costUsdMicros: outcome.costUsdMicros,
					durationMs: outcome.durationMs,
					metadata: outcome.metadata,
					occurredAt: outcome.occurredAt,
					createdAt: now,
					updatedAt: now,
				})
				.returning();

			return row
				? recordFromRow(row)
				: {
						id: randomUUID(),
						workspaceId: outcome.workspaceId,
						agentId: outcome.agentId,
						outcomeId: outcome.outcomeId,
						outcomeType: outcome.outcomeType,
						attributionModel: outcome.attributionModel,
						attributionWeightBps: outcome.attributionWeightBps,
						revenueUsd: usdFromMicros(outcome.revenueUsdMicros),
						pipelineValueUsd: usdFromMicros(outcome.pipelineValueUsdMicros),
						costUsd: usdFromMicros(outcome.costUsdMicros),
						durationMs: outcome.durationMs,
						occurredAt: outcome.occurredAt.toISOString(),
						createdAt: now.toISOString(),
						updatedAt: now.toISOString(),
						metadata: outcome.metadata,
						...(outcome.actionId ? { actionId: outcome.actionId } : {}),
						...(outcome.traceId ? { traceId: outcome.traceId } : {}),
					};
		} catch (error) {
			logger.warn("Failed to record revenue attribution outcome", {
				error: error instanceof Error ? error.message : String(error),
				workspaceId: outcome.workspaceId,
				agentId: outcome.agentId,
				outcomeId: outcome.outcomeId,
			});
			throw error;
		}
	}

	async queryRoi(
		input: RevenueAttributionRoiQuery,
	): Promise<RevenueAttributionRoiReport> {
		const query = normalizeRevenueAttributionRoiQuery(input);
		const db = this.requireDatabase();
		const filters = buildFilters(query);
		const where = sql`WHERE ${sql.join(filters, sql` AND `)}`;

		const totalsResult = await db.execute(sql`
			SELECT
				COUNT(*) AS outcome_count,
				COUNT(DISTINCT action_id) FILTER (WHERE action_id IS NOT NULL) AS action_count,
				COUNT(DISTINCT trace_id) FILTER (WHERE trace_id IS NOT NULL) AS trace_count,
				COALESCE(SUM((revenue_usd_micros * attribution_weight_bps) / 10000), 0) AS revenue_usd_micros,
				COALESCE(SUM((pipeline_value_usd_micros * attribution_weight_bps) / 10000), 0) AS pipeline_value_usd_micros,
				COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros,
				COALESCE(SUM(duration_ms), 0) AS duration_ms
			FROM revenue_attribution
			${where}
		`);
		const outcomeResult = await db.execute(sql`
			SELECT
				outcome_type,
				COUNT(*) AS outcome_count,
				COALESCE(SUM((revenue_usd_micros * attribution_weight_bps) / 10000), 0) AS revenue_usd_micros,
				COALESCE(SUM((pipeline_value_usd_micros * attribution_weight_bps) / 10000), 0) AS pipeline_value_usd_micros,
				COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros
			FROM revenue_attribution
			${where}
			GROUP BY outcome_type
			ORDER BY revenue_usd_micros DESC, outcome_type ASC
		`);

		const [totalsRow] = Array.from(totalsResult) as Array<
			Record<string, unknown>
		>;
		const outcomeRows = Array.from(outcomeResult) as Array<
			Record<string, unknown>
		>;
		return createRevenueAttributionRoiReport({
			query,
			totalsRow,
			outcomeRows,
		});
	}
}

let defaultRevenueAttributionService: RevenueAttributionService | null = null;

export function getRevenueAttributionService(): RevenueAttributionService {
	defaultRevenueAttributionService ??= new RevenueAttributionService();
	return defaultRevenueAttributionService;
}

export function setRevenueAttributionServiceForTest(
	service: RevenueAttributionService | null,
): void {
	defaultRevenueAttributionService = service;
}
