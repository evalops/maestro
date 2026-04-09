import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOAuthToken } from "../../src/oauth/index.js";
import { loadOAuthCredentials } from "../../src/oauth/storage.js";
import { createAuthResolver } from "../../src/providers/auth.js";
import { getFreshOpenAIOAuthCredential } from "../../src/providers/openai-auth.js";

vi.mock("../../src/providers/openai-auth.js", () => ({
	getFreshOpenAIOAuthCredential: vi.fn(),
}));

vi.mock("../../src/oauth/index.js", () => ({
	getOAuthToken: vi.fn(),
}));

vi.mock("../../src/oauth/storage.js", () => ({
	loadOAuthCredentials: vi.fn(),
}));

describe("auth resolver", () => {
	const originalAnthropic = process.env.ANTHROPIC_API_KEY;
	const originalOpenAI = process.env.OPENAI_API_KEY;
	const originalClaude = process.env.CLAUDE_CODE_TOKEN;
	const originalCodex = process.env.CODEX_API_KEY;

	beforeEach(() => {
		Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
		Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
		Reflect.deleteProperty(process.env, "CLAUDE_CODE_TOKEN");
	});

	afterEach(() => {
		if (originalAnthropic === undefined) {
			Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
		} else {
			process.env.ANTHROPIC_API_KEY = originalAnthropic;
		}
		if (originalOpenAI === undefined) {
			Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
		} else {
			process.env.OPENAI_API_KEY = originalOpenAI;
		}
		if (originalClaude === undefined) {
			Reflect.deleteProperty(process.env, "CLAUDE_CODE_TOKEN");
		} else {
			process.env.CLAUDE_CODE_TOKEN = originalClaude;
		}
		if (originalCodex === undefined) {
			Reflect.deleteProperty(process.env, "CODEX_API_KEY");
		} else {
			process.env.CODEX_API_KEY = originalCodex;
		}
		vi.clearAllMocks();
	});

	it("prefers explicit API key when provided", async () => {
		const resolver = createAuthResolver({
			mode: "auto",
			explicitApiKey: "cli-key",
		});
		const credential = await resolver("openai");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("cli-key");
		expect(credential?.type).toBe("api-key");
	});

	it("falls back to provider env vars in api-key mode", async () => {
		process.env.ANTHROPIC_API_KEY = "anthropic-env";
		const resolver = createAuthResolver({ mode: "api-key" });
		const credential = await resolver("anthropic");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("anthropic-env");
		expect(credential?.type).toBe("api-key");
	});

	it("ignores Codex subscription tokens", async () => {
		vi.mocked(getFreshOpenAIOAuthCredential).mockResolvedValue(null);
		process.env.CODEX_API_KEY = "codex-token";
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("openai");
		expect(credential).toBeUndefined();
		Reflect.deleteProperty(process.env, "CODEX_API_KEY");
	});

	it("returns undefined when credentials are missing", async () => {
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("openai");
		expect(credential).toBeUndefined();
	});

	it("prefers stored anthropic oauth token in claude mode", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("oauth-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "oauth-token",
			refresh: "ref",
			expires: Date.now() + 60_000,
			metadata: { mode: "pro" },
		});
		const resolver = createAuthResolver({ mode: "claude" });
		const credential = await resolver("anthropic");
		expect(credential).toBeDefined();
		expect(credential?.type).toBe("anthropic-oauth");
		expect(credential?.token).toBe("oauth-token");
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("uses GitHub Copilot OAuth token when available", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("copilot-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "copilot-token",
			refresh: "ref",
			expires: Date.now() + 60_000,
			metadata: { scope: "copilot" },
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("github-copilot");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("copilot-token");
		expect(credential?.source).toBe("github_copilot_oauth_file");
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("uses EvalOps OAuth token with org header and provider_ref", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("evalops-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "evalops-token",
			refresh: "",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openai",
					environment: "prod",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("evalops-token");
		expect(credential?.source).toBe("evalops_oauth_file");
		expect(credential?.headers).toEqual({
			"X-Organization-ID": "org_evalops",
		});
		expect(credential?.requestBody).toEqual({
			provider_ref: {
				provider: "openai",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("overrides stored EvalOps provider_ref when using an evalops provider alias", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("evalops-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "evalops-token",
			refresh: "",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openai",
					environment: "prod",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops-openrouter");
		expect(credential).toBeDefined();
		expect(credential?.requestBody).toEqual({
			provider_ref: {
				provider: "openrouter",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("uses anthropic oauth auth type for managed EvalOps anthropic aliases", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("evalops-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "evalops-token",
			refresh: "",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openai",
					environment: "prod",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops-anthropic");
		expect(credential).toBeDefined();
		expect(credential?.type).toBe("anthropic-oauth");
		expect(credential?.requestBody).toEqual({
			provider_ref: {
				provider: "anthropic",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("overrides stored EvalOps provider_ref for Azure OpenAI aliases", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("evalops-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "evalops-token",
			refresh: "",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openai",
					environment: "prod",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops-azure-openai");
		expect(credential).toBeDefined();
		expect(credential?.type).toBe("api-key");
		expect(credential?.requestBody).toEqual({
			provider_ref: {
				provider: "azure-openai",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("overrides stored EvalOps provider_ref for Fireworks aliases", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("evalops-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "evalops-token",
			refresh: "",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openai",
					environment: "prod",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops-fireworks");
		expect(credential).toBeDefined();
		expect(credential?.type).toBe("api-key");
		expect(credential?.requestBody).toEqual({
			provider_ref: {
				provider: "fireworks",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("overrides stored EvalOps provider_ref for Google aliases", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("evalops-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "evalops-token",
			refresh: "",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openai",
					environment: "prod",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops-google");
		expect(credential).toBeDefined();
		expect(credential?.type).toBe("api-key");
		expect(credential?.requestBody).toEqual({
			provider_ref: {
				provider: "google",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("overrides stored EvalOps provider_ref for Groq aliases", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("evalops-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "evalops-token",
			refresh: "",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openai",
					environment: "prod",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops-groq");
		expect(credential).toBeDefined();
		expect(credential?.type).toBe("api-key");
		expect(credential?.requestBody).toEqual({
			provider_ref: {
				provider: "groq",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("overrides stored EvalOps provider_ref for Mistral aliases", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("evalops-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "evalops-token",
			refresh: "",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openai",
					environment: "prod",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops-mistral");
		expect(credential).toBeDefined();
		expect(credential?.type).toBe("api-key");
		expect(credential?.requestBody).toEqual({
			provider_ref: {
				provider: "mistral",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("overrides stored EvalOps provider_ref for xAI aliases", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("evalops-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "evalops-token",
			refresh: "",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openai",
					environment: "prod",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops-xai");
		expect(credential).toBeDefined();
		expect(credential?.type).toBe("api-key");
		expect(credential?.requestBody).toEqual({
			provider_ref: {
				provider: "xai",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("adds optional credential_name and team_id from env to EvalOps provider_ref", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		process.env.MAESTRO_EVALOPS_CREDENTIAL_NAME = "primary";
		process.env.MAESTRO_EVALOPS_TEAM_ID = "team_123";
		mockedGetToken.mockResolvedValue("evalops-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "evalops-token",
			refresh: "",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openrouter",
					environment: "prod",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops-openrouter");
		expect(credential?.requestBody).toEqual({
			provider_ref: {
				provider: "openrouter",
				environment: "prod",
				credential_name: "primary",
				team_id: "team_123",
			},
		});
		Reflect.deleteProperty(process.env, "MAESTRO_EVALOPS_CREDENTIAL_NAME");
		Reflect.deleteProperty(process.env, "MAESTRO_EVALOPS_TEAM_ID");
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("reads env claude token ahead of file", async () => {
		process.env.CLAUDE_CODE_TOKEN = "env-token";
		const resolver = createAuthResolver({ mode: "claude" });
		const credential = await resolver("anthropic");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("env-token");
		expect(credential?.type).toBe("anthropic-oauth");
		Reflect.deleteProperty(process.env, "CLAUDE_CODE_TOKEN");
	});

	it("fails when claude mode lacks oauth tokens", async () => {
		const resolver = createAuthResolver({ mode: "claude" });
		const credential = await resolver("anthropic");
		expect(credential).toBeUndefined();
	});
});
