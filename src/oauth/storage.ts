import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("oauth:storage");

export interface OAuthCredentials {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	metadata?: Record<string, unknown>;
}

interface OAuthStorageFormat {
	[provider: string]: OAuthCredentials;
}

/**
 * Get path to oauth.json
 */
function getOAuthFilePath(): string {
	const agentDir = process.env.COMPOSER_AGENT_DIR;
	const configDir = agentDir
		? join(agentDir, "..")
		: join(homedir(), ".composer");
	return join(configDir, "oauth.json");
}

/**
 * Ensure the config directory exists
 */
function ensureConfigDir(): void {
	const filePath = getOAuthFilePath();
	const configDir = join(filePath, "..");
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
}

/**
 * Load all OAuth credentials from oauth.json
 */
function loadStorage(): OAuthStorageFormat {
	const filePath = getOAuthFilePath();
	if (!existsSync(filePath)) {
		return {};
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		return JSON.parse(content);
	} catch (error) {
		logger.error(
			"Failed to load OAuth credentials",
			error instanceof Error ? error : undefined,
			{ error: error instanceof Error ? error.message : String(error) },
		);
		return {};
	}
}

/**
 * Save all OAuth credentials to oauth.json
 */
function saveStorage(storage: OAuthStorageFormat): void {
	ensureConfigDir();
	const filePath = getOAuthFilePath();
	writeFileSync(filePath, JSON.stringify(storage, null, 2), "utf-8");
	// Set permissions to owner read/write only
	chmodSync(filePath, 0o600);
}

/**
 * Load OAuth credentials for a specific provider
 */
export function loadOAuthCredentials(
	provider: string,
): OAuthCredentials | null {
	const storage = loadStorage();
	return storage[provider] || null;
}

/**
 * Save OAuth credentials for a specific provider
 */
export function saveOAuthCredentials(
	provider: string,
	creds: OAuthCredentials,
): void {
	const storage = loadStorage();
	storage[provider] = creds;
	saveStorage(storage);
}

/**
 * Remove OAuth credentials for a specific provider
 */
export function removeOAuthCredentials(provider: string): void {
	const storage = loadStorage();
	delete storage[provider];
	saveStorage(storage);
}

/**
 * List all providers with OAuth credentials
 */
export function listOAuthProviders(): string[] {
	const storage = loadStorage();
	return Object.keys(storage);
}
