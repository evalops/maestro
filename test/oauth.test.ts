import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Set up test directory before importing modules
const testDir = join(tmpdir(), `composer-oauth-test-${Date.now()}`);
process.env.MAESTRO_AGENT_DIR = join(testDir, "agent");

import { resetFeatureFlagCacheForTests } from "../src/config/feature-flags.js";
import {
	type SupportedOAuthProvider,
	buildEvalOpsDelegationEnvironment,
	getOAuthProviders,
	getOAuthToken,
	hasOAuthCredentials,
	issueEvalOpsDelegationToken,
	login,
	logout,
} from "../src/oauth/index.js";
import {
	listOAuthProviders,
	loadOAuthCredentials,
	removeOAuthCredentials,
	saveOAuthCredentials,
} from "../src/oauth/storage.js";

const TEST_DELEGATED_ACCESS_VALUE = "child-test";

describe("OAuth Storage", () => {
	beforeEach(() => {
		process.env.MAESTRO_AGENT_DIR = join(testDir, "agent");
		// Create test directory
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should save and load OAuth credentials", () => {
		const creds = {
			type: "oauth" as const,
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600000,
			metadata: { mode: "pro" },
		};

		saveOAuthCredentials("test-provider", creds);
		const loaded = loadOAuthCredentials("test-provider");

		expect(loaded).not.toBeNull();
		expect(loaded?.access).toBe("test-access-token");
		expect(loaded?.refresh).toBe("test-refresh-token");
		expect(loaded?.metadata?.mode).toBe("pro");
	});

	it("should return null for non-existent provider", () => {
		const loaded = loadOAuthCredentials("non-existent");
		expect(loaded).toBeNull();
	});

	it("should remove OAuth credentials", () => {
		const creds = {
			type: "oauth" as const,
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600000,
		};

		saveOAuthCredentials("test-provider", creds);
		expect(loadOAuthCredentials("test-provider")).not.toBeNull();

		removeOAuthCredentials("test-provider");
		expect(loadOAuthCredentials("test-provider")).toBeNull();
	});

	it("should list all OAuth providers with credentials", () => {
		saveOAuthCredentials("provider1", {
			type: "oauth",
			access: "token1",
			refresh: "refresh1",
			expires: Date.now() + 3600000,
		});
		saveOAuthCredentials("provider2", {
			type: "oauth",
			access: "token2",
			refresh: "refresh2",
			expires: Date.now() + 3600000,
		});

		const providers = listOAuthProviders();
		expect(providers).toContain("provider1");
		expect(providers).toContain("provider2");
		expect(providers.length).toBe(2);
	});

	it("should handle corrupted storage file gracefully", () => {
		// Create corrupted oauth.json
		const oauthPath = join(testDir, "oauth.json");
		mkdirSync(testDir, { recursive: true });
		writeFileSync(oauthPath, "{ invalid json }");

		// Should return null, not throw
		const loaded = loadOAuthCredentials("any-provider");
		expect(loaded).toBeNull();
	});
});

