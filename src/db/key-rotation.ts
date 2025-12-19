/**
 * Encryption key rotation for database field encryption.
 *
 * This module provides functionality to rotate encryption keys for
 * sensitive database fields. It handles re-encrypting all encrypted
 * values with a new key.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createLogger } from "../utils/logger.js";
import { getDb, isDatabaseConfigured } from "./client.js";
import { generateEncryptionKey, reEncryptField } from "./encryption.js";
import { organizations, users } from "./schema.js";

const logger = createLogger("db:key-rotation");
const __filename = fileURLToPath(import.meta.url);

export interface KeyRotationResult {
	success: boolean;
	orgsUpdated: number;
	usersUpdated: number;
	errors: string[];
}

/**
 * Rotate encryption key for all encrypted fields in the database.
 *
 * This function:
 * 1. Validates both old and new keys
 * 2. Re-encrypts organization webhook secrets
 * 3. Re-encrypts user TOTP secrets
 * 4. Reports success/failure for each record
 *
 * After successful rotation, update COMPOSER_DB_ENCRYPTION_KEY to the new key.
 */
export async function rotateEncryptionKey(
	oldKeyHex: string,
	newKeyHex: string,
): Promise<KeyRotationResult> {
	const result: KeyRotationResult = {
		success: false,
		orgsUpdated: 0,
		usersUpdated: 0,
		errors: [],
	};

	if (!isDatabaseConfigured()) {
		result.errors.push("Database not configured");
		return result;
	}

	// Validate keys
	if (oldKeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(oldKeyHex)) {
		result.errors.push("Old key must be 64 hex characters (32 bytes)");
		return result;
	}
	if (newKeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(newKeyHex)) {
		result.errors.push("New key must be 64 hex characters (32 bytes)");
		return result;
	}

	const oldKey = Buffer.from(oldKeyHex, "hex");
	const newKey = Buffer.from(newKeyHex, "hex");

	const db = getDb();

	logger.info("Starting encryption key rotation");

	// Rotate organization webhook secrets
	try {
		const orgs = await db
			.select({
				id: organizations.id,
				settings: organizations.settings,
			})
			.from(organizations);

		for (const org of orgs) {
			if (!org.settings?.webhookSigningSecret) continue;

			try {
				const reEncrypted = reEncryptField(
					org.settings.webhookSigningSecret,
					oldKey,
					newKey,
				);

				await db
					.update(organizations)
					.set({
						settings: {
							...org.settings,
							webhookSigningSecret: reEncrypted,
						},
					})
					.where(eq(organizations.id, org.id));

				result.orgsUpdated++;
			} catch (error) {
				result.errors.push(
					`Failed to rotate org ${org.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	} catch (error) {
		result.errors.push(
			`Failed to query organizations: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Rotate user TOTP secrets
	try {
		const allUsers = await db
			.select({
				id: users.id,
				settings: users.settings,
			})
			.from(users);

		for (const user of allUsers) {
			if (!user.settings?.twoFactor?.secret) continue;

			try {
				const reEncrypted = reEncryptField(
					user.settings.twoFactor.secret,
					oldKey,
					newKey,
				);

				await db
					.update(users)
					.set({
						settings: {
							...user.settings,
							twoFactor: {
								...user.settings.twoFactor,
								secret: reEncrypted,
							},
						},
					})
					.where(eq(users.id, user.id));

				result.usersUpdated++;
			} catch (error) {
				result.errors.push(
					`Failed to rotate user ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	} catch (error) {
		result.errors.push(
			`Failed to query users: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	result.success = result.errors.length === 0;

	logger.info("Key rotation completed", {
		success: result.success,
		orgsUpdated: result.orgsUpdated,
		usersUpdated: result.usersUpdated,
		errorCount: result.errors.length,
	});

	return result;
}

/**
 * CLI entry point for key rotation.
 *
 * Usage:
 *   bun run src/db/key-rotation.ts rotate <old-key> <new-key>
 *   bun run src/db/key-rotation.ts generate
 */
export async function runKeyRotationCli(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (command === "generate") {
		const newKey = generateEncryptionKey();
		console.log("Generated new encryption key:");
		console.log(newKey);
		console.log(
			"\nStore this securely and use it as COMPOSER_DB_ENCRYPTION_KEY",
		);
		process.exit(0);
	}

	if (command === "rotate") {
		const oldKey = args[1];
		const newKey = args[2];

		if (!oldKey || !newKey) {
			console.error("Usage: key-rotation rotate <old-key-hex> <new-key-hex>");
			console.error("       key-rotation generate");
			process.exit(1);
		}

		console.log("Starting key rotation...");
		const result = await rotateEncryptionKey(oldKey, newKey);

		if (result.success) {
			console.log("\nKey rotation completed successfully!");
			console.log(`  Organizations updated: ${result.orgsUpdated}`);
			console.log(`  Users updated: ${result.usersUpdated}`);
			console.log(
				"\nIMPORTANT: Update COMPOSER_DB_ENCRYPTION_KEY to the new key",
			);
		} else {
			console.error("\nKey rotation completed with errors:");
			for (const error of result.errors) {
				console.error(`  - ${error}`);
			}
			console.log(`\n  Organizations updated: ${result.orgsUpdated}`);
			console.log(`  Users updated: ${result.usersUpdated}`);
			process.exit(1);
		}

		process.exit(0);
	}

	console.error("Unknown command. Usage:");
	console.error("  key-rotation rotate <old-key-hex> <new-key-hex>");
	console.error("  key-rotation generate");
	process.exit(1);
}

// Run if called directly
if (process.argv[1] && __filename === resolve(process.argv[1])) {
	runKeyRotationCli().catch((err) => {
		console.error("Key rotation failed:", err);
		process.exit(1);
	});
}
