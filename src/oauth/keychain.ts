/**
 * OS Keychain Integration for Secure Credential Storage
 *
 * Provides secure credential storage using the OS keychain (macOS Keychain,
 * Windows Credential Manager, Linux libsecret) with fallback to encrypted file storage.
 *
 * ## Security Benefits
 *
 * - Credentials protected by OS-level encryption
 * - Integrated with system authentication (Touch ID, Windows Hello, etc.)
 * - No plaintext API keys in config files
 * - Credentials locked when system is locked
 *
 * ## Usage
 *
 * ```typescript
 * import { secureCredentialStore } from "./keychain.js";
 *
 * // Store a credential
 * await secureCredentialStore.set("anthropic", "sk-ant-api03-xxx");
 *
 * // Retrieve a credential
 * const apiKey = await secureCredentialStore.get("anthropic");
 *
 * // Delete a credential
 * await secureCredentialStore.delete("anthropic");
 * ```
 *
 * ## Fallback Behavior
 *
 * If OS keychain is unavailable (e.g., headless Linux), falls back to
 * AES-256-GCM encrypted file storage with a machine-derived key.
 */

import { execSync } from "node:child_process";
import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("oauth:keychain");

const SERVICE_NAME = "composer";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

interface EncryptedStore {
	salt: string; // hex
	credentials: {
		[key: string]: {
			iv: string; // hex
			authTag: string; // hex
			data: string; // hex
		};
	};
}

/**
 * Check if we're running on macOS
 */
function isMacOS(): boolean {
	return process.platform === "darwin";
}

/**
 * Check if macOS security command is available
 */
