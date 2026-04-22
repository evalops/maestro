import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock all dependencies before importing lifecycle
vi.mock("../../src/db/client.js", () => ({
	isDbAvailable: vi.fn(() => false),
	isDatabaseConfigured: vi.fn(() => false),
	getDb: vi.fn(),
}));

vi.mock("../../src/db/migrate.js", () => ({
	migrate: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("../../src/audit/integrity.js", () => ({
	warmHashCache: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("../../src/auth/token-revocation.js", () => ({
	warmUserRevocationCache: vi.fn(() => Promise.resolve(0)),
	cleanupExpiredRevocations: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("../../src/auth/totp.js", () => ({
	cleanupRateLimits: vi.fn(() => Promise.resolve(0)),
	cleanupUsedCodes: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("../../src/webhooks/delivery.js", () => ({
	startWebhookProcessor: vi.fn(),
	stopWebhookProcessor: vi.fn(() => Promise.resolve()),
	cleanupWebhookQueue: vi.fn(() => Promise.resolve(0)),
}));

import { warmHashCache } from "../../src/audit/integrity.js";
import {
	cleanupExpiredRevocations,
	warmUserRevocationCache,
} from "../../src/auth/token-revocation.js";
import { cleanupRateLimits, cleanupUsedCodes } from "../../src/auth/totp.js";
import { isDatabaseConfigured, isDbAvailable } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import {
	initLifecycle,
	shutdownLifecycle,
	warmCaches,
} from "../../src/lifecycle.js";
import {
	cleanupWebhookQueue,
	startWebhookProcessor,
	stopWebhookProcessor,
} from "../../src/webhooks/delivery.js";

describe("Lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
		// Reset lifecycle state
		await shutdownLifecycle();
	});

	describe("warmCaches", () => {
		it("should skip warming when DB is unavailable", async () => {
			vi.mocked(isDbAvailable).mockReturnValue(false);

			await warmCaches();

			expect(warmUserRevocationCache).not.toHaveBeenCalled();
			expect(warmHashCache).not.toHaveBeenCalled();
		});

		it("should warm all caches when DB is available", async () => {
			vi.mocked(isDbAvailable).mockReturnValue(true);
			vi.mocked(warmUserRevocationCache).mockResolvedValue(5);
			vi.mocked(warmHashCache).mockResolvedValue(3);

			await warmCaches();

			expect(warmUserRevocationCache).toHaveBeenCalledOnce();
			expect(warmHashCache).toHaveBeenCalledOnce();
		});

		it("should handle cache warming failures gracefully", async () => {
			vi.mocked(isDbAvailable).mockReturnValue(true);
			vi.mocked(warmUserRevocationCache).mockRejectedValue(
				new Error("DB error"),
			);
			vi.mocked(warmHashCache).mockResolvedValue(3);

			// Should not throw
			await expect(warmCaches()).resolves.toBeUndefined();
		});
	});

	describe("initLifecycle", () => {
		it("runs migrations when the database is configured", async () => {
			vi.mocked(isDatabaseConfigured).mockReturnValue(true);
			vi.mocked(isDbAvailable).mockReturnValue(false);

			await initLifecycle();

			expect(migrate).toHaveBeenCalledOnce();
		});

		it("should initialize all services", async () => {
			vi.mocked(isDbAvailable).mockReturnValue(true);

			await initLifecycle();

			expect(warmUserRevocationCache).toHaveBeenCalled();
			expect(warmHashCache).toHaveBeenCalled();
			expect(startWebhookProcessor).toHaveBeenCalled();
		});

		it("should be idempotent", async () => {
			vi.mocked(isDbAvailable).mockReturnValue(true);

			await initLifecycle();
			await initLifecycle();

			// Should only be called once
			expect(startWebhookProcessor).toHaveBeenCalledTimes(1);
		});

		it("should start cleanup scheduler", async () => {
			vi.mocked(isDbAvailable).mockReturnValue(true);

			await initLifecycle();

			// Initial cleanup runs in background with staggered execution
			// Advance timers to allow all cleanup tasks to complete
			await vi.advanceTimersByTimeAsync(5000);

			expect(cleanupExpiredRevocations).toHaveBeenCalled();
			expect(cleanupUsedCodes).toHaveBeenCalled();
			expect(cleanupRateLimits).toHaveBeenCalled();
			expect(cleanupWebhookQueue).toHaveBeenCalled();
		});

		it("should run cleanup on schedule", async () => {
			vi.mocked(isDbAvailable).mockReturnValue(true);

			await initLifecycle();
			// Wait for initial cleanup to complete
			await vi.advanceTimersByTimeAsync(5000);
			vi.clearAllMocks();

			// Advance 5 minutes + stagger time
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 5000);

			expect(cleanupExpiredRevocations).toHaveBeenCalled();
			expect(cleanupUsedCodes).toHaveBeenCalled();
			expect(cleanupRateLimits).toHaveBeenCalled();
			expect(cleanupWebhookQueue).toHaveBeenCalled();
		});
	});

	describe("shutdownLifecycle", () => {
		it("should stop all services", async () => {
			vi.mocked(isDbAvailable).mockReturnValue(true);

			await initLifecycle();
			await shutdownLifecycle();

			expect(stopWebhookProcessor).toHaveBeenCalled();
		});

		it("should be idempotent", async () => {
			vi.mocked(isDbAvailable).mockReturnValue(true);

			await initLifecycle();
			await shutdownLifecycle();
			await shutdownLifecycle();

			expect(stopWebhookProcessor).toHaveBeenCalledTimes(1);
		});

		it("should stop cleanup scheduler", async () => {
			vi.mocked(isDbAvailable).mockReturnValue(true);

			await initLifecycle();
			vi.clearAllMocks();
			await shutdownLifecycle();

			// Advance time - cleanup should not run
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

			expect(cleanupExpiredRevocations).not.toHaveBeenCalled();
		});
	});
});
