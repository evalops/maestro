import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("OpenAI OAuth credential refresh", () => {
	const originalAgentDir = process.env.MAESTRO_AGENT_DIR;
	const originalOAuthFile = process.env.OPENAI_OAUTH_FILE;
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "maestro-openai-oauth-refresh-"));
		process.env.MAESTRO_AGENT_DIR = join(testDir, "agent");
		process.env.OPENAI_OAUTH_FILE = join(testDir, "openai-oauth.json");
		vi.resetModules();
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_AGENT_DIR");
		} else {
			process.env.MAESTRO_AGENT_DIR = originalAgentDir;
		}
		if (originalOAuthFile === undefined) {
			Reflect.deleteProperty(process.env, "OPENAI_OAUTH_FILE");
		} else {
			process.env.OPENAI_OAUTH_FILE = originalOAuthFile;
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("deletes stored credentials when a successful refresh response is malformed", async () => {
		const auth = await import("../../src/providers/openai-auth.js");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ refresh_token: "still-invalid" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await auth.saveOpenAIOAuthCredential({
			accessToken: "expired-access",
			refreshToken: "stale-refresh",
			idToken: "id-token",
			expiresAt: Date.now() - 1000,
			mode: "openai-oauth",
		});

		await expect(auth.getFreshOpenAIOAuthCredential()).resolves.toBeNull();
		await expect(auth.getStoredOpenAIOAuthCredential()).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("preserves stored credentials when refresh hits a transient network error", async () => {
		const auth = await import("../../src/providers/openai-auth.js");
		const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await auth.saveOpenAIOAuthCredential({
			accessToken: "expired-access-token",
			refreshToken: "retryable-refresh-token",
			idToken: "id-token",
			expiresAt: Date.now() - 1_000,
			mode: "openai-oauth",
		});

		await expect(auth.getFreshOpenAIOAuthCredential()).resolves.toBeNull();
		await expect(auth.getStoredOpenAIOAuthCredential()).resolves.toMatchObject({
			accessToken: "expired-access-token",
			refreshToken: "retryable-refresh-token",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
