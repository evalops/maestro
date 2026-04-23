import { type SQL, eq, sql } from "drizzle-orm";
import { type DbClient, getDb, isDatabaseConfigured } from "../../db/client.js";
import { executionTraces } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";
import {
	countTraceSpans,
	normalizeExecutionTraceInput,
	parseTraceStatus,
} from "./normalize.js";
import type {
	ExecutionTrace,
	ExecutionTraceInput,
	ExecutionTraceSpan,
	ExecutionTraceSummary,
	TraceListQuery,
	TraceListResult,
} from "./types.js";

const logger = createLogger("traces");

type ExecutionTraceRow = typeof executionTraces.$inferSelect;

export class TracesUnavailableError extends Error {
	constructor() {
		super("Traces database is not configured.");
		this.name = "TracesUnavailableError";
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

function readDateIso(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return new Date(value).toISOString();
	return new Date(0).toISOString();
}

function normalizeStoredSpans(spans: unknown): ExecutionTraceSpan[] {
	if (!Array.isArray(spans)) return [];
	return spans as ExecutionTraceSpan[];
}

function traceFromRow(row: ExecutionTraceRow): ExecutionTrace {
	return {
		traceId: row.traceId,
		workspaceId: row.workspaceId,
		agentId: row.agentId,
		spans: normalizeStoredSpans(row.spans),
		durationMs: row.durationMs,
		status: parseTraceStatus(row.status),
		createdAt: row.createdAt.toISOString(),
	};
}

function buildFilters(query: TraceListQuery): SQL[] {
	const filters: SQL[] = [];
	if (query.workspaceId) {
		filters.push(sql`workspace_id = ${query.workspaceId}`);
	}
	if (query.agentId) {
		filters.push(sql`agent_id = ${query.agentId}`);
	}
	if (query.status) {
		filters.push(sql`status = ${query.status}`);
	}
	return filters;
}

function summaryFromRow(row: Record<string, unknown>): ExecutionTraceSummary {
	const spans = normalizeStoredSpans(row.spans);
	return {
		traceId: readString(row, "trace_id"),
		workspaceId: readString(row, "workspace_id"),
		agentId: readString(row, "agent_id"),
		durationMs: readNumber(row, "duration_ms"),
		status: parseTraceStatus(readString(row, "status")),
		spanCount:
			spans.length > 0 ? countTraceSpans(spans) : readNumber(row, "span_count"),
		createdAt: readDateIso(row, "created_at"),
	};
}

export class TracesService {
	constructor(
		private readonly getDatabase: () => DbClient = getDb,
		private readonly databaseConfigured: () => boolean = isDatabaseConfigured,
	) {}

	async recordTrace(input: ExecutionTraceInput): Promise<ExecutionTrace> {
		if (!this.databaseConfigured()) {
			throw new TracesUnavailableError();
		}

		const trace = normalizeExecutionTraceInput(input);
		const db = this.getDatabase();
		const createdAt = new Date(trace.createdAt);

		try {
			const [row] = await db
				.insert(executionTraces)
				.values({
					traceId: trace.traceId,
					workspaceId: trace.workspaceId,
					agentId: trace.agentId,
					spans: trace.spans,
					durationMs: trace.durationMs,
					status: trace.status,
					createdAt,
				})
				.onConflictDoUpdate({
					target: executionTraces.traceId,
					set: {
						workspaceId: trace.workspaceId,
						agentId: trace.agentId,
						spans: trace.spans,
						durationMs: trace.durationMs,
						status: trace.status,
						createdAt: sql`LEAST(${executionTraces.createdAt}, ${createdAt})`,
					},
				})
				.returning();

			return row ? traceFromRow(row) : trace;
		} catch (error) {
			logger.warn("Failed to record execution trace", {
				error: error instanceof Error ? error.message : String(error),
				traceId: trace.traceId,
				workspaceId: trace.workspaceId,
				agentId: trace.agentId,
			});
			throw error;
		}
	}

	async getTrace(traceId: string): Promise<ExecutionTrace | null> {
		if (!this.databaseConfigured()) {
			throw new TracesUnavailableError();
		}
		const normalizedTraceId = traceId.trim();
		if (!normalizedTraceId) return null;

		const db = this.getDatabase();
		const [row] = await db
			.select()
			.from(executionTraces)
			.where(eq(executionTraces.traceId, normalizedTraceId))
			.limit(1);

		return row ? traceFromRow(row) : null;
	}

	async listTraces(query: TraceListQuery): Promise<TraceListResult> {
		if (!this.databaseConfigured()) {
			throw new TracesUnavailableError();
		}

		const filters = buildFilters(query);
		const where =
			filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
		const db = this.getDatabase();
		const result = await db.execute(sql`
			SELECT
				trace_id,
				workspace_id,
				agent_id,
				duration_ms,
				status,
				spans,
				created_at
			FROM execution_traces
			${where}
			ORDER BY created_at DESC, trace_id ASC
			LIMIT ${query.limit + 1}
			OFFSET ${query.offset}
		`);

		const rows = Array.from(result) as Array<Record<string, unknown>>;
		const hasMore = rows.length > query.limit;
		const visibleRows = hasMore ? rows.slice(0, query.limit) : rows;
		return {
			traces: visibleRows.map(summaryFromRow),
			pagination: {
				limit: query.limit,
				offset: query.offset,
				hasMore,
				...(hasMore ? { nextOffset: query.offset + query.limit } : {}),
			},
		};
	}

	summarizeTrace(trace: ExecutionTrace): ExecutionTraceSummary {
		return {
			traceId: trace.traceId,
			workspaceId: trace.workspaceId,
			agentId: trace.agentId,
			durationMs: trace.durationMs,
			status: trace.status,
			spanCount: countTraceSpans(trace.spans),
			createdAt: trace.createdAt,
		};
	}
}

let defaultTracesService: TracesService | null = null;

export function getTracesService(): TracesService {
	defaultTracesService ??= new TracesService();
	return defaultTracesService;
}

export function setTracesServiceForTest(service: TracesService | null): void {
	defaultTracesService = service;
}
