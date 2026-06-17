import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-memory keychain that stands in for the real OS keychain in tests.
 * Mirrors the `@napi-rs/keyring` Entry surface used by
 * `src/oauth/keychain-storage.ts`.
 */
class InMemoryKeychain {
	private store = new Map<string, string | null>();
	private fail = false;

	failNext(): void {
		this.fail = true;
	}

	entry(service: string, account: string) {
		const key = `${service}::${account}`;
		const self = this;
		return {
			getPassword(): string | null {
				if (self.fail) {
					self.fail = false;
					throw new Error("keychain unavailable");
				}
				return self.store.get(key) ?? null;
			},
			setPassword(value: string): void {
				self.store.set(key, value);
			},
			deletePassword(): void {
				self.store.delete(key);
			},
			getSecret(): Buffer {
				return Buffer.from(self.store.get(key) ?? "");
			},
			setSecret(value: Buffer): void {
				self.store.set(key, value.toString());
			},
			deleteCredential(): boolean {
				return self.store.delete(key);
			},
		};
	}

	clear(): void {
		this.store.clear();
	}

	size(): number {
		return this.store.size;
	}
}

const fakeKeychain = new InMemoryKeychain();

vi.mock("@napi-rs/keyring", () => {
	// Mock as a real class so `new Entry(service, account)` works.
	class Entry {
		private service: string;
		private account: string;
		constructor(service: string, account: string) {
			this.service = service;
			this.account = account;
		}
		private inner() {
			return fakeKeychain.entry(this.service, this.account);
		}
		getPassword() {
			return this.inner().getPassword();
		}
		setPassword(value: string) {
			this.inner().setPassword(value);
		}
		deletePassword() {
			this.inner().deletePassword();
		}
		getSecret() {
			return this.inner().getSecret();
		}
		setSecret(value: Buffer) {
			this.inner().setSecret(value);
		}
		deleteCredential() {
			return this.inner().deleteCredential();
		}
	}
	return { Entry };
});

