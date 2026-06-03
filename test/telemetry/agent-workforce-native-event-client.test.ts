import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
} from "../../src/agent/action-approval.js";
import type {
	AgentEvent,
	AssistantMessage,
	ToolResultMessage,
} from "../../src/agent/types.js";
import {
	type AgentWorkforceNativeEventBatchBody,
	buildAgentWorkforceNativeEventBatchBody,
	mirrorAgentWorkforceNativeEventsToPlatform,
	postAgentWorkforceNativeEventBatchToPlatform,
	resolveAgentWorkforceNativeEventPlatformConfig,
} from "../../src/telemetry/agent-workforce-native-event-client.js";
import {
	type AgentWorkforceNativeEvent,
	type AgentWorkforceNativeProjectionOptions,
	type AgentWorkforcePlatformCredentialAuthority,
	projectAgentWorkforceNativeEvents,
	verifyAgentWorkforceNativeEventChain,
} from "../../src/telemetry/agent-workforce-native-event.js";

const baseTime = new Date("2026-06-03T16:30:00.000Z");

type CapturedRequest = {
	body: AgentWorkforceNativeEventBatchBody;
	headers: Record<string, string>;
	method?: string;
	url: string;
};

function headersToRecord(
	headers: HeadersInit | undefined,
): Record<string, string> {
	return Object.fromEntries(new Headers(headers).entries());
}

function parseBatchBody(
	body: BodyInit | null | undefined,
): AgentWorkforceNativeEventBatchBody {
	return JSON.parse(String(body ?? "{}")) as AgentWorkforceNativeEventBatchBody;
}

function usageMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.5",
		usage: {
			input: 200,
			output: 50,
			cacheRead: 8,
			cacheWrite: 3,
			cost: {
				input: 0.002,
				output: 0.001,
				cacheRead: 0.00001,
				cacheWrite: 0.00003,
				total: 0.00304,
			},
		},
		stopReason: "stop",
		timestamp: baseTime.getTime() + 4_000,
	};
}

function deniedToolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool-call-secret",
		toolName: "bash",
		content: [{ type: "text", text: "Denied by policy" }],
		isError: true,
		timestamp: baseTime.getTime() + 3_000,
	};
}

function approvalRequest(): ActionApprovalRequest {
	return {
		id: "local-approval-secret",
		toolName: "bash",
		args: {
			command: "git push origin main",
			["tok" + "en"]: "blocked-fixture-alpha",
			["provider_" + "request"]: {
				headers: {
					["Authori" + "zation"]: "blocked-fixture-gamma",
				},
			},
		},
		reason: "Protected branch mutation requires approval",
		startedAtMs: baseTime.getTime() + 1_000,
		platform: {
			source: "tool_execution",
			toolExecutionId: "tool-exec-secret",
			approvalRequestId: "platform-approval-secret",
		},
	};
}

function approvalDecision(): ActionApprovalDecision {
	return {
		approved: false,
		reason: "Protected branch writes are denied in this mode",
		resolvedBy: "policy",
		resolvedAtMs: baseTime.getTime() + 2_000,
	};
}

function nativeEvents(): AgentEvent[] {
	const request = approvalRequest();
	return [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{
			type: "tool_execution_start",
			toolCallId: "tool-call-secret",
			toolExecutionId: "tool-exec-secret",
			toolName: "bash",
			args: request.args as Record<string, unknown>,
		},
		{ type: "action_approval_required", request },
		{ type: "action_approval_resolved", request, decision: approvalDecision() },
		{
			type: "tool_execution_end",
			toolCallId: "tool-call-secret",
			toolExecutionId: "tool-exec-secret",
			approvalRequestId: "platform-approval-secret",
			errorCode: "approval_denied",
			toolName: "bash",
			result: deniedToolResult(),
			isError: true,
		},
		{ type: "message_end", message: usageMessage() },
	];
}

