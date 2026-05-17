import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildOperatingPlaneRunsUrl,
	inspectOperatingPlaneRuns,
	resolveOperatingPlaneServiceConfig,
} from "../../src/platform/operating-plane-client.js";

type CapturedRequest = {
	headers: Record<string, string>;
	method?: string;
	pathname: string;
	searchParams: URLSearchParams;
	url: string;
};

function headersToRecord(
	headers: HeadersInit | undefined,
): Record<string, string> {
	return Object.fromEntries(new Headers(headers).entries());
}

describe("operating plane Platform client", () => {
	let requests: CapturedRequest[];

	beforeEach(() => {
		requests = [];
		for (const name of [
			"MAESTRO_AGENT_OPERATING_PLANE_URL",
			"AGENT_OPERATING_PLANE_URL",
			"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
			"AGENT_RUNTIME_SERVICE_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"MAESTRO_AGENT_OPERATING_PLANE_TOKEN",
			"AGENT_OPERATING_PLANE_TOKEN",
			"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN",
			"AGENT_RUNTIME_SERVICE_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"MAESTRO_AGENT_OPERATING_PLANE_ORG_ID",
			"AGENT_OPERATING_PLANE_ORGANIZATION_ID",
			"MAESTRO_AGENT_RUNTIME_ORG_ID",
			"AGENT_RUNTIME_ORGANIZATION_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"EVALOPS_ORG_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"MAESTRO_AGENT_OPERATING_PLANE_WORKSPACE_ID",
			"AGENT_OPERATING_PLANE_WORKSPACE_ID",
			"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
			"AGENT_RUNTIME_WORKSPACE_ID",
			"MAESTRO_WORKSPACE_ID",
			"EVALOPS_WORKSPACE_ID",
			"MAESTRO_AGENT_OPERATING_PLANE_TIMEOUT_MS",
			"AGENT_OPERATING_PLANE_TIMEOUT_MS",
			"MAESTRO_AGENT_OPERATING_PLANE_MAX_ATTEMPTS",
			"AGENT_OPERATING_PLANE_MAX_ATTEMPTS",
		]) {
			vi.stubEnv(name, "");
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("resolves dedicated operating-plane config and strips endpoint suffixes", async () => {
		vi.stubEnv(
			"MAESTRO_AGENT_OPERATING_PLANE_URL",
			"https://platform.test/v1/agent-operating-plane/runs",
		);
		vi.stubEnv("MAESTRO_AGENT_OPERATING_PLANE_TOKEN", "plane-token");
		vi.stubEnv("MAESTRO_AGENT_OPERATING_PLANE_ORG_ID", "org_plane");
		vi.stubEnv("MAESTRO_AGENT_OPERATING_PLANE_WORKSPACE_ID", "ws_plane");
		vi.stubEnv("MAESTRO_AGENT_OPERATING_PLANE_TIMEOUT_MS", "7500");
		vi.stubEnv("MAESTRO_AGENT_OPERATING_PLANE_MAX_ATTEMPTS", "4");

		await expect(resolveOperatingPlaneServiceConfig()).resolves.toMatchObject({
			baseUrl: "https://platform.test",
			token: "plane-token",
			organizationId: "org_plane",
			workspaceId: "ws_plane",
			timeoutMs: 7500,
			maxAttempts: 4,
		});
	});

	it("builds lookup URLs for Slack, trace, evidence, and authenticated gateway identity", () => {
		const url = buildOperatingPlaneRunsUrl(
			{
				baseUrl: "https://platform.test",
				token: "evalops-token",
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
				timeoutMs: 2000,
				maxAttempts: 2,
			},
			{
				threadId: "C123:1740000000.000100",
				traceId: "trace-1",
				sessionId: "maestro-session-1",
				evidenceId: "gateway:req_123",
				gatewayAuthenticatedSubject: "user:alice",
				audience: "audit",
				includeGates: false,
				limit: 25,
			},
		);

		const parsed = new URL(url);
		expect(parsed.origin).toBe("https://platform.test");
		expect(parsed.pathname).toBe("/v1/agent-operating-plane/runs");
		expect(parsed.searchParams.get("workspace_id")).toBe("ws_evalops");
		expect(parsed.searchParams.get("thread_id")).toBe("C123:1740000000.000100");
		expect(parsed.searchParams.get("trace_id")).toBe("trace-1");
		expect(parsed.searchParams.get("session_id")).toBe("maestro-session-1");
		expect(parsed.searchParams.get("evidence_id")).toBe("gateway:req_123");
		expect(parsed.searchParams.get("gateway_authenticated_subject")).toBe(
			"user:alice",
		);
		expect(parsed.searchParams.get("audience")).toBe("audit");
		expect(parsed.searchParams.get("include_gates")).toBe("false");
		expect(parsed.searchParams.get("limit")).toBe("25");
	});

	it("fetches operating-plane runs with EvalOps auth headers and no prompt content", async () => {
		vi.stubEnv("MAESTRO_AGENT_OPERATING_PLANE_URL", "https://platform.test");
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "evalops-token");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");
		vi.stubEnv("MAESTRO_WORKSPACE_ID", "ws_evalops");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const parsed = new URL(url);
				requests.push({
					headers: headersToRecord(init?.headers),
					method: init?.method,
					pathname: parsed.pathname,
					searchParams: parsed.searchParams,
					url,
				});

				return new Response(
					JSON.stringify({
						contract_version: "agent-operating-plane.v1",
						generated_at: "2026-05-17T05:45:00Z",
						runs: [
							{
								agent_run_id: "run_1",
								title: "Slack answer",
								status: "succeeded",
								surface: "slack",
								channel_thread_id: "C123:1740000000.000100",
								identity: {
									workspace_id: "ws_evalops",
									gateway_authenticated_subject: "user:alice",
								},
								evidence_refs: [
									{
										id: "gateway:req_123",
										source: "llm_gateway",
										kind: "model_event",
										available: true,
										summary: "Gateway model event metadata",
									},
								],
								value_proof: {
									operation_id: "run_1",
									operator_summary: "Gateway request is tied to Slack thread",
									identity_bound: true,
									model_observed: true,
									tool_observed: false,
									approval_observed: false,
									trace_linked: true,
									evidence_linked: true,
									cost_attributed: true,
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		const inspection = await inspectOperatingPlaneRuns({
			threadId: "C123:1740000000.000100",
			evidenceId: "gateway:req_123",
			gatewayAuthenticatedSubject: "user:alice",
			audience: "audit",
			includeGates: false,
		});

		expect(inspection.contract_version).toBe("agent-operating-plane.v1");
		expect(inspection.runs[0]).toMatchObject({
			agent_run_id: "run_1",
			channel_thread_id: "C123:1740000000.000100",
			identity: {
				gateway_authenticated_subject: "user:alice",
			},
			value_proof: {
				identity_bound: true,
				model_observed: true,
				evidence_linked: true,
				cost_attributed: true,
			},
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			method: "GET",
			pathname: "/v1/agent-operating-plane/runs",
			headers: expect.objectContaining({
				authorization: "Bearer evalops-token",
				"content-type": "application/json",
				"x-organization-id": "org_evalops",
			}),
		});
		expect(requests[0].searchParams.get("workspace_id")).toBe("ws_evalops");
		expect(requests[0].searchParams.get("thread_id")).toBe(
			"C123:1740000000.000100",
		);
		expect(requests[0].searchParams.get("evidence_id")).toBe("gateway:req_123");
		expect(requests[0].searchParams.get("gateway_authenticated_subject")).toBe(
			"user:alice",
		);
		expect(requests[0].searchParams.get("include_gates")).toBe("false");
	});

	it("surfaces Platform errors with response bodies for operator debugging", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					JSON.stringify({
						code: "missing_workspace_id",
						message: "workspace_id is required",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(
			inspectOperatingPlaneRuns(
				{},
				{
					config: {
						baseUrl: "https://platform.test",
						token: "evalops-token",
						organizationId: "org_evalops",
						timeoutMs: 2000,
						maxAttempts: 1,
					},
				},
			),
		).rejects.toThrow(
			/agent operating plane service returned 400: .*workspace_id is required/u,
		);
	});
});
