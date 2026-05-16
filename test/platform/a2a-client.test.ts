import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildA2AUserMessage,
	discoverA2AAgentCard,
	getA2ATask,
	resolveA2AServiceConfig,
	resolveA2ATraceContext,
	sendA2AMessage,
	streamA2AMessage,
	subscribeA2ATask,
} from "../../src/platform/a2a-client.js";

type CapturedRequest = {
	body?: Record<string, unknown>;
	headers: Record<string, string>;
	method?: string;
	pathname: string;
	url: string;
};

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

function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		}),
		{
			headers: { "content-type": "text/event-stream" },
		},
	);
}

async function collectAsyncIterable<T>(
	iterable: AsyncIterable<T>,
): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterable) {
		values.push(value);
	}
	return values;
}

describe("platform A2A client", () => {
	let requests: CapturedRequest[];

	beforeEach(() => {
		requests = [];
		for (const name of [
			"MAESTRO_PLATFORM_A2A_URL",
			"MAESTRO_A2A_URL",
			"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
			"PLATFORM_AGENT_RUNTIME_URL",
			"AGENT_RUNTIME_SERVICE_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"MAESTRO_PLATFORM_A2A_TOKEN",
			"MAESTRO_A2A_TOKEN",
			"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN",
			"AGENT_RUNTIME_SERVICE_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"MAESTRO_PLATFORM_A2A_ORG_ID",
			"MAESTRO_A2A_ORG_ID",
			"MAESTRO_AGENT_RUNTIME_ORG_ID",
			"AGENT_RUNTIME_ORGANIZATION_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_PLATFORM_A2A_WORKSPACE_ID",
			"MAESTRO_A2A_WORKSPACE_ID",
			"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
			"AGENT_RUNTIME_WORKSPACE_ID",
			"MAESTRO_EVALOPS_WORKSPACE_ID",
			"MAESTRO_WORKSPACE_ID",
			"EVALOPS_WORKSPACE_ID",
			"MAESTRO_AGENT_ID",
			"MAESTRO_SESSION_ID",
			"MAESTRO_USER_ID",
			"TRACEPARENT",
			"TRACE_PARENT",
			"TRACESTATE",
			"TRACE_STATE",
			"MAESTRO_TRACEPARENT",
			"MAESTRO_TRACESTATE",
		]) {
			vi.stubEnv(name, "");
		}
		vi.stubEnv(
			"MAESTRO_PLATFORM_A2A_URL",
			"https://platform.test/message:send",
		);
		vi.stubEnv("MAESTRO_PLATFORM_A2A_TOKEN", "a2a-token");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_ORG_ID", "org_1");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_WORKSPACE_ID", "ws_1");
		vi.stubEnv("MAESTRO_AGENT_ID", "agent_maestro");
		vi.stubEnv("MAESTRO_SESSION_ID", "session_1");
		vi.stubEnv("MAESTRO_USER_ID", "user_1");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const parsed = new URL(url);
				requests.push({
					body: parseRequestBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					pathname: parsed.pathname,
					url,
				});

				if (parsed.pathname === "/.well-known/agent-card.json") {
					return Response.json({
						name: "EvalOps Platform Agent Runtime",
						description: "A2A facade",
						supportedInterfaces: [
							{
								url: "https://platform.test",
								protocolBinding: "HTTP+JSON",
								protocolVersion: "1.0",
							},
						],
						version: "test",
						capabilities: { streaming: false, pushNotifications: false },
						defaultInputModes: ["text/plain"],
						defaultOutputModes: ["application/json"],
						skills: [
							{
								id: "platform-agent-runtime",
								name: "Platform AgentRuntime",
								description: "Submit work",
								tags: ["evalops"],
							},
						],
					});
				}

				if (parsed.pathname === "/message:send") {
					return Response.json({
						task: {
							id: "run_1",
							contextId: "session_1",
							status: { state: "TASK_STATE_SUBMITTED" },
							metadata: { agentRunId: "run_1" },
						},
					});
				}

				if (parsed.pathname === "/message:stream") {
					return sseResponse([
						'data: {"task":{"id":"run_stream","contextId":"session_1","status":{"state":"TASK_STATE_SUBMITTED"}}}\n\n',
						'data: {"statusUpdate":{"taskId":"run_stream","contextId":"session_1","status":{"state":"TASK_STATE_WORKING","timestamp":"2026-05-16T12:00:00.000Z"},"metadata":{"step":"start"}}}\n\n',
						'data: {"artifactUpdate":{"taskId":"run_stream","contextId":"session_1","artifact":{"artifactId":"artifact_1","name":"summary","parts":[{"text":"done","mediaType":"text/plain"}]},"append":false,"lastChunk":true}}\n\n',
					]);
				}

				if (parsed.pathname === "/tasks/run_1") {
					return Response.json({
						id: "run_1",
						contextId: "session_1",
						status: { state: "TASK_STATE_COMPLETED" },
					});
				}

				if (parsed.pathname === "/tasks/run_1:subscribe") {
					return sseResponse([
						'data: {"taskId":"run_1","status":{"state":"TASK_STATE_WORKING"}}\r\n\r\n',
						'data: {"taskId":"run_1","artifact":{"artifactId":"artifact_2","parts":[{"text":"partial"}]},"append":true}\r\n\r\n',
						'data: {"taskId":"run_1","status":{"state":"TASK_STATE_COMPLETED"},"final":true}\r\n\r\n',
					]);
				}

				return Response.json(
					{ error: { code: "not_found", message: `unexpected ${url}` } },
					{ status: 404 },
				);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("resolves A2A config from shared EvalOps environment", async () => {
		await expect(resolveA2AServiceConfig()).resolves.toMatchObject({
			baseUrl: "https://platform.test",
			token: "a2a-token",
			organizationId: "org_1",
			workspaceId: "ws_1",
			agentId: "agent_maestro",
			sessionId: "session_1",
			actorId: "user_1",
		});
	});

	it("resolves explicit overrides without requiring A2A environment", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_URL", "");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_TOKEN", "");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_WORKSPACE_ID", "");

		await expect(
			resolveA2AServiceConfig({
				baseUrl: "https://override.test/message:send",
				token: "override-token",
				workspaceId: "ws_override",
				timeoutMs: 123,
				maxAttempts: 1,
			}),
		).resolves.toMatchObject({
			baseUrl: "https://override.test",
			token: "override-token",
			workspaceId: "ws_override",
			timeoutMs: 123,
			maxAttempts: 1,
		});
	});

	it("does not forward generic EvalOps tokens to arbitrary A2A URLs", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_URL", "");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_TOKEN", "");
		vi.stubEnv("MAESTRO_A2A_URL", "https://third-party-a2a.test");
		vi.stubEnv("MAESTRO_A2A_WORKSPACE_ID", "ws_external");
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "evalops-access-token");
		vi.stubEnv("EVALOPS_TOKEN", "evalops-token");

		const config = await resolveA2AServiceConfig();
		if (!config) {
			throw new Error("expected config");
		}

		expect(config.token).toBeUndefined();
		await discoverA2AAgentCard(config);

		expect(requests[0]?.headers).not.toHaveProperty("authorization");
	});

	it("discovers the Platform A2A agent card", async () => {
		const config = await resolveA2AServiceConfig();
		if (!config) {
			throw new Error("expected config");
		}

		await expect(discoverA2AAgentCard(config)).resolves.toMatchObject({
			name: "EvalOps Platform Agent Runtime",
			supportedInterfaces: [
				{
					protocolBinding: "HTTP+JSON",
					protocolVersion: "1.0",
				},
			],
		});

		expect(requests[0]).toMatchObject({
			method: "GET",
			url: "https://platform.test/.well-known/agent-card.json",
			headers: expect.objectContaining({
				authorization: "Bearer a2a-token",
				"x-evalops-workspace-id": "ws_1",
				"x-evalops-agent-id": "agent_maestro",
				"x-evalops-session-id": "session_1",
			}),
		});
	});

	it("sends A2A messages with Platform correlation metadata", async () => {
		const config = await resolveA2AServiceConfig();
		if (!config) {
			throw new Error("expected config");
		}

		await expect(
			sendA2AMessage(config, {
				message: buildA2AUserMessage({
					messageId: "msg_1",
					contextId: "session_1",
					text: "Run the release smoke test",
					metadata: {
						workspaceId: "caller_ws",
						agentId: "caller_agent",
						sessionId: "caller_session",
						actorId: "caller_actor",
						requestKind: "smoke",
					},
				}),
				configuration: { returnImmediately: true },
				traceContext: {
					traceparent:
						"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
					tracestate: "evalops=maestro",
				},
			}),
		).resolves.toMatchObject({
			task: {
				id: "run_1",
				status: { state: "TASK_STATE_SUBMITTED" },
			},
		});

		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "https://platform.test/message:send",
			body: expect.objectContaining({
				message: expect.objectContaining({
					messageId: "msg_1",
					metadata: expect.objectContaining({
						workspaceId: "ws_1",
						agentId: "agent_maestro",
						sessionId: "session_1",
						actorId: "user_1",
						requestKind: "smoke",
						traceparent:
							"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
						tracestate: "evalops=maestro",
					}),
				}),
				configuration: { returnImmediately: true },
			}),
			headers: expect.objectContaining({
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				tracestate: "evalops=maestro",
			}),
		});
		expect(requests[0]?.body).not.toHaveProperty("traceContext");
	});

	it("keeps explicit partial trace context isolated from env tracestate", () => {
		vi.stubEnv("TRACESTATE", "evalops=stale-env-state");

		expect(
			resolveA2ATraceContext(
				{
					traceparent:
						"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				},
				{ envFallback: false },
			),
		).toEqual({
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
		});
		expect(
			resolveA2ATraceContext({
				tracestate: "evalops=orphan-state",
			}),
		).toBeUndefined();
	});

	it("does not backfill env tracestate when sending an explicit traceparent", async () => {
		vi.stubEnv("TRACESTATE", "evalops=stale-env-state");
		const config = await resolveA2AServiceConfig();
		if (!config) {
			throw new Error("expected config");
		}

		await sendA2AMessage(config, {
			message: buildA2AUserMessage({
				messageId: "msg_partial_trace",
				contextId: "session_1",
				text: "Run with a request trace only",
			}),
			traceContext: {
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			},
		});

		expect(requests[0]?.headers).toMatchObject({
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
		});
		expect(requests[0]?.headers).not.toHaveProperty("tracestate");
		expect(requests[0]?.body).not.toHaveProperty("traceContext");
		expect(requests[0]?.body).toMatchObject({
			message: {
				metadata: {
					traceparent:
						"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				},
			},
		});
		expect(
			(requests[0]?.body?.message as Record<string, unknown>)
				?.metadata as Record<string, unknown>,
		).not.toHaveProperty("tracestate");
	});

	it("streams A2A message events with Platform correlation metadata", async () => {
		const config = await resolveA2AServiceConfig();
		if (!config) {
			throw new Error("expected config");
		}

		const events = await collectAsyncIterable(
			streamA2AMessage(config, {
				message: buildA2AUserMessage({
					messageId: "msg_stream",
					contextId: "session_1",
					text: "Stream the release smoke test",
				}),
				traceContext: {
					traceparent:
						"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
					tracestate: "evalops=maestro",
				},
			}),
		);

		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "https://platform.test/message:stream",
			body: {
				message: expect.objectContaining({
					messageId: "msg_stream",
					metadata: expect.objectContaining({
						workspaceId: "ws_1",
						agentId: "agent_maestro",
						sessionId: "session_1",
						actorId: "user_1",
						traceparent:
							"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
						tracestate: "evalops=maestro",
					}),
				}),
			},
			headers: expect.objectContaining({
				accept: "text/event-stream",
				authorization: "Bearer a2a-token",
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				tracestate: "evalops=maestro",
				"x-evalops-workspace-id": "ws_1",
			}),
		});
		expect(requests[0]?.body).not.toHaveProperty("traceContext");
		expect(events).toEqual([
			{
				type: "task",
				task: {
					id: "run_stream",
					contextId: "session_1",
					status: { state: "TASK_STATE_SUBMITTED" },
				},
			},
			{
				type: "statusUpdate",
				taskId: "run_stream",
				contextId: "session_1",
				status: {
					state: "TASK_STATE_WORKING",
					timestamp: "2026-05-16T12:00:00.000Z",
				},
				metadata: { step: "start" },
			},
			{
				type: "artifactUpdate",
				taskId: "run_stream",
				contextId: "session_1",
				artifact: {
					artifactId: "artifact_1",
					name: "summary",
					parts: [{ text: "done", mediaType: "text/plain" }],
				},
				append: false,
				lastChunk: true,
			},
		]);
	});

	it("skips malformed A2A SSE frames without aborting the stream", async () => {
		const config = await resolveA2AServiceConfig();
		if (!config) {
			throw new Error("expected config");
		}
		vi.mocked(fetch).mockImplementationOnce(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const parsed = new URL(url);
				requests.push({
					body: parseRequestBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					pathname: parsed.pathname,
					url,
				});
				return sseResponse([
					"data: not-json\n\n",
					"data: null\n\n",
					'data: {"statusUpdate":{"taskId":"run_stream","status":{"state":"TASK_STATE_COMPLETED"},"final":true}}\n\n',
				]);
			},
		);

		const events = await collectAsyncIterable(
			streamA2AMessage(config, {
				message: buildA2AUserMessage({
					messageId: "msg_stream_malformed",
					contextId: "session_1",
					text: "Stream through malformed frames",
				}),
			}),
		);

		expect(events).toEqual([
			{
				type: "statusUpdate",
				taskId: "run_stream",
				status: { state: "TASK_STATE_COMPLETED" },
				final: true,
			},
		]);
	});

	it("gets an A2A task by run id", async () => {
		const config = await resolveA2AServiceConfig();
		if (!config) {
			throw new Error("expected config");
		}

		await expect(getA2ATask(config, "run_1")).resolves.toMatchObject({
			id: "run_1",
			status: { state: "TASK_STATE_COMPLETED" },
		});
		expect(requests[0]?.url).toBe("https://platform.test/tasks/run_1");
	});

	it("subscribes to A2A task SSE updates with explicit trace headers", async () => {
		const config = await resolveA2AServiceConfig();
		if (!config) {
			throw new Error("expected config");
		}

		const events = await collectAsyncIterable(
			subscribeA2ATask(config, "run_1", {
				traceContext: {
					traceparent:
						"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
					tracestate: "evalops=maestro",
				},
			}),
		);

		expect(requests[0]).toMatchObject({
			method: "GET",
			url: "https://platform.test/tasks/run_1:subscribe",
			headers: expect.objectContaining({
				accept: "text/event-stream",
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				tracestate: "evalops=maestro",
			}),
		});
		expect(events).toEqual([
			{
				type: "statusUpdate",
				taskId: "run_1",
				status: { state: "TASK_STATE_WORKING" },
			},
			{
				type: "artifactUpdate",
				taskId: "run_1",
				artifact: {
					artifactId: "artifact_2",
					parts: [{ text: "partial" }],
				},
				append: true,
			},
			{
				type: "statusUpdate",
				taskId: "run_1",
				status: { state: "TASK_STATE_COMPLETED" },
				final: true,
			},
		]);
	});

	it("cancels the A2A SSE body when the consumer stops early", async () => {
		const config = await resolveA2AServiceConfig();
		if (!config) {
			throw new Error("expected config");
		}
		let canceled = false;
		vi.mocked(fetch).mockImplementationOnce(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const parsed = new URL(url);
				requests.push({
					body: parseRequestBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					pathname: parsed.pathname,
					url,
				});
				const encoder = new TextEncoder();
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								encoder.encode(
									'data: {"taskId":"run_cancel","status":{"state":"TASK_STATE_WORKING"}}\n\n',
								),
							);
						},
						cancel() {
							canceled = true;
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		);

		for await (const event of subscribeA2ATask(config, "run_cancel")) {
			expect(event).toMatchObject({
				type: "statusUpdate",
				taskId: "run_cancel",
			});
			break;
		}

		expect(canceled).toBe(true);
		expect(requests.at(-1)?.url).toBe(
			"https://platform.test/tasks/run_cancel:subscribe",
		);
	});

	it("gets an A2A task with explicit trace headers", async () => {
		const config = await resolveA2AServiceConfig();
		if (!config) {
			throw new Error("expected config");
		}

		await getA2ATask(config, "run_1", {
			traceContext: {
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				tracestate: "evalops=maestro",
			},
		});

		expect(requests[0]?.headers).toMatchObject({
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			tracestate: "evalops=maestro",
		});
	});

	it("reuses the existing AgentRuntime service environment", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_URL", "");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_TOKEN", "");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_ORG_ID", "");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_WORKSPACE_ID", "");
		vi.stubEnv(
			"AGENT_RUNTIME_SERVICE_URL",
			"http://agent-runtime-service.staging.svc.cluster.local:8080",
		);
		vi.stubEnv("AGENT_RUNTIME_SERVICE_TOKEN", "agent-runtime-token");
		vi.stubEnv("AGENT_RUNTIME_ORGANIZATION_ID", "org_runtime");
		vi.stubEnv("AGENT_RUNTIME_WORKSPACE_ID", "ws_runtime");

		await expect(resolveA2AServiceConfig()).resolves.toMatchObject({
			baseUrl: "http://agent-runtime-service.staging.svc.cluster.local:8080",
			token: "agent-runtime-token",
			organizationId: "org_runtime",
			workspaceId: "ws_runtime",
		});
	});

	it("resolves from deploy's current Maestro AgentRuntime wiring", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_URL", "");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_TOKEN", "");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_ORG_ID", "");
		vi.stubEnv("MAESTRO_PLATFORM_A2A_WORKSPACE_ID", "");
		vi.stubEnv(
			"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
			"http://agent-runtime-service.evalops.svc.cluster.local:8080",
		);
		vi.stubEnv("MAESTRO_EVALOPS_WORKSPACE_ID", "evalops");

		await expect(resolveA2AServiceConfig()).resolves.toMatchObject({
			baseUrl: "http://agent-runtime-service.evalops.svc.cluster.local:8080",
			workspaceId: "evalops",
		});
	});
});