function platformCredentialAuthority(): AgentWorkforcePlatformCredentialAuthority {
	return {
		source: "platform_resolver",
		credential_subject: "agent:agent-maestro-1",
		credential_assumption_ref: "secretbroker:grant:grant-verified",
		grant_id: "grant-verified",
		credential_name: "github-pr-writer",
		verified_provenance: {
			authority: "secret_broker",
			authority_ref: "secretbroker:grant:grant-verified",
			join_correlation_id: "platform-join-secret",
			observed_at: new Date(baseTime.getTime() - 1_000).toISOString(),
			expires_at: new Date(baseTime.getTime() + 60_000).toISOString(),
			ttl_seconds: 60,
			revocation_status: "active",
			joined_evidence_refs: [
				{
					kind: "identity",
					ref: "join-identity",
					observed_at: baseTime.toISOString(),
				},
				{
					kind: "agent_runtime",
					ref: "join-runtime",
					observed_at: baseTime.toISOString(),
				},
				{
					kind: "secret_broker",
					ref: "join-secret",
					observed_at: baseTime.toISOString(),
				},
			],
		},
	};
}

function projectionOptions(
	platformCredentialAuthority?: AgentWorkforcePlatformCredentialAuthority,
): AgentWorkforceNativeProjectionOptions {
	return {
		correlation: {
			organization_id: "org_evalops",
			workspace_id: "ws_evalops",
			session_id: "session-platform-post",
			agent_run_id: "run-platform-post",
			agent_id: "agent-maestro-1",
			user_id: "user-1",
			request_id: "response-platform-post",
		},
		principal: {
			subject: "user:user-1",
			user_id: "user-1",
			organization_id: "org_evalops",
			workspace_id: "ws_evalops",
		},
		chainId: platformCredentialAuthority
			? "chain-platform-proven"
			: "chain-platform-missing",
		clock: () => baseTime,
		makeEnvelopeId: (_event, sequence) => `awf_evt_platform_post_${sequence}`,
		declaredCredential: {
			credential_subject: "agent:agent-maestro-1",
			credential_assumption_ref: "secretbroker:grant:grant-declared",
			grant_id: "grant-declared",
			credential_name: "github-pr-writer",
			declared_authority: "secret_broker",
		},
		platformCredentialAuthority,
	};
}

