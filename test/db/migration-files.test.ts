import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface MigrationJournal {
	entries: Array<{
		idx: number;
		tag: string;
	}>;
}

const migrationsDir = join(process.cwd(), "src/db/migrations");
const dockerfilePath = join(process.cwd(), "Dockerfile");

describe("database migration files", () => {
	it("includes an idempotent repair migration for distributed_locks", () => {
		const journal = JSON.parse(
			readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf-8"),
		) as MigrationJournal;
		const tags = journal.entries.map((entry) => entry.tag);

		expect(tags).toContain("0002_ensure_distributed_locks");
		expect(tags.indexOf("0002_ensure_distributed_locks")).toBeGreaterThan(
			tags.indexOf("0000_initial"),
		);

		const repairSql = readFileSync(
			join(migrationsDir, "0002_ensure_distributed_locks.sql"),
			"utf-8",
		);

		expect(repairSql).toContain(
			'CREATE TABLE IF NOT EXISTS "distributed_locks"',
		);
		expect(repairSql).toContain(
			'CREATE INDEX IF NOT EXISTS "distributed_lock_expires_idx"',
		);
		expect(repairSql).toContain("--> statement-breakpoint");
		expect(repairSql).not.toMatch(/\bDROP\b/i);
		expect(repairSql).not.toMatch(/\bDELETE\b/i);
	});

	it("includes an idempotent repair migration for runtime identity tables", () => {
		const journal = JSON.parse(
			readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf-8"),
		) as MigrationJournal;
		const tags = journal.entries.map((entry) => entry.tag);

		expect(tags).toContain("0003_ensure_runtime_identity_tables");
		expect(tags.indexOf("0003_ensure_runtime_identity_tables")).toBeGreaterThan(
			tags.indexOf("0002_ensure_distributed_locks"),
		);

		const repairSql = readFileSync(
			join(migrationsDir, "0003_ensure_runtime_identity_tables.sql"),
			"utf-8",
		);

		for (const tableName of [
			"revoked_tokens",
			"user_revocation_timestamps",
			"totp_rate_limits",
			"totp_used_codes",
			"distributed_locks",
		]) {
			expect(repairSql).toContain(`CREATE TABLE IF NOT EXISTS "${tableName}"`);
		}
		expect(repairSql).toContain("--> statement-breakpoint");
		expect(repairSql).not.toMatch(/\bDROP\b/i);
		expect(repairSql).not.toMatch(/\bDELETE\s+FROM\b/i);
	});

	it("copies SQL migrations into the runtime Docker image", () => {
		const dockerfile = readFileSync(dockerfilePath, "utf-8");

		expect(dockerfile).toContain(
			"COPY --from=builder /app/src/db/migrations ./dist/db/migrations",
		);
	});
});
