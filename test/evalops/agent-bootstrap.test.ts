import { describe, expect, it, vi } from "vitest";
import {
	type EvalOpsMcpClient,
	bootstrapEvalOpsAgent,
} from "../../src/evalops/agent-bootstrap.js";
import type { OAuthCredentials } from "../../src/oauth/storage.js";

describe("bootstrapEvalOpsAgent", () => {
	it("logs in, creates an API key, registers through MCP, and persists metadata", async () => {
		const calls: Array<{
			args: Record<string, unknown>;
			token: string;
			tool: string;
		}> = [];
		let storedCredentials: OAuthCredentials | null = {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
				providerRef: {
					provider: "openai",
					environment: "prod",
				},
			},
		};
		const savedCredentials: OAuthCredentials[] = [];
		const createMcpClient = vi.fn(
			(endpoint: string, token: string): EvalOpsMcpClient => ({
				callTool: async (tool, args) => {
					calls.push({ args, token, tool });
					if (endpoint !== "https://app.evalops.dev/mcp") {
						throw new Error(`unexpected endpoint ${endpoint}`);
					}
					if (tool === "evalops_create_api_key") {
						return {
							content: [],
							structuredContent: {
								api_key: "eoak_created",
								key_id: "key_123",
								name: "maestro-init-test",
								prefix: "eoak_live_123",
								scopes: ["agent:register"],
							},
						};
					}
					if (tool === "evalops_register") {
						return {
							content: [],
							structuredContent: {
								agent_id: "agent_123",
								expires_at: "2026-05-03T20:00:00Z",
								registered: true,
								registry_visible: true,
								run_id: "run_123",
								scopes_granted: ["llm_gateway:invoke"],
							},
						};
					}
					throw new Error(`unexpected tool ${tool}`);
				},
				close: async () => undefined,
				connect: async () => undefined,
			}),
		);

		const result = await bootstrapEvalOpsAgent(
			{
				keyName: "maestro-init-test",
				mcpUrl: "https://app.evalops.dev",
			},
			{
				createMcpClient,
				getOAuthToken: vi.fn().mockResolvedValue("oauth-access"),
				hasOAuthCredentials: vi.fn().mockReturnValue(true),
				loadCredentials: vi.fn(() => storedCredentials),
				login: vi.fn(),
				now: () => new Date("2026-05-03T19:00:00Z"),
				saveCredentials: vi.fn((_provider, credentials) => {
					storedCredentials = credentials;
					savedCredentials.push(credentials);
				}),
			},
		);

		expect(result).toMatchObject({
			agentId: "agent_123",
			apiKeyCreated: true,
			endpoint: "https://app.evalops.dev/mcp",
			keyPrefix: "eoak_live_123",
			organizationId: "org_evalops",
			registryVisible: true,
			runId: "run_123",
			stored: true,
		});
		expect(calls.map((call) => [call.tool, call.token])).toEqual([
			["evalops_create_api_key", ""],
			["evalops_register", ""],
		]);
		expect(calls[0]?.args).toMatchObject({
			name: "maestro-init-test",
			scopes: expect.arrayContaining(["agent:register"]),
			user_token: "oauth-access",
		});
		expect(calls[1]?.args).toMatchObject({
			agent_type: "maestro",
			surface: "cli",
			scopes: ["llm_gateway:invoke"],
			user_token: "eoak_created",
		});
		expect(savedCredentials[0]?.metadata?.agentMcp).toMatchObject({
			agentId: "agent_123",
			apiKey: "eoak_created",
			endpoint: "https://app.evalops.dev/mcp",
			keyPrefix: "eoak_live_123",
			runId: "run_123",
		});
	});

	it("reuses a stored key and rotates it when registration fails", async () => {
		let storedCredentials: OAuthCredentials | null = {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60_000,
			metadata: {
				agentMcp: {
					apiKey: "eoak_old",
					createdAt: "2026-05-02T19:00:00.000Z",
					endpoint: "https://app.evalops.dev/mcp",
					registeredAt: "2026-05-02T19:00:00.000Z",
					surface: "cli",
				},
				organizationId: "org_evalops",
			},
		};
		const tokensUsed: string[] = [];
		const createMcpClient = vi.fn(
			(_endpoint: string, token: string): EvalOpsMcpClient => ({
				callTool: async (tool, args) => {
					tokensUsed.push(token);
					if (tool === "evalops_register" && args.user_token === "eoak_old") {
						throw new Error("old key expired");
					}
					if (tool === "evalops_create_api_key") {
						return {
							content: [],
							structuredContent: {
								api_key: "eoak_new",
								prefix: "eoak_live_new",
								scopes: ["agent:register"],
							},
						};
					}
					return {
						content: [],
						structuredContent: {
							agent_id: "agent_new",
							registered: true,
							run_id: "run_new",
						},
					};
				},
				close: async () => undefined,
				connect: async () => undefined,
			}),
		);

		const result = await bootstrapEvalOpsAgent(
			{},
			{
				createMcpClient,
				getOAuthToken: vi.fn().mockResolvedValue("oauth-access"),
				hasOAuthCredentials: vi.fn().mockReturnValue(true),
				loadCredentials: vi.fn(() => storedCredentials),
				login: vi.fn(),
				now: () => new Date("2026-05-03T19:00:00Z"),
				saveCredentials: vi.fn((_provider, credentials) => {
					storedCredentials = credentials;
				}),
			},
		);

		expect(result).toMatchObject({
			agentId: "agent_new",
			apiKeyCreated: true,
			keyPrefix: "eoak_live_new",
		});
		expect(tokensUsed).toEqual(["", "", ""]);
		expect(storedCredentials?.metadata?.agentMcp).toMatchObject({
			apiKey: "eoak_new",
			agentId: "agent_new",
		});
	});
});
