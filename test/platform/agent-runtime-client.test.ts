import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MaestroAgentRuntimeSourceEventType,
	PlatformAgentRunStateValue,
	PlatformRuntimeChannelKindValue,
	PlatformRuntimeEventTypeValue,
	PlatformRuntimeTriggerKindValue,
	PlatformSurfaceValue,
	buildMaestroSessionRuntimeTrigger,
	recordMaestroSessionRuntimeTrigger,
} from "../../src/platform/agent-runtime-client.js";

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

describe("agent runtime service client", () => {
	beforeEach(() => {
		for (const name of [
			"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
			"AGENT_RUNTIME_SERVICE_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN",
			"AGENT_RUNTIME_SERVICE_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"MAESTRO_AGENT_RUNTIME_ORG_ID",
			"AGENT_RUNTIME_ORGANIZATION_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
			"AGENT_RUNTIME_WORKSPACE_ID",
			"MAESTRO_WORKSPACE_ID",
			"EVALOPS_WORKSPACE_ID",
		]) {
			vi.stubEnv(name, "");
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("builds enum-backed Maestro session triggers for Platform agent-runtime", () => {
		expect(
			buildMaestroSessionRuntimeTrigger({
				workspaceId: "ws_1",
				sessionId: "session_1",
				actorId: "user_1",
				metadata: { model: "gpt-5" },
			}),
		).toMatchObject({
			workspaceId: "ws_1",
			agentId: "maestro",
			channelId: "maestro-session:session_1",
			idempotencyKey: "maestro-session:ws_1:session_1",
			sourceEventType: MaestroAgentRuntimeSourceEventType.SessionStarted,
			actorId: "user_1",
			surfaceType: PlatformSurfaceValue.Maestro,
			channelContext: {
				channelKind: PlatformRuntimeChannelKindValue.Api,
				providerWorkspaceId: "ws_1",
				channelId: "maestro-session:session_1",
				threadId: "session_1",
				actorId: "user_1",
				attributes: {
					route: "maestro_session",
					maestro_session_id: "session_1",
					source: "maestro",
				},
			},
			triggerKind: PlatformRuntimeTriggerKindValue.Api,
			payload: {
				maestroSessionId: "session_1",
				metadata: { model: "gpt-5" },
			},
		});
	});

	it("records Maestro session triggers through the shared Platform Connect endpoint", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_URL", "https://runtime.test/");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "runtime-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://runtime.test/agentruntime.v1.AgentRuntimeService/HandleTrigger",
				);
				expect(init?.method).toBe("POST");
				expect(headersToRecord(init?.headers)).toEqual(
					expect.objectContaining({
						authorization: "Bearer runtime-token",
						"connect-protocol-version": "1",
						"content-type": "application/json",
						"x-organization-id": "org_1",
					}),
				);
				expect(parseRequestBody(init?.body)).toMatchObject({
					trigger: {
						workspaceId: "ws_env",
						agentId: "maestro",
						channelId: "maestro-session:session_1",
						idempotencyKey: "maestro-session:ws_env:session_1",
						surfaceType: PlatformSurfaceValue.Maestro,
						triggerKind: PlatformRuntimeTriggerKindValue.Api,
					},
				});
				return new Response(
					JSON.stringify({
						run: {
							id: "run_1",
							state: PlatformAgentRunStateValue.Accepted,
							linkage: {
								runId: "run_1",
								workspaceId: "ws_env",
								agentId: "maestro",
							},
						},
						events: [
							{
								id: "evt_1",
								runId: "run_1",
								sequence: 1,
								type: PlatformRuntimeEventTypeValue.TriggerAccepted,
							},
						],
						idempotentReplay: false,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			recordMaestroSessionRuntimeTrigger({ sessionId: "session_1" }),
		).resolves.toEqual({
			run: {
				id: "run_1",
				state: PlatformAgentRunStateValue.Accepted,
				linkage: {
					runId: "run_1",
					workspaceId: "ws_env",
					agentId: "maestro",
					objectiveId: undefined,
				},
				createdAt: undefined,
				updatedAt: undefined,
			},
			events: [
				{
					id: "evt_1",
					runId: "run_1",
					sequence: 1,
					type: PlatformRuntimeEventTypeValue.TriggerAccepted,
					message: undefined,
					occurredAt: undefined,
				},
			],
			idempotentReplay: false,
		});
	});

	it("fails open when agent-runtime is not configured or unavailable", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network down");
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			recordMaestroSessionRuntimeTrigger({ sessionId: "session_1" }),
		).resolves.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();

		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_URL", "https://runtime.test/");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "runtime-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");

		await expect(
			recordMaestroSessionRuntimeTrigger({ sessionId: "session_1" }),
		).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
