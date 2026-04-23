import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeadlessRuntimeState } from "../../src/cli/headless-protocol.js";
import {
	connectToRemoteRunnerSession,
	shouldUseInteractiveRemoteAttach,
} from "../../src/remote-runner/attach-client.js";

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

describe("remote runner attach client", () => {
	let requests: CapturedRequest[];

	beforeEach(() => {
		requests = [];
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

				if (parsed.pathname.endsWith("/subscribe")) {
					return new Response(
						JSON.stringify({
							connection_id: "conn_1",
							subscription_id: "sub_1",
							role: requests[0]?.body?.role ?? "controller",
							controller_lease_granted: true,
							controller_subscription_id: "sub_1",
							controller_connection_id: "conn_1",
							lease_expires_at: "2026-04-23T20:00:00Z",
							heartbeat_interval_ms: 30000,
							snapshot: {
								protocolVersion: "2026-04-02",
								session_id: "sess_runtime_1",
								cursor: 0,
								last_init: null,
								state: createHeadlessRuntimeState(),
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				throw new Error(`Unexpected attach-client request: ${url}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("creates a controller connection and explicit subscription", async () => {
		await expect(
			connectToRemoteRunnerSession({
				gatewayBaseUrl:
					"https://runner.test/v1/runner-sessions/mrs_attach_1/headless",
				sessionId: "mrs_attach_1",
				tokenId: "rat_1",
				tokenSecret: "runner-secret",
				role: "controller",
				clientVersion: "0.10.8",
			}),
		).resolves.toMatchObject({
			sessionId: "sess_runtime_1",
			connectionId: "conn_1",
			subscriptionId: "sub_1",
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
				role: "controller",
				optOutNotifications: ["heartbeat"],
				capabilities: {
					serverRequests: ["approval", "user_input", "tool_retry"],
				},
			}),
		});
		expect(requests[1]).toMatchObject({
			method: "POST",
			url: "https://runner.test/v1/runner-sessions/mrs_attach_1/headless/api/headless/sessions/sess_runtime_1/subscribe",
			headers: expect.objectContaining({
				authorization: "Bearer runner-secret",
				"x-evalops-runner-attach-token-id": "rat_1",
				"x-maestro-headless-connection-id": "conn_1",
			}),
			body: expect.objectContaining({
				connectionId: "conn_1",
				role: "controller",
			}),
		});
	});

	it("keeps viewer attach capabilities read-only", async () => {
		await connectToRemoteRunnerSession({
			gatewayBaseUrl:
				"https://runner.test/v1/runner-sessions/mrs_attach_2/headless",
			sessionId: "mrs_attach_2",
			tokenId: "rat_2",
			tokenSecret: "runner-secret-2",
			role: "viewer",
		});

		expect(requests[0]?.body?.capabilities).toBeUndefined();
		expect(requests[1]?.body?.capabilities).toBeUndefined();
	});

	it("only uses the live attach client for interactive tty sessions", () => {
		expect(
			shouldUseInteractiveRemoteAttach({
				json: false,
				printEnv: false,
				stdinIsTTY: true,
				stdoutIsTTY: true,
			}),
		).toBe(true);
		expect(
			shouldUseInteractiveRemoteAttach({
				json: true,
				printEnv: false,
				stdinIsTTY: true,
				stdoutIsTTY: true,
			}),
		).toBe(false);
		expect(
			shouldUseInteractiveRemoteAttach({
				json: false,
				printEnv: true,
				stdinIsTTY: true,
				stdoutIsTTY: true,
			}),
		).toBe(false);
	});
});
