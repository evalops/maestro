import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MaestroAgentRuntimeSourceEventType,
	PlatformAgentRunStateValue,
	PlatformAgentRunStepKindValue,
	PlatformAgentRunStepStateValue,
	PlatformAgentRunWaitTypeValue,
	PlatformRuntimeChannelKindValue,
	PlatformRuntimeEventTypeValue,
	PlatformRuntimeTriggerKindValue,
	PlatformSurfaceValue,
	buildMaestroSessionRuntimeTrigger,
	claimNextAgentRuntimeRun,
	completeAgentRuntimeRun,
	failAgentRuntimeRun,
	getAgentRuntimeRun,
	listAgentRuntimeRunEvents,
	recordAgentRuntimeRunStep,
	recordMaestroSessionRuntimeTrigger,
	resumeAgentRuntimeRun,
	waitAgentRuntimeRun,
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
			"MAESTRO_AGENT_RUNTIME_A2A_ENABLED",
			"AGENT_RUNTIME_SERVICE_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_PLATFORM_A2A_ENABLED",
			"MAESTRO_PLATFORM_A2A_URL",
			"MAESTRO_A2A_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN",
			"AGENT_RUNTIME_SERVICE_TOKEN",
			"MAESTRO_PLATFORM_A2A_TOKEN",
			"MAESTRO_A2A_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"MAESTRO_AGENT_RUNTIME_ORG_ID",
			"AGENT_RUNTIME_ORGANIZATION_ID",
			"MAESTRO_PLATFORM_A2A_ORG_ID",
			"MAESTRO_A2A_ORG_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
			"AGENT_RUNTIME_WORKSPACE_ID",
			"MAESTRO_PLATFORM_A2A_WORKSPACE_ID",
			"MAESTRO_A2A_WORKSPACE_ID",
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
			"TRACEPARENT",
			"TRACE_PARENT",
			"TRACESTATE",
			"TRACE_STATE",
			"MAESTRO_TRACEPARENT",
			"MAESTRO_TRACESTATE",
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

	it("drives the Platform AgentRuntime lease, step, wait, resume, and complete lifecycle", async () => {
		const config = {
			baseUrl: "https://runtime.test",
			token: "runtime-token",
			organizationId: "org_1",
			workspaceId: "ws_1",
			timeoutMs: 2_000,
			maxAttempts: 1,
		};
		const requests: Array<{
			url: string;
			body: Record<string, unknown> | undefined;
		}> = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const body = parseRequestBody(init?.body);
				requests.push({ url, body });
				expect(init?.method).toBe("POST");
				expect(headersToRecord(init?.headers)).toMatchObject({
					authorization: "Bearer runtime-token",
					"connect-protocol-version": "1",
					"content-type": "application/json",
					"x-organization-id": "org_1",
				});

				if (url.endsWith("/ClaimNextRun")) {
					expect(body).toMatchObject({
						workerId: "maestro-worker",
						workerQueue: "runs.default",
						leaseSeconds: 30,
					});
					return Response.json({
						run: {
							id: "run_1",
							state: PlatformAgentRunStateValue.Running,
							lease: {
								id: "lease_1",
								token: "lease-token-1",
								workerId: "maestro-worker",
							},
						},
						lease: {
							id: "lease_1",
							token: "lease-token-1",
							workerId: "maestro-worker",
						},
						events: [
							{
								id: "event_claimed",
								runId: "run_1",
								type: PlatformRuntimeEventTypeValue.RunClaimed,
							},
						],
					});
				}

				if (url.endsWith("/RecordRunStep")) {
					expect(body).toMatchObject({
						runId: "run_1",
						leaseToken: "lease-token-1",
						step: {
							id: "step_tool_1",
							name: "governed shell",
							stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
							state: PlatformAgentRunStepStateValue.Running,
						},
					});
					return Response.json({
						run: {
							id: "run_1",
							state: PlatformAgentRunStateValue.Running,
							steps: [
								{
									id: "step_tool_1",
									name: "governed shell",
									stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
									state: PlatformAgentRunStepStateValue.Running,
								},
							],
						},
						step: {
							id: "step_tool_1",
							name: "governed shell",
							stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
							state: PlatformAgentRunStepStateValue.Running,
						},
						event: {
							id: "event_step",
							stepId: "step_tool_1",
							type: PlatformRuntimeEventTypeValue.StepRecorded,
						},
					});
				}

				if (url.endsWith("/WaitRun")) {
					expect(body).toMatchObject({
						runId: "run_1",
						leaseToken: "lease-token-1",
						wait: {
							id: "wait_approval_1",
							stepId: "step_tool_1",
							type: PlatformAgentRunWaitTypeValue.Approval,
							externalRef: "approval_1",
						},
						checkpoint: {
							id: "checkpoint_approval_1",
							stepId: "step_tool_1",
							resumeToken: "resume-after-approval",
						},
					});
					return Response.json({
						run: {
							id: "run_1",
							state: PlatformAgentRunStateValue.Waiting,
							waits: [
								{
									id: "wait_approval_1",
									stepId: "step_tool_1",
									type: PlatformAgentRunWaitTypeValue.Approval,
									externalRef: "approval_1",
								},
							],
							latestCheckpoint: {
								id: "checkpoint_approval_1",
								stepId: "step_tool_1",
								sequence: 1,
							},
						},
						wait: {
							id: "wait_approval_1",
							stepId: "step_tool_1",
							type: PlatformAgentRunWaitTypeValue.Approval,
						},
						checkpoint: {
							id: "checkpoint_approval_1",
							stepId: "step_tool_1",
							sequence: 1,
						},
						event: {
							id: "event_wait",
							waitId: "wait_approval_1",
							checkpointId: "checkpoint_approval_1",
							type: PlatformRuntimeEventTypeValue.RunWaiting,
						},
					});
				}

				if (url.endsWith("/ResumeRun")) {
					expect(body).toMatchObject({
						runId: "run_1",
						waitId: "wait_approval_1",
						resumeEventId: "approval_event_1",
					});
					return Response.json({
						run: {
							id: "run_1",
							state: PlatformAgentRunStateValue.Queued,
						},
						event: {
							id: "event_resume",
							waitId: "wait_approval_1",
							type: PlatformRuntimeEventTypeValue.RunResumed,
						},
					});
				}

				if (url.endsWith("/CompleteRun")) {
					expect(body).toMatchObject({
						runId: "run_1",
						leaseToken: "lease-token-2",
						result: { status: "ok" },
					});
					return Response.json({
						run: {
							id: "run_1",
							state: PlatformAgentRunStateValue.Succeeded,
						},
						event: {
							id: "event_complete",
							type: PlatformRuntimeEventTypeValue.RunSucceeded,
						},
					});
				}

				if (url.endsWith("/GetRun")) {
					expect(body).toMatchObject({ id: "run_1" });
					return Response.json({
						run: {
							id: "run_1",
							state: PlatformAgentRunStateValue.Succeeded,
						},
					});
				}

				if (url.endsWith("/ListRunEvents")) {
					expect(body).toMatchObject({ runId: "run_1" });
					return Response.json({
						events: [
							{
								id: "event_complete",
								runId: "run_1",
								type: PlatformRuntimeEventTypeValue.RunSucceeded,
							},
						],
					});
				}

				return new Response("unexpected endpoint", { status: 404 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const claim = await claimNextAgentRuntimeRun(
			{
				workerId: "maestro-worker",
				workerQueue: "runs.default",
				leaseSeconds: 30,
			},
			{ config },
		);
		expect(claim.run.lease?.token).toBe("lease-token-1");
		expect(claim.lease?.workerId).toBe("maestro-worker");

		await expect(
			recordAgentRuntimeRunStep(
				{
					runId: "run_1",
					leaseToken: "lease-token-1",
					step: {
						id: "step_tool_1",
						name: "governed shell",
						stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
						state: PlatformAgentRunStepStateValue.Running,
					},
				},
				{ config },
			),
		).resolves.toMatchObject({
			step: { id: "step_tool_1" },
			event: { stepId: "step_tool_1" },
		});

		await expect(
			waitAgentRuntimeRun(
				{
					runId: "run_1",
					leaseToken: "lease-token-1",
					wait: {
						id: "wait_approval_1",
						stepId: "step_tool_1",
						type: PlatformAgentRunWaitTypeValue.Approval,
						externalRef: "approval_1",
						reason: "needs approval",
					},
					checkpoint: {
						id: "checkpoint_approval_1",
						stepId: "step_tool_1",
						resumeToken: "resume-after-approval",
					},
				},
				{ config },
			),
		).resolves.toMatchObject({
			run: {
				state: PlatformAgentRunStateValue.Waiting,
				latestCheckpoint: { id: "checkpoint_approval_1" },
			},
			wait: { id: "wait_approval_1" },
		});

		await expect(
			resumeAgentRuntimeRun(
				{
					runId: "run_1",
					waitId: "wait_approval_1",
					resumeEventId: "approval_event_1",
				},
				{ config },
			),
		).resolves.toMatchObject({
			run: { state: PlatformAgentRunStateValue.Queued },
			event: { waitId: "wait_approval_1" },
		});

		await expect(
			completeAgentRuntimeRun(
				{
					runId: "run_1",
					leaseToken: "lease-token-2",
					result: { status: "ok" },
				},
				{ config },
			),
		).resolves.toMatchObject({
			run: { state: PlatformAgentRunStateValue.Succeeded },
		});

		await expect(
			getAgentRuntimeRun({ runId: "run_1" }, { config }),
		).resolves.toMatchObject({
			run: { state: PlatformAgentRunStateValue.Succeeded },
		});
		await expect(
			listAgentRuntimeRunEvents({ runId: "run_1" }, { config }),
		).resolves.toMatchObject({
			events: [{ type: PlatformRuntimeEventTypeValue.RunSucceeded }],
		});

		expect(requests.map((request) => request.url)).toEqual([
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/ClaimNextRun",
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/RecordRunStep",
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/WaitRun",
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/ResumeRun",
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/CompleteRun",
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/GetRun",
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/ListRunEvents",
		]);
	});

	it("preserves zero lease seconds when claiming a Platform AgentRuntime run", async () => {
		const config = {
			baseUrl: "https://runtime.test",
			token: "runtime-token",
			organizationId: "org_1",
			workspaceId: "ws_1",
			timeoutMs: 2_000,
			maxAttempts: 1,
		};
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://runtime.test/agentruntime.v1.AgentRuntimeService/ClaimNextRun",
				);
				expect(parseRequestBody(init?.body)).toMatchObject({
					workerId: "maestro-worker",
					workerQueue: "runs.default",
					leaseSeconds: 0,
				});
				return Response.json({
					run: {
						id: "run_1",
						state: PlatformAgentRunStateValue.Running,
					},
					lease: {
						id: "lease_1",
						token: "lease-token-1",
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			claimNextAgentRuntimeRun(
				{
					workerId: "maestro-worker",
					workerQueue: "runs.default",
					leaseSeconds: 0,
				},
				{ config },
			),
		).resolves.toMatchObject({
			run: { state: PlatformAgentRunStateValue.Running },
			lease: { token: "lease-token-1" },
		});
	});

	it("preserves zero retry delay when failing a Platform AgentRuntime run", async () => {
		const config = {
			baseUrl: "https://runtime.test",
			token: "runtime-token",
			organizationId: "org_1",
			workspaceId: "ws_1",
			timeoutMs: 2_000,
			maxAttempts: 1,
		};
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://runtime.test/agentruntime.v1.AgentRuntimeService/FailRun",
				);
				expect(parseRequestBody(init?.body)).toMatchObject({
					runId: "run_1",
					leaseToken: "lease-token-1",
					errorMessage: "tool failed",
					retryable: true,
					retryDelaySeconds: 0,
				});
				return Response.json({
					run: {
						id: "run_1",
						state: PlatformAgentRunStateValue.Failed,
					},
					event: {
						id: "event_failed",
						runId: "run_1",
						type: PlatformRuntimeEventTypeValue.RunFailed,
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			failAgentRuntimeRun(
				{
					runId: "run_1",
					leaseToken: "lease-token-1",
					errorMessage: "tool failed",
					retryable: true,
					retryDelaySeconds: 0,
				},
				{ config },
			),
		).resolves.toMatchObject({
			run: { state: PlatformAgentRunStateValue.Failed },
			event: { type: PlatformRuntimeEventTypeValue.RunFailed },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("omits non-finite lease duration when claiming a Platform AgentRuntime run", async () => {
		const config = {
			baseUrl: "https://runtime.test",
			token: "runtime-token",
			organizationId: "org_1",
			workspaceId: "ws_1",
			timeoutMs: 2_000,
			maxAttempts: 1,
		};
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://runtime.test/agentruntime.v1.AgentRuntimeService/ClaimNextRun",
				);
				expect(parseRequestBody(init?.body)).toEqual({
					workerId: "maestro-worker",
					workerQueue: "runs.default",
				});
				return Response.json({
					run: {
						id: "run_1",
						state: PlatformAgentRunStateValue.Running,
					},
					lease: {
						token: "lease-token-1",
						workerId: "maestro-worker",
						workerQueue: "runs.default",
					},
					events: [],
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			claimNextAgentRuntimeRun(
				{
					workerId: "maestro-worker",
					workerQueue: "runs.default",
					leaseSeconds: Number.NaN,
				},
				{ config },
			),
		).resolves.toMatchObject({
			run: { state: PlatformAgentRunStateValue.Running },
			lease: { token: "lease-token-1" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
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
						links: [
							{
								id: "link_search_owner",
								sourceThingId: "thing_pipeline",
								targetThingId: "thing_owner",
								kind: "LINK_KIND_OWNS",
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

				if (url.endsWith("/cerebro.v1.CerebroService/MapThing")) {
					expect(body).toMatchObject({
						workspaceId: "ws_env",
						thingId: "thing_pipeline",
						depth: 1,
					});
					return Response.json({
						root: {
							id: "thing_pipeline",
							name: "Pipeline",
							kind: "THING_KIND_SERVICE",
						},
						things: [
							{
								id: "thing_owner",
								name: "Platform",
								kind: "THING_KIND_TEAM",
							},
						],
						links: [
							{
								id: "link_pipeline_owner",
								sourceThingId: "thing_pipeline",
								targetThingId: "thing_owner",
								kind: "LINK_KIND_OWNS",
							},
						],
						paths: [
							{
								thingIds: ["thing_pipeline", "thing_owner"],
								linkIds: ["link_pipeline_owner"],
							},
						],
						evidence: [
							{
								id: "evidence_graph",
								uri: "https://github.com/evalops/platform/blob/main/OWNERS",
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
							{
								event: { id: "" },
								affectedThingIds: ["thing_pipeline"],
								whyItMatters: "Pipeline ownership changed",
							},
							{
								event: { id: "" },
								affectedThingIds: ["thing_pipeline"],
								whyItMatters: "Pipeline ownership changed",
							},
							{ affectedThingIds: [], whyItMatters: "" },
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
									thingIds: [
										"thing_pipeline",
										"thing_pipeline_canonical",
										"thing_owner",
									],
									linkIds: ["link_search_owner", "link_pipeline_owner"],
									factIds: ["fact_pipeline_owner"],
									eventIds: ["event_pipeline_deploy"],
									links: [
										{
											id: "link_search_owner",
											sourceThingId: "thing_pipeline",
											targetThingId: "thing_owner",
											kind: "LINK_KIND_OWNS",
										},
										{
											id: "link_pipeline_owner",
											sourceThingId: "thing_pipeline",
											targetThingId: "thing_owner",
											kind: "LINK_KIND_OWNS",
										},
									],
									paths: [
										{
											thingIds: ["thing_pipeline", "thing_owner"],
											linkIds: ["link_pipeline_owner"],
										},
									],
									changes: [
										{
											id: "change_pipeline_recent",
											thingId: "thing_pipeline",
										},
										{
											event: { id: "" },
											affectedThingIds: ["thing_pipeline"],
											whyItMatters: "Pipeline ownership changed",
										},
									],
									watermarks: [],
									summary: {
										thingCount: 3,
										linkCount: 2,
										pathCount: 1,
										factCount: 1,
										eventCount: 1,
										changeCount: 2,
										evidenceCount: 3,
										watermarkCount: 0,
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
			"https://cerebro.test/cerebro.v1.CerebroService/MapThing",
			"https://cerebro.test/cerebro.v1.CerebroService/ListChanges",
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/HandleTrigger",
		]);
	});

	it("keeps gathered Cerebro facts when one map lookup fails", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_URL", "https://runtime.test/");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "runtime-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");
		vi.stubEnv("MAESTRO_CEREBRO_URL", "https://cerebro.test/");
		vi.stubEnv("MAESTRO_CEREBRO_MAX_ATTEMPTS", "1");

		const requests: string[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const body = parseRequestBody(init?.body);
				requests.push(url);

				if (url.endsWith("/cerebro.v1.CerebroService/Search")) {
					return Response.json({
						things: [
							{ id: "thing_pipeline", name: "Pipeline" },
							{ id: "thing_scheduler", name: "Scheduler" },
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
					if (body?.thingId === "thing_pipeline") {
						return Response.json({
							thing: { id: "thing_pipeline", name: "Pipeline" },
							facts: [
								{
									id: "fact_pipeline_owner",
									subjectThingId: "thing_pipeline",
									statement: "Pipeline is owned by Platform",
								},
							],
						});
					}
					expect(body?.thingId).toBe("thing_scheduler");
					return Response.json({
						thing: { id: "thing_scheduler", name: "Scheduler" },
						facts: [
							{
								id: "fact_scheduler_slo",
								subjectThingId: "thing_scheduler",
								statement: "Scheduler has an SLO",
							},
						],
					});
				}

				if (url.endsWith("/cerebro.v1.CerebroService/MapThing")) {
					if (body?.thingId === "thing_scheduler") {
						return new Response("map temporarily unavailable", { status: 503 });
					}
					expect(body).toMatchObject({
						workspaceId: "ws_env",
						thingId: "thing_pipeline",
						depth: 1,
					});
					return Response.json({
						root: { id: "thing_pipeline", name: "Pipeline" },
						things: [{ id: "thing_owner", name: "Platform" }],
						links: [
							{
								id: "link_pipeline_owner",
								sourceThingId: "thing_pipeline",
								targetThingId: "thing_owner",
							},
						],
						paths: [
							{
								thingIds: ["thing_pipeline", "thing_owner"],
								linkIds: ["link_pipeline_owner"],
							},
						],
						evidence: [
							{
								id: "evidence_graph",
								uri: "https://github.com/evalops/platform/blob/main/OWNERS",
							},
						],
					});
				}

				if (url.endsWith("/cerebro.v1.CerebroService/ListChanges")) {
					expect(body).toMatchObject({
						workspaceId: "ws_env",
						thingIds: ["thing_pipeline", "thing_scheduler"],
						limit: 10,
					});
					return Response.json({
						changes: [{ id: "change_pipeline_recent" }],
					});
				}

				if (
					url ===
					"https://runtime.test/agentruntime.v1.AgentRuntimeService/HandleTrigger"
				) {
					expect(body).toMatchObject({
						trigger: {
							workspaceId: "ws_env",
							payload: {
								maestroSessionId: "session_1",
								facts_context: {
									provider: "cerebro",
									thingIds: [
										"thing_pipeline",
										"thing_scheduler",
										"thing_owner",
									],
									linkIds: ["link_pipeline_owner"],
									factIds: ["fact_pipeline_owner", "fact_scheduler_slo"],
									links: [
										{
											id: "link_pipeline_owner",
											sourceThingId: "thing_pipeline",
											targetThingId: "thing_owner",
										},
									],
									paths: [
										{
											thingIds: ["thing_pipeline", "thing_owner"],
											linkIds: ["link_pipeline_owner"],
										},
									],
									summary: {
										thingCount: 3,
										linkCount: 1,
										pathCount: 1,
										factCount: 2,
										changeCount: 1,
										evidenceCount: 2,
									},
								},
							},
						},
					});
					return Response.json({
						run: {
							id: "run_with_partial_map",
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
			run: { id: "run_with_partial_map" },
		});

		expect(requests).toEqual([
			"https://cerebro.test/cerebro.v1.CerebroService/Search",
			"https://cerebro.test/cerebro.v1.CerebroService/GetThing",
			"https://cerebro.test/cerebro.v1.CerebroService/GetThing",
			"https://cerebro.test/cerebro.v1.CerebroService/MapThing",
			"https://cerebro.test/cerebro.v1.CerebroService/MapThing",
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

	it("keeps the A2A send result when task lookup is temporarily unavailable", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_A2A_ENABLED", "true");
		vi.stubEnv(
			"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/HandleTrigger",
		);
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "runtime-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");

		const requests: Array<{
			body?: Record<string, unknown>;
			headers: Record<string, string>;
			url: string;
		}> = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				requests.push({
					url,
					headers: headersToRecord(init?.headers),
					body: parseRequestBody(init?.body),
				});
				if (url === "https://runtime.test/message:send") {
					return Response.json({
						task: {
							id: "task_from_send",
							contextId: "maestro-session:session_1",
							status: { state: "TASK_STATE_SUBMITTED" },
							metadata: {
								a2aMessageId: "maestro-session:ws_env:session_1",
								a2aTaskId: "task_from_send",
								agent_run_id: "run_from_send",
								agent_run_state: PlatformAgentRunStateValue.Queued,
								workspace_id: "ws_env",
								agent_id: "maestro",
								workerQueue: "agent-runtime.local",
								traceparent:
									"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
								tracestate: "evalops=maestro-test",
								correlationPath:
									"maestro_message_id=maestro-session:ws_env:session_1 a2a_task_id=task_from_send platform_agent_run_id=run_from_send worker_queue=agent-runtime.local",
							},
						},
					});
				}
				if (url === "https://runtime.test/tasks/task_from_send") {
					return Response.json(
						{ error: { code: "unavailable", message: "not indexed yet" } },
						{ status: 503 },
					);
				}
				return new Response("unexpected endpoint", { status: 404 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			recordMaestroSessionRuntimeTrigger({
				sessionId: "session_1",
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				tracestate: "evalops=maestro-test",
			}),
		).resolves.toMatchObject({
			run: { id: "run_from_send", state: PlatformAgentRunStateValue.Queued },
			events: [
				{
					type: "maestro.platform_runtime.a2a_correlated",
					runId: "run_from_send",
					attributes: {
						a2a_message_id: "maestro-session:ws_env:session_1",
						a2a_task_id: "task_from_send",
						platform_agent_run_id: "run_from_send",
						worker_queue: "agent-runtime.local",
						traceparent:
							"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
						tracestate: "evalops=maestro-test",
					},
				},
			],
		});
		expect(requests.map((request) => request.url)).toEqual([
			"https://runtime.test/message:send",
			"https://runtime.test/tasks/task_from_send",
			"https://runtime.test/tasks/task_from_send",
		]);
		expect(requests[0]?.headers).toMatchObject({
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			tracestate: "evalops=maestro-test",
		});
		expect(requests[1]?.headers).toMatchObject({
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			tracestate: "evalops=maestro-test",
		});
		expect(requests[2]?.headers).toMatchObject({
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			tracestate: "evalops=maestro-test",
		});
		expect(requests[0]?.body).toMatchObject({
			message: {
				metadata: {
					traceparent:
						"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
					tracestate: "evalops=maestro-test",
				},
			},
		});
	});

	it("normalizes AgentRuntime Connect URLs when authless A2A falls back to shared env", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_A2A_ENABLED", "true");
		vi.stubEnv(
			"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
			"https://runtime.test/agentruntime.v1.AgentRuntimeService/HandleTrigger",
		);
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");

		const requests: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			requests.push(url);
			if (url === "https://runtime.test/message:send") {
				return Response.json({
					task: {
						id: "task_from_send",
						contextId: "maestro-session:session_1",
						status: { state: "working" },
					},
				});
			}
			if (url === "https://runtime.test/tasks/task_from_send") {
				return Response.json({
					id: "task_from_send",
					contextId: "maestro-session:session_1",
					status: { state: "working" },
				});
			}
			return new Response("unexpected endpoint", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			recordMaestroSessionRuntimeTrigger({ sessionId: "session_1" }),
		).resolves.toMatchObject({
			run: { id: "task_from_send", state: PlatformAgentRunStateValue.Running },
		});
		expect(requests).toEqual([
			"https://runtime.test/message:send",
			"https://runtime.test/tasks/task_from_send",
		]);
	});

	it("preserves send-time run metadata when A2A task lookup returns status-only", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_A2A_ENABLED", "true");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_URL", "https://runtime.test/");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "runtime-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://runtime.test/message:send") {
				return Response.json({
					task: {
						id: "task_from_send",
						contextId: "maestro-session:session_1",
						status: { state: "TASK_STATE_SUBMITTED" },
						metadata: {
							a2aMessageId: "maestro-session:ws_env:session_1",
							a2aTaskId: "task_from_send",
							agent_run_id: "run_from_send",
							agent_run_state: PlatformAgentRunStateValue.Queued,
							workspace_id: "ws_env",
							agent_id: "maestro",
							workerQueue: "agent-runtime.local",
						},
					},
				});
			}
			if (url === "https://runtime.test/tasks/task_from_send") {
				return Response.json({
					id: "task_from_send",
					contextId: "maestro-session:session_1",
					status: { state: "working", timestamp: "2026-05-07T03:15:00Z" },
				});
			}
			return new Response("unexpected endpoint", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			recordMaestroSessionRuntimeTrigger({ sessionId: "session_1" }),
		).resolves.toMatchObject({
			run: {
				id: "run_from_send",
				state: PlatformAgentRunStateValue.Running,
				updatedAt: "2026-05-07T03:15:00Z",
				linkage: {
					runId: "run_from_send",
					workspaceId: "ws_env",
					agentId: "maestro",
				},
			},
			events: [
				{
					runId: "run_from_send",
					attributes: {
						a2a_message_id: "maestro-session:ws_env:session_1",
						a2a_task_id: "task_from_send",
						platform_agent_run_id: "run_from_send",
						worker_queue: "agent-runtime.local",
					},
				},
			],
		});
	});

	it("prefers dedicated A2A endpoint and credentials over AgentRuntime fallback env", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_A2A_ENABLED", "true");
		vi.stubEnv(
			"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
			"https://legacy-runtime.test/agentruntime.v1.AgentRuntimeService/HandleTrigger",
		);
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "legacy-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "legacy-org");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "legacy-ws");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_URL", "https://bridge.test/message:send");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_TOKEN", "a2a-token");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_ORG_ID", "a2a-org");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_WORKSPACE_ID", "a2a-ws");

		const requests: string[] = [];
		const headers: Record<string, string>[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				requests.push(url);
				headers.push(headersToRecord(init?.headers));
				if (url === "https://bridge.test/message:send") {
					return Response.json({
						task: {
							id: "task_1",
							contextId: "maestro-session:session_1",
							status: { state: "TASK_STATE_SUBMITTED" },
						},
					});
				}
				if (url === "https://bridge.test/tasks/task_1") {
					return Response.json({
						id: "task_1",
						contextId: "maestro-session:session_1",
						status: { state: "TASK_STATE_WORKING" },
					});
				}
				return new Response("unexpected endpoint", { status: 404 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			recordMaestroSessionRuntimeTrigger({ sessionId: "session_1" }),
		).resolves.toMatchObject({
			run: { id: "task_1", linkage: { workspaceId: "a2a-ws" } },
		});
		expect(requests).toEqual([
			"https://bridge.test/message:send",
			"https://bridge.test/tasks/task_1",
		]);
		expect(headers[0]).toMatchObject({
			authorization: "Bearer a2a-token",
			"content-type": "application/json",
			"x-organization-id": "a2a-org",
			"x-evalops-workspace-id": "a2a-ws",
		});
	});

	it("maps proto and JSON A2A task states", async () => {
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_A2A_ENABLED", "true");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_URL", "https://runtime.test/");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN", "runtime-token");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_AGENT_RUNTIME_WORKSPACE_ID", "ws_env");

		const cases = [
			{
				sessionId: "working",
				taskState: "working",
				runState: PlatformAgentRunStateValue.Running,
			},
			{
				sessionId: "input-required",
				taskState: "input-required",
				runState: PlatformAgentRunStateValue.Waiting,
			},
			{
				sessionId: "completed",
				taskState: "completed",
				runState: PlatformAgentRunStateValue.Succeeded,
			},
			{
				sessionId: "failed",
				taskState: "failed",
				runState: PlatformAgentRunStateValue.Failed,
			},
			{
				sessionId: "rejected",
				taskState: "TASK_STATE_REJECTED",
				runState: PlatformAgentRunStateValue.Failed,
			},
			{
				sessionId: "rejected-json",
				taskState: "rejected",
				runState: PlatformAgentRunStateValue.Failed,
			},
			{
				sessionId: "auth-required",
				taskState: "TASK_STATE_AUTH_REQUIRED",
				runState: PlatformAgentRunStateValue.Waiting,
			},
			{
				sessionId: "auth-required-json",
				taskState: "auth-required",
				runState: PlatformAgentRunStateValue.Waiting,
			},
			{
				sessionId: "canceled",
				taskState: "TASK_STATE_CANCELED",
				runState: PlatformAgentRunStateValue.Cancelled,
			},
			{
				sessionId: "cancelled",
				taskState: "TASK_STATE_CANCELLED",
				runState: PlatformAgentRunStateValue.Cancelled,
			},
			{
				sessionId: "canceled-json",
				taskState: "canceled",
				runState: PlatformAgentRunStateValue.Cancelled,
			},
			{
				sessionId: "cancelled-json",
				taskState: "cancelled",
				runState: PlatformAgentRunStateValue.Cancelled,
			},
		] as const;
		for (const testCase of cases) {
			const taskId = `task_${testCase.sessionId}`;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "https://runtime.test/message:send") {
					return Response.json({
						task: {
							id: taskId,
							contextId: `maestro-session:${testCase.sessionId}`,
							status: { state: "TASK_STATE_SUBMITTED" },
						},
					});
				}
				if (url === `https://runtime.test/tasks/${taskId}`) {
					return Response.json({
						id: taskId,
						contextId: `maestro-session:${testCase.sessionId}`,
						status: { state: testCase.taskState },
						metadata: {
							workspace_id: "ws_env",
							agent_id: "maestro",
						},
					});
				}
				return new Response("unexpected endpoint", { status: 404 });
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				recordMaestroSessionRuntimeTrigger({
					sessionId: testCase.sessionId,
				}),
			).resolves.toMatchObject({
				run: { id: taskId, state: testCase.runState },
			});
		}
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
