import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execute: vi.fn(),
	queries: [] as string[],
	tableState: new Map<string, boolean>(),
}));

vi.mock("../../src/db/client.js", () => ({
	isDatabaseConfigured: vi.fn(() => true),
	getDb: vi.fn(() => ({ execute: mocks.execute })),
}));

import { migrate } from "../../src/db/migrate.js";

function sqlText(query: unknown): string {
	const chunks =
		(query as { queryChunks?: Array<string | { value?: string[] }> })
			.queryChunks ?? [];

	return chunks
		.map((chunk) => {
			if (typeof chunk === "string") {
				return chunk;
			}
			return chunk.value?.join("") ?? "";
		})
		.join("");
}

describe("migrate", () => {
	beforeEach(() => {
		mocks.queries.length = 0;
		mocks.tableState.clear();
		mocks.execute.mockReset();
		mocks.execute.mockImplementation(async (query: unknown) => {
			const text = sqlText(query);
			mocks.queries.push(text);

			if (text.includes("SELECT tag FROM _composer_migrations")) {
				return [];
			}
			if (text.includes("pg_type") && text.includes("alert_severity")) {
				return [{ exists: true }];
			}
			if (text.includes("to_regclass(")) {
				const tableName = Array.from(mocks.tableState.keys()).find((name) =>
					text.includes(`public.${name}`),
				);
				return [
					{ exists: tableName ? mocks.tableState.get(tableName) : false },
				];
			}

			return [];
		});
	});

	it("marks the initial migration applied instead of replaying existing schema", async () => {
		const applied = await migrate();

		expect(applied).toBe(5);
		expect(
			mocks.queries.some((query) =>
				query.includes('CREATE TYPE "public"."alert_severity"'),
			),
		).toBe(false);
		expect(
			mocks.queries.some(
				(query) =>
					query.includes("INSERT INTO _composer_migrations") &&
					query.includes("0000_initial"),
			),
		).toBe(true);
		expect(
			mocks.queries.some((query) =>
				query.includes('CREATE TABLE IF NOT EXISTS "shared_sessions"'),
			),
		).toBe(true);
		expect(
			mocks.queries.some((query) =>
				query.includes(
					'ALTER TABLE "permissions" ADD COLUMN IF NOT EXISTS "action"',
				),
			),
		).toBe(true);
	});

	it("also backfills the shared session migration when that table already exists", async () => {
		mocks.tableState.set("shared_sessions", true);

		const applied = await migrate();

		expect(applied).toBe(4);
		expect(
			mocks.queries.some((query) =>
				query.includes('CREATE TABLE IF NOT EXISTS "shared_sessions"'),
			),
		).toBe(false);
		expect(
			mocks.queries.some(
				(query) =>
					query.includes("INSERT INTO _composer_migrations") &&
					query.includes("0001_shared_sessions"),
			),
		).toBe(true);
	});
});