describe("OAuth Index", () => {
	const originalEvalOpsOrgId = process.env.MAESTRO_EVALOPS_ORG_ID;
	const originalEvalOpsOrganizationId = process.env.EVALOPS_ORGANIZATION_ID;
	const originalEvalOpsIdentityUrl = process.env.EVALOPS_IDENTITY_URL;
	const originalFeatureFlagsPath = process.env.EVALOPS_FEATURE_FLAGS_PATH;
	const originalFetch = global.fetch;
	const originalIdentityUrl = process.env.MAESTRO_IDENTITY_URL;
	const originalPlatformBaseUrl = process.env.MAESTRO_PLATFORM_BASE_URL;

	beforeEach(() => {
		process.env.MAESTRO_AGENT_DIR = join(testDir, "agent");
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (originalEvalOpsOrgId === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_EVALOPS_ORG_ID");
		} else {
			process.env.MAESTRO_EVALOPS_ORG_ID = originalEvalOpsOrgId;
		}
		if (originalEvalOpsOrganizationId === undefined) {
			Reflect.deleteProperty(process.env, "EVALOPS_ORGANIZATION_ID");
		} else {
			process.env.EVALOPS_ORGANIZATION_ID = originalEvalOpsOrganizationId;
		}
		if (originalEvalOpsIdentityUrl === undefined) {
			Reflect.deleteProperty(process.env, "EVALOPS_IDENTITY_URL");
		} else {
			process.env.EVALOPS_IDENTITY_URL = originalEvalOpsIdentityUrl;
		}
		if (originalFeatureFlagsPath === undefined) {
			Reflect.deleteProperty(process.env, "EVALOPS_FEATURE_FLAGS_PATH");
		} else {
			process.env.EVALOPS_FEATURE_FLAGS_PATH = originalFeatureFlagsPath;
		}
		if (originalIdentityUrl === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_IDENTITY_URL");
		} else {
			process.env.MAESTRO_IDENTITY_URL = originalIdentityUrl;
		}
		if (originalPlatformBaseUrl === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_PLATFORM_BASE_URL");
		} else {
			process.env.MAESTRO_PLATFORM_BASE_URL = originalPlatformBaseUrl;
		}
		resetFeatureFlagCacheForTests();
		global.fetch = originalFetch;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("getOAuthProviders", () => {
		it("should return all supported providers", () => {
			const providers = getOAuthProviders();

			expect(providers).toHaveLength(6);
			expect(providers.map((p) => p.id)).toContain("anthropic");
			expect(providers.map((p) => p.id)).toContain("evalops");
			expect(providers.map((p) => p.id)).toContain("openai");
			expect(providers.map((p) => p.id)).toContain("github-copilot");
			expect(providers.map((p) => p.id)).toContain("google-gemini-cli");
			expect(providers.map((p) => p.id)).toContain("google-antigravity");
		});

		it("should mark all providers as available", () => {
			const providers = getOAuthProviders();

			for (const provider of providers) {
				expect(provider.available).toBe(true);
			}
		});

		it("marks evalops unavailable when the kill switch is enabled", () => {
			const path = join(testDir, "flags.json");
			writeFileSync(
				path,
				JSON.stringify({
					flags: [
						{
							key: "platform.kill_switches.maestro.evalops_managed",
							enabled: true,
						},
					],
				}),
			);
			process.env.EVALOPS_FEATURE_FLAGS_PATH = path;
			resetFeatureFlagCacheForTests();

			const providers = getOAuthProviders();
			expect(providers.find((provider) => provider.id === "evalops")).toEqual(
				expect.objectContaining({ available: false }),
			);
		});
	});

	describe("hasOAuthCredentials", () => {
		it("should return false when no credentials exist", () => {
			expect(hasOAuthCredentials("anthropic")).toBe(false);
			expect(hasOAuthCredentials("evalops")).toBe(false);
			expect(hasOAuthCredentials("openai")).toBe(false);
			expect(hasOAuthCredentials("github-copilot")).toBe(false);
			expect(hasOAuthCredentials("google-gemini-cli")).toBe(false);
			expect(hasOAuthCredentials("google-antigravity")).toBe(false);
		});

		it("should return true when credentials exist", () => {
			saveOAuthCredentials("anthropic", {
				type: "oauth",
				access: "test-token",
				refresh: "test-refresh",
				expires: Date.now() + 3600000,
			});

			expect(hasOAuthCredentials("anthropic")).toBe(true);
			expect(hasOAuthCredentials("openai")).toBe(false);
		});
	});

	describe("logout", () => {
		it("should remove credentials for provider", async () => {
			saveOAuthCredentials("anthropic", {
				type: "oauth",
				access: "test-token",
				refresh: "test-refresh",
				expires: Date.now() + 3600000,
			});

			expect(hasOAuthCredentials("anthropic")).toBe(true);

			await logout("anthropic");

			expect(hasOAuthCredentials("anthropic")).toBe(false);
		});

		it("should revoke EvalOps credentials before removing them", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ revoked: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			vi.stubGlobal("fetch", fetchMock);

			saveOAuthCredentials("evalops", {
				type: "oauth",
				access: "evalops-access",
				refresh: "evalops-refresh",
				expires: Date.now() + 3600000,
				metadata: {
					identityBaseUrl: "https://identity.evalops.test",
					organizationId: "org_123",
				},
			});

			await logout("evalops");

			expect(hasOAuthCredentials("evalops")).toBe(false);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] ?? [];
			expect(url).toBe("https://identity.evalops.test/v1/tokens/revoke");
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				"Content-Type": "application/json",
			});
			expect(init?.body).toBe(
				JSON.stringify({ refresh_token: "evalops-refresh" }),
			);
		});

		it("should still remove EvalOps credentials when revoke fails", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: "upstream_error" }), {
					status: 502,
					headers: { "Content-Type": "application/json" },
				}),
			);
			vi.stubGlobal("fetch", fetchMock);

			saveOAuthCredentials("evalops", {
				type: "oauth",
				access: "evalops-access",
				refresh: "evalops-refresh",
				expires: Date.now() + 3600000,
				metadata: {
					identityBaseUrl: "https://identity.evalops.test",
				},
			});

			await logout("evalops");

			expect(hasOAuthCredentials("evalops")).toBe(false);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});

	describe("getOAuthToken", () => {
		it("should return null when no credentials exist", async () => {
			const token = await getOAuthToken("anthropic");
			expect(token).toBeNull();
		});

		it("should return access token when not expired", async () => {
			saveOAuthCredentials("anthropic", {
				type: "oauth",
				access: "valid-access-token",
				refresh: "test-refresh",
				expires: Date.now() + 3600000, // 1 hour from now
			});

			const token = await getOAuthToken("anthropic");
			expect(token).toBe("valid-access-token");
		});

		it("should remove credentials and return null when refresh fails for expired token", async () => {
			// Save expired credentials
			saveOAuthCredentials("anthropic", {
				type: "oauth",
				access: "expired-token",
				refresh: "invalid-refresh",
				expires: Date.now() - 1000, // Already expired
			});

			// The refresh will fail (no mock for the API), credentials should be removed
			const token = await getOAuthToken("anthropic");
			expect(token).toBeNull();
			expect(hasOAuthCredentials("anthropic")).toBe(false);
		});

		it("should refresh EvalOps credentials when the access token expires", async () => {
			const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
			const refreshExpiresAt = new Date(
				Date.now() + 7 * 24 * 60 * 60 * 1000,
			).toISOString();
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						access_token: "new-evalops-access",
						expires_at: expiresAt,
						organization_id: "org_123",
						refresh_expires_at: refreshExpiresAt,
						refresh_token: "new-evalops-refresh",
						scopes: ["llm_gateway:invoke"],
						token_type: "Bearer",
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
			vi.stubGlobal("fetch", fetchMock);

			saveOAuthCredentials("evalops", {
				type: "oauth",
				access: "expired-access",
				refresh: "old-evalops-refresh",
				expires: Date.now() - 1000,
				metadata: {
					identityBaseUrl: "https://identity.evalops.test",
					organizationId: "org_123",
					providerRef: {
						provider: "openai",
						environment: "prod",
					},
					scopes: ["llm_gateway:invoke"],
				},
			});

			const token = await getOAuthToken("evalops");
			expect(token).toBe("new-evalops-access");

			const saved = loadOAuthCredentials("evalops");
			expect(saved).not.toBeNull();
			expect(saved?.access).toBe("new-evalops-access");
			expect(saved?.refresh).toBe("new-evalops-refresh");
			expect(saved?.metadata?.organizationId).toBe("org_123");
			expect(saved?.metadata?.refreshExpiresAt).toBeTypeOf("number");
			expect(saved?.metadata?.providerRef).toEqual({
				provider: "openai",
				environment: "prod",
			});

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] ?? [];
			expect(url).toBe("https://identity.evalops.test/v1/tokens/refresh");
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				"Content-Type": "application/json",
			});
			expect(init?.body).toBe(
				JSON.stringify({ refresh_token: "old-evalops-refresh" }),
			);
		});
	});

	describe("login", () => {
		it("rejects evalops login when the managed gateway kill switch is enabled", async () => {
			const path = join(testDir, "flags.json");
			writeFileSync(
				path,
				JSON.stringify({
					flags: [
						{
							key: "platform.kill_switches.maestro.evalops_managed",
							enabled: true,
						},
					],
				}),
			);
			process.env.EVALOPS_FEATURE_FLAGS_PATH = path;
			process.env.MAESTRO_EVALOPS_ORG_ID = "org_123";
			resetFeatureFlagCacheForTests();

			await expect(
				login("evalops", {
					onAuthUrl: () => {},
					onStatus: () => {},
				}),
			).rejects.toThrow(/disabled by dynamic config/);
		});
	});

	describe("EvalOps delegation tokens", () => {
		it("issues a narrowed delegation token from stored EvalOps credentials", async () => {
			const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						agent_id: "agent-child-1",
						expires_at: expiresAt,
						run_id: "run-child-1",
						scopes_denied: ["admin:all"],
						scopes_granted: ["llm_gateway:invoke", "memory:write"],
						scopes_requested: [
							"llm_gateway:invoke",
							"memory:write",
							"admin:all",
						],
						token: TEST_DELEGATED_ACCESS_VALUE,
						token_type: "Bearer",
					}),
					{
						status: 201,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
			vi.stubGlobal("fetch", fetchMock);

			saveOAuthCredentials("evalops", {
				type: "oauth",
				access: "parent-access-token",
				refresh: "parent-refresh-token",
				expires: Date.now() + 60 * 60 * 1000,
				metadata: {
					identityBaseUrl: "https://identity.evalops.test",
					organizationId: "org_123",
					providerRef: {
						provider: "openai",
						environment: "prod",
						credential_name: "managed-openai",
						team_id: "team_456",
					},
				},
			});

			const result = await issueEvalOpsDelegationToken({
				agentId: "agent-child-1",
				agentType: "coder",
				capabilities: ["write", "bash"],
				runId: "run-child-1",
				scopes: ["llm_gateway:invoke", "memory:write", "admin:all"],
				surface: "maestro-subagent",
				ttlSeconds: 900,
			});

			expect(result).toEqual({
				agentId: "agent-child-1",
				expiresAt: Date.parse(expiresAt),
				organizationId: "org_123",
				providerRef: {
					provider: "openai",
					environment: "prod",
					credential_name: "managed-openai",
					team_id: "team_456",
				},
				runId: "run-child-1",
				scopesDenied: ["admin:all"],
				scopesGranted: ["llm_gateway:invoke", "memory:write"],
				scopesRequested: ["llm_gateway:invoke", "memory:write", "admin:all"],
				token: TEST_DELEGATED_ACCESS_VALUE,
				tokenType: "Bearer",
			});

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] ?? [];
			expect(url).toBe("https://identity.evalops.test/v1/delegation-tokens");
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				Authorization: "Bearer parent-access-token",
				"Content-Type": "application/json",
			});
			expect(init?.body).toBe(
				JSON.stringify({
					agent_id: "agent-child-1",
					agent_type: "coder",
					capabilities: ["write", "bash"],
					run_id: "run-child-1",
					scopes: ["llm_gateway:invoke", "memory:write", "admin:all"],
					surface: "maestro-subagent",
					ttl_seconds: 900,
				}),
			);
		});

		it("uses the shared Platform base URL when no identity-specific base is configured", async () => {
			const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						agent_id: "agent-child-1",
						expires_at: expiresAt,
						run_id: "run-child-1",
						scopes_granted: ["llm_gateway:invoke"],
						scopes_requested: ["llm_gateway:invoke"],
						token: TEST_DELEGATED_ACCESS_VALUE,
						token_type: "Bearer",
					}),
					{
						status: 201,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
			vi.stubGlobal("fetch", fetchMock);
			vi.stubEnv("MAESTRO_IDENTITY_URL", "");
			vi.stubEnv("EVALOPS_IDENTITY_URL", "");
			vi.stubEnv("MAESTRO_PLATFORM_BASE_URL", "https://platform.evalops.test/");

			saveOAuthCredentials("evalops", {
				type: "oauth",
				access: "parent-access-token",
				refresh: "parent-refresh-token",
				expires: Date.now() + 60 * 60 * 1000,
				metadata: {
					organizationId: "org_123",
					providerRef: {
						provider: "openai",
						environment: "prod",
					},
				},
			});

			await expect(
				issueEvalOpsDelegationToken({
					agentId: "agent-child-1",
					agentType: "coder",
					runId: "run-child-1",
					scopes: ["llm_gateway:invoke"],
					surface: "maestro-subagent",
				}),
			).resolves.toEqual(
				expect.objectContaining({
					token: TEST_DELEGATED_ACCESS_VALUE,
				}),
			);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url] = fetchMock.mock.calls[0] ?? [];
			expect(url).toBe("https://platform.evalops.test/v1/delegation-tokens");
		});

		it("materializes child environment overrides for delegated EvalOps auth", () => {
			const env = buildEvalOpsDelegationEnvironment({
				organizationId: "org_123",
				providerRef: {
					provider: "openai",
					environment: "prod",
					credential_name: "managed-openai",
					team_id: "team_456",
				},
				token: TEST_DELEGATED_ACCESS_VALUE,
			});

			expect(env).toEqual({
				MAESTRO_EVALOPS_ACCESS_TOKEN: TEST_DELEGATED_ACCESS_VALUE,
				MAESTRO_EVALOPS_CREDENTIAL_NAME: "managed-openai",
				MAESTRO_EVALOPS_ENVIRONMENT: "prod",
				MAESTRO_EVALOPS_ORG_ID: "org_123",
				MAESTRO_EVALOPS_PROVIDER: "openai",
				MAESTRO_EVALOPS_TEAM_ID: "team_456",
			});
		});
	});

	describe("login", () => {
		it("should throw error for unknown provider", async () => {
			await expect(
				login("unknown-provider" as SupportedOAuthProvider, {
					onAuthUrl: vi.fn(),
					onPromptCode: vi.fn(),
				}),
			).rejects.toThrow("Unknown OAuth provider");
		});

		it("should throw error for github-copilot without onDeviceCode", async () => {
			await expect(
				login("github-copilot", {
					onAuthUrl: vi.fn(),
					onPromptCode: vi.fn(),
					// No onDeviceCode provided
				}),
			).rejects.toThrow("GitHub Copilot requires onDeviceCode callback");
		});

		it("should require an org id for evalops login", async () => {
			Reflect.deleteProperty(process.env, "MAESTRO_EVALOPS_ORG_ID");
			Reflect.deleteProperty(process.env, "EVALOPS_ORGANIZATION_ID");
			await expect(
				login("evalops", {
					onAuthUrl: vi.fn(),
					onStatus: vi.fn(),
				}),
			).rejects.toThrow("MAESTRO_EVALOPS_ORG_ID");
		});
	});
});

