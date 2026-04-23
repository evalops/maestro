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
}

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
		checks.push({
			name: tableName,
			exists: row?.exists === true,
		});
	}

	return checks;
}
