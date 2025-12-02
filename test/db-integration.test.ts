/**
 * Database Integration Tests
 *
 * These tests require a PostgreSQL database connection.
 * Set COMPOSER_DATABASE_URL to run these tests.
 *
 * To skip these tests when no DB is available:
 * - They check for COMPOSER_DATABASE_URL and skip if not set
 * - They use a test-specific schema prefix to avoid polluting production data
 *
 * @vitest-environment node
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Check if database is configured
const DB_URL = process.env.COMPOSER_DATABASE_URL || process.env.DATABASE_URL;
const skipDb = !DB_URL;

// Conditional test wrapper
const describeDb = skipDb ? describe.skip : describe;

describeDb("Database Integration Tests", () => {
	let getDb: () => ReturnType<typeof import("../src/db/client.js").getDb>;
	let closeDb: () => Promise<void>;
	let schema: typeof import("../src/db/schema.js");

	beforeAll(async () => {
		// Dynamically import to avoid errors when DB not configured
		const clientModule = await import("../src/db/client.js");
		const schemaModule = await import("../src/db/schema.js");

		getDb = clientModule.getDb;
		closeDb = clientModule.closeDb;
		schema = schemaModule;
	});

	afterAll(async () => {
		if (closeDb) {
			await closeDb();
		}
	});

	describe("Connection", () => {
		it("should connect to the database", async () => {
			const db = getDb();
			expect(db).toBeDefined();
		});

		it("should execute a simple query", async () => {
			const db = getDb();
			const result = await db.execute(
				await import("drizzle-orm").then((m) => m.sql`SELECT 1 as one`),
			);
			expect(result).toBeDefined();
		});
	});

	describe("Schema Tables", () => {
		it("should have organizations table defined", () => {
			expect(schema.organizations).toBeDefined();
		});

		it("should have users table defined", () => {
			expect(schema.users).toBeDefined();
		});

		it("should have sessions table defined", () => {
			expect(schema.sessions).toBeDefined();
		});

		it("should have audit_logs table defined", () => {
			expect(schema.auditLogs).toBeDefined();
		});

		it("should have revoked_tokens table defined", () => {
			expect(schema.revokedTokens).toBeDefined();
		});

		it("should have webhook_deliveries table defined", () => {
			expect(schema.webhookDeliveries).toBeDefined();
		});

		it("should have distributed_locks table defined", () => {
			expect(schema.distributedLocks).toBeDefined();
		});

		it("should have totp_rate_limits table defined", () => {
			expect(schema.totpRateLimits).toBeDefined();
		});

		it("should have totp_used_codes table defined", () => {
			expect(schema.totpUsedCodes).toBeDefined();
		});
	});

	describe("Encryption Integration", () => {
		it("should import encryption module", async () => {
			const encryption = await import("../src/db/encryption.js");
			expect(encryption.encryptField).toBeInstanceOf(Function);
			expect(encryption.decryptField).toBeInstanceOf(Function);
			expect(encryption.isEncryptionEnabled).toBeInstanceOf(Function);
		});

		it("should import settings encryption module", async () => {
			const settingsEncryption = await import(
				"../src/db/settings-encryption.js"
			);
			expect(settingsEncryption.encryptOrgSettings).toBeInstanceOf(Function);
			expect(settingsEncryption.decryptOrgSettings).toBeInstanceOf(Function);
			expect(settingsEncryption.encryptUserSettings).toBeInstanceOf(Function);
			expect(settingsEncryption.decryptUserSettings).toBeInstanceOf(Function);
		});
	});

	describe("Migration Module", () => {
		it("should import migration functions", async () => {
			const migrate = await import("../src/db/migrate.js");
			expect(migrate.migrate).toBeInstanceOf(Function);
			expect(migrate.getMigrationStatus).toBeInstanceOf(Function);
		});

		it("should get migration status", async () => {
			const { getMigrationStatus } = await import("../src/db/migrate.js");
			const status = await getMigrationStatus();

			expect(status).toHaveProperty("pending");
			expect(status).toHaveProperty("applied");
			expect(Array.isArray(status.pending)).toBe(true);
			expect(Array.isArray(status.applied)).toBe(true);
		});
	});
});

// Additional tests that don't require DB connection
describe("Database Schema Types", () => {
	it("should export organization settings type", async () => {
		const schema = await import("../src/db/schema.js");
		// Just verify the module loads and has the expected exports
		expect(schema.organizations).toBeDefined();
	});

	it("should export user settings type", async () => {
		const schema = await import("../src/db/schema.js");
		expect(schema.users).toBeDefined();
	});

	it("should export audit log status enum", async () => {
		const schema = await import("../src/db/schema.js");
		expect(schema.auditStatusEnum).toBeDefined();
	});

	it("should export alert severity enum", async () => {
		const schema = await import("../src/db/schema.js");
		expect(schema.alertSeverityEnum).toBeDefined();
	});

	it("should export webhook delivery status enum", async () => {
		const schema = await import("../src/db/schema.js");
		expect(schema.webhookDeliveryStatusEnum).toBeDefined();
	});

	it("should export user role enum", async () => {
		const schema = await import("../src/db/schema.js");
		expect(schema.userRoleEnum).toBeDefined();
	});
});

describe("Settings Encryption Helpers", () => {
	it("should handle null org settings", async () => {
		const { encryptOrgSettings, decryptOrgSettings } = await import(
			"../src/db/settings-encryption.js"
		);

		expect(encryptOrgSettings(null)).toBeNull();
		expect(encryptOrgSettings(undefined)).toBeUndefined();
		expect(decryptOrgSettings(null)).toBeNull();
		expect(decryptOrgSettings(undefined)).toBeUndefined();
	});

	it("should handle null user settings", async () => {
		const { encryptUserSettings, decryptUserSettings } = await import(
			"../src/db/settings-encryption.js"
		);

		expect(encryptUserSettings(null)).toBeNull();
		expect(encryptUserSettings(undefined)).toBeUndefined();
		expect(decryptUserSettings(null)).toBeNull();
		expect(decryptUserSettings(undefined)).toBeUndefined();
	});

	it("should detect encrypted values", async () => {
		const { isOrgSecretEncrypted, isUserTotpSecretEncrypted } = await import(
			"../src/db/settings-encryption.js"
		);

		expect(isOrgSecretEncrypted(null)).toBe(false);
		expect(isOrgSecretEncrypted({})).toBe(false);
		expect(isOrgSecretEncrypted({ webhookSigningSecret: "plain" })).toBe(false);
		expect(
			isOrgSecretEncrypted({ webhookSigningSecret: "enc:something" }),
		).toBe(true);

		expect(isUserTotpSecretEncrypted(null)).toBe(false);
		expect(isUserTotpSecretEncrypted({})).toBe(false);
		expect(isUserTotpSecretEncrypted({ twoFactor: { secret: "plain" } })).toBe(
			false,
		);
		expect(
			isUserTotpSecretEncrypted({ twoFactor: { secret: "enc:something" } }),
		).toBe(true);
	});
});
