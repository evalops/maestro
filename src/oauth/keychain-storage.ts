/**
 * OS keychain-backed OAuth credential store (#2611).
 *
 * Uses `@napi-rs/keyring` which dispatches to:
 *   - macOS: Security framework (Keychain)
 *   - Linux: libsecret (GNOME Keyring / KWallet)
 *   - Windows: Credential Manager
 *
 * Per-provider credentials are stored as the JSON-serialized
 * `OAuthCredentials` body, keyed by `(SERVICE_NAME, provider)`. Since
 * the keychain API does not expose enumeration, we keep a tiny
 * registry file at `<configDir>/oauth-providers.json` listing only the
 * provider names that currently have a keychain entry. The registry
 * carries no secrets — its only job is to answer
 * `listOAuthProviders()`.
 *
 * When the OS keychain is unavailable (Linux headless host with no
 * dbus session, sandboxed CI, locked Keychain on macOS), the calling
 * code in `storage.ts` falls back to the plain-file backend.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { getAgentDir } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import { writePrivateFileSync } from "./private-file.js";

const logger = createLogger("oauth:keychain-storage");

const SERVICE_NAME = "maestro-oauth";

export interface OAuthCredentials {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	metadata?: Record<string, unknown>;
}

interface ProviderRegistry {
	providers: string[];
}

function getConfigDir(): string {
	return join(getAgentDir(), "..");
}

function getRegistryPath(): string {
	return join(getConfigDir(), "oauth-providers.json");
}

function ensureConfigDir(): void {
	const dir = getConfigDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
}

function loadRegistry(): ProviderRegistry {
	const path = getRegistryPath();
	if (!existsSync(path)) {
		return { providers: [] };
	}
	try {
		const data = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (
			typeof data === "object" &&
			data !== null &&
			Array.isArray((data as ProviderRegistry).providers)
		) {
			return data as ProviderRegistry;
		}
	} catch (error) {
		logger.warn("Failed to parse OAuth provider registry; treating as empty", {
			path,
			errorType: error instanceof Error ? error.name : "unknown",
		});
	}
	return { providers: [] };
}

function saveRegistry(registry: ProviderRegistry): void {
	ensureConfigDir();
	writePrivateFileSync(getRegistryPath(), JSON.stringify(registry, null, 2));
}

function entryFor(provider: string): Entry {
	return new Entry(SERVICE_NAME, provider);
}

/**
 * Probe whether the OS keychain is actually usable in this process.
 * On Linux without a dbus session, libsecret throws on any operation;
 * on macOS the keychain can be locked. Callers use this to decide
 * whether to engage the keychain backend or fall back to file.
 */
export function isKeychainAvailable(): boolean {
	try {
		const probe = entryFor("__maestro_probe__");
		// `getPassword` for a non-existent entry should return null
		// without throwing on a healthy keychain.
		probe.getPassword();
		return true;
	} catch (error) {
		logger.debug("Keychain probe failed", {
			errorType: error instanceof Error ? error.name : "unknown",
		});
		return false;
	}
}

export function loadOAuthCredentialsKeychain(
	provider: string,
): OAuthCredentials | null {
	try {
		const raw = entryFor(provider).getPassword();
		if (!raw) return null;
		return JSON.parse(raw) as OAuthCredentials;
	} catch (error) {
		logger.warn("Failed to read OAuth credentials from keychain", {
			provider,
			errorType: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
}

export function saveOAuthCredentialsKeychain(
	provider: string,
	creds: OAuthCredentials,
): void {
	const serialized = JSON.stringify(creds);
	entryFor(provider).setPassword(serialized);

	const registry = loadRegistry();
	if (!registry.providers.includes(provider)) {
		registry.providers = [...registry.providers, provider];
		saveRegistry(registry);
	}
}

export function removeOAuthCredentialsKeychain(provider: string): void {
	try {
		entryFor(provider).deletePassword();
	} catch (error) {
		logger.debug("Keychain entry already absent or unreadable", {
			provider,
			errorType: error instanceof Error ? error.name : "unknown",
		});
	}

	const registry = loadRegistry();
	if (registry.providers.includes(provider)) {
		registry.providers = registry.providers.filter((p) => p !== provider);
		saveRegistry(registry);
	}
}

export function listOAuthProvidersKeychain(): string[] {
	return [...loadRegistry().providers];
}
