import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Store original env
const originalEnv = { ...process.env };

describe("Database Field Encryption", () => {
	beforeEach(() => {
		// Reset modules to get fresh encryption state
		vi.resetModules();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("initEncryption", () => {
		it("should return false when no key is configured", async () => {
			Reflect.deleteProperty(process.env, "MAESTRO_DB_ENCRYPTION_KEY");
			const { initEncryption, isEncryptionEnabled } = await import(
				"../../src/db/encryption.js"
			);

			const result = initEncryption();

			expect(result).toBe(false);
			expect(isEncryptionEnabled()).toBe(false);
		});

		it("should accept hex-encoded 32-byte key", async () => {
			// 64 hex chars = 32 bytes
			process.env.MAESTRO_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
			const { initEncryption, isEncryptionEnabled } = await import(
				"../../src/db/encryption.js"
			);

			const result = initEncryption();

			expect(result).toBe(true);
			expect(isEncryptionEnabled()).toBe(true);
		});

		it("should accept base64-encoded 32-byte key", async () => {
			// 32 bytes in base64
			process.env.MAESTRO_DB_ENCRYPTION_KEY =
				"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
			const { initEncryption, isEncryptionEnabled } = await import(
				"../../src/db/encryption.js"
			);

			const result = initEncryption();

			expect(result).toBe(true);
			expect(isEncryptionEnabled()).toBe(true);
		});

		it("should reject keys with wrong length", async () => {
			process.env.MAESTRO_DB_ENCRYPTION_KEY = "tooshort";
			const { initEncryption, isEncryptionEnabled } = await import(
				"../../src/db/encryption.js"
			);

			const result = initEncryption();

			expect(result).toBe(false);
			expect(isEncryptionEnabled()).toBe(false);
		});
	});

	describe("encryptField / decryptField", () => {
		it("should encrypt and decrypt a value", async () => {
			process.env.MAESTRO_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
			const { encryptField, decryptField } = await import(
				"../../src/db/encryption.js"
			);

			const plaintext = "my-secret-webhook-key";
			const encrypted = encryptField(plaintext);
			const decrypted = decryptField(encrypted);

			expect(encrypted).not.toBe(plaintext);
			expect(encrypted).toMatch(/^enc:/);
			expect(decrypted).toBe(plaintext);
		});

		it("should produce different ciphertext for same plaintext (due to random IV)", async () => {
			process.env.MAESTRO_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
			const { encryptField } = await import("../../src/db/encryption.js");

			const plaintext = "my-secret";
			const encrypted1 = encryptField(plaintext);
			const encrypted2 = encryptField(plaintext);

			expect(encrypted1).not.toBe(encrypted2);
		});

		it("should return plaintext unchanged when encryption is disabled", async () => {
			Reflect.deleteProperty(process.env, "MAESTRO_DB_ENCRYPTION_KEY");
			const { initEncryption, encryptField } = await import(
				"../../src/db/encryption.js"
			);
			initEncryption();

			const plaintext = "my-secret";
			const result = encryptField(plaintext);

			expect(result).toBe(plaintext);
		});

		it("should return unencrypted values unchanged when decrypting", async () => {
			process.env.MAESTRO_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
			const { decryptField } = await import("../../src/db/encryption.js");

			const plaintext = "not-encrypted-value";
			const result = decryptField(plaintext);

			expect(result).toBe(plaintext);
		});

		it("should handle empty strings", async () => {
			process.env.MAESTRO_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
			const { encryptField, decryptField } = await import(
				"../../src/db/encryption.js"
			);

			const encrypted = encryptField("");
			const decrypted = decryptField(encrypted);

			expect(decrypted).toBe("");
		});

		it("should handle unicode strings", async () => {
			process.env.MAESTRO_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
			const { encryptField, decryptField } = await import(
				"../../src/db/encryption.js"
			);

			const plaintext = "秘密のキー 🔐";
			const encrypted = encryptField(plaintext);
			const decrypted = decryptField(encrypted);

			expect(decrypted).toBe(plaintext);
		});

		it("should detect tampered ciphertext", async () => {
			process.env.MAESTRO_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
			const { encryptField, decryptField } = await import(
				"../../src/db/encryption.js"
			);

			const encrypted = encryptField("secret");
			// Tamper with the encrypted value
			const tampered = `${encrypted.slice(0, -2)}XX`;

			expect(() => decryptField(tampered)).toThrow();
		});
	});

	describe("isEncrypted", () => {
		it("should return true for encrypted values", async () => {
			process.env.MAESTRO_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
			const { encryptField, isEncrypted } = await import(
				"../../src/db/encryption.js"
			);

			const encrypted = encryptField("secret");

			expect(isEncrypted(encrypted)).toBe(true);
		});

		it("should return false for plain values", async () => {
			const { isEncrypted } = await import("../../src/db/encryption.js");

			expect(isEncrypted("plain-value")).toBe(false);
			expect(isEncrypted("")).toBe(false);
		});
	});

	describe("generateEncryptionKey", () => {
		it("should generate a valid 64-char hex key", async () => {
			const { generateEncryptionKey } = await import(
				"../../src/db/encryption.js"
			);

			const key = generateEncryptionKey();

			expect(key).toMatch(/^[0-9a-f]{64}$/);
		});

		it("should generate unique keys", async () => {
			const { generateEncryptionKey } = await import(
				"../../src/db/encryption.js"
			);

			const key1 = generateEncryptionKey();
			const key2 = generateEncryptionKey();

			expect(key1).not.toBe(key2);
		});
	});
});
