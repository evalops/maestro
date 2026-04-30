import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	listMaestroTimelineWithPlatform,
	resolveMaestroTimelineServiceConfig,
} from "../../src/platform/maestro-timeline-client.js";

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

describe("maestro timeline client", () => {
	let requests: CapturedRequest[];

	beforeEach(() => {
		requests = [];
		for (const name of [
			"MAESTRO_TIMELINE_SERVICE_URL",
			"MAESTRO_PLATFORM_TIMELINE_SERVICE_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"MAESTRO_TIMELINE_SERVICE_TOKEN",
			"MAESTRO_PLATFORM_TIMELINE_SERVICE_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"MAESTRO_TIMELINE_ORG_ID",
			"MAESTRO_PLATFORM_TIMELINE_ORG_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"MAESTRO_TIMELINE_WORKSPACE_ID",
			"MAESTRO_PLATFORM_TIMELINE_WORKSPACE_ID",
			"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
			"MAESTRO_EVALOPS_WORKSPACE_ID",
			"EVALOPS_WORKSPACE_ID",
			"MAESTRO_WORKSPACE_ID",
		]) {
			vi.stubEnv(name, "");
		}
		vi.stubEnv("MAESTRO_PLATFORM_BASE_URL", "https://platform.test/");
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "evalops-token");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");
		vi.stubEnv("MAESTRO_REMOTE_RUNNER_WORKSPACE_ID", "ws_evalops");

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

				if (
					parsed.pathname ===
					"/maestro.v1.MaestroTimelineService/ListRunTimeline"
				) {
					const requestBody = parseRequestBody(init?.body);
					if (requestBody?.pageToken === "page_2") {
						return new Response(
							JSON.stringify({
								organizationId: "org_evalops",
								workspaceId: "ws_evalops",
								sessionId: "sess_1",
								agentRunId: "run_1",
								remoteRunnerSessionId: "mrs_1",
								entries: [
									{
										id: "entry_audit_unknown",
										timestamp: "2026-04-30T18:02:00Z",
										type: "MAESTRO_TIMELINE_ENTRY_TYPE_RUNTIME_EVENT",
										title: "Unknown visibility",
										visibility: "MAESTRO_TIMELINE_VISIBILITY_FUTURE_INTERNAL",
										relatedIds: {
											sessionId: "sess_1",
											agentRunId: "run_1",
											remoteRunnerSessionId: "mrs_1",
										},
									},
								],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					return new Response(
						JSON.stringify({
							organizationId: "org_evalops",
							workspaceId: "ws_evalops",
							sessionId: "sess_1",
							agentRunId: "run_1",
							remoteRunnerSessionId: "mrs_1",
							partial: true,
							missingSources: ["audit"],
							nextPageToken: "page_2",
							entries: [
								{
									id: "entry_tool_1",
									timestamp: "2026-04-30T18:00:00Z",
									type: "MAESTRO_TIMELINE_ENTRY_TYPE_TOOL_CALL_COMPLETED",
									title: "Ran tests",
									summary: "npm test completed successfully",
									visibility: "MAESTRO_TIMELINE_VISIBILITY_USER_VISIBLE",
									sensitivity: "MAESTRO_TIMELINE_SENSITIVITY_INTERNAL",
									relatedIds: {
										sessionId: "sess_1",
										agentRunId: "run_1",
										agentRunStepId: "step_1",
										toolCallId: "tool_call_1",
										toolExecutionId: "texec_1",
										remoteRunnerSessionId: "mrs_1",
									},
									sourceObject: {
										source: "MAESTRO_TIMELINE_SOURCE_TOOL_EXECUTION",
										id: "texec_1",
										type: "toolexecution.v1.ToolExecution",
									},
									metadata: {
										command:
											"curl -H 'Authorization: Bearer leaked-token-1234567890'",
										prompt: "send sk-leaked1234567890",
										safeNote: "see ghp_leakedtoken1234567890",
										nested: {
											requestBody: "raw payload",
											status: "ok",
										},
									},
								},
								{
									id: "entry_approval_1",
									timestamp: "2026-04-30T18:01:00Z",
									type: "MAESTRO_TIMELINE_ENTRY_TYPE_TOOL_EXECUTION_WAITING_APPROVAL",
									title: "Approval required",
									visibility: "MAESTRO_TIMELINE_VISIBILITY_USER_VISIBLE",
									relatedIds: {
										sessionId: "sess_1",
										agentRunId: "run_1",
										toolExecutionId: "texec_2",
										approvalRequestId: "approval_1",
										remoteRunnerSessionId: "mrs_1",
									},
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				throw new Error(`Unexpected timeline request: ${url}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("resolves shared platform configuration for Maestro timelines", async () => {
		await expect(resolveMaestroTimelineServiceConfig()).resolves.toMatchObject({
			baseUrl: "https://platform.test",
			token: "evalops-token",
			organizationId: "org_evalops",
			workspaceId: "ws_evalops",
		});
	});

	it("maps Platform timeline entries into the composer timeline contract", async () => {
		const config = await resolveMaestroTimelineServiceConfig();
		if (!config) {
			throw new Error("expected timeline config");
		}

		const response = await listMaestroTimelineWithPlatform(config, {
			sessionId: "sess_1",
			agentRunId: "run_1",
			remoteRunnerSessionId: "mrs_1",
			pendingRequestCount: 1,
		});

		expect(response).toMatchObject({
			sessionId: "sess_1",
			source: "platform",
			platformBacked: true,
			pendingRequestCount: 1,
			items: [
				{
					id: "entry_tool_1",
					type: "tool.completed",
					source: "platform",
					status: "completed",
					toolCallId: "tool_call_1",
					toolExecutionId: "texec_1",
					remoteRunnerSessionId: "mrs_1",
					metadata: expect.objectContaining({
						agentRunId: "run_1",
						agentRunStepId: "step_1",
						platformPartial: true,
						platformMissingSources: ["audit"],
						sourceObjectId: "texec_1",
						safeNote: "see [redacted-token]",
						nested: { status: "ok" },
					}),
				},
				{
					id: "entry_approval_1",
					type: "wait.pending",
					status: "pending",
					toolExecutionId: "texec_2",
					approvalRequestId: "approval_1",
					platformOperation: "ResumeToolExecution",
				},
				{
					id: "entry_audit_unknown",
					type: "session.updated",
					visibility: "audit",
				},
			],
		});

		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "https://platform.test/maestro.v1.MaestroTimelineService/ListRunTimeline",
			headers: expect.objectContaining({
				authorization: "Bearer evalops-token",
				"connect-protocol-version": "1",
				"x-organization-id": "org_evalops",
			}),
			body: expect.objectContaining({
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
				sessionId: "sess_1",
				agentRunId: "run_1",
				remoteRunnerSessionId: "mrs_1",
				includeAdminSummaries: true,
				includeAuditOnly: false,
			}),
		});
		expect(requests[1]).toMatchObject({
			body: expect.objectContaining({
				pageToken: "page_2",
			}),
		});
		const serialized = JSON.stringify(
			response.items.find((item) => item.id === "entry_tool_1")?.metadata,
		);
		expect(serialized).not.toContain("Authorization");
		expect(serialized).not.toContain("leaked-token");
		expect(serialized).not.toContain("sk-leaked");
		expect(serialized).not.toContain("raw payload");
	});
});