describe("GitHub Copilot OAuth", () => {
	beforeEach(() => {
		process.env.MAESTRO_AGENT_DIR = join(testDir, "agent");
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should import github-copilot module without errors", async () => {
		const module = await import("../src/oauth/github-copilot.js");
		expect(module.loginGitHubCopilot).toBeDefined();
		expect(module.refreshGitHubCopilotToken).toBeDefined();
		expect(module.hasGitHubCopilotCredentials).toBeDefined();
		expect(module.migrateGitHubCopilotCredentials).toBeDefined();
	});

	it("hasGitHubCopilotCredentials should return false when no credentials", async () => {
		const { hasGitHubCopilotCredentials } = await import(
			"../src/oauth/github-copilot.js"
		);
		expect(hasGitHubCopilotCredentials()).toBe(false);
	});

	it("hasGitHubCopilotCredentials should return true when credentials exist", async () => {
		saveOAuthCredentials("github-copilot", {
			type: "oauth",
			access: "test-token",
			refresh: "test-github-token",
			expires: Date.now() + 3600000,
			metadata: { scope: "copilot", githubToken: "test-github-token" },
		});

		const { hasGitHubCopilotCredentials } = await import(
			"../src/oauth/github-copilot.js"
		);
		expect(hasGitHubCopilotCredentials()).toBe(true);
	});
});

describe("OpenAI OAuth", () => {
	beforeEach(() => {
		process.env.MAESTRO_AGENT_DIR = join(testDir, "agent");
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should import openai module without errors", async () => {
		const module = await import("../src/oauth/openai.js");
		expect(module.loginOpenAI).toBeDefined();
		expect(module.refreshOpenAIToken).toBeDefined();
		expect(module.migrateOpenAICredentials).toBeDefined();
	});
});

describe("Anthropic OAuth", () => {
	beforeEach(() => {
		process.env.MAESTRO_AGENT_DIR = join(testDir, "agent");
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should import anthropic module without errors", async () => {
		const module = await import("../src/oauth/anthropic.js");
		expect(module.loginAnthropic).toBeDefined();
		expect(module.refreshAnthropicToken).toBeDefined();
		expect(module.migrateAnthropicCredentials).toBeDefined();
	});
});
