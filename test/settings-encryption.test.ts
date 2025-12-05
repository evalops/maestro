import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Store original env
const originalEnv = { ...process.env };

describe("Settings Encryption", () => {
	beforeEach(() => {
		// Reset modules to get fresh encryption state
		vi.resetModules();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("Organization Settings", () => {
		it("should encrypt webhookSigningSecret when encryption is enabled", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { encryptOrgSettings, decryptOrgSettings } = await import(
				"../src/db/settings-encryption.js"
			);

			const settings = {
				webhookSigningSecret: "my-secret-key-12345",
				alertWebhooks: ["https://example.com/webhook"],
				piiRedactionEnabled: true,
			};

			const encrypted = encryptOrgSettings(settings);

			// Secret should be encrypted (prefixed with enc:)
			expect(encrypted?.webhookSigningSecret).toMatch(/^enc:/);
			expect(encrypted?.webhookSigningSecret).not.toBe(
				settings.webhookSigningSecret,
			);

			// Other fields should be unchanged
			expect(encrypted?.alertWebhooks).toEqual(settings.alertWebhooks);
			expect(encrypted?.piiRedactionEnabled).toBe(true);

			// Should decrypt back to original
			const decrypted = decryptOrgSettings(encrypted);
			expect(decrypted?.webhookSigningSecret).toBe(
				settings.webhookSigningSecret,
			);
		});

		it("should pass through settings unchanged when encryption is disabled", async () => {
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_DB_ENCRYPTION_KEY;

			const { encryptOrgSettings } = await import(
				"../src/db/settings-encryption.js"
			);
			const { initEncryption, isEncryptionEnabled } = await import(
				"../src/db/encryption.js"
			);
			initEncryption();

			expect(isEncryptionEnabled()).toBe(false);

			const settings = {
				webhookSigningSecret: "my-secret-key",
				alertWebhooks: ["https://example.com"],
			};

			const result = encryptOrgSettings(settings);

			// Should be unchanged
			expect(result?.webhookSigningSecret).toBe(settings.webhookSigningSecret);
		});

		it("should handle null and undefined settings", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { encryptOrgSettings, decryptOrgSettings } = await import(
				"../src/db/settings-encryption.js"
			);

			expect(encryptOrgSettings(null)).toBeNull();
			expect(encryptOrgSettings(undefined)).toBeUndefined();
			expect(decryptOrgSettings(null)).toBeNull();
			expect(decryptOrgSettings(undefined)).toBeUndefined();
		});

		it("should handle settings without sensitive fields", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { encryptOrgSettings, decryptOrgSettings } = await import(
				"../src/db/settings-encryption.js"
			);

			const settings = {
				piiRedactionEnabled: true,
				auditRetentionDays: 30,
			};

			const encrypted = encryptOrgSettings(settings);
			const decrypted = decryptOrgSettings(encrypted);

			expect(decrypted).toEqual(settings);
		});

		it("should detect encrypted org secrets", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { encryptOrgSettings, isOrgSecretEncrypted } = await import(
				"../src/db/settings-encryption.js"
			);

			const settings = {
				webhookSigningSecret: "my-secret",
			};

			expect(isOrgSecretEncrypted(settings)).toBe(false);

			const encrypted = encryptOrgSettings(settings);
			expect(isOrgSecretEncrypted(encrypted)).toBe(true);
		});
	});

	describe("User Settings", () => {
		it("should encrypt twoFactor.secret when encryption is enabled", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { encryptUserSettings, decryptUserSettings } = await import(
				"../src/db/settings-encryption.js"
			);

			const settings = {
				preferredModels: ["claude-sonnet"],
				twoFactor: {
					enabled: true,
					secret: "JBSWY3DPEHPK3PXP",
					backupCodeHashes: ["hash1", "hash2"],
					enabledAt: "2024-01-01T00:00:00Z",
				},
			};

			const encrypted = encryptUserSettings(settings);

			// Secret should be encrypted
			expect(encrypted?.twoFactor?.secret).toMatch(/^enc:/);
			expect(encrypted?.twoFactor?.secret).not.toBe(settings.twoFactor.secret);

			// Other twoFactor fields should be unchanged
			expect(encrypted?.twoFactor?.enabled).toBe(true);
			expect(encrypted?.twoFactor?.backupCodeHashes).toEqual([
				"hash1",
				"hash2",
			]);
			expect(encrypted?.twoFactor?.enabledAt).toBe("2024-01-01T00:00:00Z");

			// Other settings should be unchanged
			expect(encrypted?.preferredModels).toEqual(["claude-sonnet"]);

			// Should decrypt back to original
			const decrypted = decryptUserSettings(encrypted);
			expect(decrypted?.twoFactor?.secret).toBe(settings.twoFactor.secret);
		});

		it("should pass through user settings unchanged when encryption is disabled", async () => {
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_DB_ENCRYPTION_KEY;

			const { encryptUserSettings } = await import(
				"../src/db/settings-encryption.js"
			);
			const { initEncryption, isEncryptionEnabled } = await import(
				"../src/db/encryption.js"
			);
			initEncryption();

			expect(isEncryptionEnabled()).toBe(false);

			const settings = {
				twoFactor: {
					enabled: true,
					secret: "JBSWY3DPEHPK3PXP",
				},
			};

			const result = encryptUserSettings(settings);

			// Should be unchanged
			expect(result?.twoFactor?.secret).toBe(settings.twoFactor.secret);
		});

		it("should handle null and undefined user settings", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { encryptUserSettings, decryptUserSettings } = await import(
				"../src/db/settings-encryption.js"
			);

			expect(encryptUserSettings(null)).toBeNull();
			expect(encryptUserSettings(undefined)).toBeUndefined();
			expect(decryptUserSettings(null)).toBeNull();
			expect(decryptUserSettings(undefined)).toBeUndefined();
		});

		it("should handle user settings without twoFactor", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { encryptUserSettings, decryptUserSettings } = await import(
				"../src/db/settings-encryption.js"
			);

			const settings = {
				preferredModels: ["claude-sonnet"],
				defaultThinkingLevel: "medium",
			};

			const encrypted = encryptUserSettings(settings);
			const decrypted = decryptUserSettings(encrypted);

			expect(decrypted).toEqual(settings);
		});

		it("should handle twoFactor without secret", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { encryptUserSettings, decryptUserSettings } = await import(
				"../src/db/settings-encryption.js"
			);

			const settings = {
				twoFactor: {
					enabled: false,
					// No secret - 2FA not fully set up yet
				},
			};

			const encrypted = encryptUserSettings(settings);
			const decrypted = decryptUserSettings(encrypted);

			expect(decrypted).toEqual(settings);
		});

		it("should detect encrypted user TOTP secrets", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { encryptUserSettings, isUserTotpSecretEncrypted } = await import(
				"../src/db/settings-encryption.js"
			);

			const settings = {
				twoFactor: {
					enabled: true,
					secret: "JBSWY3DPEHPK3PXP",
				},
			};

			expect(isUserTotpSecretEncrypted(settings)).toBe(false);

			const encrypted = encryptUserSettings(settings);
			expect(isUserTotpSecretEncrypted(encrypted)).toBe(true);
		});
	});

	describe("Migration Compatibility", () => {
		it("should decrypt values that are already encrypted", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { encryptOrgSettings, decryptOrgSettings } = await import(
				"../src/db/settings-encryption.js"
			);

			// Simulate data that was already encrypted
			const original = { webhookSigningSecret: "original-secret" };
			const encrypted = encryptOrgSettings(original);

			// Reading encrypted data should work
			const decrypted = decryptOrgSettings(encrypted);
			expect(decrypted?.webhookSigningSecret).toBe("original-secret");
		});

		it("should pass through unencrypted values during read", async () => {
			process.env.COMPOSER_DB_ENCRYPTION_KEY =
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

			const { decryptOrgSettings } = await import(
				"../src/db/settings-encryption.js"
			);

			// Simulate legacy data that was never encrypted
			const legacySettings = {
				webhookSigningSecret: "plaintext-secret",
			};

			// Should pass through without error
			const result = decryptOrgSettings(legacySettings);
			expect(result?.webhookSigningSecret).toBe("plaintext-secret");
		});
	});
});
