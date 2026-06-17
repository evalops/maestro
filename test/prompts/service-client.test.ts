import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetOAuthStorageForTests } from "../../src/oauth/storage.js";
import { resolvePromptTemplate } from "../../src/prompts/service-client.js";

const PROMPTS_ENV_KEYS = [
	"PROMPTS_SERVICE_URL",
	"PROMPTS_SERVICE_TOKEN",
	"PROMPTS_SERVICE_ORGANIZATION_ID",
	"PROMPTS_SERVICE_TIMEOUT_MS",
	"PROMPTS_SERVICE_TRANSPORT",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
	"MAESTRO_PROMPTS_SERVICE_URL",
	"MAESTRO_PROMPTS_SERVICE_TOKEN",
	"MAESTRO_PROMPTS_ORGANIZATION_ID",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
	"MAESTRO_HOME",
	"MAESTRO_AGENT_DIR",
	"MAESTRO_DISABLE_KEYCHAIN",
] as const;

describe("prompts service client", () => {
	let previousEnv: Partial<Record<(typeof PROMPTS_ENV_KEYS)[number], string>>;

	beforeEach(() => {
		previousEnv = Object.fromEntries(
			PROMPTS_ENV_KEYS.map((key) => [key, process.env[key]]),
		);
		for (const key of PROMPTS_ENV_KEYS) {
			Reflect.deleteProperty(process.env, key);
		}
		process.env.MAESTRO_HOME = `/tmp/maestro-prompts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		// Force file-mode OAuth storage so the OS keychain (which can
		// hold stale evalops credentials from prior CI runs / dev
		// laptops) does NOT leak a refresh-able token into these
		// tests via `getOAuthToken("evalops")`. Without this, every
		// `resolvePlatformToken` call hits the real identity service
		// in CI.
		process.env.MAESTRO_DISABLE_KEYCHAIN = "1";
		process.env.PROMPTS_SERVICE_URL = "http://prompts.test/";
		process.env.PROMPTS_SERVICE_TOKEN = "prompts-token";
		process.env.PROMPTS_SERVICE_ORGANIZATION_ID = "org_123";
		process.env.PROMPTS_SERVICE_TIMEOUT_MS = "2400";
		vi.unstubAllGlobals();
		resetOAuthStorageForTests();
	});

	afterEach(() => {
		for (const key of PROMPTS_ENV_KEYS) {
			const value = previousEnv[key];
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		// `cachedMode` is a module-level singleton; reset so the next
		// test re-resolves storage mode from its own (restored) env.
		resetOAuthStorageForTests();
	});

	it("resolves a prompt version with org-scoped headers", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://prompts.test/v1/resolve?name=maestro-system&env=production&surface=maestro",
			);
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual(
				expect.objectContaining({
					Authorization: "Bearer prompts-token",
					"X-Organization-ID": "org_123",
				}),
			);
			expect(init?.headers).not.toEqual(
				expect.objectContaining({ "Content-Type": "application/json" }),
			);
			return new Response(
				JSON.stringify({
					version: {
						id: "ver_7",
						version: 7,
						content: "Resolved system instructions",
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await resolvePromptTemplate({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
		});

		expect(result).toEqual({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
			version: 7,
			versionId: "ver_7",
			content: "Resolved system instructions",
		});
	});

	it("resolves prompt versions through the shared Platform Connect endpoint", async () => {
		delete process.env.PROMPTS_SERVICE_URL;
		delete process.env.PROMPTS_SERVICE_TOKEN;
		delete process.env.PROMPTS_SERVICE_ORGANIZATION_ID;
		process.env.PROMPTS_SERVICE_TRANSPORT = "connect";
		process.env.MAESTRO_PLATFORM_BASE_URL = "http://platform.test/";
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "platform-token";
		process.env.MAESTRO_EVALOPS_ORG_ID = "org_platform";

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://platform.test/prompts.v1.PromptService/Resolve",
			);
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual(
				expect.objectContaining({
					Authorization: "Bearer platform-token",
					"Connect-Protocol-Version": "1",
					"Content-Type": "application/json",
					"X-Organization-ID": "org_platform",
				}),
			);
			expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
				name: "maestro-system",
				label: "production",
			});
			return new Response(
				JSON.stringify({
					version: {
						id: "ver_platform_9",
						version: 9,
						content: "Platform resolved system instructions",
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await resolvePromptTemplate({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
		});

		expect(result).toEqual({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
			version: 9,
			versionId: "ver_platform_9",
			content: "Platform resolved system instructions",
		});
	});

	it("returns null when there is no active prompt deployment", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		await expect(
			resolvePromptTemplate({
				name: "maestro-system",
				label: "production",
				surface: "maestro",
			}),
		).resolves.toBeNull();
	});

	it("returns null when prompt service configuration throws before fetch", async () => {
		process.env.PROMPTS_SERVICE_URL = "not a url";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			resolvePromptTemplate({
				name: "maestro-system",
				label: "production",
				surface: "maestro",
			}),
		).resolves.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("warns when configured prompt service is missing an organization id", async () => {
		delete process.env.PROMPTS_SERVICE_ORGANIZATION_ID;
		const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			resolvePromptTemplate({
				name: "maestro-system",
				label: "production",
				surface: "maestro",
			}),
		).resolves.toBeNull();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"Prompts service configured without organization id",
			),
		);
	});

	it("warns when configured prompt service is missing an access token", async () => {
		delete process.env.PROMPTS_SERVICE_TOKEN;
		// Use a unique MAESTRO_HOME per run so stale `oauth.json` /
		// `oauth-providers.json` left by a previous CI run can't leak a
		// stored access token into this assertion's environment. Reset
		// the OAuth storage cache again so the new MAESTRO_HOME is
		// re-resolved on the next access.
		process.env.MAESTRO_HOME = `/tmp/maestro-prompts-test-no-oauth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		process.env.MAESTRO_DISABLE_KEYCHAIN = "1";
		resetOAuthStorageForTests();
		const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			resolvePromptTemplate({
				name: "maestro-system",
				label: "production",
				surface: "maestro",
			}),
		).resolves.toBeNull();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"Prompts service configured without access token",
			),
		);
	});
});
