import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Set up test directory before importing modules
const testDir = join(tmpdir(), `composer-oauth-test-${Date.now()}`);
process.env.COMPOSER_AGENT_DIR = join(testDir, "agent");

import {
	type SupportedOAuthProvider,
	getOAuthProviders,
	getOAuthToken,
	hasOAuthCredentials,
	login,
	logout,
} from "../src/oauth/index.js";
import {
	listOAuthProviders,
	loadOAuthCredentials,
	removeOAuthCredentials,
	saveOAuthCredentials,
} from "../src/oauth/storage.js";

describe("OAuth Storage", () => {
	beforeEach(() => {
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
	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("getOAuthProviders", () => {
		it("should return all supported providers", () => {
			const providers = getOAuthProviders();

			expect(providers).toHaveLength(3);
			expect(providers.map((p) => p.id)).toContain("anthropic");
			expect(providers.map((p) => p.id)).toContain("openai");
			expect(providers.map((p) => p.id)).toContain("github-copilot");
		});

		it("should mark all providers as available", () => {
			const providers = getOAuthProviders();

			for (const provider of providers) {
				expect(provider.available).toBe(true);
			}
		});
	});

	describe("hasOAuthCredentials", () => {
		it("should return false when no credentials exist", () => {
			expect(hasOAuthCredentials("anthropic")).toBe(false);
			expect(hasOAuthCredentials("openai")).toBe(false);
			expect(hasOAuthCredentials("github-copilot")).toBe(false);
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
	});
});

describe("GitHub Copilot OAuth", () => {
	beforeEach(() => {
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
