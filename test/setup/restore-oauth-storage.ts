import { afterEach, beforeEach } from "vitest";
import { resetOAuthStorageForTests } from "../../src/oauth/storage.js";

/**
 * Global test isolation for OAuth storage.
 *
 * # Why this exists
 *
 * `src/oauth/storage.ts` caches the resolved storage backend
 * (`cachedMode`) at module scope. The first OAuth call in a vitest
 * worker resolves the backend — by default, the OS keychain — and
 * every subsequent test in that worker inherits it. On a developer
 * laptop or CI runner with a stored `evalops` credential, this
 * silently leaks the credential into tests that explicitly cleared
 * env vars to assert the "no token configured" path:
 *
 *   - `mcp-config-write` saw a spurious `evalops` MCP server.
 *   - `mcp-platform-plugin` saw spurious profile headers.
 *   - `prompts/service-client.warns when missing access token` saw
 *     a token-refresh fetch fire when it asserted `not.toHaveBeenCalled`.
 *   - `platform/agent-runtime-client.normalizes…authless A2A` saw an
 *     extra Authorization header on the request.
 *   - `telemetry/meter-service-client.skips remote mirroring when
 *     required meter config is missing` got `true` from
 *     `hasRemoteMeterDestination()` instead of `false`.
 *   - `cli.integration.prints providers summary for filter` got an
 *     undefined command-beacon count.
 *
 * PRs #2752, #2761, #2762, #2763 patched these one by one. Each
 * patch was the same shape:
 *
 *   1. Set `MAESTRO_DISABLE_KEYCHAIN=1` in `beforeEach`.
 *   2. Call `resetOAuthStorageForTests()` to clear `cachedMode`.
 *   3. Save / restore the env in `afterEach`.
 *
 * This setup file lifts that pattern to the worker level so future
 * test files inherit the safe default without having to re-discover
 * the same leak.
 *
 * # Opt-out
 *
 * `test/oauth/keychain-storage.test.ts` exercises the keychain
 * backend itself. It already deletes `MAESTRO_DISABLE_KEYCHAIN` in
 * its own `beforeEach` (which runs after this one) and calls
 * `vi.resetModules()`, so its tests see a fresh keychain-mode
 * resolution. The opt-out works because Vitest runs `setupFiles`
 * hooks before per-file hooks.
 */

let previousDisableKeychain: string | undefined;

beforeEach(() => {
	previousDisableKeychain = process.env.MAESTRO_DISABLE_KEYCHAIN;
	// Force file-mode OAuth resolution unless the test has explicitly
	// chosen otherwise (the keychain-storage suite, for example).
	if (process.env.MAESTRO_DISABLE_KEYCHAIN === undefined) {
		process.env.MAESTRO_DISABLE_KEYCHAIN = "1";
	}
	resetOAuthStorageForTests();
});

afterEach(() => {
	if (previousDisableKeychain === undefined) {
		Reflect.deleteProperty(process.env, "MAESTRO_DISABLE_KEYCHAIN");
	} else {
		process.env.MAESTRO_DISABLE_KEYCHAIN = previousDisableKeychain;
	}
	// `cachedMode` is module-level; clear it on teardown so the next
	// test re-resolves storage mode from its own (restored) env.
	resetOAuthStorageForTests();
});
