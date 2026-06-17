/**
 * OAuth credential storage. Backed by either:
 *
 *   - **OS keychain** (default): macOS Keychain, libsecret on Linux,
 *     Credential Manager on Windows. Implemented in
 *     `./keychain-storage.ts` using `@napi-rs/keyring`.
 *   - **Plain file**: `~/.maestro/oauth.json` (mode 0o600). The
 *     fallback for headless CI / sandboxed builds where the keychain
 *     is unavailable, and for users who explicitly opt out.
 *
 * Mode selection (#2611):
 *
 *   - `MAESTRO_OAUTH_STORAGE_MODE=keychain` — force keychain. Errors
 *     are surfaced.
 *   - `MAESTRO_OAUTH_STORAGE_MODE=file` — force file mode.
 *   - `MAESTRO_DISABLE_KEYCHAIN=1` — same as `file`, present for
 *     parity with droid's `FACTORY_DISABLE_KEYRING`.
 *   - Default: try keychain; if `isKeychainAvailable()` returns
 *     false, log once and use file mode for this process.
 *
 * One-time migration: the first time we successfully load the
 * keychain backend, if `~/.maestro/oauth.json` exists with entries,
 * we migrate them into the keychain and then `chmod 0` + `rm` the
 * file. The migration is idempotent — re-running on an empty/missing
 * file is a no-op.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config/constants.js";
import { readJsonFile, writeTextFileAtomic } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import {
	type OAuthCredentials,
	isKeychainAvailable,
	listOAuthProvidersKeychain,
	loadOAuthCredentialsKeychain,
	removeOAuthCredentialsKeychain,
	saveOAuthCredentialsKeychain,
} from "./keychain-storage.js";
import { writePrivateFileSync } from "./private-file.js";

const logger = createLogger("oauth:storage");

export type { OAuthCredentials };

type StorageMode = "keychain" | "file";

interface OAuthStorageFormat {
	[provider: string]: OAuthCredentials;
}

let oauthStorageRevision = 0;

export function getOAuthStorageRevision(): number {
	return oauthStorageRevision;
}

function getOAuthFilePath(): string {
	const configDir = join(getAgentDir(), "..");
	return join(configDir, "oauth.json");
}

function ensureConfigDir(): void {
	const filePath = getOAuthFilePath();
	const configDir = join(filePath, "..");
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
}

function loadFileStorage(): OAuthStorageFormat {
	const filePath = getOAuthFilePath();
	if (!existsSync(filePath)) {
		return {};
	}
	// Rotate-on-parse-fail (#2631 follow-up from adversarial review):
	// silently overwriting a corrupt oauth.json with `{}` would let
	// the next save delete every other provider's tokens. Rotate the
	// bad file aside as evidence so the corruption is visible in
	// monitoring and the original bytes survive for recovery.
	return readJsonFile<OAuthStorageFormat>(filePath, {
		fallback: {},
		rotateOnParseFail: true,
	});
}

function saveFileStorage(storage: OAuthStorageFormat): void {
	ensureConfigDir();
	writePrivateFileSync(getOAuthFilePath(), JSON.stringify(storage, null, 2));
}

/**
 * Resolve the storage mode for THIS process based on env. Cached for
 * the lifetime of the process so we don't re-probe the keychain on
 * every read.
 */
let cachedMode: StorageMode | null = null;
let migrationAttempted = false;

function resolveStorageMode(): StorageMode {
	if (cachedMode) return cachedMode;

	const envMode = process.env.MAESTRO_OAUTH_STORAGE_MODE?.toLowerCase();
	const explicitDisable = process.env.MAESTRO_DISABLE_KEYCHAIN === "1";

	if (envMode === "file" || explicitDisable) {
		cachedMode = "file";
		logger.debug("OAuth storage: file mode (explicit)");
		return cachedMode;
	}

	if (envMode === "keychain") {
		// Force keychain even if the probe fails — surfaces a real error
		// when the user really wants keychain (rather than silently
		// falling back to plaintext).
		cachedMode = "keychain";
		logger.debug("OAuth storage: keychain mode (explicit)");
		return cachedMode;
	}

	// Default: try keychain, fall back to file if unavailable.
	if (isKeychainAvailable()) {
		cachedMode = "keychain";
		logger.debug("OAuth storage: keychain mode (auto-detected)");
	} else {
		cachedMode = "file";
		logger.info(
			"OAuth storage: keychain unavailable, falling back to ~/.maestro/oauth.json",
		);
	}
	return cachedMode;
}

