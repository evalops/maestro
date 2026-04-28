import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { copyDbMigrations } from "../../scripts/copy-db-migrations.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const migrationsDir = path.join(repoRoot, "src", "db", "migrations");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("database migration packaging", () => {
	it("keeps every journal entry backed by a SQL file", () => {
		const journalPath = path.join(migrationsDir, "meta", "_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
			entries: Array<{ tag: string }>;
		};

		expect(journal.entries.map((entry) => entry.tag)).toContain(
			"0007_reconcile_legacy_audit_hash_cache",
		);
		expect(journal.entries.map((entry) => entry.tag)).toContain(
			"0008_reconcile_legacy_webhook_deliveries",
		);

		for (const entry of journal.entries) {
			expect(
				existsSync(path.join(migrationsDir, `${entry.tag}.sql`)),
				`missing migration SQL for ${entry.tag}`,
			).toBe(true);
		}
	});

	it("copies migrations into dist for package and image runtime", () => {
		const sourceDir = mkdtempSync(
			path.join(tmpdir(), "maestro-migrations-src-"),
		);
		const targetDir = mkdtempSync(
			path.join(tmpdir(), "maestro-migrations-dst-"),
		);
		tempDirs.push(sourceDir, targetDir);

		const metaDir = path.join(sourceDir, "meta");
		mkdirSync(metaDir, { recursive: true });
		writeFileSync(path.join(sourceDir, "0000_initial.sql"), "SELECT 1;\n");
		writeFileSync(path.join(metaDir, "_journal.json"), "{}\n", {
			flag: "wx",
		});

		copyDbMigrations({ sourceDir, targetDir });

		expect(existsSync(path.join(targetDir, "0000_initial.sql"))).toBe(true);
		expect(existsSync(path.join(targetDir, "meta", "_journal.json"))).toBe(
			true,
		);
	});

	it("keeps build scripts wired without the legacy Node image copy", () => {
		const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
		const runnerStage =
			dockerfile.split("# ---------- runner ----------")[1] ?? "";
		expect(dockerfile).toContain("RUN bun run build:all");
		expect(runnerStage).toContain(
			"COPY --from=web-builder /app/packages/web/dist ./packages/web/dist",
		);
		expect(runnerStage).not.toContain(
			"COPY --from=web-builder /usr/local/bin/bun /usr/local/bin/bun",
		);
		expect(runnerStage).not.toContain(
			"COPY --from=deps /app/node_modules ./node_modules",
		);
		expect(runnerStage).not.toContain("COPY package.json bun.lockb ./");
		expect(runnerStage).toContain("nodejs npm");
		expect(runnerStage).not.toContain(
			"COPY --from=builder /app/src/db/migrations",
		);

		const packageJson = JSON.parse(
			readFileSync(path.join(repoRoot, "package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(packageJson.scripts.build).toContain("copy-db-migrations.js");
	});

	it("preserves the legacy audit hash cache repair migration", () => {
		const migration = readFileSync(
			path.join(migrationsDir, "0007_reconcile_legacy_audit_hash_cache.sql"),
			"utf8",
		);

		expect(migration).toContain(
			'CREATE TABLE IF NOT EXISTS "audit_hash_cache"',
		);
		expect(migration).toContain("audit_hash_cache_org_id_organizations_id_fk");
	});

	it("preserves the legacy webhook delivery repair migration", () => {
		const migration = readFileSync(
			path.join(migrationsDir, "0008_reconcile_legacy_webhook_deliveries.sql"),
			"utf8",
		);

		expect(migration).toContain('ADD COLUMN IF NOT EXISTS "id"');
		expect(migration).toContain('ADD COLUMN IF NOT EXISTS "payload"');
		expect(migration).toContain('ADD COLUMN IF NOT EXISTS "status"');
		expect(migration).toMatch(
			/CREATE TYPE "webhook_delivery_status"[\s\S]+EXCEPTION\s+WHEN duplicate_object OR unique_violation THEN\s+NULL;\s+END;/,
		);
		expect(migration).toContain(
			'ALTER TYPE "webhook_delivery_status" ADD VALUE IF NOT EXISTS',
		);
		expect(migration).toContain('"status"::text NOT IN');
		expect(migration).toMatch(
			/CREATE OR REPLACE FUNCTION maestro_reconcile_webhook_payload[\s\S]+EXCEPTION\s+WHEN duplicate_function OR unique_violation THEN\s+NULL;\s+END;/,
		);
		expect(migration).not.toContain(
			"DROP FUNCTION IF EXISTS maestro_reconcile_webhook_payload",
		);
		expect(migration).toContain("webhook_deliveries_pkey");
		expect(migration).toContain(
			"WHEN duplicate_object OR invalid_table_definition THEN",
		);
		expect(migration).toContain("WHEN duplicate_object THEN");
		expect(migration).toContain(
			"WHEN duplicate_table OR unique_violation THEN",
		);
		expect(migration).toContain("organization_id");
		expect(migration).toContain("next_attempt_at");
		expect(migration).toContain('ALTER COLUMN "url" DROP DEFAULT');
		expect(migration).toContain(
			"IF to_regclass('public.webhook_deliveries') IS NOT NULL THEN",
		);
		expect(migration).toContain("webhook_delivery_retry_idx");
	});
});