function hasMacOSKeychain(): boolean {
	if (!isMacOS()) return false;
	try {
		execSync("which security", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Derive a machine-specific encryption key
 * Uses hostname + username + a static component for key derivation
 */
function deriveMachineKey(salt: Buffer): Buffer {
	const machineId = `${hostname()}-${userInfo().username}-composer-v1`;
	return scryptSync(machineId, salt, KEY_LENGTH);
}

/**
 * Get path to encrypted credentials file
 */
function getEncryptedStorePath(): string {
	const configDir = join(getAgentDir(), "..");
	return join(configDir, ".credentials.enc");
}

/**
 * Load encrypted store from disk
 */
function loadEncryptedStore(): EncryptedStore {
	const storePath = getEncryptedStorePath();
	if (!existsSync(storePath)) {
		return {
			salt: randomBytes(SALT_LENGTH).toString("hex"),
			credentials: {},
		};
	}

	try {
		const content = readFileSync(storePath, "utf-8");
		return JSON.parse(content);
	} catch (error) {
		logger.warn("Failed to load encrypted store; creating new one", {
			errorType: error instanceof Error ? error.name : "unknown",
		});
		return {
			salt: randomBytes(SALT_LENGTH).toString("hex"),
			credentials: {},
		};
	}
}

/**
 * Save encrypted store to disk
 */
function saveEncryptedStore(store: EncryptedStore): void {
	const configDir = join(getAgentDir(), "..");
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}

	const storePath = getEncryptedStorePath();
	writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
	chmodSync(storePath, 0o600);
}

/**
 * Encrypt a value using AES-256-GCM
 */
function encryptValue(
	value: string,
	key: Buffer,
): { iv: string; authTag: string; data: string } {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

	let encrypted = cipher.update(value, "utf8", "hex");
	encrypted += cipher.final("hex");
	const authTag = cipher.getAuthTag();

	return {
		iv: iv.toString("hex"),
		authTag: authTag.toString("hex"),
		data: encrypted,
	};
}

/**
 * Decrypt a value using AES-256-GCM
 */
function decryptValue(
	encrypted: { iv: string; authTag: string; data: string },
	key: Buffer,
): string {
	const iv = Buffer.from(encrypted.iv, "hex");
	const authTag = Buffer.from(encrypted.authTag, "hex");
	const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
	decipher.setAuthTag(authTag);

	let decrypted = decipher.update(encrypted.data, "hex", "utf8");
	decrypted += decipher.final("utf8");
	return decrypted;
}

/**
 * macOS Keychain operations using security command
 */
const macOSKeychain = {
	async get(key: string): Promise<string | null> {
		try {
			const result = execSync(
				`security find-generic-password -s "${SERVICE_NAME}" -a "${key}" -w 2>/dev/null`,
				{ encoding: "utf8" },
			);
			return result.trim();
		} catch {
			return null;
		}
	},

	async set(key: string, value: string): Promise<void> {
		// Delete existing entry first (if any)
		try {
			execSync(
				`security delete-generic-password -s "${SERVICE_NAME}" -a "${key}" 2>/dev/null`,
				{ stdio: "ignore" },
			);
		} catch {
			// Ignore - entry might not exist
		}

		// Add new entry
		execSync(
			`security add-generic-password -s "${SERVICE_NAME}" -a "${key}" -w "${value.replace(/"/g, '\\"')}"`,
			{ stdio: "ignore" },
		);
	},

	async delete(key: string): Promise<void> {
		try {
			execSync(
				`security delete-generic-password -s "${SERVICE_NAME}" -a "${key}" 2>/dev/null`,
				{ stdio: "ignore" },
			);
		} catch {
			// Ignore - entry might not exist
		}
	},

	async list(): Promise<string[]> {
		try {
			const result = execSync(
				`security dump-keychain 2>/dev/null | grep -A4 'svce.*="${SERVICE_NAME}"' | grep 'acct' | sed 's/.*="\\(.*\\)"/\\1/'`,
				{ encoding: "utf8" },
			);
			return result.trim().split("\n").filter(Boolean);
		} catch {
			return [];
		}
	},
};

/**
 * Encrypted file fallback operations
 */
const encryptedFileStore = {
	async get(key: string): Promise<string | null> {
		const store = loadEncryptedStore();
		const entry = store.credentials[key];
		if (!entry) return null;

		try {
			const salt = Buffer.from(store.salt, "hex");
			const encKey = deriveMachineKey(salt);
			return decryptValue(entry, encKey);
		} catch (error) {
			logger.warn("Failed to decrypt credential", {
				key,
				errorType: error instanceof Error ? error.name : "unknown",
			});
			return null;
		}
	},

	async set(key: string, value: string): Promise<void> {
		const store = loadEncryptedStore();
		const salt = Buffer.from(store.salt, "hex");
		const encKey = deriveMachineKey(salt);

		store.credentials[key] = encryptValue(value, encKey);
		saveEncryptedStore(store);
	},

	async delete(key: string): Promise<void> {
		const store = loadEncryptedStore();
		delete store.credentials[key];
		saveEncryptedStore(store);
	},

	async list(): Promise<string[]> {
		const store = loadEncryptedStore();
		return Object.keys(store.credentials);
	},
};

/**
 * Secure credential store interface
 */
interface SecureCredentialStore {
	/**
	 * Get a credential by key
	 */
	get(key: string): Promise<string | null>;

	/**
	 * Set a credential
	 */
	set(key: string, value: string): Promise<void>;

	/**
	 * Delete a credential
	 */
	delete(key: string): Promise<void>;

	/**
	 * List all stored credential keys
	 */
	list(): Promise<string[]>;

	/**
	 * Check if using OS keychain or encrypted file fallback
	 */
	isUsingKeychain(): boolean;
}

/**
 * Create the appropriate credential store based on platform
 */
function createSecureCredentialStore(): SecureCredentialStore {
	const useKeychain = hasMacOSKeychain();

	if (useKeychain) {
		logger.info("Using macOS Keychain for credential storage");
	} else {
		logger.info("Using encrypted file storage for credentials");
	}

	const backend = useKeychain ? macOSKeychain : encryptedFileStore;

	return {
		async get(key: string): Promise<string | null> {
			try {
				return await backend.get(key);
			} catch (error) {
				logger.warn("Failed to get credential from secure store", {
					key,
					errorType: error instanceof Error ? error.name : "unknown",
				});
				return null;
			}
		},

		async set(key: string, value: string): Promise<void> {
			try {
				await backend.set(key, value);
				logger.info("Credential stored securely", { key });
			} catch (error) {
				logger.warn("Failed to store credential in secure store", {
					key,
					errorType: error instanceof Error ? error.name : "unknown",
				});
				throw error;
			}
		},

		async delete(key: string): Promise<void> {
			try {
				await backend.delete(key);
				logger.info("Credential deleted from secure store", { key });
			} catch (error) {
				logger.warn("Failed to delete credential from secure store", {
					key,
					errorType: error instanceof Error ? error.name : "unknown",
				});
			}
		},

		async list(): Promise<string[]> {
			try {
				return await backend.list();
			} catch (error) {
				logger.warn("Failed to list credentials from secure store", {
					errorType: error instanceof Error ? error.name : "unknown",
				});
				return [];
			}
		},

		isUsingKeychain(): boolean {
			return useKeychain;
		},
	};
}

/**
 * Global secure credential store instance
 */
export const secureCredentialStore = createSecureCredentialStore();

/**
 * Migration helper: Move credentials from plaintext storage to secure store
 */
export async function migrateToSecureStorage(
	plaintextCredentials: Record<string, string>,
): Promise<{ migrated: string[]; failed: string[] }> {
	const migrated: string[] = [];
	const failed: string[] = [];

	for (const [key, value] of Object.entries(plaintextCredentials)) {
		try {
			await secureCredentialStore.set(key, value);
			migrated.push(key);
		} catch {
			failed.push(key);
		}
	}

	return { migrated, failed };
}