/**
 * Sentinel file written once after every provider in `oauth.json`
 * has been migrated to the keychain. Its existence means "do not
 * attempt to re-migrate" — even if `oauth.json` is somehow
 * recreated by a backup tool or sync service, we won't re-read
 * stale credentials from it.
 *
 * The adversarial review (#2611) flagged the original migration
 * window: between the last `saveOAuthCredentialsKeychain` and the
 * `safelyRemoveOauthFile` call, a crash could leave the file on
 * disk; the next launch would re-migrate, potentially overwriting
 * keychain entries that had since been refreshed with stale tokens.
 * The sentinel closes that window — it is written atomically before
 * the file is removed, so once it exists we know the migration
 * succeeded and never repeat it.
 */
function getMigrationSentinelPath(): string {
	return `${getOAuthFilePath()}.migrated`;
}

const SENTINEL_VERSION = 1;

/**
 * Validate that the sentinel file actually contains a well-formed
 * migration record. A bare `existsSync` check is content-blind — a
 * round-2-review finding noted that a same-UID attacker (or a backup
 * tool restoring a zero-byte sentinel from a botched prior attempt)
 * could touch the sentinel and permanently suppress migration AND
 * trigger plaintext-file deletion of a legitimate reappeared
 * `oauth.json`, destroying tokens. We now require the sentinel JSON
 * to parse and carry a valid `migratedAt` timestamp + version.
 */
