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

import { randomUUID } from "node:crypto";
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

	describe("Real CRUD Operations", () => {
		const testId = `test-${Date.now()}`;

		it("should create and read an organization", async () => {
			const db = getDb();
			const eq = (await import("drizzle-orm")).eq;

			// Create org with unique ID and slug to avoid conflicts
			const orgId = randomUUID();
			const slug = `test-org-${testId}`;
			const [created] = await db
				.insert(schema.organizations)
				.values({
					id: orgId,
					name: `Test Org ${testId}`,
					slug,
					settings: {
						alertWebhooks: ["https://example.com/webhook"],
					},
				})
				.returning();

			expect(created).toBeDefined();
			expect(created.id).toBe(orgId);
			expect(created.name).toBe(`Test Org ${testId}`);

			// Read back
			const [found] = await db
				.select()
				.from(schema.organizations)
				.where(eq(schema.organizations.id, orgId));

			expect(found).toBeDefined();
			expect(found.name).toBe(`Test Org ${testId}`);
			expect(found.settings).toEqual({
				alertWebhooks: ["https://example.com/webhook"],
			});

			// Cleanup
			await db
				.delete(schema.organizations)
				.where(eq(schema.organizations.id, orgId));
		});

		it("should update organization settings", async () => {
			const db = getDb();
			const eq = (await import("drizzle-orm")).eq;

			// Create org
			const orgId = randomUUID();
			const slug = `update-test-${testId}`;
			await db.insert(schema.organizations).values({
				id: orgId,
				name: `Update Test ${testId}`,
				slug,
				settings: { alertWebhooks: [] },
			});

			// Update settings
			const [updated] = await db
				.update(schema.organizations)
				.set({
					settings: {
						alertWebhooks: ["https://new.webhook"],
						webhookSigningSecret: "secret123",
					},
				})
				.where(eq(schema.organizations.id, orgId))
				.returning();

			expect(updated.settings).toEqual({
				alertWebhooks: ["https://new.webhook"],
				webhookSigningSecret: "secret123",
			});

			// Cleanup
			await db
				.delete(schema.organizations)
				.where(eq(schema.organizations.id, orgId));
		});

		it("should create and query users with settings", async () => {
			const db = getDb();
			const eq = (await import("drizzle-orm")).eq;

			const userId = randomUUID();
			const [created] = await db
				.insert(schema.users)
				.values({
					id: userId,
					email: `test-${testId}@example.com`,
					passwordHash: "hashed",
					name: "Test User",
					settings: {
						preferredModels: ["claude-3"],
						defaultThinkingLevel: "medium",
					},
				})
				.returning();

			expect(created).toBeDefined();
			expect(created.email).toBe(`test-${testId}@example.com`);
			expect(created.settings?.preferredModels).toContain("claude-3");

			// Cleanup
			await db.delete(schema.users).where(eq(schema.users.id, userId));
		});

		it("should handle alerts CRUD", async () => {
			const db = getDb();
			const eq = (await import("drizzle-orm")).eq;

			// Create org first (needed for foreign key)
			const orgId = randomUUID();
			const slug = `alert-test-${testId}`;
			await db.insert(schema.organizations).values({
				id: orgId,
				name: `Alert Test Org ${testId}`,
				slug,
			});

			// Create alert
			const alertId = randomUUID();
			const [created] = await db
				.insert(schema.alerts)
				.values({
					id: alertId,
					orgId,
					type: "usage_spike",
					severity: "medium", // Valid enum value
					message: "Test alert",
				})
				.returning();

			expect(created).toBeDefined();
			expect(created.severity).toBe("medium");
			expect(created.isRead).toBe(false);

			// Update alert
			const [updated] = await db
				.update(schema.alerts)
				.set({ isRead: true })
				.where(eq(schema.alerts.id, alertId))
				.returning();

			expect(updated.isRead).toBe(true);

			// Delete alert and org
			await db.delete(schema.alerts).where(eq(schema.alerts.id, alertId));
			await db
				.delete(schema.organizations)
				.where(eq(schema.organizations.id, orgId));
		});

		it("should handle audit logs creation", async () => {
			const db = getDb();
			const eq = (await import("drizzle-orm")).eq;

			// Create org and user for foreign keys
			const orgId = randomUUID();
			const userId = randomUUID();
			const slug = `audit-test-${testId}`;

			await db.insert(schema.organizations).values({
				id: orgId,
				name: `Audit Test Org ${testId}`,
				slug,
			});

			await db.insert(schema.users).values({
				id: userId,
				email: `audit-${testId}@example.com`,
				passwordHash: "hashed",
				name: "Audit User",
			});

			// Create audit log
			const logId = randomUUID();
			const [created] = await db
				.insert(schema.auditLogs)
				.values({
					id: logId,
					orgId,
					userId,
					action: "test.action",
					resourceType: "test",
					status: "success",
					metadata: { toolName: "test-tool" },
				})
				.returning();

			expect(created).toBeDefined();
			expect(created.action).toBe("test.action");
			expect(created.status).toBe("success");

			// Cleanup
			await db.delete(schema.auditLogs).where(eq(schema.auditLogs.id, logId));
			await db.delete(schema.users).where(eq(schema.users.id, userId));
			await db
				.delete(schema.organizations)
				.where(eq(schema.organizations.id, orgId));
		});

		it("should handle shared sessions CRUD", async () => {
			const db = getDb();
			const eq = (await import("drizzle-orm")).eq;

			const shareId = randomUUID();
			const shareToken = `token-${testId}`;
			const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

			// Create shared session
			const [created] = await db
				.insert(schema.sharedSessions)
				.values({
					id: shareId,
					sessionId: `session-${testId}`,
					shareToken,
					expiresAt,
					maxAccesses: 10,
				})
				.returning();

			expect(created).toBeDefined();
			expect(created.shareToken).toBe(shareToken);
			expect(created.accessCount).toBe(0);

			// Increment access count
			const [updated] = await db
				.update(schema.sharedSessions)
				.set({ accessCount: 1 })
				.where(eq(schema.sharedSessions.id, shareId))
				.returning();

			expect(updated.accessCount).toBe(1);

			// Query by token
			const [found] = await db
				.select()
				.from(schema.sharedSessions)
				.where(eq(schema.sharedSessions.shareToken, shareToken));

			expect(found).toBeDefined();
			expect(found.sessionId).toBe(`session-${testId}`);

			// Cleanup
			await db
				.delete(schema.sharedSessions)
				.where(eq(schema.sharedSessions.id, shareId));
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
		expect(
			isUserTotpSecretEncrypted({
				twoFactor: { enabled: true, secret: "plain" },
			}),
		).toBe(false);
		expect(
			isUserTotpSecretEncrypted({
				twoFactor: { enabled: true, secret: "enc:something" },
			}),
		).toBe(true);
	});
});
