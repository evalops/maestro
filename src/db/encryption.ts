/**
 * Field-level encryption for sensitive database columns.
 *
 * Uses AES-256-GCM for authenticated encryption. The encryption key
 * is derived from MAESTRO_DB_ENCRYPTION_KEY environment variable.
 *
 * Encrypted values are stored as: base64(iv:ciphertext:authTag)
 */

import crypto from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("db:encryption");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recommended IV length
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

let encryptionKey: Buffer | null = null;

/**
 * Initialize encryption with key from environment.
 * Returns true if encryption is available, false otherwise.
 */
export function initEncryption(): boolean {
	const keySource = process.env.MAESTRO_DB_ENCRYPTION_KEY;

	if (!keySource) {
		logger.debug("No encryption key configured, field encryption disabled");
		return false;
	}

	try {
		// Support both raw hex keys and base64-encoded keys
		if (keySource.length === 64 && /^[0-9a-fA-F]+$/.test(keySource)) {
			encryptionKey = Buffer.from(keySource, "hex");
		} else {
			encryptionKey = Buffer.from(keySource, "base64");
		}

		if (encryptionKey.length !== KEY_LENGTH) {
			logger.error("Encryption key must be 32 bytes (256 bits)", undefined, {
				actualLength: encryptionKey.length,
			});
			encryptionKey = null;
			return false;
		}

		logger.info("Field encryption initialized");
		return true;
	} catch (error) {
		logger.error(
			"Failed to initialize encryption",
			error instanceof Error ? error : undefined,
		);
		encryptionKey = null;
		return false;
	}
}

/**
 * Check if encryption is available.
 */
export function isEncryptionEnabled(): boolean {
	return encryptionKey !== null;
}

/**
 * Encrypt a plaintext value.
 * Returns the encrypted value as a base64 string, or the original value if encryption is disabled.
 */
export function encryptField(plaintext: string): string {
	if (!encryptionKey) {
		return plaintext;
	}

	// Handle empty string specially
	if (plaintext === "") {
		return "enc:empty";
	}

	try {
		const iv = crypto.randomBytes(IV_LENGTH);
		const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv, {
			authTagLength: AUTH_TAG_LENGTH,
		});

		const encrypted = Buffer.concat([
			cipher.update(plaintext, "utf8"),
			cipher.final(),
		]);
		const authTag = cipher.getAuthTag();

		// Format: iv:ciphertext:authTag (all base64)
		const combined = Buffer.concat([iv, encrypted, authTag]);
		return `enc:${combined.toString("base64")}`;
	} catch (error) {
		logger.error(
			"Encryption failed",
			error instanceof Error ? error : undefined,
		);
		throw new Error("Failed to encrypt field");
	}
}

/**
 * Decrypt an encrypted value.
 * Returns the plaintext, or the original value if it's not encrypted or encryption is disabled.
 */
export function decryptField(encrypted: string): string {
	// Check if value is encrypted (has our prefix)
	if (!encrypted.startsWith("enc:")) {
		return encrypted;
	}

	// Handle empty string specially
	if (encrypted === "enc:empty") {
		return "";
	}

	if (!encryptionKey) {
		logger.warn("Cannot decrypt field: encryption key not configured");
		throw new Error("Encryption key not configured");
	}

	try {
		const combined = Buffer.from(encrypted.slice(4), "base64");

		if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
			throw new Error("Invalid encrypted data length");
		}

		const iv = combined.subarray(0, IV_LENGTH);
		const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
		const ciphertext = combined.subarray(
			IV_LENGTH,
			combined.length - AUTH_TAG_LENGTH,
		);

		const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, iv, {
			authTagLength: AUTH_TAG_LENGTH,
		});
		decipher.setAuthTag(authTag);

		const decrypted = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]);

		return decrypted.toString("utf8");
	} catch (error) {
		logger.error(
			"Decryption failed",
			error instanceof Error ? error : undefined,
		);
		throw new Error("Failed to decrypt field");
	}
}

/**
 * Check if a value is encrypted.
 */
export function isEncrypted(value: string): boolean {
	return value.startsWith("enc:");
}

/**
 * Re-encrypt a field with a new key.
 * Used during key rotation.
 */
export function reEncryptField(
	encrypted: string,
	oldKey: Buffer,
	newKey: Buffer,
): string {
	if (!encrypted.startsWith("enc:")) {
		// Not encrypted, encrypt with new key
		const originalKey = encryptionKey;
		encryptionKey = newKey;
		const result = encryptField(encrypted);
		encryptionKey = originalKey;
		return result;
	}

	// Decrypt with old key
	const originalKey = encryptionKey;
	encryptionKey = oldKey;
	let plaintext: string;
	try {
		plaintext = decryptField(encrypted);
	} finally {
		encryptionKey = originalKey;
	}

	// Encrypt with new key
	encryptionKey = newKey;
	try {
		return encryptField(plaintext);
	} finally {
		encryptionKey = originalKey;
	}
}

/**
 * Generate a new encryption key.
 * Returns the key as a hex string suitable for MAESTRO_DB_ENCRYPTION_KEY.
 */
export function generateEncryptionKey(): string {
	return crypto.randomBytes(KEY_LENGTH).toString("hex");
}

// Initialize on module load
initEncryption();
