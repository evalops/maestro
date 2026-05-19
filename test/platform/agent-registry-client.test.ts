import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PlatformAgentStatusValue,
	PlatformDelegationStatusValue,
	delegateAgentWithPlatform,
	heartbeatAgentWithPlatform,
	listA2APeerCandidatesWithPlatform,
	listAgentsWithPlatform,
	registerAgentWithPlatform,
	resolveAgentDelegationWithPlatform,
	resolveAgentRegistryServiceConfig,
	updateAgentWithPlatform,
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

	it("lists Platform agents using an explicit workspace when env workspace is unset", async () => {
		vi.stubEnv("AGENT_REGISTRY_SERVICE_URL", "https://registry.test/");
		vi.stubEnv("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
		vi.stubEnv("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://registry.test/agents.v1.AgentService/List",
				);
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
				expect(parseRequestBody(init?.body)).toMatchObject({
					workspaceId: "ws_1",
					limit: 5,
				});
				return new Response(JSON.stringify({ agents: [], total: 0 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			listAgentsWithPlatform({
				workspaceId: "ws_1",
				limit: 5,
			}),
		).resolves.toEqual({ agents: [], total: 0 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("lists Platform agents and extracts governed A2A peer candidates", async () => {
		vi.stubEnv("AGENT_REGISTRY_SERVICE_URL", "https://registry.test/");
		vi.stubEnv("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
		vi.stubEnv("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");
		vi.stubEnv("AGENT_REGISTRY_WORKSPACE_ID", "ws_from_env");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://registry.test/agents.v1.AgentService/List",
				);
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
				expect(parseRequestBody(init?.body)).toMatchObject({
					workspaceId: "ws_1",
					capability: "code:review",
					limit: 25,
				});
				return new Response(
					JSON.stringify({
						agents: [
							{
								id: "maestro-reviewer",
								workspaceId: "ws_1",
								name: "Remote Maestro Reviewer",
								agentType: "maestro",
								capabilities: ["code:review"],
								status: "AGENT_STATUS_ONLINE",
								a2a: {
									public_endpoint_url: "https://reviewer.test/a2a",
									internalEndpointUrl: "http://reviewer.mesh/a2a",
									agent_card_url:
										"https://reviewer.test/.well-known/agent-card.json",
									protocol_binding: "HTTP+JSON",
									protocolVersion: "1.0",
									push_notifications: true,
									supported_extensions: [
										"https://evalops.dev/a2a/extensions/operating-plane/v1",
									],
									skills: [
										{
											id: "maestro.subagent.code-review",
											name: "Maestro code review subagent",
											tags: ["maestro", "subagent", "review"],
											required_context_grants: ["repo:read"],
											approvalPolicyRef: "target-maestro-policy",
											max_autonomy: "bounded",
											required_artifact_kinds: ["review.summary"],
											allowedTaskClasses: ["code.review"],
											attributes: { lane: "code-review" },
											metadata: {
												requestMetadataPath: "evalops.subagentRequest",
												resultPolicy: "summary-and-artifacts",
											},
										},
									],
								},
							},
							{
								id: "maestro-offline",
								workspaceId: "ws_1",
								name: "No A2A endpoint yet",
								status: "AGENT_STATUS_OFFLINE",
							},
						],
						totalSize: 2,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			listAgentsWithPlatform({
				workspaceId: "ws_1",
				capability: "code:review",
				limit: 25,
			}),
		).resolves.toMatchObject({
			total: 2,
			agents: [
				expect.objectContaining({
					id: "maestro-reviewer",
					a2a: expect.objectContaining({
						publicEndpointUrl: "https://reviewer.test/a2a",
						internalEndpointUrl: "http://reviewer.mesh/a2a",
						pushNotifications: true,
						skills: [
							expect.objectContaining({
								id: "maestro.subagent.code-review",
								requiredContextGrants: ["repo:read"],
								approvalPolicyRef: "target-maestro-policy",
								maxAutonomy: "bounded",
								requiredArtifactKinds: ["review.summary"],
								allowedTaskClasses: ["code.review"],
								attributes: { lane: "code-review" },
								metadata: {
									requestMetadataPath: "evalops.subagentRequest",
									resultPolicy: "summary-and-artifacts",
								},
							}),
						],
					}),
				}),
				expect.objectContaining({ id: "maestro-offline" }),
			],
		});

		await expect(
			listA2APeerCandidatesWithPlatform({
				workspaceId: "ws_1",
				capability: "code:review",
				limit: 25,
				preferInternalEndpoint: true,
				skillId: "maestro.subagent.code-review",
			}),
		).resolves.toEqual([
			expect.objectContaining({
				endpointUrl: "http://reviewer.mesh/a2a",
				endpointKind: "internal",
				agentCardUrl: "https://reviewer.test/.well-known/agent-card.json",
				protocolBinding: "HTTP+JSON",
				protocolVersion: "1.0",
				pushNotifications: true,
				agent: expect.objectContaining({ id: "maestro-reviewer" }),
				skills: [
					expect.objectContaining({
						id: "maestro.subagent.code-review",
						approvalPolicyRef: "target-maestro-policy",
						metadata: expect.objectContaining({
							requestMetadataPath: "evalops.subagentRequest",
						}),
					}),
				],
			}),
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("registers, updates, and heartbeats a governed A2A Maestro peer", async () => {
		vi.stubEnv("AGENT_REGISTRY_SERVICE_URL", "https://registry.test/");
		vi.stubEnv("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
		vi.stubEnv("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");

		const a2a = {
			publicEndpointUrl: "https://maestro.example/a2a",
			internalEndpointUrl: "http://maestro.evalops.svc/a2a",
			agentCardUrl: "https://maestro.example/a2a/.well-known/agent-card.json",
			protocolBinding: "HTTP+JSON",
			protocolVersion: "1.0",
			supportedExtensions: [
				"https://evalops.com/a2a/extensions/operating-plane/v1",
			],
			skills: [
				{
					id: "maestro.subagent.code-review",
					name: "Maestro code review subagent",
					tags: ["maestro", "subagent", "review"],
					requiredContextGrants: ["repo:read"],
					approvalPolicyRef: "maestro.subagent.code-review.target-policy",
					metadata: {
						requestMetadataPath: "evalops.subagentRequest",
					},
				},
			],
			securitySchemes: ["evalops-agent-token"],
			pushNotifications: true,
			attributes: { runtime: "maestro" },
		};
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
					"https://registry.test/agents.v1.AgentService/Register"
				) {
					expect(body).toMatchObject({
						workspaceId: "ws_1",
						id: "maestro-peer-1",
						name: "Maestro Peer",
						agentType: "maestro",
						capabilities: ["maestro:a2a", "code:review"],
						surfaces: ["maestro"],
						surfaceTypes: ["SURFACE_MAESTRO"],
						a2a: expect.objectContaining({
							publicEndpointUrl: "https://maestro.example/a2a",
							skills: [
								expect.objectContaining({
									id: "maestro.subagent.code-review",
									requiredContextGrants: ["repo:read"],
									approvalPolicyRef:
										"maestro.subagent.code-review.target-policy",
								}),
							],
						}),
					});
					expect(
						(body?.a2a as { skills?: Array<Record<string, unknown>> })
							.skills?.[0]?.metadata,
					).toBeUndefined();
					return new Response(
						JSON.stringify({
							agent: {
								id: "maestro-peer-1",
								workspaceId: "ws_1",
								name: "Maestro Peer",
								agentType: "maestro",
								capabilities: ["maestro:a2a", "code:review"],
								surfaces: ["maestro"],
								surfaceTypes: ["SURFACE_MAESTRO"],
								a2a,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (
					String(input) ===
					"https://registry.test/agents.v1.AgentService/Update"
				) {
					expect(body).toMatchObject({
						id: "maestro-peer-1",
						name: "Maestro Peer Updated",
						capabilities: ["maestro:a2a", "code:review"],
						a2a: expect.objectContaining({
							internalEndpointUrl: "http://maestro.evalops.svc/a2a",
						}),
					});
					return new Response(
						JSON.stringify({
							agent: {
								id: "maestro-peer-1",
								name: "Maestro Peer Updated",
								a2a,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				expect(String(input)).toBe(
					"https://registry.test/agents.v1.AgentService/Heartbeat",
				);
				expect(body).toMatchObject({
					agentId: "maestro-peer-1",
					status: PlatformAgentStatusValue.Idle,
					surface: "maestro",
					surfaceType: "SURFACE_MAESTRO",
					a2a: expect.objectContaining({
						protocolVersion: "1.0",
					}),
				});
				return new Response(
					JSON.stringify({ nextHeartbeatBy: "2026-05-19T10:05:00Z" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			registerAgentWithPlatform({
				workspaceId: "ws_1",
				id: "maestro-peer-1",
				name: "Maestro Peer",
				agentType: "maestro",
				capabilities: ["maestro:a2a", "code:review"],
				surfaces: ["maestro"],
				surfaceTypes: ["SURFACE_MAESTRO"],
				a2a,
			}),
		).resolves.toMatchObject({
			agent: {
				id: "maestro-peer-1",
				workspaceId: "ws_1",
				name: "Maestro Peer",
				a2a: expect.objectContaining({
					publicEndpointUrl: "https://maestro.example/a2a",
				}),
			},
		});
		await expect(
			updateAgentWithPlatform({
				workspaceId: "ws_1",
				id: "maestro-peer-1",
				name: "Maestro Peer Updated",
				capabilities: ["maestro:a2a", "code:review"],
				a2a,
			}),
		).resolves.toMatchObject({
			agent: {
				id: "maestro-peer-1",
				name: "Maestro Peer Updated",
			},
		});
		await expect(
			heartbeatAgentWithPlatform({
				workspaceId: "ws_1",
				agentId: "maestro-peer-1",
				status: PlatformAgentStatusValue.Idle,
				surface: "maestro",
				surfaceType: "SURFACE_MAESTRO",
				a2a,
			}),
		).resolves.toEqual({ nextHeartbeatBy: "2026-05-19T10:05:00Z" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
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
						a2aSkillId: "maestro.subagent.code-review",
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
								a2aTaskId: "remote_task_1",
								a2aMessageId: "a2a-delegation_1",
								a2aEndpointUrl: "https://peer.test/a2a/message:send",
								a2aDispatchStatus: "submitted",
								a2aSkillId: "maestro.subagent.code-review",
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
				a2aSkillId: "maestro.subagent.code-review",
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
				a2aTaskId: "remote_task_1",
				a2aMessageId: "a2a-delegation_1",
				a2aEndpointUrl: "https://peer.test/a2a/message:send",
				a2aDispatchStatus: "submitted",
				a2aSkillId: "maestro.subagent.code-review",
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