function migrationSentinelIsValid(): boolean {
	const sentinelPath = getMigrationSentinelPath();
	if (!existsSync(sentinelPath)) return false;
	try {
		const raw = readFileSync(sentinelPath, "utf-8");
		if (!raw.trim()) return false;
		const parsed = JSON.parse(raw) as {
			migratedAt?: unknown;
			version?: unknown;
		};
		if (typeof parsed.migratedAt !== "string") return false;
		if (Number.isNaN(Date.parse(parsed.migratedAt))) return false;
		// Legacy sentinels written by the original migration fix didn't
		// carry a `version` field. Accept them as valid so an upgrade to
		// the version-aware check doesn't silently treat them as missing
		// and re-trigger a full migration that could overwrite fresher
		// keychain tokens with stale plaintext from a restored
		// `oauth.json` (round-3 review finding on PR #2750). An *invalid*
		// `version` value (wrong type or `< 1`) is still rejected.
		if (parsed.version !== undefined) {
			if (typeof parsed.version !== "number" || parsed.version < 1) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * If keychain mode is active and `oauth.json` still has plaintext
 * entries from before this change, migrate them into the keychain
 * and then chmod-0 + delete the file. Idempotent: a sentinel marker
 * is written when migration completes so subsequent process launches
 * skip the work even if `oauth.json` reappears (e.g. restored from
 * backup).
 */
function maybeMigrateFileToKeychain(): void {
	if (migrationAttempted) return;
	migrationAttempted = true;

	if (resolveStorageMode() !== "keychain") return;

	// If we previously completed migration, don't touch the file path
	// again — even if a copy of `oauth.json` reappears (Time Machine
	// restore, Dropbox sync, etc.) we won't read stale credentials
	// from it and clobber the keychain.
	//
	// The sentinel content is validated (not just present) so a
	// touched or zero-byte sentinel cannot suppress migration. If the
	// sentinel exists but is malformed, treat it as absent and rerun
	// migration (saveOAuthCredentialsKeychain is idempotent).
	if (migrationSentinelIsValid()) {
		// Clean up any stray oauth.json that reappeared after the
		// migration completed. Best-effort.
		const filePath = getOAuthFilePath();
		if (existsSync(filePath)) {
			logger.warn("oauth.json reappeared after migration; removing", {
				filePath,
			});
			safelyRemoveOauthFile(filePath);
		}
		return;
	}

	const filePath = getOAuthFilePath();
	if (!existsSync(filePath)) {
		// Nothing to migrate, but write the sentinel so a future
		// reappearing file gets cleaned up rather than re-migrated.
		// Round-4 review finding on PR #2754 confirmed this protection
		// is load-bearing: a backup tool dropping a stale `oauth.json`
		// on a keychain-only install must NOT be allowed to overwrite
		// fresher keychain tokens with older file contents. The
		// trade-off is that a user who genuinely wants to restore an
		// `oauth.json` from backup must clear the sentinel first
		// (delete `oauth.json.migrated`) before launch.
		writeMigrationSentinel();
		return;
	}

	let entries: OAuthStorageFormat;
	try {
		entries = loadFileStorage();
	} catch {
		return;
	}

	const providers = Object.keys(entries);
	if (providers.length === 0) {
		// Empty file — just remove it and mark complete.
		safelyRemoveOauthFile(filePath);
		writeMigrationSentinel();
		return;
	}

	logger.info("Migrating OAuth credentials from oauth.json to OS keychain", {
		count: providers.length,
	});
	for (const provider of providers) {
		const creds = entries[provider];
		if (!creds) continue;
		try {
			saveOAuthCredentialsKeychain(provider, creds);
		} catch (error) {
			logger.warn(
				"Failed to migrate provider to keychain; keeping file backend for this provider",
				{
					provider,
					errorType: error instanceof Error ? error.name : "unknown",
				},
			);
			// Bail out — leaving the file intact is safer than a
			// partial migration. The user can rerun after fixing
			// keychain access.
			return;
		}
	}

	// CRITICAL ORDER (adversarial review #2611):
	//   1. Write the sentinel FIRST so a crash here leaves us in the
	//      "migration succeeded" state. Worst case: the file remains
	//      and is cleaned up on next launch.
	//   2. Remove the plaintext file.
	// Doing this in the opposite order is the original bug: a crash
	// after rm but before sentinel would re-migrate stale tokens
	// from any backup-restored file on the next launch.
	writeMigrationSentinel();
	safelyRemoveOauthFile(filePath);
}

function writeMigrationSentinel(): void {
	const sentinelPath = getMigrationSentinelPath();
	try {
		writeTextFileAtomic(
			sentinelPath,
			`${JSON.stringify(
				{
					version: SENTINEL_VERSION,
					migratedAt: new Date().toISOString(),
				},
				null,
				2,
			)}\n`,
			{ encoding: "utf-8", mode: 0o600 },
		);
	} catch (error) {
		logger.warn("Failed to write OAuth migration sentinel", {
			sentinelPath,
			errorType: error instanceof Error ? error.name : "unknown",
		});
	}
}

function safelyRemoveOauthFile(filePath: string): void {
	// Adversarial-review fix: previously the order was `chmod 0o000`
	// then `rmSync`. If chmod succeeded but rmSync failed (read-only
	// mount, immutable bit), the file was left on disk with mode
	// 0o000 — unreadable to the user, requiring sudo to recover their
	// OAuth state. Now we rmSync first; if that fails, restore the
	// 0o600 mode so the file is at least readable to the owner.
	try {
		rmSync(filePath, { force: true });
		logger.info("Removed migrated oauth.json", { filePath });
		return;
	} catch (error) {
		logger.warn("Failed to remove migrated oauth.json", {
			filePath,
			errorType: error instanceof Error ? error.name : "unknown",
		});
	}
	try {
		chmodSync(filePath, 0o600);
	} catch {
		// Best-effort — the file is already migrated to the keychain.
	}
}

export function loadOAuthCredentials(
	provider: string,
): OAuthCredentials | null {
	maybeMigrateFileToKeychain();
	if (resolveStorageMode() === "keychain") {
		return loadOAuthCredentialsKeychain(provider);
	}
	const storage = loadFileStorage();
	return storage[provider] || null;
}

export function saveOAuthCredentials(
	provider: string,
	creds: OAuthCredentials,
): void {
	maybeMigrateFileToKeychain();
	if (resolveStorageMode() === "keychain") {
		saveOAuthCredentialsKeychain(provider, creds);
		oauthStorageRevision += 1;
		return;
	}
	const storage = loadFileStorage();
	storage[provider] = creds;
	saveFileStorage(storage);
	oauthStorageRevision += 1;
}

export function removeOAuthCredentials(provider: string): void {
	maybeMigrateFileToKeychain();
	if (resolveStorageMode() === "keychain") {
		removeOAuthCredentialsKeychain(provider);
		oauthStorageRevision += 1;
		return;
	}
	const storage = loadFileStorage();
	delete storage[provider];
	saveFileStorage(storage);
	oauthStorageRevision += 1;
}

export function listOAuthProviders(): string[] {
	maybeMigrateFileToKeychain();
	if (resolveStorageMode() === "keychain") {
		return listOAuthProvidersKeychain();
	}
	const storage = loadFileStorage();
	return Object.keys(storage);
}

/** Test helper — reset mode/migration cache. */
export function resetOAuthStorageForTests(): void {
	cachedMode = null;
	migrationAttempted = false;
	oauthStorageRevision = 0;
}

/** Test helper — expose the active mode. */
export function getOAuthStorageModeForTests(): StorageMode {
	return resolveStorageMode();
}
