import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/client.js", () => ({
	isDbAvailable: vi.fn(),
}));

vi.mock("../src/auth/token-revocation.js", () => ({
	cleanupExpiredRevocations: vi.fn(),
	warmUserRevocationCache: vi.fn(),
}));

vi.mock("../src/auth/totp.js", () => ({
	cleanupUsedCodes: vi.fn(),
	cleanupRateLimits: vi.fn(),
}));

vi.mock("../src/audit/integrity.js", () => ({
	warmHashCache: vi.fn(),
}));

vi.mock("../src/webhooks/delivery.js", () => ({
	cleanupWebhookQueue: vi.fn(),
}));

import { warmHashCache } from "../src/audit/integrity.js";
import {
	cleanupExpiredRevocations,
	warmUserRevocationCache,
} from "../src/auth/token-revocation.js";
import { cleanupRateLimits, cleanupUsedCodes } from "../src/auth/totp.js";
import { isDbAvailable } from "../src/db/client.js";
import { cleanupWebhookQueue } from "../src/webhooks/delivery.js";

import type {
	CacheWarmResult,
	CleanupResult,
} from "../src/web/handlers/admin.js";

interface MockRequest {
	method: string;
	headers: Record<string, string>;
}

interface MockResponse {
	writeHead: ReturnType<typeof vi.fn>;
	setHeader: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	getStatusCode: () => number;
	getBody: () => unknown;
}

// Helper to create mock request/response
function createMockReqRes(method = "POST"): {
	req: IncomingMessage;
	res: ServerResponse & { getStatusCode: () => number; getBody: () => unknown };
} {
	const req: MockRequest = {
		method,
		headers: {
			"accept-encoding": "",
		},
	};
	let statusCode = 0;
	let body = "";
	const res: MockResponse = {
		writeHead: vi.fn((code: number) => {
			statusCode = code;
		}),
		setHeader: vi.fn(),
		end: vi.fn((data: string) => {
			body = data;
		}),
		getStatusCode: () => statusCode,
		getBody: () => JSON.parse(body),
	};
	return {
		req: req as unknown as IncomingMessage,
		res: res as unknown as ServerResponse & {
			getStatusCode: () => number;
			getBody: () => unknown;
		},
	};
}

describe("Admin Handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe("handleAdminCleanup", () => {
		it("should return 405 for non-POST requests", async () => {
			const { handleAdminCleanup } = await import(
				"../src/web/handlers/admin.js"
			);
			const { req, res } = createMockReqRes("GET");

			await handleAdminCleanup(req, res, {});

			expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
		});

		it("should return 503 when database is not available", async () => {
			const { handleAdminCleanup } = await import(
				"../src/web/handlers/admin.js"
			);
			vi.mocked(isDbAvailable).mockReturnValue(false);
			const { req, res } = createMockReqRes();

			await handleAdminCleanup(req, res, {});

			expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
		});

		it("should run all cleanup tasks when database is available", async () => {
			const { handleAdminCleanup } = await import(
				"../src/web/handlers/admin.js"
			);
			vi.mocked(isDbAvailable).mockReturnValue(true);
			vi.mocked(cleanupExpiredRevocations).mockResolvedValue(5);
			vi.mocked(cleanupUsedCodes).mockResolvedValue(3);
			vi.mocked(cleanupRateLimits).mockResolvedValue(2);
			vi.mocked(cleanupWebhookQueue).mockResolvedValue(1);

			const { req, res } = createMockReqRes();
			await handleAdminCleanup(req, res, {});

			expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
			const result = res.getBody() as CleanupResult;
			expect(result.success).toBe(true);
			expect(result.results.revokedTokens).toBe(5);
			expect(result.results.totpCodes).toBe(3);
			expect(result.results.rateLimits).toBe(2);
			expect(result.results.webhooks).toBe(1);
			expect(result.totalCleaned).toBe(11);
			expect(typeof result.durationMs).toBe("number");
		});

		it("should report partial success when some tasks fail", async () => {
			const { handleAdminCleanup } = await import(
				"../src/web/handlers/admin.js"
			);
			vi.mocked(isDbAvailable).mockReturnValue(true);
			vi.mocked(cleanupExpiredRevocations).mockResolvedValue(5);
			vi.mocked(cleanupUsedCodes).mockRejectedValue(new Error("fail"));
			vi.mocked(cleanupRateLimits).mockResolvedValue(2);
			vi.mocked(cleanupWebhookQueue).mockResolvedValue(1);

			const { req, res } = createMockReqRes();
			await handleAdminCleanup(req, res, {});

			const result = res.getBody() as CleanupResult;
			expect(result.success).toBe(false);
			expect(result.results.revokedTokens).toBe(5);
			expect(result.results.totpCodes).toBeNull();
			expect(result.results.rateLimits).toBe(2);
			expect(result.results.webhooks).toBe(1);
			expect(result.totalCleaned).toBe(8);
		});
	});

	describe("handleAdminWarmCaches", () => {
		it("should return 405 for non-POST requests", async () => {
			const { handleAdminWarmCaches } = await import(
				"../src/web/handlers/admin.js"
			);
			const { req, res } = createMockReqRes("GET");

			await handleAdminWarmCaches(req, res, {});

			expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
		});

		it("should return 503 when database is not available", async () => {
			const { handleAdminWarmCaches } = await import(
				"../src/web/handlers/admin.js"
			);
			vi.mocked(isDbAvailable).mockReturnValue(false);
			const { req, res } = createMockReqRes();

			await handleAdminWarmCaches(req, res, {});

			expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
		});

		it("should warm all caches when database is available", async () => {
			const { handleAdminWarmCaches } = await import(
				"../src/web/handlers/admin.js"
			);
			vi.mocked(isDbAvailable).mockReturnValue(true);
			vi.mocked(warmUserRevocationCache).mockResolvedValue(10);
			vi.mocked(warmHashCache).mockResolvedValue(5);

			const { req, res } = createMockReqRes();
			await handleAdminWarmCaches(req, res, {});

			expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
			const result = res.getBody() as CacheWarmResult;
			expect(result.success).toBe(true);
			expect(result.results.revocationCache).toBe(10);
			expect(result.results.hashCache).toBe(5);
			expect(typeof result.durationMs).toBe("number");
		});

		it("should report partial success when some tasks fail", async () => {
			const { handleAdminWarmCaches } = await import(
				"../src/web/handlers/admin.js"
			);
			vi.mocked(isDbAvailable).mockReturnValue(true);
			vi.mocked(warmUserRevocationCache).mockResolvedValue(10);
			vi.mocked(warmHashCache).mockRejectedValue(new Error("fail"));

			const { req, res } = createMockReqRes();
			await handleAdminWarmCaches(req, res, {});

			const result = res.getBody() as CacheWarmResult;
			expect(result.success).toBe(false);
			expect(result.results.revocationCache).toBe(10);
			expect(result.results.hashCache).toBeNull();
		});
	});
});
