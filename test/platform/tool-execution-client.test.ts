import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	executeToolWithPlatform,
	recordToolExecutionOutputWithPlatform,
	resolveToolExecutionServiceConfig,
	resumeToolExecutionWithPlatform,
} from "../../src/platform/tool-execution-client.js";

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

describe("tool execution client", () => {
	let requests: CapturedRequest[];

	beforeEach(() => {
		requests = [];
		for (const name of [
			"TOOL_EXECUTION_SERVICE_URL",
			"MAESTRO_TOOL_EXECUTION_SERVICE_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"TOOL_EXECUTION_SERVICE_TOKEN",
			"MAESTRO_TOOL_EXECUTION_SERVICE_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"TOOL_EXECUTION_SERVICE_ORGANIZATION_ID",
			"MAESTRO_TOOL_EXECUTION_ORGANIZATION_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"TOOL_EXECUTION_SERVICE_WORKSPACE_ID",
			"MAESTRO_TOOL_EXECUTION_WORKSPACE_ID",
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
					"/toolexecution.v1.ToolExecutionService/ExecuteTool"
				) {
					return new Response(
						JSON.stringify({
							execution: {
								id: "texec_1",
								state: "TOOL_EXECUTION_STATE_WAITING_APPROVAL",
								approvalWait: {
									approvalRequestId: "approval_1",
									resumeToken: "resume_1",
									reason: "manager approval required",
								},
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (
					parsed.pathname ===
					"/toolexecution.v1.ToolExecutionService/ResumeToolExecution"
				) {
					return new Response(
						JSON.stringify({
							execution: {
								id: "texec_1",
								state: "TOOL_EXECUTION_STATE_SUCCEEDED",
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (
					parsed.pathname ===
					"/toolexecution.v1.ToolExecutionService/RecordToolExecutionOutput"
				) {
					return new Response(
						JSON.stringify({
							execution: {
								id: "texec_1",
								state: "TOOL_EXECUTION_STATE_SUCCEEDED",
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				throw new Error(`Unexpected tool execution request: ${url}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("resolves shared platform configuration for tool execution", async () => {
		await expect(resolveToolExecutionServiceConfig()).resolves.toMatchObject({
			baseUrl: "https://platform.test",
			token: "evalops-token",
			organizationId: "org_evalops",
			workspaceId: "ws_evalops",
		});
	});

	it("executes tool requests through the shared connect catalog", async () => {
		const config = await resolveToolExecutionServiceConfig();
		if (!config) {
			throw new Error("expected tool execution config");
		}

		await expect(
			executeToolWithPlatform(config, {
				linkage: {
					workspaceId: "ws_evalops",
					organizationId: "org_evalops",
					agentId: "maestro",
					runId: "run_1",
					stepId: "tool_call_1",
				},
				tool: {
					namespace: "maestro",
					name: "bash",
					capability: "maestro.tool.bash",
					idempotent: false,
					mutatesResource: true,
				},
				arguments: { command: "git push" },
				riskLevel: "RISK_LEVEL_HIGH",
				idempotencyKey: "maestro:tool_call_1",
				metadata: {
					maestro_tool_call_id: "tool_call_1",
				},
			}),
		).resolves.toMatchObject({
			execution: {
				id: "texec_1",
				state: "TOOL_EXECUTION_STATE_WAITING_APPROVAL",
				approvalWait: {
					approvalRequestId: "approval_1",
					resumeToken: "resume_1",
				},
			},
		});

		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "https://platform.test/toolexecution.v1.ToolExecutionService/ExecuteTool",
			headers: expect.objectContaining({
				authorization: "Bearer evalops-token",
				"connect-protocol-version": "1",
				"x-organization-id": "org_evalops",
			}),
			body: expect.objectContaining({
				idempotencyKey: "maestro:tool_call_1",
				riskLevel: "RISK_LEVEL_HIGH",
				linkage: expect.objectContaining({
					workspaceId: "ws_evalops",
					runId: "run_1",
					stepId: "tool_call_1",
				}),
				tool: expect.objectContaining({
					namespace: "maestro",
					name: "bash",
				}),
			}),
		});
	});

	it("resumes pending approval waits through the shared connect catalog", async () => {
		const config = await resolveToolExecutionServiceConfig();
		if (!config) {
			throw new Error("expected tool execution config");
		}

		await expect(
			resumeToolExecutionWithPlatform(config, {
				executionId: "texec_1",
				approvalRequestId: "approval_1",
				resumeToken: "resume_1",
				approved: true,
				decidedBy: "user_1",
				reason: "approved in ui",
			}),
		).resolves.toMatchObject({
			execution: {
				id: "texec_1",
				state: "TOOL_EXECUTION_STATE_SUCCEEDED",
			},
		});

		expect(requests[0]?.pathname).toBe(
			"/toolexecution.v1.ToolExecutionService/ResumeToolExecution",
		);
		expect(requests[0]?.body).toMatchObject({
			executionId: "texec_1",
			approvalRequestId: "approval_1",
			resumeToken: "resume_1",
			approved: true,
			decidedBy: "user_1",
			reason: "approved in ui",
		});
	});

	it("records local execution output through the shared connect catalog", async () => {
		const config = await resolveToolExecutionServiceConfig();
		if (!config) {
			throw new Error("expected tool execution config");
		}

		await expect(
			recordToolExecutionOutputWithPlatform(config, {
				executionId: "texec_1",
				output: {
					safeOutput: {
						status: "succeeded",
						summary: "git status clean",
					},
					redactions: [],
					contentType: "application/json",
					durationMs: 42,
				},
				metadata: {
					maestro_local_outcome: "succeeded",
				},
			}),
		).resolves.toMatchObject({
			execution: {
				id: "texec_1",
				state: "TOOL_EXECUTION_STATE_SUCCEEDED",
			},
		});

		expect(requests[0]?.pathname).toBe(
			"/toolexecution.v1.ToolExecutionService/RecordToolExecutionOutput",
		);
		expect(requests[0]?.body).toMatchObject({
			executionId: "texec_1",
			output: {
				safeOutput: {
					status: "succeeded",
					summary: "git status clean",
				},
				contentType: "application/json",
				durationMs: 42,
			},
			metadata: {
				maestro_local_outcome: "succeeded",
			},
		});
	});
});