describe("agent workforce native event Platform client", () => {
	let requests: CapturedRequest[];

	beforeEach(() => {
		requests = [];
		for (const name of [
			"MAESTRO_AGENT_WORKFORCE_INGEST_URL",
			"MAESTRO_AGENT_WORKFORCE_BASE_URL",
			"MAESTRO_AGENT_WORKFORCE_SERVICE_URL",
			"MAESTRO_AGENT_WORKFORCE_ACCESS_TOKEN",
			"MAESTRO_AGENT_WORKFORCE_ORG_ID",
			"MAESTRO_AGENT_WORKFORCE_WORKSPACE_ID",
			"MAESTRO_AGENT_WORKFORCE_TIMEOUT_MS",
			"MAESTRO_AGENT_WORKFORCE_MAX_ATTEMPTS",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"EVALOPS_ORG_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"MAESTRO_EVALOPS_WORKSPACE_ID",
			"EVALOPS_WORKSPACE_ID",
			"MAESTRO_WORKSPACE_ID",
			"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
		]) {
			vi.stubEnv(name, "");
		}
		vi.stubEnv("MAESTRO_PLATFORM_BASE_URL", "https://platform.test/");
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "evalops-token");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");
		vi.stubEnv("MAESTRO_EVALOPS_WORKSPACE_ID", "ws_evalops");
		vi.stubEnv("MAESTRO_AGENT_WORKFORCE_MAX_ATTEMPTS", "1");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("posts denied tool, approval, and local unreconciled model usage events", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push({
					body: parseBatchBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					url: String(input),
				});
				return new Response(JSON.stringify({ accepted: true }), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				});
			},
		);

		await expect(
			mirrorAgentWorkforceNativeEventsToPlatform(
				nativeEvents(),
				projectionOptions(),
				{
					batchId: "batch-denied-usage",
					fetchImpl: fetchMock as unknown as typeof fetch,
				},
			),
		).resolves.toBe(true);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "https://platform.test/v1/agent-workforce/native-events:batch",
			headers: expect.objectContaining({
				authorization: "Bearer evalops-token",
				"content-type": "application/json",
				"x-organization-id": "org_evalops",
				"x-workspace-id": "ws_evalops",
			}),
			body: expect.objectContaining({
				schema_version: "agent_workforce_native_event_batch.v1",
				organization_id: "org_evalops",
				workspace_id: "ws_evalops",
				batch_id: "batch-denied-usage",
				event_count: 7,
			}),
		});

		const postedEvents = requests[0]?.body.events ?? [];
		expect(
			postedEvents.every(
				(event) => event.credential_assumption?.proof_status === "missing",
			),
		).toBe(true);
		expect(verifyAgentWorkforceNativeEventChain(postedEvents)).toEqual({
			valid: true,
		});
		expect(postedEvents.map((event) => event.event_type)).toEqual([
			"run.started",
			"turn.started",
			"tool.attempted",
			"approval.requested",
			"approval.resolved",
			"tool.completed",
			"model.usage",
		]);

		const deniedTool = postedEvents.find(
			(event) => event.event_type === "tool.completed",
		);
		expect(deniedTool).toMatchObject({
			action: {
				status: "denied",
				tool_name: "bash",
				safe_args_summary: {
					argument_keys: ["command", "redacted_sensitive_key"],
				},
			},
			policy: {
				approval_ref: "platform-approval-secret",
				decision: "deny",
			},
			credential_assumption: {
				proof_status: "missing",
				provenance_verified: false,
			},
		});

		const approval = postedEvents.find(
			(event) => event.event_type === "approval.resolved",
		);
		expect(approval).toMatchObject({
			action: {
				action_kind: "approval",
				status: "denied",
			},
			policy: {
				decision: "deny",
			},
		});

		const usage = postedEvents.find(
			(event) => event.event_type === "model.usage",
		);
		expect(usage).toMatchObject({
			model_usage: {
				usage_authority: "maestro_local",
				cost_reconciliation_status: "unreconciled",
				provider: "openai",
				model: "gpt-5.5",
				request_id: "response-platform-post",
				input_tokens: 200,
				output_tokens: 50,
				total_cost_usd: 0.00304,
			},
			credential_assumption: {
				proof_status: "missing",
			},
		});

		const postedBody = JSON.stringify(requests[0]?.body);
		expect(postedBody).not.toContain("blocked-fixture-alpha");
		expect(postedBody).not.toContain("blocked-fixture-gamma");
		expect(postedBody).not.toContain("provider_request");
		expect(postedBody).not.toContain("openai-responses");
	});

	it("posts proven credential authority only when a fresh Platform bundle is supplied", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push({
					body: parseBatchBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					url: String(input),
				});
				return new Response(null, { status: 204 });
			},
		);

		await expect(
			mirrorAgentWorkforceNativeEventsToPlatform(
				[{ type: "message_end", message: usageMessage() }],
				projectionOptions(platformCredentialAuthority()),
				{
					batchId: "batch-proven",
					fetchImpl: fetchMock as unknown as typeof fetch,
				},
			),
		).resolves.toBe(true);

		const [posted] = requests[0]?.body.events ?? [];
		expect(posted).toMatchObject({
			event_type: "model.usage",
			timeline_correlation: {
				credential_join_correlation_id: "platform-join-secret",
			},
			credential_assumption: {
				credential_assumption_ref: "secretbroker:grant:grant-verified",
				proof_status: "proven",
				declared_authority: "secret_broker",
				provenance_verified: true,
				verified_provenance: {
					join_correlation_id: "platform-join-secret",
					joined_evidence_refs: expect.arrayContaining([
						expect.objectContaining({ kind: "identity", ref: "join-identity" }),
						expect.objectContaining({
							kind: "agent_runtime",
							ref: "join-runtime",
						}),
						expect.objectContaining({
							kind: "secret_broker",
							ref: "join-secret",
						}),
					]),
				},
			},
			evidence: {
				missing_evidence: [],
			},
		});
	});

	it("uses exact ingest URL config and bounded retry behavior", async () => {
		vi.stubEnv(
			"MAESTRO_AGENT_WORKFORCE_INGEST_URL",
			"https://ingest.test/custom/native-events",
		);
		vi.stubEnv("MAESTRO_AGENT_WORKFORCE_TIMEOUT_MS", "1500");
		vi.stubEnv("MAESTRO_AGENT_WORKFORCE_MAX_ATTEMPTS", "2");
		const config = await resolveAgentWorkforceNativeEventPlatformConfig();
		if (!config) {
			throw new Error("expected Agent Workforce Platform config");
		}
		expect(config).toMatchObject({
			endpointUrl: "https://ingest.test/custom/native-events",
			timeoutMs: 1500,
			maxAttempts: 2,
		});

		let callCount = 0;
		const delays: number[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				callCount += 1;
				requests.push({
					body: parseBatchBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					url: String(input),
				});
				if (callCount === 1) {
					return new Response("try again", {
						status: 503,
						headers: { "Retry-After-Ms": "50" },
					});
				}
				return new Response(null, { status: 204 });
			},
		);
		const events = projectAgentWorkforceNativeEvents(
			[{ type: "message_end", message: usageMessage() }],
			projectionOptions(),
		);

		await expect(
			postAgentWorkforceNativeEventBatchToPlatform(config, events, {
				batchId: "batch-retry",
				fetchImpl: fetchMock as unknown as typeof fetch,
				sleepMs: async (delayMs) => {
					delays.push(delayMs);
				},
			}),
		).resolves.toMatchObject({
			accepted: true,
			status: 204,
			eventCount: 1,
		});

		expect(requests.map((request) => request.url)).toEqual([
			"https://ingest.test/custom/native-events",
			"https://ingest.test/custom/native-events",
		]);
		expect(delays).toEqual([50]);
	});

	it("resolves explicit override config without env credentials", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_BASE_URL", "");
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "");
		vi.stubEnv("MAESTRO_EVALOPS_WORKSPACE_ID", "");

		await expect(
			resolveAgentWorkforceNativeEventPlatformConfig({
				endpointUrl: "https://override.test/native-events",
				organizationId: "org_override",
				workspaceId: "ws_override",
				token: "override-token",
			}),
		).resolves.toMatchObject({
			endpointUrl: "https://override.test/native-events",
			organizationId: "org_override",
			workspaceId: "ws_override",
			token: "override-token",
		});
	});

	it("drops raw sensitive extras before POST without changing contract fields", () => {
		const [event] = projectAgentWorkforceNativeEvents(
			[{ type: "message_end", message: usageMessage() }],
			projectionOptions(platformCredentialAuthority()),
		);
		if (!event) {
			throw new Error("expected projected event");
		}
		const eventWithRawExtra = {
			...event,
			["a" + "pi"]: "openai-responses",
			["access" + "Token"]: "blocked-fixture-delta",
			["credential" + "Value"]: "blocked-fixture-epsilon",
			["credential" + "s"]: {
				["tok" + "en"]: "blocked-fixture-zeta",
			},
			["provider_" + "request"]: {
				headers: {
					["Authori" + "zation"]: "blocked-fixture-eta",
				},
			},
		} as AgentWorkforceNativeEvent;

		const body = JSON.stringify([eventWithRawExtra]);
		expect(body).toContain("blocked-fixture-delta");

		const sanitizedBody = buildAgentWorkforceNativeEventBatchBody(
			{
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
			},
			[eventWithRawExtra],
		);
		expect(sanitizedBody.events[0]?.credential_assumption).toEqual(
			event.credential_assumption,
		);
		expect(
			sanitizedBody.events[0]?.timeline_correlation
				.credential_join_correlation_id,
		).toBe("platform-join-secret");
		expect(verifyAgentWorkforceNativeEventChain(sanitizedBody.events)).toEqual({
			valid: true,
		});
		const sanitizedJson = JSON.stringify(sanitizedBody);
		expect(sanitizedJson).not.toContain("blocked-fixture-delta");
		expect(sanitizedJson).not.toContain("blocked-fixture-epsilon");
		expect(sanitizedJson).not.toContain("blocked-fixture-zeta");
		expect(sanitizedJson).not.toContain("blocked-fixture-eta");
		expect(sanitizedJson).not.toContain("openai-responses");
		expect(sanitizedJson).toContain("credential_join_correlation_id");
		expect(sanitizedJson).toContain("model_usage");
	});
});
