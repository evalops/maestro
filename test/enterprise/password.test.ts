import { beforeAll, describe, expect, it } from "vitest";
import {
	hashPassword,
	validatePasswordStrength,
	verifyPassword,
} from "../../src/auth/password.js";

describe("Password Security", () => {
	const password = "SecurePass123!";
	let sharedHash = "";

	beforeAll(async () => {
		sharedHash = await hashPassword(password);
	});

	describe("validatePasswordStrength", () => {
		it("rejects passwords shorter than 8 characters", () => {
			const result = validatePasswordStrength("Abc123!");
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"Password must be at least 8 characters long",
			);
		});

		it("rejects passwords without uppercase", () => {
			const result = validatePasswordStrength("abcd1234!");
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"Password must contain at least one uppercase letter",
			);
		});

		it("rejects passwords without lowercase", () => {
			const result = validatePasswordStrength("ABCD1234!");
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"Password must contain at least one lowercase letter",
			);
		});

		it("rejects passwords without numbers", () => {
			const result = validatePasswordStrength("Abcdefgh!");
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"Password must contain at least one number",
			);
		});

		it("rejects passwords without special characters", () => {
			const result = validatePasswordStrength("Abcd1234");
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"Password must contain at least one special character",
			);
		});

		it("accepts valid passwords", () => {
			const result = validatePasswordStrength("SecurePass123!");
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("returns multiple errors for weak passwords", () => {
			const result = validatePasswordStrength("abc");
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(1);
		});
	});

	describe("hashPassword and verifyPassword", () => {
		it("hashes password correctly", async () => {
			expect(sharedHash).toBeDefined();
			expect(sharedHash).not.toBe(password);
			expect(sharedHash.startsWith("$2")).toBe(true); // bcrypt hash prefix
		});

		it("generates different hashes for same password", async () => {
			const hash1 = await hashPassword(password);
			const hash2 = await hashPassword(password);

			expect(hash1).not.toBe(hash2);
		});

		it("verifies correct password", async () => {
			const isValid = await verifyPassword(password, sharedHash);

			expect(isValid).toBe(true);
		});

		it("rejects incorrect password", async () => {
			const isValid = await verifyPassword("WrongPassword!", sharedHash);

			expect(isValid).toBe(false);
		});

		it("rejects empty password", async () => {
			const isValid = await verifyPassword("", sharedHash);

			expect(isValid).toBe(false);
		});
	});
});
