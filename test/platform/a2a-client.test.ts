import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildA2AUserMessage,
	discoverA2AAgentCard,
	getA2ATask,
	resolveA2AServiceConfig,
	sendA2AMessage,
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

				if (parsed.pathname === "/tasks/run_1") {
					return Response.json({
						id: "run_1",
						contextId: "session_1",
						status: { state: "TASK_STATE_COMPLETED" },
					});
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
					}),
				}),
				configuration: { returnImmediately: true },
			}),
		});
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
