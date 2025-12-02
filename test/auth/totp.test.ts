import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetRateLimitsForTesting,
	generateBackupCodes,
	generateTotpCode,
	generateTotpSecret,
	generateTotpUri,
	hashBackupCode,
	isRateLimited,
	verifyBackupCode,
	verifyTotpCode,
} from "../../src/auth/totp.js";

// Mock DB
vi.mock("../../src/db/client.js", () => ({
	getDb: vi.fn(() => ({
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({
					limit: vi.fn(() => Promise.resolve([])),
				})),
			})),
		})),
		insert: vi.fn(() => ({
			values: vi.fn(() => ({
				onConflictDoNothing: vi.fn(() => Promise.resolve()),
			})),
		})),
		delete: vi.fn(() => ({
			where: vi.fn(() => ({
				returning: vi.fn(() => Promise.resolve([])),
			})),
		})),
	})),
	isDbAvailable: vi.fn(() => false),
}));

describe("TOTP Service", () => {
	beforeEach(() => {
		_resetRateLimitsForTesting();
	});

	afterEach(() => {
		_resetRateLimitsForTesting();
	});

	describe("generateTotpSecret", () => {
		it("should generate a secret", () => {
			const secret = generateTotpSecret();
			expect(secret).toBeDefined();
			expect(secret.length).toBeGreaterThan(10);
		});

		it("should generate unique secrets", () => {
			const s1 = generateTotpSecret();
			const s2 = generateTotpSecret();
			expect(s1).not.toBe(s2);
		});
	});

	describe("generateTotpUri", () => {
		it("should generate valid otpauth URI", () => {
			const secret = generateTotpSecret();
			const uri = generateTotpUri(secret, "user@example.com", "TestApp");

			expect(uri).toContain("otpauth://totp/");
			expect(uri).toContain("TestApp");
			expect(uri).toContain("user%40example.com");
			expect(uri).toContain(`secret=${secret}`);
		});
	});

	describe("generateTotpCode and verifyTotpCode", () => {
		it("should verify valid code", async () => {
			const secret = generateTotpSecret();
			const code = generateTotpCode(secret);

			const result = await verifyTotpCode("user-1", secret, code);
			expect(result.valid).toBe(true);
		});

		it("should reject invalid code", async () => {
			const secret = generateTotpSecret();

			const result = await verifyTotpCode("user-1", secret, "000000");
			expect(result.valid).toBe(false);
			expect(result.error).toBe("invalid_code");
		});
	});

	describe("rate limiting", () => {
		it("should not rate limit initially", () => {
			expect(isRateLimited("user-1").limited).toBe(false);
		});

		it("should rate limit after too many failures", async () => {
			const secret = generateTotpSecret();

			// Make 5 failed attempts
			for (let i = 0; i < 5; i++) {
				await verifyTotpCode("user-2", secret, "000000");
			}

			const status = isRateLimited("user-2");
			expect(status.limited).toBe(true);
			expect(status.retryAfterMs).toBeGreaterThan(0);
		});

		it("should return rate_limited error when limited", async () => {
			const secret = generateTotpSecret();

			// Exhaust attempts
			for (let i = 0; i < 5; i++) {
				await verifyTotpCode("user-3", secret, "000000");
			}

			const result = await verifyTotpCode("user-3", secret, "123456");
			expect(result.valid).toBe(false);
			expect(result.error).toBe("rate_limited");
			expect(result.retryAfterMs).toBeGreaterThan(0);
		});

		it("should clear rate limit on success", async () => {
			const secret = generateTotpSecret();

			// Make some failures
			await verifyTotpCode("user-4", secret, "000000");
			await verifyTotpCode("user-4", secret, "000000");

			// Succeed
			const code = generateTotpCode(secret);
			await verifyTotpCode("user-4", secret, code);

			// Should not be rate limited
			expect(isRateLimited("user-4").limited).toBe(false);
		});
	});

	describe("backup codes", () => {
		it("should generate unique codes", () => {
			const codes = generateBackupCodes(10);

			expect(codes).toHaveLength(10);
			expect(new Set(codes).size).toBe(10);
		});

		it("should format codes as XXXX-XXXX", () => {
			const codes = generateBackupCodes(5);

			for (const code of codes) {
				expect(code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
			}
		});

		it("should hash codes consistently", () => {
			const code = "ABCD-1234";
			const h1 = hashBackupCode(code);
			const h2 = hashBackupCode(code);
			const h3 = hashBackupCode("abcd1234"); // normalized

			expect(h1).toBe(h2);
			expect(h1).toBe(h3);
			expect(h1).toHaveLength(64);
		});

		it("should verify valid backup code", () => {
			const codes = generateBackupCodes(5);
			const hashes = codes.map(hashBackupCode);

			const result = verifyBackupCode(codes[2], hashes);
			expect(result.valid).toBe(true);
			expect(result.usedIndex).toBe(2);
		});

		it("should reject invalid backup code", () => {
			const codes = generateBackupCodes(5);
			const hashes = codes.map(hashBackupCode);

			const result = verifyBackupCode("XXXX-XXXX", hashes);
			expect(result.valid).toBe(false);
			expect(result.usedIndex).toBe(-1);
		});
	});
});
