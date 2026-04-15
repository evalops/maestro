import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/client.js", () => ({
	isDbAvailable: vi.fn(),
	isDatabaseConfigured: vi.fn(),
	testConnection: vi.fn(),
}));

import {
	isDatabaseConfigured,
	isDbAvailable,
	testConnection,
} from "../src/db/client.js";
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
			vi.mocked(isDbAvailable).mockReturnValue(false);

			const result = await runHealthChecks();

			expect(result.status).toBe("degraded");
			expect(result.checks.database.status).toBe("down");
		});

		it("should return healthy when database is up and responding", async () => {
			vi.mocked(isDatabaseConfigured).mockReturnValue(true);
			vi.mocked(isDbAvailable).mockReturnValue(true);
			vi.mocked(testConnection).mockResolvedValue(true);

			const result = await runHealthChecks();

			expect(result.status).toBe("healthy");
			expect(result.checks.database.status).toBe("up");
			expect(result.checks.database.latencyMs).toBeDefined();
			expect(typeof result.checks.database.latencyMs).toBe("number");
		});

		it("should return degraded when database connection test fails", async () => {
			vi.mocked(isDatabaseConfigured).mockReturnValue(true);
			vi.mocked(isDbAvailable).mockReturnValue(true);
			vi.mocked(testConnection).mockResolvedValue(false);

			const result = await runHealthChecks();

			expect(result.status).toBe("degraded");
			expect(result.checks.database.status).toBe("down");
			expect(result.checks.database.latencyMs).toBeDefined();
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
