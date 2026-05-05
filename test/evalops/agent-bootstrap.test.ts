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
		const apiKeyRequests: Array<{
			body: Record<string, unknown>;
			url: string;
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
				fetch: vi.fn(async (url, init) => {
					apiKeyRequests.push({
						body: JSON.parse(String(init?.body ?? "{}")) as Record<
							string,
							unknown
						>,
						url: String(url),
					});
					expect(init?.headers).toMatchObject({
						Authorization: "Bearer oauth-access",
						"Content-Type": "application/json",
					});
					return new Response(
						JSON.stringify({
							api_key: "eoak_created",
							key: {
								id: "key_123",
								name: "maestro-init-test",
								prefix: "eoak_live_123",
								scopes: [
									"agent:register",
									"agent:heartbeat",
									"llm_gateway:invoke",
								],
							},
						}),
						{ status: 201 },
					);
				}),
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
		expect(apiKeyRequests).toHaveLength(1);
		expect(apiKeyRequests[0]).toMatchObject({
			url: "https://identity.evalops.dev/v1/api-keys",
		});
		expect(apiKeyRequests[0]?.body).toMatchObject({
			name: "maestro-init-test",
			scopes: expect.arrayContaining([
				"agent:register",
				"agent:heartbeat",
				"llm_gateway:invoke",
			]),
		});
		expect(calls.map((call) => [call.tool, call.token])).toEqual([
			["evalops_register", "eoak_created"],
		]);
		expect(calls[0]?.args).toMatchObject({
			agent_type: "maestro",
			surface: "cli",
		});
		expect(calls[0]?.args).not.toHaveProperty("scopes");
		expect(calls[0]?.args).not.toHaveProperty("user_token");
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
		const apiKeyRequests: Array<Record<string, unknown>> = [];
		const createMcpClient = vi.fn(
			(_endpoint: string, token: string): EvalOpsMcpClient => ({
				callTool: async (tool, args) => {
					tokensUsed.push(token);
					if (tool === "evalops_register" && token === "eoak_old") {
						throw new Error("old key expired");
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
				fetch: vi.fn(async (_url, init) => {
					apiKeyRequests.push(
						JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
					);
					return new Response(
						JSON.stringify({
							api_key: "eoak_new",
							key: {
								prefix: "eoak_live_new",
								scopes: ["agent:register", "llm_gateway:invoke"],
							},
						}),
						{ status: 201 },
					);
				}),
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
		expect(apiKeyRequests).toHaveLength(1);
		expect(tokensUsed).toEqual(["eoak_old", "eoak_new"]);
		expect(storedCredentials?.metadata?.agentMcp).toMatchObject({
			apiKey: "eoak_new",
			agentId: "agent_new",
		});
	});

	it("strips MCP paths when deriving identity URLs from custom app hosts", async () => {
		const apiKeyRequests: string[] = [];
		const createMcpClient = vi.fn(
			(_endpoint: string, _token: string): EvalOpsMcpClient => ({
				callTool: async () => ({
					content: [],
					structuredContent: {
						agent_id: "agent_custom",
						registered: true,
						run_id: "run_custom",
					},
				}),
				close: async () => undefined,
				connect: async () => undefined,
			}),
		);

		await bootstrapEvalOpsAgent(
			{
				mcpUrl: "https://app.staging.example.com/mcp",
			},
			{
				createMcpClient,
				fetch: vi.fn(async (url) => {
					apiKeyRequests.push(String(url));
					return new Response(
						JSON.stringify({
							api_key: "eoak_custom",
							key: {
								prefix: "eoak_live_custom",
								scopes: ["agent:register"],
							},
						}),
						{ status: 201 },
					);
				}),
				getOAuthToken: vi.fn().mockResolvedValue("oauth-access"),
				hasOAuthCredentials: vi.fn().mockReturnValue(true),
				loadCredentials: vi.fn(() => ({
					type: "oauth",
					access: "oauth-access",
					refresh: "oauth-refresh",
					expires: Date.now() + 60_000,
					metadata: {},
				})),
				login: vi.fn(),
				now: () => new Date("2026-05-03T19:00:00Z"),
				saveCredentials: vi.fn(),
			},
		);

		expect(apiKeyRequests).toEqual([
			"https://identity.staging.example.com/v1/api-keys",
		]);
	});

	it("prefers a selected MCP endpoint over stale stored identity metadata", async () => {
		const apiKeyRequests: string[] = [];
		const createMcpClient = vi.fn(
			(_endpoint: string, _token: string): EvalOpsMcpClient => ({
				callTool: async () => ({
					content: [],
					structuredContent: {
						agent_id: "agent_staging",
						registered: true,
						run_id: "run_staging",
					},
				}),
				close: async () => undefined,
				connect: async () => undefined,
			}),
		);

		await bootstrapEvalOpsAgent(
			{
				mcpUrl: "https://app.staging.example.com/mcp",
			},
			{
				createMcpClient,
				fetch: vi.fn(async (url) => {
					apiKeyRequests.push(String(url));
					return new Response(
						JSON.stringify({
							api_key: "eoak_staging",
							key: {
								prefix: "eoak_live_staging",
								scopes: ["agent:register"],
							},
						}),
						{ status: 201 },
					);
				}),
				getOAuthToken: vi.fn().mockResolvedValue("oauth-access"),
				hasOAuthCredentials: vi.fn().mockReturnValue(true),
				loadCredentials: vi.fn(() => ({
					type: "oauth",
					access: "oauth-access",
					refresh: "oauth-refresh",
					expires: Date.now() + 60_000,
					metadata: {
						identityBaseUrl: "https://identity.previous.example.com",
					},
				})),
				login: vi.fn(),
				now: () => new Date("2026-05-03T19:00:00Z"),
				saveCredentials: vi.fn(),
			},
		);

		expect(apiKeyRequests).toEqual([
			"https://identity.staging.example.com/v1/api-keys",
		]);
	});

	it("keeps stored identity metadata for stored custom MCP endpoints", async () => {
		const apiKeyRequests: string[] = [];
		const createMcpClient = vi.fn(
			(endpoint: string, _token: string): EvalOpsMcpClient => ({
				callTool: async () => {
					expect(endpoint).toBe("https://mcp.custom.example.com/mcp");
					return {
						content: [],
						structuredContent: {
							agent_id: "agent_custom",
							registered: true,
							run_id: "run_custom",
						},
					};
				},
				close: async () => undefined,
				connect: async () => undefined,
			}),
		);

		await bootstrapEvalOpsAgent(
			{
				rotateKey: true,
			},
			{
				createMcpClient,
				fetch: vi.fn(async (url) => {
					apiKeyRequests.push(String(url));
					return new Response(
						JSON.stringify({
							api_key: "eoak_custom",
							key: {
								prefix: "eoak_live_custom",
								scopes: ["agent:register"],
							},
						}),
						{ status: 201 },
					);
				}),
				getOAuthToken: vi.fn().mockResolvedValue("oauth-access"),
				hasOAuthCredentials: vi.fn().mockReturnValue(true),
				loadCredentials: vi.fn(() => ({
					type: "oauth",
					access: "oauth-access",
					refresh: "oauth-refresh",
					expires: Date.now() + 60_000,
					metadata: {
						agentMcp: {
							apiKey: "eoak_previous",
							createdAt: "2026-05-02T19:00:00.000Z",
							endpoint: "https://mcp.custom.example.com/mcp",
							registeredAt: "2026-05-02T19:00:00.000Z",
							surface: "cli",
						},
						identityBaseUrl: "https://identity.custom.example.net",
					},
				})),
				login: vi.fn(),
				now: () => new Date("2026-05-03T19:00:00Z"),
				saveCredentials: vi.fn(),
			},
		);

		expect(apiKeyRequests).toEqual([
			"https://identity.custom.example.net/v1/api-keys",
		]);
	});

	it("derives identity URLs for stored first-party MCP endpoints", async () => {
		const apiKeyRequests: string[] = [];
		const createMcpClient = vi.fn(
			(endpoint: string, _token: string): EvalOpsMcpClient => ({
				callTool: async () => {
					expect(endpoint).toBe("https://staging.evalops.dev/mcp");
					return {
						content: [],
						structuredContent: {
							agent_id: "agent_staging",
							registered: true,
							run_id: "run_staging",
						},
					};
				},
				close: async () => undefined,
				connect: async () => undefined,
			}),
		);

		await bootstrapEvalOpsAgent(
			{
				rotateKey: true,
			},
			{
				createMcpClient,
				fetch: vi.fn(async (url) => {
					apiKeyRequests.push(String(url));
					return new Response(
						JSON.stringify({
							api_key: "eoak_staging",
							key: {
								prefix: "eoak_live_staging",
								scopes: ["agent:register"],
							},
						}),
						{ status: 201 },
					);
				}),
				getOAuthToken: vi.fn().mockResolvedValue("oauth-access"),
				hasOAuthCredentials: vi.fn().mockReturnValue(true),
				loadCredentials: vi.fn(() => ({
					type: "oauth",
					access: "oauth-access",
					refresh: "oauth-refresh",
					expires: Date.now() + 60_000,
					metadata: {
						agentMcp: {
							apiKey: "eoak_previous",
							createdAt: "2026-05-02T19:00:00.000Z",
							endpoint: "https://staging.evalops.dev/mcp",
							registeredAt: "2026-05-02T19:00:00.000Z",
							surface: "cli",
						},
						identityBaseUrl: "https://identity.previous.example.com",
					},
				})),
				login: vi.fn(),
				now: () => new Date("2026-05-03T19:00:00Z"),
				saveCredentials: vi.fn(),
			},
		);

		expect(apiKeyRequests).toEqual([
			"https://api.staging.evalops.dev/v1/api-keys",
		]);
	});
});
