import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/client.js", () => ({
	isDatabaseConfigured: vi.fn(),
	testConnection: vi.fn(),
}));

vi.mock("../src/db/health.js", () => ({
	CRITICAL_DATABASE_TABLES: [
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
	],
	checkCriticalTables: vi.fn(),
}));

import { isDatabaseConfigured, testConnection } from "../src/db/client.js";
import { checkCriticalTables } from "../src/db/health.js";
import { runHealthChecks } from "../src/server/handlers/health.js";

describe("Health Checks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe("runHealthChecks", () => {
		it("should return healthy when database is not configured", async () => {
			vi.mocked(isDatabaseConfigured).mockReturnValue(false);

			const result = await runHealthChecks();

			expect(result.status).toBe("healthy");
			expect(result.checks.database.status).toBe("unconfigured");
			expect(result.checks.database.latencyMs).toBeUndefined();
		});

		it("should return degraded when database is configured but not available", async () => {
			vi.mocked(isDatabaseConfigured).mockReturnValue(true);
			vi.mocked(testConnection).mockResolvedValue(false);

			const result = await runHealthChecks();

			expect(result.status).toBe("degraded");
			expect(result.checks.database.status).toBe("down");
		});

		it("should return healthy when database is up and responding", async () => {
			vi.mocked(isDatabaseConfigured).mockReturnValue(true);
			vi.mocked(testConnection).mockResolvedValue(true);
			vi.mocked(checkCriticalTables).mockResolvedValue([
				{ name: "_composer_migrations", exists: true },
				{ name: "organizations", exists: true },
				{ name: "users", exists: true },
				{ name: "sessions", exists: true },
				{ name: "webhook_deliveries", exists: true },
				{ name: "distributed_locks", exists: true },
				{ name: "usage_metrics", exists: true },
				{ name: "execution_traces", exists: true },
				{ name: "workspace_config", exists: true },
				{ name: "revenue_attribution", exists: true },
			]);

			const result = await runHealthChecks();

			expect(result.status).toBe("healthy");
			expect(result.checks.database.status).toBe("up");
			expect(result.checks.database.latencyMs).toBeDefined();
			expect(typeof result.checks.database.latencyMs).toBe("number");
		});

		it("should return degraded when database connection test fails", async () => {
			vi.mocked(isDatabaseConfigured).mockReturnValue(true);
			vi.mocked(testConnection).mockResolvedValue(false);

			const result = await runHealthChecks();

			expect(result.status).toBe("degraded");
			expect(result.checks.database.status).toBe("down");
			expect(result.checks.database.latencyMs).toBeDefined();
		});

		it("should return unhealthy when a critical database table is missing", async () => {
			vi.mocked(isDatabaseConfigured).mockReturnValue(true);
			vi.mocked(testConnection).mockResolvedValue(true);
			vi.mocked(checkCriticalTables).mockResolvedValue([
				{ name: "_composer_migrations", exists: true },
				{ name: "organizations", exists: true },
				{ name: "users", exists: true },
				{ name: "sessions", exists: true },
				{ name: "webhook_deliveries", exists: true },
				{ name: "distributed_locks", exists: false },
				{ name: "usage_metrics", exists: true },
				{ name: "execution_traces", exists: true },
				{ name: "workspace_config", exists: true },
				{ name: "revenue_attribution", exists: true },
			]);

			const result = await runHealthChecks();

			expect(result.status).toBe("unhealthy");
			expect(result.checks.database.status).toBe("up");
			expect(result.checks.database.criticalTables).toMatchObject({
				status: "missing",
				missing: ["distributed_locks"],
			});
		});

		it("should include timestamp in result", async () => {
			vi.mocked(isDatabaseConfigured).mockReturnValue(false);

			const before = Date.now();
			const result = await runHealthChecks();
			const after = Date.now();

			expect(result.timestamp).toBeGreaterThanOrEqual(before);
			expect(result.timestamp).toBeLessThanOrEqual(after);
		});
	});
});
