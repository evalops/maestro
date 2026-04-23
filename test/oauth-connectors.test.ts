import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testDir = join(tmpdir(), `maestro-oauth-connectors-${Date.now()}`);

import { resetConnectorsDownstreamForTests } from "../src/connectors/service-client.js";
import {
	clearOAuthProviderSourceOfTruthPolicy,
	configureOAuthProviderSourceOfTruthPolicy,
	revokeOAuthProviderConnection,
	syncOAuthProviderConnection,
	syncStoredOAuthProviderConnection,
} from "../src/oauth/connectors.js";
import {
	type OAuthCredentials,
	loadOAuthCredentials,
	saveOAuthCredentials,
} from "../src/oauth/storage.js";

describe("OAuth connectors integration", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.MAESTRO_AGENT_DIR = join(testDir, "agent");
		process.env.CONNECTORS_SERVICE_URL = "http://connectors.test";
		process.env.CONNECTORS_SERVICE_WORKSPACE_ID = "org_123";
		process.env.CONNECTORS_SERVICE_TOKEN = "connectors-token";
		process.env.CONNECTORS_SERVICE_MAX_ATTEMPTS = "1";
		mkdirSync(testDir, { recursive: true });
		resetConnectorsDownstreamForTests();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				Reflect.deleteProperty(process.env, key);
			}
		}
		Object.assign(process.env, originalEnv);
		resetConnectorsDownstreamForTests();
		vi.unstubAllGlobals();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("registers a stored provider OAuth credential with connectors", async () => {
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toEqual({
				workspaceId: "org_123",
				providerId: "github",
				displayName: "GitHub Copilot OAuth",
				authType: "AUTH_TYPE_OAUTH2",
				scopes: ["repo.read"],
			});
			return new Response(
				JSON.stringify({
					connection: {
						id: "conn_github",
						workspaceId: "org_123",
						providerId: "github",
						healthStatus: "HEALTH_STATUS_HEALTHY",
						updatedAt: "2026-04-20T12:00:00Z",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		saveOAuthCredentials("github-copilot", {
			type: "oauth",
			access: "github-access",
			refresh: "github-refresh",
			expires: Date.now() + 3_600_000,
			metadata: { scopes: ["repo.read"] },
		});

		await syncStoredOAuthProviderConnection("github-copilot");

		const stored = loadOAuthCredentials("github-copilot");
		expect(stored?.metadata).toMatchObject({
			connectorConnectionId: "conn_github",
			connectorHealthStatus: "HEALTH_STATUS_HEALTHY",
			connectorProviderId: "github",
			connectorUpdatedAt: "2026-04-20T12:00:00Z",
			connectorWorkspaceId: "org_123",
		});
	});

	it("sets Platform source-of-truth policy when OAuth metadata declares an area", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body));
			if (url.endsWith("/RegisterConnection")) {
				expect(body).toEqual({
					workspaceId: "org_123",
					providerId: "x-evalops:openai",
					displayName: "OpenAI OAuth",
					authType: "AUTH_TYPE_OAUTH2",
					scopes: ["model.read"],
				});
				return new Response(
					JSON.stringify({
						connection: {
							id: "conn_openai",
							workspaceId: "org_123",
							providerId: "x-evalops:openai",
							healthStatus: "HEALTH_STATUS_HEALTHY",
							updatedAt: "2026-04-20T12:00:00Z",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			expect(url).toBe(
				"http://connectors.test/connectors.v1.ConnectorService/SetSourceOfTruthPolicy",
			);
			expect(body).toEqual({
				policy: {
					workspaceId: "org_123",
					area: "SOURCE_OF_TRUTH_AREA_ANALYTICS",
					primaryConnectionId: "conn_openai",
					fallbackConnectionId: "conn_analytics_fallback",
				},
			});
			return new Response(
				JSON.stringify({
					policy: {
						workspaceId: "org_123",
						area: "SOURCE_OF_TRUTH_AREA_ANALYTICS",
						primaryConnectionId: "conn_openai",
						fallbackConnectionId: "conn_analytics_fallback",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const synced = await syncOAuthProviderConnection("openai", {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: {
				scopes: ["model.read"],
				connectorSourceOfTruthArea: "analytics",
				connectorSourceOfTruthFallbackConnectionId: "conn_analytics_fallback",
			},
		});

		expect(synced.metadata).toMatchObject({
			connectorConnectionId: "conn_openai",
			connectorSourceOfTruthArea: "analytics",
			connectorSourceOfTruthPrimaryConnectionId: "conn_openai",
			connectorSourceOfTruthWorkspaceId: "org_123",
			connectorSourceOfTruthFallbackConnectionId: "conn_analytics_fallback",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("configures a stored OAuth provider as source of truth and syncs immediately", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body));
			if (url.endsWith("/RegisterConnection")) {
				expect(body).toMatchObject({
					workspaceId: "org_123",
					providerId: "x-evalops:openai",
					displayName: "OpenAI OAuth",
					authType: "AUTH_TYPE_OAUTH2",
				});
				return new Response(
					JSON.stringify({
						connection: {
							id: "conn_openai",
							workspaceId: "org_123",
							providerId: "x-evalops:openai",
							healthStatus: "HEALTH_STATUS_HEALTHY",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			expect(url).toBe(
				"http://connectors.test/connectors.v1.ConnectorService/SetSourceOfTruthPolicy",
			);
			expect(body).toEqual({
				policy: {
					workspaceId: "org_123",
					area: "SOURCE_OF_TRUTH_AREA_CRM",
					primaryConnectionId: "conn_openai",
					fallbackConnectionId: "conn_crm_fallback",
				},
			});
			return new Response(
				JSON.stringify({
					policy: {
						workspaceId: "org_123",
						area: "SOURCE_OF_TRUTH_AREA_CRM",
						primaryConnectionId: "conn_openai",
						fallbackConnectionId: "conn_crm_fallback",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		saveOAuthCredentials("openai", {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: {
				scopes: ["model.read"],
				sourceOfTruthArea: "analytics",
			},
		});

		const configured = await configureOAuthProviderSourceOfTruthPolicy(
			"openai",
			{
				area: "crm",
				fallbackConnectionId: "conn_crm_fallback",
			},
		);

		expect(configured).toMatchObject({
			provider: "openai",
			area: "crm",
			fallbackConnectionId: "conn_crm_fallback",
			connectorConnectionId: "conn_openai",
			primaryConnectionId: "conn_openai",
			workspaceId: "org_123",
		});
		expect(loadOAuthCredentials("openai")?.metadata).toMatchObject({
			connectorConnectionId: "conn_openai",
			connectorSourceOfTruthArea: "crm",
			connectorSourceOfTruthFallbackConnectionId: "conn_crm_fallback",
			connectorSourceOfTruthPrimaryConnectionId: "conn_openai",
			connectorSourceOfTruthWorkspaceId: "org_123",
		});
		expect(loadOAuthCredentials("openai")?.metadata).not.toHaveProperty(
			"sourceOfTruthArea",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects unsupported source-of-truth areas before changing credentials", async () => {
		saveOAuthCredentials("openai", {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: { connectorSourceOfTruthArea: "analytics" },
		});

		await expect(
			configureOAuthProviderSourceOfTruthPolicy("openai", {
				area: "finance",
			}),
		).rejects.toThrow("Unsupported source-of-truth area");
		expect(loadOAuthCredentials("openai")?.metadata).toMatchObject({
			connectorSourceOfTruthArea: "analytics",
		});
	});

	it("clears local OAuth source-of-truth policy metadata", async () => {
		saveOAuthCredentials("openai", {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: {
				connectorConnectionId: "conn_openai",
				connectorSourceOfTruthArea: "crm",
				connectorSourceOfTruthFallbackConnectionId: "conn_fallback",
				connectorSourceOfTruthPrimaryConnectionId: "conn_openai",
				connectorSourceOfTruthWorkspaceId: "org_123",
			},
		});

		expect(clearOAuthProviderSourceOfTruthPolicy("openai")).toBe(true);
		expect(loadOAuthCredentials("openai")?.metadata).toEqual({
			connectorConnectionId: "conn_openai",
		});
		expect(clearOAuthProviderSourceOfTruthPolicy("openai")).toBe(false);
	});

	it("keeps connector metadata when source-of-truth policy sync fails open", async () => {
		const fetchMock = vi.fn(async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/RegisterConnection")) {
				return new Response(
					JSON.stringify({
						connection: {
							id: "conn_openai",
							workspaceId: "org_123",
							providerId: "x-evalops:openai",
							healthStatus: "HEALTH_STATUS_HEALTHY",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("unavailable", { status: 503 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const synced = await syncOAuthProviderConnection("openai", {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: { sourceOfTruthArea: "analytics" },
		});

		expect(synced.metadata).toMatchObject({
			connectorConnectionId: "conn_openai",
			connectorHealthStatus: "HEALTH_STATUS_HEALTHY",
			sourceOfTruthArea: "analytics",
		});
		expect(synced.metadata).not.toHaveProperty(
			"connectorSourceOfTruthPrimaryConnectionId",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("refreshes existing connector lifecycle metadata without replacing local tokens", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://connectors.test/connectors.v1.ConnectorService/RefreshConnection",
			);
			expect(JSON.parse(String(init?.body))).toEqual({ id: "conn_openai" });
			return new Response(
				JSON.stringify({
					connection: {
						id: "conn_openai",
						workspaceId: "org_123",
						providerId: "x-evalops:openai",
						healthStatus: "HEALTH_STATUS_DEGRADED",
						updatedAt: "2026-04-20T13:00:00Z",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials: OAuthCredentials = {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: { connectorConnectionId: "conn_openai" },
		};

		const synced = await syncOAuthProviderConnection("openai", credentials);

		expect(synced.access).toBe("openai-access");
		expect(synced.refresh).toBe("openai-refresh");
		expect(synced.metadata).toMatchObject({
			connectorConnectionId: "conn_openai",
			connectorHealthStatus: "HEALTH_STATUS_DEGRADED",
			connectorProviderId: "x-evalops:openai",
			connectorUpdatedAt: "2026-04-20T13:00:00Z",
			connectorWorkspaceId: "org_123",
		});
	});

	it("fails open when connector refresh is unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unavailable", { status: 503 })),
		);

		const credentials: OAuthCredentials = {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: { connectorConnectionId: "conn_openai" },
		};

		await expect(
			syncOAuthProviderConnection("openai", credentials),
		).resolves.toBe(credentials);
	});

	it("fails open when connector registration is unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unavailable", { status: 503 })),
		);

		const credentials: OAuthCredentials = {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: { scopes: ["model.read"] },
		};

		await expect(
			syncOAuthProviderConnection("openai", credentials),
		).resolves.toBe(credentials);
	});

	it("revokes connector metadata on provider logout", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://connectors.test/connectors.v1.ConnectorService/RevokeConnection",
			);
			expect(JSON.parse(String(init?.body))).toEqual({ id: "conn_google" });
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		await revokeOAuthProviderConnection("google-gemini-cli", {
			type: "oauth",
			access: "google-access",
			refresh: "google-refresh",
			expires: Date.now() + 3_600_000,
			metadata: { connectorConnectionId: "conn_google" },
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
