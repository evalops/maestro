import { describe, expect, it } from "vitest";
import {
	extractBearerToken,
	generateTokenPair,
	verifyToken,
} from "../../src/auth/jwt.js";

describe("JWT Authentication", () => {
	const testPayload = {
		userId: "user-123",
		email: "test@example.com",
		orgId: "org-456",
		roleId: "role-789",
	};

	describe("generateTokenPair", () => {
		it("generates access and refresh tokens", () => {
			const tokens = generateTokenPair(testPayload);
			expect(tokens.accessToken).toBeDefined();
			expect(tokens.refreshToken).toBeDefined();
			expect(tokens.expiresIn).toBeGreaterThan(0);
		});

		it("generates different access and refresh tokens", () => {
			const tokens = generateTokenPair(testPayload);
			expect(tokens.accessToken).not.toBe(tokens.refreshToken);
		});
	});

	describe("verifyToken", () => {
		it("verifies valid access token", () => {
			const tokens = generateTokenPair(testPayload);
			const payload = verifyToken(tokens.accessToken);

			expect(payload).not.toBeNull();
			expect(payload?.userId).toBe(testPayload.userId);
			expect(payload?.email).toBe(testPayload.email);
			expect(payload?.orgId).toBe(testPayload.orgId);
			expect(payload?.roleId).toBe(testPayload.roleId);
			expect(payload?.type).toBe("access");
		});

		it("verifies valid refresh token", () => {
			const tokens = generateTokenPair(testPayload);
			const payload = verifyToken(tokens.refreshToken);

			expect(payload).not.toBeNull();
			expect(payload?.type).toBe("refresh");
		});

		it("returns null for invalid token", () => {
			const payload = verifyToken("invalid-token");
			expect(payload).toBeNull();
		});

		it("returns null for empty token", () => {
			const payload = verifyToken("");
			expect(payload).toBeNull();
		});
	});

	describe("extractBearerToken", () => {
		it("extracts token from Bearer header", () => {
			const token = extractBearerToken("Bearer abc123");
			expect(token).toBe("abc123");
		});

		it("returns null for missing header", () => {
			const token = extractBearerToken(undefined);
			expect(token).toBeNull();
		});

		it("returns null for non-Bearer header", () => {
			const token = extractBearerToken("Basic abc123");
			expect(token).toBeNull();
		});

		it("returns null for empty header", () => {
			const token = extractBearerToken("");
			expect(token).toBeNull();
		});

		it("handles token with spaces after Bearer", () => {
			const token = extractBearerToken("Bearer   abc123");
			expect(token).toBe("  abc123");
		});
	});

	describe("token expiration", () => {
		it("includes expiration time in token pair", () => {
			const tokens = generateTokenPair(testPayload);
			expect(tokens.expiresIn).toBeGreaterThan(0);
			// Default is 24h = 86400 seconds
			expect(tokens.expiresIn).toBeLessThanOrEqual(86400);
		});
	});
});
