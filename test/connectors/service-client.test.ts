import { afterEach, describe, expect, it, vi } from "vitest";
import {
	listRemoteConnections,
	registerRemoteConnection,
	resetConnectorsDownstreamForTests,
	resolveConnectorsServiceConfig,
	setRemoteSourceOfTruthPolicy,
} from "../../src/connectors/service-client.js";

describe("connectors service client", () => {
	afterEach(() => {
		resetConnectorsDownstreamForTests();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("resolves shared Platform configuration for connectors", () => {
		vi.stubEnv("MAESTRO_PLATFORM_BASE_URL", "http://platform.test/");
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "evalops-token");
		vi.stubEnv("MAESTRO_EVALOPS_WORKSPACE_ID", "workspace-platform");

		expect(resolveConnectorsServiceConfig()).toMatchObject({
			baseUrl: "http://platform.test",
			token: "evalops-token",
			workspaceId: "workspace-platform",
		});
	});

	it("registers OAuth connections with Connect JSON headers", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://connectors.test/connectors.v1.ConnectorService/RegisterConnection",
			);
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				Authorization: "Bearer connectors-token",
				"Connect-Protocol-Version": "1",
				"Content-Type": "application/json",
			});
			expect(JSON.parse(String(init?.body))).toEqual({
				workspaceId: "org_123",
				providerId: "github",
				displayName: "GitHub",
				authType: "AUTH_TYPE_OAUTH2",
				scopes: ["repo.read"],
			});
			return new Response(
				JSON.stringify({
					connection: {
						id: "conn_123",
						workspaceId: "org_123",
						providerId: "github",
						displayName: "GitHub",
						authType: "AUTH_TYPE_OAUTH2",
						scopes: ["repo.read"],
						healthStatus: "HEALTH_STATUS_HEALTHY",
						updatedAt: "2026-04-20T12:00:00Z",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const connection = await registerRemoteConnection(
			{
				providerId: "github",
				displayName: "GitHub",
				authType: "AUTH_TYPE_OAUTH2",
				scopes: ["repo.read"],
			},
			{
				baseUrl: "http://connectors.test/connectors.v1.ConnectorService",
				token: "connectors-token",
				workspaceId: "org_123",
				timeoutMs: 1_000,
				maxAttempts: 1,
			},
		);

		expect(connection).toEqual({
			id: "conn_123",
			workspaceId: "org_123",
			providerId: "github",
			displayName: "GitHub",
			authType: "AUTH_TYPE_OAUTH2",
			scopes: ["repo.read"],
			healthStatus: "HEALTH_STATUS_HEALTHY",
			updatedAt: "2026-04-20T12:00:00Z",
		});
	});

	it("fails open when registration fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("bad gateway", { status: 502 })),
		);

		await expect(
			registerRemoteConnection(
				{
					providerId: "github",
					authType: "AUTH_TYPE_OAUTH2",
				},
				{
					baseUrl: "http://connectors.test",
					workspaceId: "org_123",
					timeoutMs: 1_000,
					maxAttempts: 1,
				},
			),
		).resolves.toBeNull();
	});

	it("fails open for connection list calls", async () => {
		const fetchMock = vi.fn(
			async () => new Response("unavailable", { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			listRemoteConnections("org_123", {
				baseUrl: "http://connectors.test",
				timeoutMs: 1_000,
				maxAttempts: 1,
			}),
		).resolves.toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("sets source-of-truth policy through the shared connectors method", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://connectors.test/connectors.v1.ConnectorService/SetSourceOfTruthPolicy",
			);
			expect(JSON.parse(String(init?.body))).toEqual({
				policy: {
					workspaceId: "org_123",
					area: "SOURCE_OF_TRUTH_AREA_CRM",
					primaryConnectionId: "conn_crm_primary",
					fallbackConnectionId: "conn_crm_fallback",
				},
			});
			return new Response(
				JSON.stringify({
					policy: {
						workspaceId: "org_123",
						area: "SOURCE_OF_TRUTH_AREA_CRM",
						primaryConnectionId: "conn_crm_primary",
						fallbackConnectionId: "conn_crm_fallback",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			setRemoteSourceOfTruthPolicy(
				{
					area: "crm",
					primaryConnectionId: "conn_crm_primary",
					fallbackConnectionId: "conn_crm_fallback",
				},
				{
					baseUrl: "http://connectors.test/connectors.v1.ConnectorService",
					workspaceId: "org_123",
					timeoutMs: 1_000,
					maxAttempts: 1,
				},
			),
		).resolves.toEqual({
			workspaceId: "org_123",
			area: "crm",
			primaryConnectionId: "conn_crm_primary",
			fallbackConnectionId: "conn_crm_fallback",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("opens the configured circuit after repeated downstream failures", async () => {
		const fetchMock = vi.fn(
			async () => new Response("unavailable", { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const config = {
			baseUrl: "http://connectors.test",
			circuitFailureThreshold: 1,
			circuitResetTimeoutMs: 60_000,
			circuitSuccessThreshold: 1,
			timeoutMs: 1_000,
			maxAttempts: 1,
		};

		await expect(listRemoteConnections("org_123", config)).resolves.toEqual([]);
		await expect(listRemoteConnections("org_123", config)).resolves.toEqual([]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
