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
});
