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
				email: "jonathan@evalops.dev",
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
					if (tool === "evalops_check_action") {
						return {
							content: [],
							structuredContent: {
								decision: "allow",
								risk_level: "low",
								reasons: ["starter policy active"],
							},
						};
					}
					if (tool === "evalops_control_plane_summary") {
						return {
							content: [],
							structuredContent: {
								metrics: {
									approval_required_tools: 3,
									high_risk_tools: 0,
									total_tools: 17,
								},
								evidence: [
									{
										id: "registration",
										title: "Agent registration active",
										agent: "agent_123",
										state: "verified",
										detail: "Expires 2026-05-03T20:00:00Z",
										trace: "run_123",
									},
								],
								findings: [],
								policy_controls: [
									{
										label: "Starter policy",
										value: "Active",
										detail: "Default approval policy attached",
									},
								],
								tools: Array.from({ length: 17 }, (_, index) => ({
									name: `tool_${index}`,
								})),
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
			approvalPolicyAttached: true,
			authenticatedAs: "jonathan@evalops.dev",
			consoleUrl: "https://app.evalops.dev/overview?env=production",
			endpoint: "https://app.evalops.dev/mcp",
			evidenceEventPublished: true,
			evidenceEvents: 1,
			governedActionsLoaded: 17,
			governedInferenceCheckRan: true,
			keyPrefix: "eoak_live_123",
			organizationId: "org_evalops",
			registryVisible: true,
			riskFindings: 0,
			runId: "run_123",
			stored: true,
			traceIngestionStarted: true,
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
			["evalops_check_action", "eoak_created"],
			["evalops_control_plane_summary", "eoak_created"],
		]);
		expect(calls[0]?.args).toMatchObject({
			agent_type: "maestro",
			surface: "cli",
		});
		expect(calls[0]?.args).not.toHaveProperty("scopes");
		expect(calls[0]?.args).not.toHaveProperty("user_token");
		expect(calls[1]?.args).toMatchObject({
			action_type: "llm_gateway.invoke",
			declared_risk_level: "low",
		});
		expect(savedCredentials[0]?.metadata?.agentMcp).toMatchObject({
			agentId: "agent_123",
			apiKey: "eoak_created",
			endpoint: "https://app.evalops.dev/mcp",
			keyPrefix: "eoak_live_123",
			runId: "run_123",
		});
	});

	it("treats trace ingestion as distinct from evidence publication", async () => {
		const createMcpClient = vi.fn(
			(_endpoint: string, _token: string): EvalOpsMcpClient => ({
				callTool: async (tool) => {
					if (tool === "evalops_register") {
						return {
							content: [],
							structuredContent: {
								agent_id: "agent_123",
								registered: true,
								run_id: "run_123",
							},
						};
					}
					if (tool === "evalops_check_action") {
						return {
							content: [],
							structuredContent: {
								decision: "allow",
							},
						};
					}
					if (tool === "evalops_control_plane_summary") {
						return {
							content: [],
							structuredContent: {
								evidence: [
									{
										id: "registration",
										title: "Agent registration active",
									},
								],
								findings: [],
								metrics: {
									total_tools: 1,
								},
								policy_controls: [],
								tools: [{ name: "tool_0" }],
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
				fetch: vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								api_key: "eoak_created",
								key: {
									prefix: "eoak_live_123",
									scopes: ["agent:register", "llm_gateway:invoke"],
								},
							}),
							{ status: 201 },
						),
				),
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

		expect(result.evidenceEventPublished).toBe(true);
		expect(result.traceIngestionStarted).toBe(false);
	});

	it("keeps registration durable when proof tools are unavailable", async () => {
		const statuses: string[] = [];
		const savedCredentials: OAuthCredentials[] = [];
		const createMcpClient = vi.fn(
			(_endpoint: string, _token: string): EvalOpsMcpClient => ({
				callTool: async (tool) => {
					if (tool === "evalops_register") {
						return {
							content: [],
							structuredContent: {
								agent_id: "agent_123",
								registered: true,
								run_id: "run_123",
							},
						};
					}
					throw new Error(`${tool} is unavailable`);
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
				fetch: vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								api_key: "eoak_created",
								key: {
									prefix: "eoak_live_123",
									scopes: ["agent:register", "llm_gateway:invoke"],
								},
							}),
							{ status: 201 },
						),
				),
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
				onStatus: (status) => statuses.push(status.message),
				saveCredentials: vi.fn((_provider, credentials) => {
					savedCredentials.push(credentials);
				}),
			},
		);

		expect(result).toMatchObject({
			agentId: "agent_123",
			evidenceEventPublished: false,
			governedActionsLoaded: 0,
			governedInferenceCheckRan: false,
			riskFindings: 0,
			traceIngestionStarted: false,
		});
		expect(savedCredentials[0]?.metadata?.agentMcp).toMatchObject({
			agentId: "agent_123",
			apiKey: "eoak_created",
		});
		expect(
			statuses.some((status) => status.includes("continuing bootstrap")),
		).toBe(true);
	});

	it("uses aggregate high-risk metrics when findings are not expanded", async () => {
		const createMcpClient = vi.fn(
			(_endpoint: string, _token: string): EvalOpsMcpClient => ({
				callTool: async (tool) => {
					if (tool === "evalops_register") {
						return {
							content: [],
							structuredContent: {
								agent_id: "agent_123",
								registered: true,
							},
						};
					}
					if (tool === "evalops_check_action") {
						return {
							content: [],
							structuredContent: {
								decision: "allow",
							},
						};
					}
					if (tool === "evalops_control_plane_summary") {
						return {
							content: [],
							structuredContent: {
								findings: [],
								metrics: {
									high_risk_tools: 2,
									total_tools: 17,
								},
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
				fetch: vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								api_key: "eoak_created",
								key: { prefix: "eoak_live_123", scopes: ["agent:register"] },
							}),
							{ status: 201 },
						),
				),
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

		expect(result.riskFindings).toBe(2);
	});

	it("loads control-plane summary even when the governed action check is unavailable", async () => {
		const calls: string[] = [];
		const createMcpClient = vi.fn(
			(_endpoint: string, _token: string): EvalOpsMcpClient => ({
				callTool: async (tool) => {
					calls.push(tool);
					if (tool === "evalops_register") {
						return {
							content: [],
							structuredContent: {
								agent_id: "agent_123",
								registered: true,
							},
						};
					}
					if (tool === "evalops_check_action") {
						throw new Error("check action unavailable");
					}
					if (tool === "evalops_control_plane_summary") {
						return {
							content: [],
							structuredContent: {
								evidence: [{ id: "evidence_1", trace: "run_123" }],
								metrics: {
									total_tools: 17,
								},
								policy_controls: [{ label: "Starter policy", value: "Active" }],
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
				fetch: vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								api_key: "eoak_created",
								key: { prefix: "eoak_live_123", scopes: ["agent:register"] },
							}),
							{ status: 201 },
						),
				),
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

		expect(calls).toContain("evalops_control_plane_summary");
		expect(result.governedInferenceCheckRan).toBe(false);
		expect(result.governedActionsLoaded).toBe(17);
		expect(result.approvalPolicyAttached).toBe(true);
		expect(result.evidenceEventPublished).toBe(true);
		expect(result.traceIngestionStarted).toBe(true);
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
		expect(tokensUsed).toEqual([
			"eoak_old",
			"eoak_new",
			"eoak_new",
			"eoak_new",
		]);
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
