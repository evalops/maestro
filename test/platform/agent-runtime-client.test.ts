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
import { resolveCerebroFactsServiceConfig } from "../../src/platform/cerebro-facts-client.js";

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
			"MAESTRO_CEREBRO_URL",
			"CEREBRO_URL",
			"CEREBRO_SERVICE_URL",
			"MAESTRO_CEREBRO_TOKEN",
			"CEREBRO_TOKEN",
			"MAESTRO_CEREBRO_WORKSPACE_ID",
			"CEREBRO_WORKSPACE_ID",
			"MAESTRO_CEREBRO_TIMEOUT_MS",
			"CEREBRO_TIMEOUT_MS",
			"MAESTRO_CEREBRO_MAX_ATTEMPTS",
			"CEREBRO_MAX_ATTEMPTS",
			"MAESTRO_CEREBRO_SEARCH_LIMIT",
			"CEREBRO_SEARCH_LIMIT",
			"MAESTRO_CEREBRO_CHANGE_LIMIT",
			"CEREBRO_CHANGE_LIMIT",
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

	it("accepts full Cerebro service URLs without duplicating the service path", () => {
		vi.stubEnv(
			"CEREBRO_SERVICE_URL",
			"https://cerebro.test/cerebro.v1.CerebroService/",
		);

		expect(resolveCerebroFactsServiceConfig()).toMatchObject({
			baseUrl: "https://cerebro.test",
		});

		vi.stubEnv(
			"CEREBRO_SERVICE_URL",
			"https://cerebro.test//cerebro.v1.CerebroService/",
		);

		expect(resolveCerebroFactsServiceConfig()).toMatchObject({
			baseUrl: "https://cerebro.test",
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

	it("enriches Maestro session triggers with Cerebro facts when configured", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_URL", "https://runtime.test/");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "runtime-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");
		vi.stubEnv("MAESTRO_CEREBRO_URL", "https://cerebro.test/");
		vi.stubEnv("MAESTRO_CEREBRO_TOKEN", "cerebro-token");

		const requests: Array<{
			url: string;
			headers: Record<string, string>;
			body: Record<string, unknown> | undefined;
		}> = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const headers = headersToRecord(init?.headers);
				const body = parseRequestBody(init?.body);
				requests.push({ url, headers, body });

				if (url.endsWith("/cerebro.v1.CerebroService/Search")) {
					expect(headers).toMatchObject({
						authorization: "Bearer cerebro-token",
						"content-type": "application/json",
					});
					expect(body).toMatchObject({
						workspaceId: "ws_env",
						query: "triage pipeline regressions",
						limit: 5,
						includeMap: true,
					});
					return Response.json({
						things: [
							{
								id: "thing_pipeline",
								name: "Pipeline",
								kind: "THING_KIND_SERVICE",
							},
						],
						evidence: [
							{
								id: "evidence_search",
								uri: "https://github.com/evalops/platform",
							},
						],
					});
				}

				if (url.endsWith("/cerebro.v1.CerebroService/GetThing")) {
					expect(body).toMatchObject({
						workspaceId: "ws_env",
						thingId: "thing_pipeline",
					});
					return Response.json({
						thing: {
							id: "thing_pipeline_canonical",
							name: "Pipeline",
							kind: "THING_KIND_SERVICE",
						},
						facts: [
							{
								id: "fact_pipeline_owner",
								subjectThingId: "thing_pipeline",
								statement: "Pipeline is owned by Platform",
								confidence: 0.9,
							},
						],
						recentEvents: [
							{
								id: "event_pipeline_deploy",
								summary: "Pipeline deployed",
							},
						],
						evidence: [
							{
								id: "evidence_owner",
								uri: "https://github.com/evalops/platform",
							},
						],
					});
				}

				if (url.endsWith("/cerebro.v1.CerebroService/ListChanges")) {
					expect(body).toMatchObject({
						workspaceId: "ws_env",
						thingIds: ["thing_pipeline", "thing_pipeline_canonical"],
						limit: 10,
					});
					return Response.json({
						changes: [
							{ id: "change_pipeline_recent", thingId: "thing_pipeline" },
						],
					});
				}

				if (
					url ===
					"https://runtime.test/agentruntime.v1.AgentRuntimeService/HandleTrigger"
				) {
					expect(body).toMatchObject({
						trigger: {
							workspaceId: "ws_env",
							agentId: "maestro",
							payload: {
								maestroSessionId: "session_1",
								metadata: {
									prompt: "triage pipeline regressions",
									workspace_root: "/repo/platform",
								},
								facts_context: {
									provider: "cerebro",
									workspaceId: "ws_env",
									query: "triage pipeline regressions",
									thingIds: ["thing_pipeline", "thing_pipeline_canonical"],
									factIds: ["fact_pipeline_owner"],
									summary: {
										thingCount: 2,
										factCount: 1,
										eventCount: 1,
										changeCount: 1,
										evidenceCount: 2,
									},
								},
							},
						},
					});
					return Response.json({
						run: {
							id: "run_with_facts",
							state: PlatformAgentRunStateValue.Accepted,
							linkage: {
								runId: "run_with_facts",
								workspaceId: "ws_env",
								agentId: "maestro",
							},
						},
						events: [],
						idempotentReplay: false,
					});
				}

				return new Response("unexpected endpoint", { status: 404 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			recordMaestroSessionRuntimeTrigger({
				sessionId: "session_1",
				metadata: {
					prompt: "triage pipeline regressions",
					workspace_root: "/repo/platform",
				},
			}),
		).resolves.toMatchObject({
			run: { id: "run_with_facts" },
		});

		expect(requests.map((request) => request.url)).toEqual([
			"https://cerebro.test/cerebro.v1.CerebroService/Search",
			"https://cerebro.test/cerebro.v1.CerebroService/GetThing",
			"https://cerebro.test/cerebro.v1.CerebroService/ListChanges",
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/HandleTrigger",
		]);
	});

	it("continues recording Maestro session triggers when Cerebro facts are unavailable", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_URL", "https://runtime.test/");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "runtime-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");
		vi.stubEnv("MAESTRO_CEREBRO_URL", "https://cerebro.test/");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/cerebro.v1.CerebroService/Search")) {
					return new Response("temporarily unavailable", { status: 503 });
				}
				if (
					url ===
					"https://runtime.test/agentruntime.v1.AgentRuntimeService/HandleTrigger"
				) {
					const body = parseRequestBody(init?.body);
					expect(body).toMatchObject({
						trigger: {
							workspaceId: "ws_env",
							payload: {
								maestroSessionId: "session_1",
								metadata: { prompt: "triage pipeline regressions" },
							},
						},
					});
					expect(
						(body?.trigger as { payload?: Record<string, unknown> })?.payload
							?.facts_context,
					).toBeUndefined();
					return Response.json({
						run: {
							id: "run_without_facts",
							state: PlatformAgentRunStateValue.Accepted,
						},
						events: [],
						idempotentReplay: false,
					});
				}
				return new Response("unexpected endpoint", { status: 404 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			recordMaestroSessionRuntimeTrigger({
				sessionId: "session_1",
				metadata: { prompt: "triage pipeline regressions" },
			}),
		).resolves.toMatchObject({
			run: { id: "run_without_facts" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("propagates cancellation while gathering Cerebro facts for Maestro session triggers", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_URL", "https://runtime.test/");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "runtime-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");
		vi.stubEnv("MAESTRO_CEREBRO_URL", "https://cerebro.test/");

		const abortError = new Error("Operation aborted");
		abortError.name = "AbortError";
		const abortController = new AbortController();
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				abortController.abort(abortError);
				expect(init?.signal?.aborted).toBe(true);
				throw abortError;
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			recordMaestroSessionRuntimeTrigger(
				{
					sessionId: "session_1",
					metadata: { prompt: "triage pipeline regressions" },
				},
				{ signal: abortController.signal },
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("propagates cancellation while sending Maestro session triggers to agent-runtime", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_URL", "https://runtime.test/");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "runtime-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");

		const abortError = new Error("Operation aborted");
		abortError.name = "AbortError";
		const abortController = new AbortController();
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				abortController.abort(abortError);
				expect(init?.signal?.aborted).toBe(true);
				throw abortError;
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			recordMaestroSessionRuntimeTrigger(
				{ sessionId: "session_1" },
				{ signal: abortController.signal },
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchMock).toHaveBeenCalledOnce();
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
