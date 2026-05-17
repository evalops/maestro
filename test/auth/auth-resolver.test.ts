import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFeatureFlagCacheForTests } from "../../src/config/feature-flags.js";
import { getOAuthToken } from "../../src/oauth/index.js";
import { loadOAuthCredentials } from "../../src/oauth/storage.js";
import { createAuthResolver } from "../../src/providers/auth.js";
import { getFreshOpenAIOAuthCredential } from "../../src/providers/openai-auth.js";
import { managedGatewayAliasDefinitions } from "../testing/evalops-managed.js";

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
	const originalOpenAICodex = process.env.OPENAI_CODEX_TOKEN;
	const originalClaude = process.env.CLAUDE_CODE_TOKEN;
	const originalCodex = process.env.CODEX_API_KEY;
	const evalOpsRequestMetadataEnvVars = [
		"EVALOPS_WORKSPACE_ID",
		"MAESTRO_AGENT_ID",
		"MAESTRO_AGENT_RUN_ID",
		"MAESTRO_AGENT_RUN_STEP_ID",
		"MAESTRO_EVALOPS_AGENT_ID",
		"MAESTRO_EVALOPS_AGENT_RUN_ID",
		"MAESTRO_EVALOPS_AGENT_RUN_STEP_ID",
		"MAESTRO_EVALOPS_OBJECTIVE_ID",
		"MAESTRO_EVALOPS_RUN_ID",
		"MAESTRO_EVALOPS_SESSION_ID",
		"MAESTRO_EVALOPS_SURFACE",
		"MAESTRO_EVALOPS_THREAD_ID",
		"MAESTRO_EVALOPS_TOOL_CALL_ID",
		"MAESTRO_EVALOPS_TURN_ID",
		"MAESTRO_EVALOPS_WORKLOAD",
		"MAESTRO_EVALOPS_WORKSPACE_ID",
		"MAESTRO_OBJECTIVE_ID",
		"MAESTRO_SESSION_ID",
		"MAESTRO_SURFACE",
		"MAESTRO_THREAD_ID",
		"MAESTRO_TOOL_CALL_ID",
		"MAESTRO_TRACE_ID",
		"MAESTRO_TURN_ID",
		"MAESTRO_WORKLOAD",
		"MAESTRO_WORKSPACE_ID",
		"TRACE_ID",
	] as const;

	beforeEach(() => {
		Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
		Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
		Reflect.deleteProperty(process.env, "OPENAI_CODEX_TOKEN");
		Reflect.deleteProperty(process.env, "CLAUDE_CODE_TOKEN");
		for (const name of evalOpsRequestMetadataEnvVars) {
			Reflect.deleteProperty(process.env, name);
		}
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
		if (originalOpenAICodex === undefined) {
			Reflect.deleteProperty(process.env, "OPENAI_CODEX_TOKEN");
		} else {
			process.env.OPENAI_CODEX_TOKEN = originalOpenAICodex;
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
		Reflect.deleteProperty(process.env, "EVALOPS_FEATURE_FLAGS_PATH");
		for (const name of evalOpsRequestMetadataEnvVars) {
			Reflect.deleteProperty(process.env, name);
		}
		resetFeatureFlagCacheForTests();
		vi.clearAllMocks();
	});

	function mockEvalOpsManagedOAuthState() {
		vi.mocked(getOAuthToken).mockResolvedValue("evalops-token");
		vi.mocked(loadOAuthCredentials).mockReturnValue({
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
	}

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

	it("uses OpenAI Codex OAuth token with account header when available", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		mockedGetToken.mockResolvedValue("codex-oauth-token");
		mockedLoadCreds.mockReturnValue({
			type: "oauth",
			access: "codex-oauth-token",
			refresh: "ref",
			expires: Date.now() + 60_000,
			metadata: { mode: "openai-codex", accountId: "acct_123" },
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("openai-codex");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("codex-oauth-token");
		expect(credential?.source).toBe("openai_codex_oauth_file");
		expect(credential?.headers).toEqual({ "chatgpt-account-id": "acct_123" });
		expect(getFreshOpenAIOAuthCredential).not.toHaveBeenCalled();
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("uses OpenAI Codex environment token only for openai-codex", async () => {
		process.env.OPENAI_CODEX_TOKEN = "codex-env-token";
		const resolver = createAuthResolver({ mode: "api-key" });
		expect(await resolver("openai")).toBeUndefined();
		const credential = await resolver("openai-codex");
		expect(credential?.token).toBe("codex-env-token");
		expect(credential?.source).toBe("env");
		expect(credential?.envVar).toBe("OPENAI_CODEX_TOKEN");
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
			metadata: {
				surface: "maestro",
			},
			provider_ref: {
				provider: "openai",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("does not use service-specific org env as generic EvalOps org fallback", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		const orgEnvVars = [
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"EVALOPS_ORG_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"MAESTRO_LLM_GATEWAY_ORG_ID",
			"MAESTRO_REMOTE_RUNNER_ORG_ID",
		] as const;
		const originalOrgEnv = Object.fromEntries(
			orgEnvVars.map((name) => [name, process.env[name]]),
		);
		try {
			for (const name of orgEnvVars) {
				Reflect.deleteProperty(process.env, name);
			}
			process.env.MAESTRO_LLM_GATEWAY_ORG_ID = "org_gateway";
			mockedGetToken.mockResolvedValue("evalops-token");
			mockedLoadCreds.mockReturnValue({
				type: "oauth",
				access: "evalops-token",
				refresh: "",
				expires: Date.now() + 60_000,
				metadata: {
					providerRef: {
						provider: "openai",
						environment: "prod",
					},
				},
			});

			const resolver = createAuthResolver({ mode: "auto" });
			const credential = await resolver("evalops");

			expect(credential?.headers).toBeUndefined();
		} finally {
			for (const [name, value] of Object.entries(originalOrgEnv)) {
				if (value === undefined) {
					Reflect.deleteProperty(process.env, name);
				} else {
					process.env[name] = value;
				}
			}
			mockedGetToken.mockReset();
			mockedLoadCreds.mockReset();
		}
	});

	it("prefers the stored EvalOps agent key for managed gateway inference", async () => {
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
				agentMcp: {
					apiKey: "pk_live_agent",
					agentId: "agent_cli",
					expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
					runId: "run_agent_key",
					scopes: ["agent:register", "llm_gateway:invoke"],
					workspaceId: "workspace_agent_key",
				},
			},
		});
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("pk_live_agent");
		expect(credential?.source).toBe("evalops_agent_key_file");
		expect(credential?.headers).toEqual({
			"X-Organization-ID": "org_evalops",
		});
		expect(credential?.requestBody).toEqual({
			metadata: {
				agent_id: "agent_cli",
				workspace_id: "workspace_agent_key",
				run_id: "run_agent_key",
				agent_run_id: "run_agent_key",
				surface: "maestro",
			},
			provider_ref: {
				provider: "openai",
				environment: "prod",
			},
		});
		expect(mockedGetToken).not.toHaveBeenCalled();
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("fails closed for evalops providers when the kill switch is enabled", async () => {
		const path = join(
			tmpdir(),
			`maestro-auth-flags-${Date.now()}-${Math.random()}.json`,
		);
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

		const resolver = createAuthResolver({
			mode: "auto",
			explicitApiKey: "cli-key",
		});

		await expect(resolver("evalops")).resolves.toBeUndefined();
	});

	for (const definition of managedGatewayAliasDefinitions) {
		it(`overrides stored EvalOps provider_ref for ${definition.id}`, async () => {
			mockEvalOpsManagedOAuthState();
			const resolver = createAuthResolver({ mode: "auto" });
			const credential = await resolver(definition.id);
			expect(credential).toBeDefined();
			expect(credential?.type).toBe(
				definition.usesAnthropicOAuth ? "anthropic-oauth" : "api-key",
			);
			expect(credential?.requestBody).toEqual({
				metadata: {
					surface: "maestro",
				},
				provider_ref: {
					provider: definition.providerRefProvider,
					environment: "prod",
				},
			});
		});
	}

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
			metadata: {
				surface: "maestro",
			},
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

	it("preserves distinct platform and Maestro request metadata ids", async () => {
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
				runId: "platform_run_123",
				agentRunId: "agent_run_456",
				sessionId: "platform_session_123",
				maestroSessionId: "maestro_session_456",
			},
		});

		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("evalops");

		expect(credential?.requestBody).toEqual({
			metadata: {
				run_id: "platform_run_123",
				agent_run_id: "agent_run_456",
				session_id: "platform_session_123",
				maestro_session_id: "maestro_session_456",
				surface: "maestro",
			},
			provider_ref: {
				provider: "openai",
				environment: "prod",
			},
		});
		mockedGetToken.mockReset();
		mockedLoadCreds.mockReset();
	});

	it("passes EvalOps managed request metadata for LLM gateway attribution", async () => {
		const mockedGetToken = vi.mocked(getOAuthToken);
		const mockedLoadCreds = vi.mocked(loadOAuthCredentials);
		process.env.MAESTRO_AGENT_ID = "agent_cli";
		process.env.MAESTRO_AGENT_RUN_ID = "generic_run_should_not_win";
		process.env.MAESTRO_EVALOPS_RUN_ID = "run_123";
		process.env.MAESTRO_EVALOPS_WORKSPACE_ID = "workspace_123";
		process.env.MAESTRO_OBJECTIVE_ID = "objective_123";
		process.env.MAESTRO_AGENT_RUN_STEP_ID = "step_123";
		process.env.MAESTRO_SESSION_ID = "session_456";
		process.env.MAESTRO_SURFACE = "cli";
		process.env.MAESTRO_TRACE_ID = "trace_123";
		process.env.MAESTRO_THREAD_ID = "maestro/message/msg_123";
		process.env.MAESTRO_TURN_ID = "turn_123";
		process.env.MAESTRO_TOOL_CALL_ID = "tool_call_123";
		process.env.MAESTRO_WORKLOAD = "maestro-coding-session";
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

		expect(credential?.requestBody).toEqual({
			metadata: {
				agent_id: "agent_cli",
				workspace_id: "workspace_123",
				objective_id: "objective_123",
				run_id: "run_123",
				agent_run_id: "generic_run_should_not_win",
				agent_run_step_id: "step_123",
				session_id: "session_456",
				maestro_session_id: "session_456",
				surface: "cli",
				trace_id: "trace_123",
				thread_id: "maestro/message/msg_123",
				turn_id: "turn_123",
				tool_call_id: "tool_call_123",
				workload: "maestro-coding-session",
			},
			provider_ref: {
				provider: "openai",
				environment: "prod",
			},
		});
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
