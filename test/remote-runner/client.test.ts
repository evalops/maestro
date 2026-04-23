import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RUNNER_ATTACH_ROLES,
	RUNNER_SESSION_STATES,
	createRunnerSession,
	listRunnerSessions,
	mintRunnerAttachToken,
	verifyRunnerHeadlessAttach,
	waitForRunnerSessionReady,
} from "../../src/remote-runner/client.js";

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

describe("remote runner client", () => {
	let requests: CapturedRequest[];
	let getRunnerSessionResponses: Array<Record<string, unknown>>;

	beforeEach(() => {
		requests = [];
		getRunnerSessionResponses = [];
		for (const name of [
			"MAESTRO_REMOTE_RUNNER_URL",
			"REMOTE_RUNNER_SERVICE_URL",
			"EVALOPS_REMOTE_RUNNER_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"MAESTRO_REMOTE_RUNNER_TOKEN",
			"REMOTE_RUNNER_SERVICE_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"MAESTRO_REMOTE_RUNNER_ORG_ID",
			"REMOTE_RUNNER_ORGANIZATION_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
			"REMOTE_RUNNER_WORKSPACE_ID",
			"MAESTRO_WORKSPACE_ID",
			"EVALOPS_WORKSPACE_ID",
		]) {
			vi.stubEnv(name, "");
		}
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "evalops-token");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");
		vi.stubEnv("MAESTRO_REMOTE_RUNNER_WORKSPACE_ID", "ws_evalops");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const parsed = new URL(url);
				const request = {
					body: parseRequestBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					pathname: parsed.pathname,
					url,
				};
				requests.push(request);

				if (
					parsed.pathname ===
					"/remoterunner.v1.RemoteRunnerService/GetRunnerSession"
				) {
					const next =
						getRunnerSessionResponses.shift() ??
						({
							session: {
								id: request.body?.sessionId ?? "mrs_get_1",
								workspaceId: "ws_evalops",
								state: RUNNER_SESSION_STATES.RUNNING,
							},
						} satisfies Record<string, unknown>);
					return new Response(JSON.stringify(next), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				if (
					parsed.pathname ===
					"/remoterunner.v1.RemoteRunnerService/CreateRunnerSession"
				) {
					return new Response(
						JSON.stringify({
							session: {
								id: "mrs_create_1",
								workspaceId: request.body?.workspaceId,
								state: RUNNER_SESSION_STATES.REQUESTED,
								runnerProfile: request.body?.runnerProfile,
								repoUrl: request.body?.repoUrl,
								branch: request.body?.branch,
							},
							events: [
								{
									id: "evt_1",
									sessionId: "mrs_create_1",
									sequence: 1,
									eventType: "runner_session.requested",
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (
					parsed.pathname ===
					"/remoterunner.v1.RemoteRunnerService/ListRunnerSessions"
				) {
					return new Response(
						JSON.stringify({
							sessions: [
								{
									id: "mrs_list_1",
									workspace_id: request.body?.workspaceId,
									state: RUNNER_SESSION_STATES.RUNNING,
								},
							],
							next_offset: 2,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (
					parsed.pathname ===
					"/remoterunner.v1.RemoteRunnerService/MintAttachToken"
				) {
					return new Response(
						JSON.stringify({
							token: {
								id: "rat_1",
								sessionId: request.body?.sessionId,
								roles: request.body?.roles,
								expiresAt: "2026-04-22T23:59:00Z",
							},
							tokenSecret: "runner-secret",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (parsed.pathname.endsWith("/api/headless/connections")) {
					return new Response(
						JSON.stringify({
							session_id: "sess_runtime_1",
							connection_id: "conn_1",
							heartbeat_interval_ms: 30000,
							role: "controller",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (parsed.pathname.endsWith("/disconnect")) {
					return new Response(JSON.stringify({ success: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				throw new Error(`Unexpected remote runner request: ${url}`);
			}),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("creates runner sessions through the shared Platform Connect catalog", async () => {
		vi.stubEnv("MAESTRO_REMOTE_RUNNER_URL", "https://runner.test/");

		await expect(
			createRunnerSession({
				runnerProfile: "standard",
				repoUrl: "evalops/foo",
				branch: "main",
				ttlMinutes: 90,
				metadata: { source: "test" },
			}),
		).resolves.toMatchObject({
			session: {
				id: "mrs_create_1",
				workspaceId: "ws_evalops",
				state: RUNNER_SESSION_STATES.REQUESTED,
			},
			events: [{ eventType: "runner_session.requested" }],
		});

		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "https://runner.test/remoterunner.v1.RemoteRunnerService/CreateRunnerSession",
			headers: expect.objectContaining({
				authorization: "Bearer evalops-token",
				"connect-protocol-version": "1",
				"x-organization-id": "org_evalops",
			}),
			body: expect.objectContaining({
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
				runnerProfile: "standard",
				repoUrl: "evalops/foo",
				branch: "main",
				ttlMinutes: 90,
				metadata: { source: "test" },
			}),
		});
	});

	it("normalizes list filters and snake_case response fields", async () => {
		await expect(
			listRunnerSessions({
				state: "running",
				limit: 10,
				offset: 1,
			}),
		).resolves.toMatchObject({
			sessions: [
				{
					id: "mrs_list_1",
					workspaceId: "ws_evalops",
					state: RUNNER_SESSION_STATES.RUNNING,
				},
			],
			nextOffset: 2,
		});

		expect(requests[0]).toMatchObject({
			url: "https://runner.evalops.dev/remoterunner.v1.RemoteRunnerService/ListRunnerSessions",
			body: expect.objectContaining({
				state: RUNNER_SESSION_STATES.RUNNING,
				limit: 10,
				offset: 1,
			}),
		});
	});

	it("mints attach tokens and exposes the headless gateway target", async () => {
		vi.stubEnv("REMOTE_RUNNER_SERVICE_URL", "https://runner.staging.test");

		await expect(
			mintRunnerAttachToken({
				sessionId: "mrs_attach_1",
				roles: ["viewer", RUNNER_ATTACH_ROLES.CONTROLLER],
				ttlMinutes: 15,
			}),
		).resolves.toMatchObject({
			token: {
				id: "rat_1",
				sessionId: "mrs_attach_1",
				roles: [RUNNER_ATTACH_ROLES.VIEWER, RUNNER_ATTACH_ROLES.CONTROLLER],
			},
			tokenSecret: "runner-secret",
			gatewayBaseUrl:
				"https://runner.staging.test/v1/runner-sessions/mrs_attach_1/headless",
		});

		expect(requests[0]).toMatchObject({
			body: expect.objectContaining({
				sessionId: "mrs_attach_1",
				roles: [RUNNER_ATTACH_ROLES.VIEWER, RUNNER_ATTACH_ROLES.CONTROLLER],
				ttlMinutes: 15,
			}),
		});
	});

	it("verifies the existing headless gateway protocol with attach headers", async () => {
		await expect(
			verifyRunnerHeadlessAttach({
				gatewayBaseUrl:
					"https://runner.test/v1/runner-sessions/mrs_attach_1/headless",
				tokenId: "rat_1",
				tokenSecret: "runner-secret",
				sessionId: "mrs_attach_1",
				protocolVersion: "2026-04-02",
			}),
		).resolves.toMatchObject({
			sessionId: "sess_runtime_1",
			connectionId: "conn_1",
			heartbeatIntervalMs: 30000,
			role: "controller",
		});

		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "https://runner.test/v1/runner-sessions/mrs_attach_1/headless/api/headless/connections",
			headers: expect.objectContaining({
				authorization: "Bearer runner-secret",
				"x-evalops-runner-attach-token-id": "rat_1",
			}),
			body: expect.objectContaining({
				sessionId: "mrs_attach_1",
				protocolVersion: "2026-04-02",
				role: "controller",
			}),
		});
	});

	it("waits for runner sessions to become ready", async () => {
		getRunnerSessionResponses.push(
			{
				session: {
					id: "mrs_wait_1",
					workspaceId: "ws_evalops",
					state: RUNNER_SESSION_STATES.REQUESTED,
				},
			},
			{
				session: {
					id: "mrs_wait_1",
					workspaceId: "ws_evalops",
					state: RUNNER_SESSION_STATES.PROVISIONING,
				},
			},
			{
				session: {
					id: "mrs_wait_1",
					workspaceId: "ws_evalops",
					state: RUNNER_SESSION_STATES.RUNNING,
				},
			},
		);

		await expect(
			waitForRunnerSessionReady("mrs_wait_1", {
				pollIntervalMs: 0,
				timeoutMs: 10_000,
			}),
		).resolves.toMatchObject({
			session: {
				id: "mrs_wait_1",
				state: RUNNER_SESSION_STATES.RUNNING,
			},
			attempts: 3,
		});
	});

	it("does not use the total wait timeout as the per-request timeout", async () => {
		vi.useFakeTimers();
		const aborts: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => {
								aborts.push("aborted");
								const error = new Error("aborted");
								error.name = "AbortError";
								reject(error);
							},
							{ once: true },
						);
					}),
			),
		);

		const waitPromise = waitForRunnerSessionReady("mrs_wait_request_timeout", {
			maxAttempts: 1,
			pollIntervalMs: 0,
			timeoutMs: 10_000,
		});
		const assertion = expect(waitPromise).rejects.toThrow(
			"remote runner service request timed out after 5000ms",
		);

		await vi.advanceTimersByTimeAsync(4_999);
		expect(aborts).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await assertion;
	});

	it("fails fast when the runner session enters a terminal state", async () => {
		getRunnerSessionResponses.push({
			session: {
				id: "mrs_wait_failed",
				workspaceId: "ws_evalops",
				state: RUNNER_SESSION_STATES.FAILED,
				stopReason: "image pull backoff",
			},
		});

		await expect(
			waitForRunnerSessionReady("mrs_wait_failed", {
				pollIntervalMs: 0,
				timeoutMs: 10_000,
			}),
		).rejects.toThrow(
			"Remote runner session mrs_wait_failed entered terminal state failed: image pull backoff",
		);
	});

	it("times out when the runner session never becomes ready", async () => {
		vi.useFakeTimers();
		getRunnerSessionResponses.push(
			{
				session: {
					id: "mrs_wait_timeout",
					workspaceId: "ws_evalops",
					state: RUNNER_SESSION_STATES.REQUESTED,
				},
			},
			{
				session: {
					id: "mrs_wait_timeout",
					workspaceId: "ws_evalops",
					state: RUNNER_SESSION_STATES.REQUESTED,
				},
			},
		);

		const waitPromise = waitForRunnerSessionReady("mrs_wait_timeout", {
			pollIntervalMs: 5,
			timeoutMs: 5,
		});
		const assertion = expect(waitPromise).rejects.toThrow(
			"Timed out after 5ms waiting for remote runner session mrs_wait_timeout to become ready",
		);
		await vi.advanceTimersByTimeAsync(5);
		await assertion;
		vi.useRealTimers();
	});
});