describe("OAuth storage × keychain backend (#2611)", () => {
	let testHome: string;
	let prevHome: string | undefined;
	let prevMode: string | undefined;
	let prevDisable: string | undefined;

	beforeEach(async () => {
		testHome = mkdtempSync(join(tmpdir(), "maestro-oauth-test-"));
		prevHome = process.env.MAESTRO_HOME;
		prevMode = process.env.MAESTRO_OAUTH_STORAGE_MODE;
		prevDisable = process.env.MAESTRO_DISABLE_KEYCHAIN;
		process.env.MAESTRO_HOME = testHome;
		delete process.env.MAESTRO_OAUTH_STORAGE_MODE;
		delete process.env.MAESTRO_DISABLE_KEYCHAIN;
		fakeKeychain.clear();
		vi.resetModules();
	});

	afterEach(() => {
		if (prevHome === undefined) delete process.env.MAESTRO_HOME;
		else process.env.MAESTRO_HOME = prevHome;
		if (prevMode === undefined) delete process.env.MAESTRO_OAUTH_STORAGE_MODE;
		else process.env.MAESTRO_OAUTH_STORAGE_MODE = prevMode;
		if (prevDisable === undefined) delete process.env.MAESTRO_DISABLE_KEYCHAIN;
		else process.env.MAESTRO_DISABLE_KEYCHAIN = prevDisable;
		if (existsSync(testHome)) {
			rmSync(testHome, { recursive: true, force: true });
		}
	});

	it("round-trips credentials via the keychain in default mode", async () => {
		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		const creds: import("../../src/oauth/storage.js").OAuthCredentials = {
			type: "oauth",
			refresh: "rt-1",
			access: "at-1",
			expires: 1_700_000_000,
			metadata: { scope: "all" },
		};
		storage.saveOAuthCredentials("openai", creds);

		expect(storage.getOAuthStorageModeForTests()).toBe("keychain");
		expect(storage.loadOAuthCredentials("openai")).toEqual(creds);
		expect(storage.listOAuthProviders()).toContain("openai");
	});

	it("removeOAuthCredentials drops the keychain entry and registry row", async () => {
		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		storage.saveOAuthCredentials("openai", {
			type: "oauth",
			refresh: "r",
			access: "a",
			expires: 0,
		});
		expect(storage.listOAuthProviders()).toContain("openai");

		storage.removeOAuthCredentials("openai");
		expect(storage.loadOAuthCredentials("openai")).toBeNull();
		expect(storage.listOAuthProviders()).not.toContain("openai");
	});

	it("MAESTRO_OAUTH_STORAGE_MODE=file forces file backend even with keychain available", async () => {
		process.env.MAESTRO_OAUTH_STORAGE_MODE = "file";
		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		expect(storage.getOAuthStorageModeForTests()).toBe("file");

		storage.saveOAuthCredentials("openai", {
			type: "oauth",
			refresh: "r",
			access: "a",
			expires: 0,
		});
		// Keychain should never have been touched
		expect(fakeKeychain.size()).toBe(0);
		// File should exist
		expect(existsSync(join(testHome, "oauth.json"))).toBe(true);
	});

	it("MAESTRO_DISABLE_KEYCHAIN=1 forces file backend (droid parity)", async () => {
		process.env.MAESTRO_DISABLE_KEYCHAIN = "1";
		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		expect(storage.getOAuthStorageModeForTests()).toBe("file");
	});

	it("falls back to file mode when keychain probe throws", async () => {
		// Make the probe fail. The InMemoryKeychain.failNext only flips
		// for the next call — `isKeychainAvailable` will see the throw
		// during its probe and resolve to file mode.
		fakeKeychain.failNext();
		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		expect(storage.getOAuthStorageModeForTests()).toBe("file");
	});

	it("migrates existing oauth.json into the keychain on first access", async () => {
		// Pre-seed oauth.json with two credentials, as if from before
		// the #2611 upgrade.
		const { writeFileSync, chmodSync } = await import("node:fs");
		writeFileSync(
			join(testHome, "oauth.json"),
			JSON.stringify({
				openai: {
					type: "oauth",
					refresh: "old-r-openai",
					access: "old-a-openai",
					expires: 1,
				},
				"github-copilot": {
					type: "oauth",
					refresh: "old-r-gh",
					access: "old-a-gh",
					expires: 2,
				},
			}),
			"utf-8",
		);
		chmodSync(join(testHome, "oauth.json"), 0o600);

		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		// First read triggers migration.
		const openai = storage.loadOAuthCredentials("openai");
		expect(openai?.refresh).toBe("old-r-openai");
		expect(openai?.access).toBe("old-a-openai");

		// Both entries should be in the keychain now.
		expect(storage.loadOAuthCredentials("github-copilot")?.refresh).toBe(
			"old-r-gh",
		);
		expect(storage.listOAuthProviders().sort()).toEqual([
			"github-copilot",
			"openai",
		]);

		// oauth.json should have been removed.
		expect(existsSync(join(testHome, "oauth.json"))).toBe(false);
		// And the sentinel marking the migration complete should exist.
		expect(existsSync(join(testHome, "oauth.json.migrated"))).toBe(true);
	});

	it("zero-byte / malformed sentinel does NOT suppress migration (round-2-review fix)", async () => {
		const { writeFileSync } = await import("node:fs");
		// Same-UID attacker (or a backup tool restoring a zero-byte
		// sentinel) drops a content-less sentinel file. The original
		// fix used `existsSync` only; with content-validation the
		// migration must still run.
		writeFileSync(join(testHome, "oauth.json.migrated"), "");
		writeFileSync(
			join(testHome, "oauth.json"),
			JSON.stringify({
				openai: {
					type: "oauth",
					refresh: "real-r",
					access: "real-a",
					expires: 0,
				},
			}),
		);

		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		// Migration runs in spite of the malformed sentinel.
		expect(storage.loadOAuthCredentials("openai")?.refresh).toBe("real-r");
		// And the original oauth.json gets cleaned up + a valid
		// sentinel replaces the zero-byte one.
		expect(existsSync(join(testHome, "oauth.json"))).toBe(false);
		expect(existsSync(join(testHome, "oauth.json.migrated"))).toBe(true);
	});

	it("re-migration is skipped after sentinel; reappearing oauth.json is cleaned up (#2611)", async () => {
		const { writeFileSync } = await import("node:fs");
		// Pre-seed the sentinel as if migration completed in a prior
		// run. The sentinel content must satisfy the round-2-review
		// validation: a valid ISO `migratedAt` AND a `version` field.
		writeFileSync(
			join(testHome, "oauth.json.migrated"),
			JSON.stringify({
				version: 1,
				migratedAt: "2026-01-01T00:00:00.000Z",
			}),
		);
		// And stash a stale oauth.json — as if Time Machine or a sync
		// service restored the file after the original migration.
		writeFileSync(
			join(testHome, "oauth.json"),
			JSON.stringify({
				openai: {
					type: "oauth",
					refresh: "STALE-token",
					access: "STALE",
					expires: 0,
				},
			}),
		);

		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		// First call: the stale file should be cleaned up rather than
		// read; the keychain (empty in this scenario) wins.
		expect(storage.loadOAuthCredentials("openai")).toBeNull();
		expect(existsSync(join(testHome, "oauth.json"))).toBe(false);
	});

	it("migration only runs once per process (idempotent on second call)", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(testHome, "oauth.json"),
			JSON.stringify({
				openai: { type: "oauth", refresh: "r", access: "a", expires: 0 },
			}),
		);

		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		storage.loadOAuthCredentials("openai");
		expect(existsSync(join(testHome, "oauth.json"))).toBe(false);

		// Subsequent calls don't try to migrate again — no file to migrate.
		storage.saveOAuthCredentials("anthropic", {
			type: "oauth",
			refresh: "r2",
			access: "a2",
			expires: 0,
		});
		expect(storage.listOAuthProviders().sort()).toEqual([
			"anthropic",
			"openai",
		]);
	});

	// Round-4 review finding on PR #2754: even when `oauth.json` is
	// absent on a keychain-only install, the sentinel must be written
	// eagerly. A backup tool that drops a stale `oauth.json` later
	// must be treated as a stale reappearance (deleted) rather than a
	// fresh migration target — otherwise older file contents could
	// overwrite fresher keychain tokens. These two tests pin the
	// conservative behavior so a future PR doesn't accidentally
	// re-defer the sentinel write again.
	it("pre-writes the sentinel when oauth.json is absent on keychain mode (#2754 round-4)", async () => {
		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();
		storage.loadOAuthCredentials("openai");
		expect(existsSync(join(testHome, "oauth.json.migrated"))).toBe(true);
	});

	it("a stale oauth.json restored after the sentinel write is silently cleaned up", async () => {
		const { writeFileSync } = await import("node:fs");
		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();
		storage.loadOAuthCredentials("openai");
		expect(existsSync(join(testHome, "oauth.json.migrated"))).toBe(true);

		// User saves a fresh credential via the keychain.
		storage.saveOAuthCredentials("anthropic", {
			type: "oauth",
			refresh: "fresh-keychain-r",
			access: "fresh-a",
			expires: 0,
		});

		// A backup tool / Dropbox sync drops a stale oauth.json on
		// disk that claims its own (older) value for `anthropic`. The
		// second process launch must NOT migrate it on top of the
		// keychain — the stale file is deleted and the keychain wins.
		writeFileSync(
			join(testHome, "oauth.json"),
			JSON.stringify({
				anthropic: {
					type: "oauth",
					refresh: "STALE-from-backup",
					access: "STALE",
					expires: 0,
				},
			}),
		);
		storage.resetOAuthStorageForTests();
		expect(storage.loadOAuthCredentials("anthropic")?.refresh).toBe(
			"fresh-keychain-r",
		);
		expect(existsSync(join(testHome, "oauth.json"))).toBe(false);
	});

	// Round-3 review finding on PR #2750: `migrationSentinelIsValid`
	// required a numeric `version >= 1`. Legacy sentinels written by the
	// prior migration fix (only `migratedAt`) were treated as invalid,
	// so after upgrade a restored `oauth.json` would trigger a full
	// re-migration and overwrite fresher keychain tokens with stale
	// plaintext. Sentinels with no `version` field are now accepted;
	// invalid `version` values are still rejected.
	it("accepts legacy sentinels that omit the version field (#2750 round-3)", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(testHome, "oauth.json.migrated"),
			JSON.stringify({ migratedAt: "2026-01-01T00:00:00.000Z" }),
		);
		writeFileSync(
			join(testHome, "oauth.json"),
			JSON.stringify({
				openai: {
					type: "oauth",
					refresh: "STALE-token",
					access: "STALE",
					expires: 0,
				},
			}),
		);

		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		// Legacy sentinel is honored: migration is skipped and the
		// stale oauth.json is cleaned up rather than read.
		expect(storage.loadOAuthCredentials("openai")).toBeNull();
		expect(existsSync(join(testHome, "oauth.json"))).toBe(false);
	});

	it("still rejects sentinels with an invalid version field", async () => {
		const { writeFileSync } = await import("node:fs");
		// Explicit non-numeric version → invalid → migration runs.
		writeFileSync(
			join(testHome, "oauth.json.migrated"),
			JSON.stringify({
				migratedAt: "2026-01-01T00:00:00.000Z",
				version: "not-a-number",
			}),
		);
		writeFileSync(
			join(testHome, "oauth.json"),
			JSON.stringify({
				openai: { type: "oauth", refresh: "r", access: "a", expires: 0 },
			}),
		);

		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		// Migration ran: keychain has the credentials.
		expect(storage.loadOAuthCredentials("openai")?.refresh).toBe("r");
	});

	it("the registry file carries no secret material", async () => {
		const storage = await import("../../src/oauth/storage.js");
		storage.resetOAuthStorageForTests();

		storage.saveOAuthCredentials("openai", {
			type: "oauth",
			refresh: "should-not-leak-rt",
			access: "should-not-leak-at",
			expires: 0,
		});

		const { readFileSync } = await import("node:fs");
		const registryPath = join(testHome, "oauth-providers.json");
		expect(existsSync(registryPath)).toBe(true);
		const registry = readFileSync(registryPath, "utf-8");
		expect(registry).toContain("openai");
		expect(registry).not.toContain("should-not-leak-rt");
		expect(registry).not.toContain("should-not-leak-at");
	});
});
