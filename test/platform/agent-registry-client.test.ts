import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PlatformDelegationStatusValue,
	delegateAgentWithPlatform,
	resolveAgentDelegationWithPlatform,
	resolveAgentRegistryServiceConfig,
} from "../../src/platform/agent-registry-client.js";

function headersToRecord(
	headers: HeadersInit | undefined,
): Record<string, string> {
	return Object.fromEntries(new Headers(headers).entries());
}

function parseRequestBody(
	body: BodyInit | null | undefined,
): Record<string, unknown> | undefined {
	return typeof body === "string"
		? (JSON.parse(body) as Record<string, unknown>)
		: undefined;
}

function decodePayload(value: unknown): Record<string, unknown> {
	if (typeof value !== "string") {
		throw new Error("expected base64 payload");
	}
	return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<
		string,
		unknown
	>;
}

describe("agent registry service client", () => {
	beforeEach(() => {
		for (const name of [
			"MAESTRO_AGENT_REGISTRY_SERVICE_URL",
			"AGENT_REGISTRY_SERVICE_URL",
			"MAESTRO_AGENT_REGISTRY_URL",
			"AGENT_REGISTRY_BASE_URL",
			"PLATFORM_AGENT_REGISTRY_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN",
			"AGENT_REGISTRY_SERVICE_TOKEN",
			"MAESTRO_AGENT_REGISTRY_TOKEN",
			"AGENT_REGISTRY_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"MAESTRO_AGENT_REGISTRY_ORG_ID",
			"AGENT_REGISTRY_ORGANIZATION_ID",
			"AGENT_REGISTRY_ORG_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"EVALOPS_ORG_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"MAESTRO_AGENT_REGISTRY_WORKSPACE_ID",
			"AGENT_REGISTRY_WORKSPACE_ID",
			"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
			"MAESTRO_EVALOPS_WORKSPACE_ID",
			"EVALOPS_WORKSPACE_ID",
			"MAESTRO_WORKSPACE_ID",
			"MAESTRO_AGENT_REGISTRY_TIMEOUT_MS",
			"AGENT_REGISTRY_SERVICE_TIMEOUT_MS",
			"MAESTRO_AGENT_REGISTRY_MAX_ATTEMPTS",
			"AGENT_REGISTRY_SERVICE_MAX_ATTEMPTS",
		]) {
			vi.stubEnv(name, "");
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("resolves direct AgentService URLs without duplicating the service path", async () => {
		vi.stubEnv(
			"AGENT_REGISTRY_SERVICE_URL",
			"https://registry.test/agents.v1.AgentService/Delegate",
		);
		vi.stubEnv("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
		vi.stubEnv("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");
		vi.stubEnv("AGENT_REGISTRY_WORKSPACE_ID", "ws_1");

		await expect(resolveAgentRegistryServiceConfig()).resolves.toMatchObject({
			baseUrl: "https://registry.test",
			token: "registry-token",
			organizationId: "org_1",
			workspaceId: "ws_1",
		});
	});

	it("delegates and resolves Codex child work through Platform Connect", async () => {
		vi.stubEnv("AGENT_REGISTRY_SERVICE_URL", "https://registry.test/");
		vi.stubEnv("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
		vi.stubEnv("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");
		vi.stubEnv("AGENT_REGISTRY_WORKSPACE_ID", "ws_1");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(init?.method).toBe("POST");
				expect(headersToRecord(init?.headers)).toEqual(
					expect.objectContaining({
						authorization: "Bearer registry-token",
						"connect-protocol-version": "1",
						"content-type": "application/json",
						"x-organization-id": "org_1",
						"x-workspace-id": "ws_1",
					}),
				);
				const body = parseRequestBody(init?.body);
				if (
					String(input) ===
					"https://registry.test/agents.v1.AgentService/Delegate"
				) {
					expect(body).toMatchObject({
						fromAgentId: "maestro-parent",
						requiredCapability: "code:review",
						reason: "spawn requested",
					});
					expect(decodePayload(body?.contextPayload)).toEqual({
						agent_run_id: "run_1",
						child_run_ids: ["agent-run-child-1"],
					});
					return new Response(
						JSON.stringify({
							delegation: {
								id: "delegation_1",
								workspaceId: "ws_1",
								fromAgentId: "maestro-parent",
								toAgentId: "maestro-child",
								status: PlatformDelegationStatusValue.Pending,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				expect(String(input)).toBe(
					"https://registry.test/agents.v1.AgentService/ResolveDelegation",
				);
				expect(body).toMatchObject({
					delegationId: "delegation_1",
					status: PlatformDelegationStatusValue.Completed,
				});
				expect(decodePayload(body?.resultPayload)).toEqual({
					child_run_ids: ["agent-run-child-1"],
				});
				return new Response(
					JSON.stringify({
						delegation: {
							id: "delegation_1",
							status: PlatformDelegationStatusValue.Completed,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			delegateAgentWithPlatform({
				fromAgentId: "maestro-parent",
				requiredCapability: "code:review",
				contextPayload: {
					agent_run_id: "run_1",
					child_run_ids: ["agent-run-child-1"],
				},
				reason: "spawn requested",
			}),
		).resolves.toEqual({
			delegation: {
				id: "delegation_1",
				workspaceId: "ws_1",
				fromAgentId: "maestro-parent",
				toAgentId: "maestro-child",
				status: PlatformDelegationStatusValue.Pending,
			},
		});
		await expect(
			resolveAgentDelegationWithPlatform({
				delegationId: "delegation_1",
				status: PlatformDelegationStatusValue.Completed,
				resultPayload: {
					child_run_ids: ["agent-run-child-1"],
				},
			}),
		).resolves.toEqual({
			delegation: {
				id: "delegation_1",
				status: PlatformDelegationStatusValue.Completed,
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
