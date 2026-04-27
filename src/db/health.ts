import { sql } from "drizzle-orm";
import { getDb } from "./client.js";

export const CRITICAL_DATABASE_TABLES = [
	"_composer_migrations",
	"organizations",
	"users",
	"sessions",
	"webhook_deliveries",
	"distributed_locks",
	"usage_metrics",
	"execution_traces",
	"workspace_config",
	"revenue_attribution",
] as const;

export interface CriticalTableCheck {
	name: (typeof CRITICAL_DATABASE_TABLES)[number];
	exists: boolean;
	missingColumns?: string[];
}

const CRITICAL_DATABASE_COLUMNS: Partial<
	Record<(typeof CRITICAL_DATABASE_TABLES)[number], readonly string[]>
> = {
	webhook_deliveries: [
		"id",
		"org_id",
		"url",
		"payload",
		"signature",
		"status",
		"attempts",
		"max_attempts",
		"next_retry_at",
		"last_error",
		"last_status_code",
		"last_response_time_ms",
		"delivered_at",
		"created_at",
	],
};

export async function checkCriticalTables(
	tables: readonly (typeof CRITICAL_DATABASE_TABLES)[number][] = CRITICAL_DATABASE_TABLES,
): Promise<CriticalTableCheck[]> {
	const db = getDb();
	const checks: CriticalTableCheck[] = [];

	for (const tableName of tables) {
		const qualifiedName = `public.${tableName}`;
		const result = await db.execute(sql`
			SELECT to_regclass(${qualifiedName}) IS NOT NULL AS exists
		`);
		const [row] = Array.from(result) as Array<Record<string, unknown>>;
		const requiredColumns = CRITICAL_DATABASE_COLUMNS[tableName] ?? [];
		let missingColumns: string[] = [];
		if (row?.exists === true && requiredColumns.length > 0) {
			const columnsResult = await db.execute(sql`
				SELECT column_name
				FROM information_schema.columns
				WHERE table_schema = 'public'
					AND table_name = ${tableName}
			`);
			const actualColumns = new Set(
				(Array.from(columnsResult) as Array<Record<string, unknown>>)
					.map((column) => column.column_name)
					.filter((name): name is string => typeof name === "string"),
			);
			missingColumns = requiredColumns.filter(
				(column) => !actualColumns.has(column),
			);
		}

		checks.push({
			name: tableName,
			exists: row?.exists === true,
			...(missingColumns.length > 0 ? { missingColumns } : {}),
		});
	}

	return checks;
}
