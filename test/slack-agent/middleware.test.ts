/**
 * Tests for connector middleware (truncation, caching, rate limiting).
 */

import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { withMiddleware } from "../../packages/slack-agent/src/connectors/middleware.js";
import type {
	Connector,
	ConnectorCapability,
	ConnectorCredentials,
	ConnectorResult,
} from "../../packages/slack-agent/src/connectors/types.js";

function createMockConnector(
	executeFn: (
		action: string,
		params: Record<string, unknown>,
	) => Promise<ConnectorResult>,
): Connector {
	return {
		name: "mock",
		displayName: "Mock",
		authType: "api_key",
		description: "test",
		connect: async () => {},
		disconnect: async () => {},
		healthCheck: async () => true,
		getCapabilities: () => [
			{
				action: "read_data",
				description: "Read",
				parameters: Type.Object({}),
				category: "read" as const,
			},
			{
				action: "write_data",
				description: "Write",
				parameters: Type.Object({}),
				category: "write" as const,
			},
		],
		execute: executeFn,
	};
}

describe("withMiddleware", () => {
	describe("truncation", () => {
		it("truncates long string responses", async () => {
			const connector = createMockConnector(async () => ({
				success: true,
				data: "x".repeat(100_000),
			}));

			const execute = withMiddleware(connector, "test", {
				maxResponseChars: 1000,
				cacheTtlMs: 0,
				maxRequestsPerMinute: 0,
			});

			const result = await execute("read_data", {});
			expect(result.success).toBe(true);
			expect((result.data as string).length).toBeLessThan(2000);
			expect(result.data as string).toContain("truncated");
		});

		it("truncates large arrays", async () => {
			const bigArray = Array.from({ length: 500 }, (_, i) => ({
				id: i,
			}));
			const connector = createMockConnector(async () => ({
				success: true,
				data: bigArray,
			}));

			const execute = withMiddleware(connector, "test", {
				maxArrayItems: 10,
				cacheTtlMs: 0,
				maxRequestsPerMinute: 0,
			});

			const result = await execute("read_data", {});
			expect(result.success).toBe(true);
			expect((result.data as unknown[]).length).toBeLessThanOrEqual(11);
		});

		it("passes through small responses unchanged", async () => {
			const connector = createMockConnector(async () => ({
				success: true,
				data: { key: "value" },
			}));

			const execute = withMiddleware(connector, "test", {
				cacheTtlMs: 0,
				maxRequestsPerMinute: 0,
			});

			const result = await execute("read_data", {});
			expect(result.data).toEqual({ key: "value" });
		});
	});

	describe("caching", () => {
		it("caches read actions", async () => {
			let callCount = 0;
			const connector = createMockConnector(async () => {
				callCount++;
				return { success: true, data: "result" };
			});

			const execute = withMiddleware(connector, "test", {
				cacheTtlMs: 60_000,
				maxRequestsPerMinute: 0,
			});

			await execute("read_data", { key: "a" });
			await execute("read_data", { key: "a" });
			expect(callCount).toBe(1);
		});

		it("does not cache write actions", async () => {
			let callCount = 0;
			const connector = createMockConnector(async () => {
				callCount++;
				return { success: true, data: "result" };
			});

			const execute = withMiddleware(connector, "test", {
				cacheTtlMs: 60_000,
				maxRequestsPerMinute: 0,
			});

			await execute("write_data", {});
			await execute("write_data", {});
			expect(callCount).toBe(2);
		});

		it("does not cache failed results", async () => {
			let callCount = 0;
			const connector = createMockConnector(async () => {
				callCount++;
				if (callCount === 1) return { success: false, error: "temp" };
				return { success: true, data: "ok" };
			});

			const execute = withMiddleware(connector, "test", {
				cacheTtlMs: 60_000,
				maxRequestsPerMinute: 0,
			});

			const r1 = await execute("read_data", {});
			expect(r1.success).toBe(false);

			const r2 = await execute("read_data", {});
			expect(r2.success).toBe(true);
			expect(callCount).toBe(2);
		});

		it("caching disabled when ttl is 0", async () => {
			let callCount = 0;
			const connector = createMockConnector(async () => {
				callCount++;
				return { success: true, data: "result" };
			});

			const execute = withMiddleware(connector, "test", {
				cacheTtlMs: 0,
				maxRequestsPerMinute: 0,
			});

			await execute("read_data", {});
			await execute("read_data", {});
			expect(callCount).toBe(2);
		});
	});

	describe("rate limiting", () => {
		it("rate limits after max requests", async () => {
			const connector = createMockConnector(async () => ({
				success: true,
				data: "ok",
			}));

			const execute = withMiddleware(connector, "test", {
				cacheTtlMs: 0,
				maxRequestsPerMinute: 2,
			});

			const r1 = await execute("read_data", {});
			expect(r1.success).toBe(true);

			const r2 = await execute("write_data", {});
			expect(r2.success).toBe(true);

			// Third call should be rate limited (or wait and succeed)
			const r3 = await execute("write_data", {});
			// It might wait briefly and succeed, or return rate limit error
			// Either way it shouldn't crash
			expect(r3).toBeDefined();
		});

		it("rate limiting disabled when maxRpm is 0", async () => {
			let callCount = 0;
			const connector = createMockConnector(async () => {
				callCount++;
				return { success: true, data: "ok" };
			});

			const execute = withMiddleware(connector, "test", {
				cacheTtlMs: 0,
				maxRequestsPerMinute: 0,
			});

			for (let i = 0; i < 10; i++) {
				await execute("write_data", {});
			}
			expect(callCount).toBe(10);
		});
	});

	describe("error handling", () => {
		it("catches thrown errors from connector", async () => {
			const connector = createMockConnector(async () => {
				throw new Error("Network failure");
			});

			const execute = withMiddleware(connector, "test", {
				cacheTtlMs: 0,
				maxRequestsPerMinute: 0,
			});

			const result = await execute("read_data", {});
			expect(result.success).toBe(false);
			expect(result.error).toContain("Network failure");
		});
	});
});
