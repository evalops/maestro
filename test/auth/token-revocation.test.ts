import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetCacheForTesting,
	getRevocationMetrics,
	hashToken,
	isTokenRevokedSync,
	revokeToken,
} from "../../src/auth/token-revocation.js";

// Mock the database client
vi.mock("../../src/db/client.js", () => ({
	getDb: vi.fn(() => ({
		insert: vi.fn(() => ({
			values: vi.fn(() => ({
				onConflictDoNothing: vi.fn(() => Promise.resolve()),
				returning: vi.fn(() => Promise.resolve([{ id: "test-id" }])),
			})),
		})),
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({
					limit: vi.fn(() => Promise.resolve([])),
				})),
			})),
		})),
		delete: vi.fn(() => ({
			where: vi.fn(() => ({
				returning: vi.fn(() => Promise.resolve([])),
			})),
		})),
	})),
	isDbAvailable: vi.fn(() => false), // Default to DB unavailable for cache-only tests
}));

describe("Token Revocation Service", () => {
	beforeEach(() => {
		_resetCacheForTesting();
	});

	afterEach(() => {
		_resetCacheForTesting();
	});

	describe("hashToken", () => {
		it("should produce consistent SHA-256 hash", () => {
			const token = "test-token-123";
			const hash1 = hashToken(token);
			const hash2 = hashToken(token);

			expect(hash1).toBe(hash2);
			expect(hash1).toHaveLength(64); // SHA-256 hex
			expect(hash1).toMatch(/^[a-f0-9]+$/);
		});

		it("should produce different hashes for different tokens", () => {
			const hash1 = hashToken("token-a");
			const hash2 = hashToken("token-b");

			expect(hash1).not.toBe(hash2);
		});
	});

	describe("revokeToken and isTokenRevokedSync", () => {
		it("should not be revoked by default", () => {
			expect(isTokenRevokedSync("fresh-token")).toBe(false);
		});

		it("should be revoked after calling revokeToken", async () => {
			const token = "token-to-revoke";
			const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now

			await revokeToken({
				token,
				tokenType: "access",
				expiresAt,
				reason: "logout",
			});

			expect(isTokenRevokedSync(token)).toBe(true);
		});

		it("should not affect other tokens", async () => {
			const expiresAt = new Date(Date.now() + 3600000);

			await revokeToken({
				token: "revoked-token",
				tokenType: "access",
				expiresAt,
			});

			expect(isTokenRevokedSync("revoked-token")).toBe(true);
			expect(isTokenRevokedSync("other-token")).toBe(false);
		});

		it("should handle expired tokens correctly", async () => {
			const token = "expired-token";
			const expiresAt = new Date(Date.now() - 1000); // Already expired

			await revokeToken({
				token,
				tokenType: "access",
				expiresAt,
			});

			// Expired tokens should not be in revocation list
			// (they're invalid anyway due to expiry)
			expect(isTokenRevokedSync(token)).toBe(false);
		});

		it("should support different token types", async () => {
			const expiresAt = new Date(Date.now() + 3600000);

			await revokeToken({
				token: "access-token",
				tokenType: "access",
				expiresAt,
			});

			await revokeToken({
				token: "refresh-token",
				tokenType: "refresh",
				expiresAt,
			});

			await revokeToken({
				token: "api-key",
				tokenType: "api_key",
				expiresAt,
			});

			expect(isTokenRevokedSync("access-token")).toBe(true);
			expect(isTokenRevokedSync("refresh-token")).toBe(true);
			expect(isTokenRevokedSync("api-key")).toBe(true);
		});

		it("should support revocation reasons", async () => {
			const expiresAt = new Date(Date.now() + 3600000);

			// Should not throw with any valid reason
			await revokeToken({
				token: "token-1",
				tokenType: "access",
				expiresAt,
				reason: "logout",
			});

			await revokeToken({
				token: "token-2",
				tokenType: "access",
				expiresAt,
				reason: "password_change",
			});

			await revokeToken({
				token: "token-3",
				tokenType: "access",
				expiresAt,
				reason: "security_incident",
			});

			expect(isTokenRevokedSync("token-1")).toBe(true);
			expect(isTokenRevokedSync("token-2")).toBe(true);
			expect(isTokenRevokedSync("token-3")).toBe(true);
		});
	});

	describe("getRevocationMetrics", () => {
		it("should return cache metrics", async () => {
			const metrics = getRevocationMetrics();

			expect(metrics).toHaveProperty("cacheSize");
			expect(metrics).toHaveProperty("cacheMaxSize");
			expect(typeof metrics.cacheSize).toBe("number");
			expect(metrics.cacheMaxSize).toBe(10_000);
		});

		it("should reflect cache size after revocations", async () => {
			const expiresAt = new Date(Date.now() + 3600000);

			await revokeToken({ token: "t1", tokenType: "access", expiresAt });
			await revokeToken({ token: "t2", tokenType: "access", expiresAt });
			await revokeToken({ token: "t3", tokenType: "access", expiresAt });

			const metrics = getRevocationMetrics();
			expect(metrics.cacheSize).toBe(3);
		});
	});

	describe("cache behavior", () => {
		it("should handle many revocations without issues", async () => {
			const expiresAt = new Date(Date.now() + 3600000);

			// Revoke many tokens
			for (let i = 0; i < 100; i++) {
				await revokeToken({
					token: `token-${i}`,
					tokenType: "access",
					expiresAt,
				});
			}

			// All should be revoked
			for (let i = 0; i < 100; i++) {
				expect(isTokenRevokedSync(`token-${i}`)).toBe(true);
			}

			const metrics = getRevocationMetrics();
			expect(metrics.cacheSize).toBe(100);
		});

		it("should handle duplicate revocations gracefully", async () => {
			const expiresAt = new Date(Date.now() + 3600000);
			const token = "duplicate-token";

			await revokeToken({ token, tokenType: "access", expiresAt });
			await revokeToken({ token, tokenType: "access", expiresAt });
			await revokeToken({ token, tokenType: "access", expiresAt });

			expect(isTokenRevokedSync(token)).toBe(true);
			// Should only have one entry despite multiple revocations
			const metrics = getRevocationMetrics();
			expect(metrics.cacheSize).toBe(1);
		});
	});
});
