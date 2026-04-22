/**
 * @vitest-environment node
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE_DB_URL =
	process.env.MAESTRO_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = BASE_DB_URL ? describe : describe.skip;

const originalEnv = { ...process.env };

function quoteIdent(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseUrlFor(baseUrl: string, databaseName: string): string {
	const url = new URL(baseUrl);
	url.pathname = `/${databaseName}`;
	return url.toString();
}

describeDb("legacy RBAC migration integration", () => {
	let admin: postgres.Sql | null = null;
	let databaseName = "";
	let databaseUrl = "";

	beforeEach(async () => {
		vi.resetModules();
		process.env = { ...originalEnv };

		databaseName = `maestro_legacy_rbac_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
		databaseUrl = databaseUrlFor(BASE_DB_URL!, databaseName);
		admin = postgres(BASE_DB_URL!, { max: 1 });

		await admin.unsafe(`CREATE DATABASE ${quoteIdent(databaseName)}`);

		process.env.MAESTRO_DATABASE_URL = databaseUrl;
		process.env.MAESTRO_DB_MAX_CONNECTIONS = "1";
	});

	afterEach(async () => {
		try {
			const client = await import("../../src/db/client.js");
			await client.closeDb();
		} catch {
			// The test may fail before the app client is imported.
		}

		if (admin) {
			await admin.unsafe(
				`
				SELECT pg_terminate_backend(pid)
				FROM pg_stat_activity
				WHERE datname = '${databaseName.replaceAll("'", "''")}'
					AND pid <> pg_backend_pid()
				`,
			);
			await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)}`);
			await admin.end();
			admin = null;
		}

		process.env = originalEnv;
		vi.resetModules();
	});

	it("reconciles legacy RBAC tables and seeds system permissions idempotently", async () => {
		const sql = postgres(databaseUrl, { max: 1 });
		try {
			await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
			await sql`
				CREATE TABLE _composer_migrations (
					id SERIAL PRIMARY KEY,
					tag VARCHAR(255) NOT NULL UNIQUE,
					applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
				)
			`;
			await sql`
				INSERT INTO _composer_migrations (tag)
				VALUES
					('0000_initial'),
					('0001_shared_sessions'),
					('0002_ensure_distributed_locks'),
					('0003_ensure_runtime_identity_tables')
			`;
			await sql`
				CREATE TABLE permissions (
					id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
					name varchar(100) NOT NULL,
					description text,
					permission_type varchar(50) NOT NULL,
					resource varchar(100),
					created_at timestamp with time zone DEFAULT now() NOT NULL,
					updated_at timestamp with time zone DEFAULT now() NOT NULL
				)
			`;
			await sql`CREATE UNIQUE INDEX ix_permissions_name ON permissions (name)`;
			await sql`
				CREATE INDEX ix_permissions_resource_type
				ON permissions (resource, permission_type)
			`;
			await sql`
				CREATE TABLE roles (
					id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
					name varchar(100) NOT NULL,
					description text,
					role_type varchar(50) NOT NULL,
					is_system_role boolean DEFAULT false NOT NULL,
					created_at timestamp with time zone DEFAULT now() NOT NULL,
					updated_at timestamp with time zone DEFAULT now() NOT NULL
				)
			`;
			await sql`CREATE UNIQUE INDEX ix_roles_name ON roles (name)`;
			await sql`
				CREATE TABLE role_permissions (
					id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
					role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
					permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
					granted boolean DEFAULT true NOT NULL,
					created_at timestamp with time zone DEFAULT now() NOT NULL
				)
			`;
		} finally {
			await sql.end();
		}

		const { migrate } = await import("../../src/db/migrate.js");
		const { seedPermissions, RESOURCES, ACTIONS } = await import(
			"../../src/rbac/permissions.js"
		);

		await expect(migrate()).resolves.toBe(1);
		await expect(seedPermissions()).resolves.toBeUndefined();
		await expect(seedPermissions()).resolves.toBeUndefined();

		const verify = postgres(databaseUrl, { max: 1 });
		try {
			const applied = await verify<{ tag: string }[]>`
				SELECT tag FROM _composer_migrations ORDER BY id
			`;
			expect(applied.map((row) => row.tag)).toContain(
				"0004_reconcile_legacy_rbac_tables",
			);

			const columnState = await verify<
				Array<{
					table_name: string;
					column_name: string;
					is_nullable: "YES" | "NO";
				}>
			>`
				SELECT table_name, column_name, is_nullable
				FROM information_schema.columns
				WHERE table_schema = 'public'
					AND table_name IN ('permissions', 'roles')
					AND column_name IN (
						'action',
						'name',
						'permission_type',
						'org_id',
						'is_system',
						'role_type'
					)
			`;
			const nullableByColumn = new Map(
				columnState.map((row) => [
					`${row.table_name}.${row.column_name}`,
					row.is_nullable,
				]),
			);

			expect(nullableByColumn.get("permissions.action")).toBe("NO");
			expect(nullableByColumn.get("permissions.name")).toBe("YES");
			expect(nullableByColumn.get("permissions.permission_type")).toBe("YES");
			expect(nullableByColumn.get("roles.org_id")).toBe("YES");
			expect(nullableByColumn.get("roles.is_system")).toBe("NO");
			expect(nullableByColumn.get("roles.role_type")).toBe("YES");

			const permissionRows = await verify<
				Array<{ count: string; missing_legacy_columns: string }>
			>`
				SELECT
					count(*)::text AS count,
					count(*) FILTER (
						WHERE name IS NULL AND permission_type IS NULL
					)::text AS missing_legacy_columns
				FROM permissions
			`;
			const expectedPermissionCount =
				Object.values(RESOURCES).length * Object.values(ACTIONS).length;
			expect(Number(permissionRows[0]?.count ?? 0)).toBe(
				expectedPermissionCount,
			);
			expect(Number(permissionRows[0]?.missing_legacy_columns ?? 0)).toBe(
				expectedPermissionCount,
			);

			const systemRoles = await verify<Array<{ name: string }>>`
				SELECT name
				FROM roles
				WHERE org_id IS NULL AND is_system = true
				ORDER BY name
			`;
			expect(systemRoles.map((row) => row.name)).toEqual([
				"org_admin",
				"org_member",
				"org_owner",
				"org_viewer",
			]);

			const duplicateRolePermissions = await verify<Array<{ count: string }>>`
				SELECT count(*)::text AS count
				FROM (
					SELECT role_id, permission_id
					FROM role_permissions
					GROUP BY role_id, permission_id
					HAVING count(*) > 1
				) duplicates
			`;
			expect(Number(duplicateRolePermissions[0]?.count ?? 0)).toBe(0);
		} finally {
			await verify.end();
		}
	});
});
