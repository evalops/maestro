import { describe, expect, it } from "vitest";
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
	AGENT_WORKFORCE_NATIVE_EVENT_SCHEMA_VERSION,
	type AgentWorkforceNativeEvent,
	type AgentWorkforcePlatformCredentialAuthority,
	projectAgentWorkforceNativeEvents,
	verifyAgentWorkforceNativeEventChain,
} from "../../src/telemetry/agent-workforce-native-event.js";

const baseTime = new Date("2026-06-03T16:00:00.000Z");

function usageMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.5",
		usage: {
			input: 120,
			output: 34,
			cacheRead: 10,
			cacheWrite: 2,
			cost: {
				input: 0.0012,
				output: 0.00068,
				cacheRead: 0.00001,
				cacheWrite: 0.00002,
				total: 0.00191,
			},
		},
		stopReason: "stop",
		timestamp: baseTime.getTime() + 4_000,
	};
}

function toolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool-call-1",
		toolName: "bash",
		content: [{ type: "text", text: "Denied by approval policy" }],
		isError: true,
		timestamp: baseTime.getTime() + 3_000,
	};
}

function approvalRequest(): ActionApprovalRequest {
	return {
		id: "local-approval-1",
		toolName: "bash",
		args: { command: "git push origin main" },
		reason: "Protected branch mutation requires approval",
		startedAtMs: baseTime.getTime() + 1_000,
		platform: {
			source: "tool_execution",
			toolExecutionId: "tool-exec-1",
			approvalRequestId: "platform-approval-1",
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
			toolCallId: "tool-call-1",
			toolExecutionId: "tool-exec-1",
			toolName: "bash",
			args: { command: "git push origin main" },
		},
		{
			type: "action_approval_required",
			request,
		},
		{
			type: "action_approval_resolved",
			request,
			decision: approvalDecision(),
		},
		{
			type: "tool_execution_end",
			toolCallId: "tool-call-1",
			toolExecutionId: "tool-exec-1",
			approvalRequestId: "platform-approval-1",
			errorCode: "approval_denied",
			toolName: "bash",
			result: toolResult(),
			isError: true,
		},
		{
			type: "message_end",
			message: usageMessage(),
		},
	];
}

function platformCredentialAuthority(
	expiresAtMs = baseTime.getTime() + 60_000,
): AgentWorkforcePlatformCredentialAuthority {
	return {
		source: "platform_ingestion",
		credential_subject: "agent:agent-maestro-1",
		credential_assumption_ref: "secretbroker:grant:grant-verified",
		grant_id: "grant-verified",
		credential_name: "github-pr-writer",
		verified_provenance: {
			authority: "secret_broker",
			authority_ref: "secretbroker:grant:grant-verified",
			join_correlation_id: "platform-join-secret",
			observed_at: new Date(baseTime.getTime() - 1_000).toISOString(),
			expires_at: new Date(expiresAtMs).toISOString(),
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

function project(events = nativeEvents()): AgentWorkforceNativeEvent[] {
	return projectAgentWorkforceNativeEvents(events, {
		correlation: {
			organization_id: "org-1",
			user_id: "user-1",
			workspace_id: "workspace-1",
			session_id: "session-1",
			agent_run_id: "run-1",
			agent_id: "agent-maestro-1",
			trace_id: "trace-1",
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			request_id: "response-1",
		},
		principal: {
			subject: "user:user-1",
			user_id: "user-1",
			organization_id: "org-1",
			workspace_id: "workspace-1",
		},
		threadId: "thread-session-1",
		chainId: "chain-1",
		clock: () => baseTime,
		makeEnvelopeId: (_event, sequence) => `awf_evt_maestro_${sequence}`,
	});
}

describe("agent workforce native event projection", () => {
	it("does not project agent prose or arbitrary status text as native evidence", () => {
		const projected = projectAgentWorkforceNativeEvents(
			[
				{
					type: "status",
					status: "Agent claims it used prod-deploy credentials",
					details: { note: "prose-only" },
				},
			],
			{
				correlation: {
					workspace_id: "workspace-1",
					session_id: "session-1",
				},
				chainId: "chain-prose",
				clock: () => baseTime,
			},
		);

		expect(projected).toEqual([]);
	});

	it("projects Platform contract fields for runtime-observed run, turn, tool, approval, and usage envelopes", () => {
		const projected = project();
		expect(projected.map((event) => event.event_type)).toEqual([
			"run.started",
			"turn.started",
			"tool.attempted",
			"approval.requested",
			"approval.resolved",
			"tool.completed",
			"model.usage",
		]);

		const toolAttempt = projected.find(
			(event) => event.event_type === "tool.attempted",
		);
		expect(toolAttempt).toMatchObject({
			schema_version: AGENT_WORKFORCE_NATIVE_EVENT_SCHEMA_VERSION,
			envelope_id: "awf_evt_maestro_3",
			emitter: {
				emitter: "evalops/maestro",
				component: "maestro.telemetry.event_bus",
				emitter_owner: "maestro.provider_event_bus",
				agent_type: "maestro",
				surface: "desktop",
			},
			source_authority: {
				declared_authority: "native_observed",
				evidence_authority: "native_observed",
				provenance_verified: false,
			},
			tenant: {
				organization_id: "org-1",
				workspace_id: "workspace-1",
			},
			agent_instance_id: "agent-maestro-1",
			associated_human: {
				subject: "user:user-1",
				user_id: "user-1",
			},
			run: {
				run_id: "run-1",
				agent_run_id: "run-1",
				agent_run_step_id: "tool-exec-1",
				turn_id: "session-1:turn:1",
				thread_id: "thread-session-1",
				maestro_session_id: "session-1",
				trace_id: "trace-1",
			},
			timeline_correlation: {
				source_event_ref:
					"maestro.AgentEvent:tool_execution_start:session-1:tool-call-1",
				native_action_correlation_id:
					"session-1/run-1/tool-exec-1/session-1:turn:1/tool-call-1",
				platform_action_correlation_id: "agentruntime:run-1:tool-exec-1",
			},
			action: {
				sequence: 3,
				action_kind: "tool",
				status: "attempted",
				tool_call_id: "tool-call-1",
				tool_execution_id: "tool-exec-1",
				tool_name: "bash",
				mutates_resource: true,
				safe_args_summary: {
					argument_keys: ["command"],
					resource_kind: "command",
					operation: "mutate",
				},
			},
			credential_assumption: {
				credential_subject: "unknown",
				proof_status: "missing",
				declared_authority: "unknown",
				provenance_verified: false,
			},
			evidence: {
				refs: expect.arrayContaining([
					expect.objectContaining({
						kind: "native_event",
						ref: "maestro.AgentEvent:tool_execution_start:session-1:tool-call-1",
					}),
					expect.objectContaining({
						kind: "agent_runtime",
						ref: "agentruntime:run-1:tool-exec-1",
					}),
				]),
				missing_evidence: [
					expect.objectContaining({
						code: "credential_assumption.unproven",
						severity: "blocking_for_platform_native",
						owner: "platform.secret_broker",
					}),
				],
				signature: expect.stringMatching(/^sha256-chain:v1:/),
			},
		});
		expect(toolAttempt).not.toHaveProperty("native_event_type");
		expect(toolAttempt).not.toHaveProperty("source");
		expect(toolAttempt).not.toHaveProperty("integrity");

		const approval = projected.find(
			(event) => event.event_type === "approval.resolved",
		);
		expect(approval).toMatchObject({
			policy: {
				approval_ref: "platform-approval-1",
				decision: "deny",
			},
			action: {
				action_kind: "approval",
				status: "denied",
				tool_name: "bash",
				tool_execution_id: "tool-exec-1",
			},
		});

		const usage = projected.find((event) => event.event_type === "model.usage");
		expect(usage).toMatchObject({
			action: {
				action_kind: "usage",
				status: "completed",
			},
			model_usage: {
				provider: "openai",
				model: "gpt-5.5",
				request_id: "response-1",
				input_tokens: 120,
				cached_input_tokens: 10,
				cache_write_tokens: 2,
				output_tokens: 34,
				total_cost_usd: 0.00191,
			},
		});
		expect(usage?.model_usage).not.toHaveProperty("reasoning_output_tokens");
	});

	it("keeps declared Secret Broker credential refs unproven without verified Platform joins", () => {
		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
			},
			chainId: "chain-credential",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "secretbroker:grant:grant-declared",
				grant_id: "grant-declared",
				credential_name: "github-pr-writer",
				declared_authority: "secret_broker",
			},
			credentialJoinRefs: [
				{
					kind: "secret_broker",
					id: "secretbroker:grant:grant-declared",
					service: "SecretBroker",
				},
			],
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) => `awf_evt_credential_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			credential_subject: "agent:agent-maestro-1",
			credential_assumption_ref: "secretbroker:grant:grant-declared",
			grant_id: "grant-declared",
			credential_name: "github-pr-writer",
			proof_status: "missing",
			declared_authority: "secret_broker",
			provenance_verified: false,
		});
		expect(projected[0]?.credential_assumption).not.toHaveProperty(
			"verified_provenance",
		);
		expect(projected[0]?.evidence.missing_evidence).toEqual([
			expect.objectContaining({ code: "credential_assumption.unproven" }),
		]);
	});

	it("routes missing LLM Gateway credential evidence to the gateway owner", () => {
		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
			},
			chainId: "chain-llm-gateway-missing",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "llmgateway:vault:grant-declared",
				grant_id: "grant-declared",
				credential_name: "model-access",
				declared_authority: "llm_gateway_vault",
			},
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) =>
				`awf_evt_llm_gateway_missing_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			proof_status: "missing",
			declared_authority: "llm_gateway_vault",
			provenance_verified: false,
		});
		expect(projected[0]?.evidence.missing_evidence).toEqual([
			expect.objectContaining({
				code: "credential_assumption.unproven",
				owner: "platform.llm_gateway",
			}),
		]);
	});

	it("does not self-upgrade caller-supplied verified-looking join refs into proven credential authority", () => {
		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
				agent_id: "agent-maestro-1",
				agent_run_id: "run-1",
			},
			chainId: "chain-verified-credential",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "secretbroker:grant:grant-verified",
				grant_id: "grant-verified",
				credential_name: "github-pr-writer",
				declared_authority: "secret_broker",
			},
			credentialJoinRefs: [
				{
					kind: "identity",
					id: "identity:user:user-1",
					evidence_id: "join-identity",
					verified: true,
					observed_at: baseTime.toISOString(),
					expires_at: new Date(baseTime.getTime() + 60_000).toISOString(),
					ttl_seconds: 60,
					revocation_status: "not_revoked",
				},
				{
					kind: "agent_runtime",
					id: "agentruntime:run-1:usage-step",
					evidence_id: "join-runtime",
					verified: true,
					observed_at: baseTime.toISOString(),
					expires_at: new Date(baseTime.getTime() + 60_000).toISOString(),
					ttl_seconds: 60,
					revocation_status: "not_revoked",
				},
				{
					kind: "secret_broker",
					id: "secretbroker:grant:grant-verified",
					evidence_id: "join-secret",
					verified: true,
					observed_at: baseTime.toISOString(),
					expires_at: new Date(baseTime.getTime() + 60_000).toISOString(),
					ttl_seconds: 60,
					revocation_status: "active",
				},
			],
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) => `awf_evt_forged_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			credential_subject: "agent:agent-maestro-1",
			credential_assumption_ref: "secretbroker:grant:grant-verified",
			grant_id: "grant-verified",
			credential_name: "github-pr-writer",
			proof_status: "missing",
			declared_authority: "secret_broker",
			provenance_verified: false,
		});
		expect(projected[0]?.credential_assumption).not.toHaveProperty(
			"verified_provenance",
		);
		expect(
			projected[0]?.timeline_correlation.credential_join_correlation_id,
		).toBeUndefined();
		expect(projected[0]?.evidence.missing_evidence).toEqual([
			expect.objectContaining({ code: "credential_assumption.unproven" }),
		]);
	});

	it("only marks credential provenance proven with a fresh Platform-issued authority bundle", () => {
		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
				agent_id: "agent-maestro-1",
				agent_run_id: "run-1",
			},
			chainId: "chain-platform-credential",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "secretbroker:grant:grant-verified",
				grant_id: "grant-verified",
				credential_name: "github-pr-writer",
				declared_authority: "secret_broker",
			},
			platformCredentialAuthority: platformCredentialAuthority(),
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) => `awf_evt_verified_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			proof_status: "proven",
			declared_authority: "secret_broker",
			provenance_verified: true,
			verified_provenance: {
				authority: "secret_broker",
				authority_ref: "secretbroker:grant:grant-verified",
				join_correlation_id: "platform-join-secret",
				joined_evidence_refs: [
					expect.objectContaining({ kind: "identity", ref: "join-identity" }),
					expect.objectContaining({
						kind: "agent_runtime",
						ref: "join-runtime",
					}),
					expect.objectContaining({
						kind: "secret_broker",
						ref: "join-secret",
					}),
				],
			},
		});
		expect(projected[0]?.timeline_correlation).toMatchObject({
			credential_join_correlation_id: "platform-join-secret",
		});
		expect(projected[0]?.evidence.missing_evidence).toEqual([]);
	});

	it("keeps expired Platform credential authority missing instead of treating positive ttl as fresh", () => {
		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
				agent_id: "agent-maestro-1",
				agent_run_id: "run-1",
			},
			chainId: "chain-expired-credential",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "secretbroker:grant:grant-expired",
				grant_id: "grant-expired",
				credential_name: "github-pr-writer",
				declared_authority: "secret_broker",
			},
			platformCredentialAuthority: platformCredentialAuthority(
				baseTime.getTime() - 1_000,
			),
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) => `awf_evt_expired_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			proof_status: "missing",
			declared_authority: "secret_broker",
			provenance_verified: false,
		});
		expect(projected[0]?.credential_assumption).not.toHaveProperty(
			"verified_provenance",
		);
		expect(projected[0]?.evidence.missing_evidence).toEqual([
			expect.objectContaining({ code: "credential_assumption.unproven" }),
		]);
	});

	it("keeps stale Platform credential TTL windows missing even with future expires_at", () => {
		const staleAuthority = platformCredentialAuthority(
			baseTime.getTime() + 60_000,
		);
		staleAuthority.verified_provenance.observed_at = new Date(
			baseTime.getTime() - 120_000,
		).toISOString();
		staleAuthority.verified_provenance.ttl_seconds = 60;

		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
				agent_id: "agent-maestro-1",
				agent_run_id: "run-1",
			},
			chainId: "chain-stale-ttl-credential",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "secretbroker:grant:grant-stale",
				grant_id: "grant-stale",
				credential_name: "github-pr-writer",
				declared_authority: "secret_broker",
			},
			platformCredentialAuthority: staleAuthority,
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) => `awf_evt_stale_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			proof_status: "missing",
			declared_authority: "secret_broker",
			provenance_verified: false,
		});
		expect(projected[0]?.credential_assumption).not.toHaveProperty(
			"verified_provenance",
		);
	});

	it("keeps Platform credential authority missing when ttl_seconds is not finite", () => {
		const malformedAuthority = platformCredentialAuthority(
			baseTime.getTime() + 60_000,
		);
		malformedAuthority.verified_provenance.ttl_seconds = Number.NaN;

		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
				agent_id: "agent-maestro-1",
				agent_run_id: "run-1",
			},
			chainId: "chain-nonfinite-ttl-credential",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "secretbroker:grant:grant-nonfinite",
				grant_id: "grant-nonfinite",
				credential_name: "github-pr-writer",
				declared_authority: "secret_broker",
			},
			platformCredentialAuthority: malformedAuthority,
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) => `awf_evt_nonfinite_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			proof_status: "missing",
			declared_authority: "secret_broker",
			provenance_verified: false,
		});
		expect(projected[0]?.credential_assumption).not.toHaveProperty(
			"verified_provenance",
		);
	});

	it("accepts fresh Platform LLM Gateway authority with matching joined evidence", () => {
		const llmGatewayAuthority = platformCredentialAuthority(
			baseTime.getTime() + 60_000,
		);
		llmGatewayAuthority.credential_assumption_ref =
			"llmgateway:vault:grant-verified";
		llmGatewayAuthority.verified_provenance = {
			...llmGatewayAuthority.verified_provenance,
			authority: "llm_gateway_vault",
			authority_ref: "llmgateway:vault:grant-verified",
			join_correlation_id: "platform-join-llm-gateway",
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
					kind: "llm_gateway",
					ref: "join-llm-gateway",
					observed_at: baseTime.toISOString(),
				},
			],
		};

		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
				agent_id: "agent-maestro-1",
				agent_run_id: "run-1",
			},
			chainId: "chain-llm-gateway-credential",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "llmgateway:vault:grant-verified",
				grant_id: "grant-verified",
				credential_name: "model-access",
				declared_authority: "llm_gateway_vault",
			},
			platformCredentialAuthority: llmGatewayAuthority,
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) => `awf_evt_llm_gateway_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			proof_status: "proven",
			declared_authority: "llm_gateway_vault",
			provenance_verified: true,
			verified_provenance: {
				authority: "llm_gateway_vault",
				authority_ref: "llmgateway:vault:grant-verified",
				join_correlation_id: "platform-join-llm-gateway",
				joined_evidence_refs: expect.arrayContaining([
					expect.objectContaining({ kind: "llm_gateway" }),
				]),
			},
		});
		expect(projected[0]?.evidence.missing_evidence).toEqual([]);
	});

	it("keeps malformed Platform resolver provenance missing instead of throwing", () => {
		const malformedResolverAuthority = {
			source: "platform_resolver",
			credential_subject: "agent:agent-maestro-1",
		} as unknown as AgentWorkforcePlatformCredentialAuthority;

		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
				agent_id: "agent-maestro-1",
				agent_run_id: "run-1",
			},
			chainId: "chain-malformed-platform-resolver",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "secretbroker:grant:grant-malformed",
				grant_id: "grant-malformed",
				credential_name: "github-pr-writer",
				declared_authority: "secret_broker",
			},
			platformCredentialAuthority: malformedResolverAuthority,
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) => `awf_evt_malformed_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			proof_status: "missing",
			declared_authority: "secret_broker",
			provenance_verified: false,
		});
		expect(projected[0]?.credential_assumption).not.toHaveProperty(
			"verified_provenance",
		);
		expect(projected[0]?.evidence.missing_evidence).toEqual([
			expect.objectContaining({ code: "credential_assumption.unproven" }),
		]);
	});

	it("keeps unsupported Platform credential authority values missing", () => {
		const unsupportedAuthority = platformCredentialAuthority(
			baseTime.getTime() + 60_000,
		);
		unsupportedAuthority.verified_provenance = {
			...unsupportedAuthority.verified_provenance,
			authority: "provider_proxy" as never,
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
					kind: "provider_proxy" as never,
					ref: "join-provider-proxy",
					observed_at: baseTime.toISOString(),
				},
			],
		};

		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
				agent_id: "agent-maestro-1",
				agent_run_id: "run-1",
			},
			chainId: "chain-unsupported-platform-authority",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "providerproxy:grant:grant-unsupported",
				grant_id: "grant-unsupported",
				credential_name: "provider-proxy",
				declared_authority: "provider_proxy",
			},
			platformCredentialAuthority: unsupportedAuthority,
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) =>
				`awf_evt_unsupported_authority_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			proof_status: "missing",
			declared_authority: "provider_proxy",
			provenance_verified: false,
		});
		expect(projected[0]?.credential_assumption).not.toHaveProperty(
			"verified_provenance",
		);
	});

	it("keeps Platform credential authority missing when any joined evidence ref is malformed", () => {
		const authorityWithMalformedExtraRef = platformCredentialAuthority(
			baseTime.getTime() + 60_000,
		);
		authorityWithMalformedExtraRef.verified_provenance.joined_evidence_refs = [
			...authorityWithMalformedExtraRef.verified_provenance
				.joined_evidence_refs,
			{
				kind: "provider_proxy" as never,
				ref: "join-provider-proxy",
				observed_at: baseTime.toISOString(),
			},
		];

		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[6]!], {
			correlation: {
				workspace_id: "workspace-1",
				session_id: "session-1",
				agent_id: "agent-maestro-1",
				agent_run_id: "run-1",
			},
			chainId: "chain-malformed-extra-evidence",
			declaredCredential: {
				credential_subject: "agent:agent-maestro-1",
				credential_assumption_ref: "secretbroker:grant:grant-malformed-extra",
				grant_id: "grant-malformed-extra",
				credential_name: "github-pr-writer",
				declared_authority: "secret_broker",
			},
			platformCredentialAuthority: authorityWithMalformedExtraRef,
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) =>
				`awf_evt_malformed_extra_evidence_${sequence}`,
		});

		expect(projected[0]?.credential_assumption).toMatchObject({
			proof_status: "missing",
			declared_authority: "secret_broker",
			provenance_verified: false,
		});
		expect(projected[0]?.credential_assumption).not.toHaveProperty(
			"verified_provenance",
		);
	});

	it("omits reasoning token usage when Maestro has no separate observed count", () => {
		const projected = project([nativeEvents()[6]!]);

		expect(projected[0]?.event_type).toBe("model.usage");
		expect(projected[0]?.model_usage).toMatchObject({
			input_tokens: 120,
			cache_write_tokens: 2,
			output_tokens: 34,
			total_cost_usd: 0.00191,
		});
		expect(projected[0]?.model_usage).not.toHaveProperty(
			"reasoning_output_tokens",
		);
	});

	it("does not use the local working directory as a fallback workspace id", () => {
		const projected = projectAgentWorkforceNativeEvents([nativeEvents()[0]!], {
			correlation: {
				session_id: "session-1",
				agent_id: "agent-maestro-1",
			},
			chainId: "chain-missing-workspace",
			clock: () => baseTime,
			makeEnvelopeId: (_event, sequence) =>
				`awf_evt_missing_workspace_${sequence}`,
		});

		expect(projected[0]?.tenant).toEqual({
			organization_id: "unknown",
			workspace_id: "unknown",
		});
		expect(projected[0]?.tenant.workspace_id).not.toBe(process.cwd());
	});

	it("does not fabricate AgentRuntime refs from local-only native tool ids", () => {
		const projected = projectAgentWorkforceNativeEvents(
			[
				{
					type: "tool_execution_start",
					toolCallId: "native-tool-call-only",
					toolName: "bash",
					args: { command: "pwd" },
				},
			],
			{
				correlation: {
					workspace_id: "workspace-1",
					session_id: "session-local-only",
				},
				chainId: "chain-local-tool-only",
				clock: () => baseTime,
				makeEnvelopeId: (_event, sequence) => `awf_evt_local_${sequence}`,
			},
		);

		expect(projected[0]?.run.agent_run_step_id).toBeUndefined();
		expect(projected[0]?.action).toMatchObject({
			tool_call_id: "native-tool-call-only",
			tool_execution_id: undefined,
		});
		expect(
			projected[0]?.timeline_correlation.native_action_correlation_id,
		).toContain("native-tool-call-only");
		expect(
			projected[0]?.timeline_correlation.platform_action_correlation_id,
		).toBeUndefined();
		expect(
			projected[0]?.evidence.refs.some((ref) => ref.kind === "agent_runtime"),
		).toBe(false);
	});

	it("does not promote correlation fallback step ids into AgentRuntime refs", () => {
		const projected = projectAgentWorkforceNativeEvents(
			[
				{
					type: "tool_execution_start",
					toolCallId: "local-tool-call-from-correlation",
					toolName: "bash",
					args: { command: "pwd" },
				},
			],
			{
				correlation: {
					workspace_id: "workspace-1",
					session_id: "session-local-correlation",
					agent_run_id: "run-1",
					agent_run_step_id: "local-tool-call-from-correlation",
				},
				chainId: "chain-local-correlation-tool-only",
				clock: () => baseTime,
				makeEnvelopeId: (_event, sequence) =>
					`awf_evt_local_correlation_${sequence}`,
			},
		);

		expect(projected[0]?.run).toMatchObject({
			agent_run_id: "run-1",
			agent_run_step_id: undefined,
		});
		expect(projected[0]?.action).toMatchObject({
			tool_call_id: "local-tool-call-from-correlation",
			tool_execution_id: undefined,
		});
		expect(
			projected[0]?.timeline_correlation.native_action_correlation_id,
		).toContain("local-tool-call-from-correlation");
		expect(
			projected[0]?.timeline_correlation.platform_action_correlation_id,
		).toBeUndefined();
		expect(
			projected[0]?.evidence.refs.some((ref) => ref.kind === "agent_runtime"),
		).toBe(false);
	});

	it("does not leak a previous turn id into a later run-start envelope", () => {
		const projected = projectAgentWorkforceNativeEvents(
			[
				{ type: "agent_start" },
				{ type: "turn_start" },
				{ type: "agent_start" },
			],
			{
				correlation: {
					workspace_id: "workspace-1",
					session_id: "session-reused-projector",
					agent_run_id: "run-reused-projector",
				},
				chainId: "chain-reused-projector",
				clock: () => baseTime,
				makeEnvelopeId: (_event, sequence) =>
					`awf_evt_reused_projector_${sequence}`,
			},
		);

		expect(projected.map((event) => event.event_type)).toEqual([
			"run.started",
			"turn.started",
			"run.started",
		]);
		expect(projected[1]?.run.turn_id).toBe("session-reused-projector:turn:1");
		expect(projected[2]?.run.turn_id).toBeUndefined();
	});

	it("uses caller-provided source record ids before synthetic source refs", () => {
		const projected = projectAgentWorkforceNativeEvents(
			[
				{
					type: "tool_execution_start",
					toolCallId: "tool-call-1",
					toolName: "bash",
				},
			],
			{
				correlation: {
					workspace_id: "workspace-1",
					session_id: "session-1",
				},
				chainId: "chain-source-record",
				sourceRecordId: "eventbus:maestro:record-123",
				clock: () => baseTime,
				makeEnvelopeId: (_event, sequence) =>
					`awf_evt_source_record_${sequence}`,
			},
		);

		expect(projected[0]?.timeline_correlation.source_event_ref).toBe(
			"eventbus:maestro:record-123",
		);
		expect(projected[0]?.evidence.source_event_ref).toBe(
			"eventbus:maestro:record-123",
		);
		expect(projected[0]?.evidence.refs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "native_event",
					ref: "eventbus:maestro:record-123",
				}),
			]),
		);
	});

	it("uses per-projection correlation for repeated assistant message usage events in one turn", () => {
		const repeatedMessages: AgentEvent[] = [
			{ type: "turn_start" },
			{ type: "message_end", message: usageMessage() },
			{ type: "message_end", message: usageMessage() },
		];
		const projected = project(repeatedMessages).filter(
			(event) => event.event_type === "model.usage",
		);

		expect(projected).toHaveLength(2);
		expect(projected[0]?.timeline_correlation.source_event_ref).not.toEqual(
			projected[1]?.timeline_correlation.source_event_ref,
		);
		expect(
			projected[0]?.timeline_correlation.native_action_correlation_id,
		).not.toEqual(
			projected[1]?.timeline_correlation.native_action_correlation_id,
		);
	});

	it("does not duplicate meterable model usage onto turn completion for the same assistant message", () => {
		const completedAssistantMessage = usageMessage();
		const projected = project([
			{ type: "turn_start" },
			{ type: "message_end", message: completedAssistantMessage },
			{ type: "turn_end", message: completedAssistantMessage },
		]);

		const meterableUsageEvents = projected.filter(
			(event) => event.model_usage !== undefined,
		);
		expect(meterableUsageEvents.map((event) => event.event_type)).toEqual([
			"model.usage",
		]);
		expect(
			projected.find((event) => event.event_type === "turn.completed")
				?.model_usage,
		).toBeUndefined();
	});

	it.each(["error", "aborted"] as const)(
		"marks assistant usage with stopReason %s as failed",
		(stopReason) => {
			const projected = project([
				{
					type: "message_end",
					message: {
						...usageMessage(),
						stopReason,
						errorMessage:
							stopReason === "error" ? "Provider stream failed" : undefined,
					},
				},
			]);

			expect(projected[0]).toMatchObject({
				event_type: "model.usage",
				action: {
					action_kind: "usage",
					status: "failed",
				},
			});
		},
	);

	it.each(["error", "aborted"] as const)(
		"marks turn completion with assistant stopReason %s as failed",
		(stopReason) => {
			const projected = project([
				{
					type: "turn_end",
					message: {
						...usageMessage(),
						stopReason,
						errorMessage:
							stopReason === "error" ? "Provider stream failed" : undefined,
					},
					toolResults: [],
				},
			]);

			expect(projected[0]).toMatchObject({
				event_type: "turn.completed",
				action: {
					action_kind: "turn",
					status: "failed",
				},
			});
			expect(projected[0]?.model_usage).toBeUndefined();
		},
	);

	it.each(["error", "aborted"] as const)(
		"marks run completion with stopReason %s as failed",
		(stopReason) => {
			const projected = project([
				{
					type: "agent_end",
					messages: [usageMessage()],
					stopReason,
					aborted: false,
				},
			]);

			expect(projected[0]).toMatchObject({
				event_type: "run.completed",
				action: {
					action_kind: "run",
					status: "failed",
				},
			});
		},
	);

	it("does not infer approval denial from a failed execution after approval was allowed", () => {
		const request = approvalRequest();
		const approvedDecision: ActionApprovalDecision = {
			approved: true,
			reason: "Approved by reviewer",
			resolvedBy: "user",
			resolvedAtMs: baseTime.getTime() + 2_000,
		};
		const projected = project([
			{
				type: "tool_execution_start",
				toolCallId: "tool-call-1",
				toolExecutionId: "tool-exec-1",
				toolName: "bash",
				args: { command: "git push origin main" },
			},
			{
				type: "action_approval_required",
				request,
			},
			{
				type: "action_approval_resolved",
				request,
				decision: approvedDecision,
			},
			{
				type: "tool_execution_end",
				toolCallId: "tool-call-1",
				toolExecutionId: "tool-exec-1",
				approvalRequestId: "platform-approval-1",
				errorCode: "execution_failed",
				toolName: "bash",
				result: toolResult(),
				isError: true,
			},
		]);
		const toolCompleted = projected.find(
			(event) => event.event_type === "tool.completed",
		);

		expect(toolCompleted).toMatchObject({
			action: {
				status: "failed",
			},
			policy: {
				approval_ref: "platform-approval-1",
				decision: "allow",
			},
		});
	});

	it("preserves resolved approval denial on tool completion without denial error codes", () => {
		const request = approvalRequest();
		const projected = project([
			{
				type: "action_approval_resolved",
				request,
				decision: approvalDecision(),
			},
			{
				type: "tool_execution_end",
				toolCallId: "tool-call-1",
				toolExecutionId: "tool-exec-1",
				approvalRequestId: "platform-approval-1",
				toolName: "bash",
				result: toolResult(),
				isError: true,
			},
		]);

		const toolCompleted = projected.find(
			(event) => event.event_type === "tool.completed",
		);

		expect(toolCompleted).toMatchObject({
			action: {
				status: "denied",
			},
			policy: {
				approval_ref: "platform-approval-1",
				decision: "deny",
			},
		});
	});

	it("does not infer Platform prepare-time denial without an explicit denial signal", () => {
		const projected = project([
			{
				type: "tool_execution_end",
				toolCallId: "tool-call-1",
				toolExecutionId: "tool-exec-1",
				approvalRequestId: "platform-approval-1",
				toolName: "bash",
				result: toolResult(),
				isError: true,
			},
		]);

		expect(projected[0]).toMatchObject({
			event_type: "tool.completed",
			action: {
				status: "failed",
			},
			policy: {
				approval_ref: "platform-approval-1",
				decision: "unknown",
			},
		});
	});

	it("uses command resource refs for command tools even when cwd is present", () => {
		const projected = project([
			{
				type: "tool_execution_start",
				toolCallId: "tool-call-command-1",
				toolExecutionId: "tool-exec-command-1",
				toolName: "bash",
				args: {
					command: "npm test -- --runInBand",
					cwd: "/workspace/app",
				},
			},
			{
				type: "tool_execution_start",
				toolCallId: "tool-call-command-2",
				toolExecutionId: "tool-exec-command-2",
				toolName: "bash",
				args: {
					command: "npm run lint",
					cwd: "/workspace/app",
				},
			},
			{
				type: "tool_execution_start",
				toolCallId: "tool-call-background",
				toolExecutionId: "tool-exec-background",
				toolName: "background_tasks",
				args: {
					action: "start",
					command: "npm run dev",
					cwd: "/workspace/app",
				},
			},
		]);

		expect(projected[0]?.action).toMatchObject({
			tool_name: "bash",
			mutates_resource: true,
			safe_args_summary: {
				argument_keys: ["command", "cwd"],
				resource_kind: "command",
				operation: "mutate",
			},
		});
		expect(projected[1]?.action).toMatchObject({
			tool_name: "bash",
			safe_args_summary: {
				resource_kind: "command",
			},
		});
		expect(projected[2]?.action).toMatchObject({
			tool_name: "background_tasks",
			safe_args_summary: {
				argument_keys: ["action", "command", "cwd"],
				resource_kind: "command",
				operation: "mutate",
			},
		});
		expect(projected[0]?.action.resource_refs).not.toEqual(
			projected[1]?.action.resource_refs,
		);
	});

	it("classifies todo writes as state mutations without raw task text", () => {
		const projected = project([
			{
				type: "tool_execution_start",
				toolCallId: "tool-call-todo",
				toolExecutionId: "tool-exec-todo",
				toolName: "todo",
				args: {
					goal: "Ship native event projection",
					items: [
						{
							content: "Draft confidential launch checklist",
							status: "pending",
						},
					],
				},
			},
		]);

		expect(projected[0]?.action).toMatchObject({
			tool_name: "todo",
			mutates_resource: true,
			safe_args_summary: {
				argument_keys: ["goal", "items"],
				resource_kind: "tool",
				operation: "mutate",
			},
		});
		expect(JSON.stringify(projected[0]?.action)).not.toContain(
			"Draft confidential launch checklist",
		);
	});

	it("honors configured Fathom CUA MCP aliases for desktop mutations", () => {
		const previous = process.env.MAESTRO_FATHOM_CUA_MCP_NAME;
		process.env.MAESTRO_FATHOM_CUA_MCP_NAME = "desktop";
		try {
			const projected = project([
				{
					type: "tool_execution_start",
					toolCallId: "tool-call-desktop-click",
					toolExecutionId: "tool-exec-desktop-click",
					toolName: "mcp__desktop__click",
					args: { element_ref: "button-1" },
				},
				{
					type: "tool_execution_start",
					toolCallId: "tool-call-random-click",
					toolExecutionId: "tool-exec-random-click",
					toolName: "mcp__random__click",
					args: { element_ref: "button-1" },
				},
			]);

			expect(projected[0]?.action).toMatchObject({
				tool_name: "mcp__desktop__click",
				mutates_resource: true,
				safe_args_summary: {
					operation: "mutate",
				},
			});
			expect(projected[1]?.action).toMatchObject({
				tool_name: "mcp__random__click",
				mutates_resource: false,
				safe_args_summary: {
					operation: "read_or_unknown",
				},
			});
		} finally {
			if (previous === undefined) {
				delete process.env.MAESTRO_FATHOM_CUA_MCP_NAME;
			} else {
				process.env.MAESTRO_FATHOM_CUA_MCP_NAME = previous;
			}
		}
	});

	it.each([
		["background_tasks", { action: "start", command: "touch tmp/output.txt" }],
		["background_tasks", { action: "stop", taskId: "task-1" }],
		["browser_operator", { phase: "act", goal: "Click submit" }],
		["click_element", { selector: "#submit" }],
		["highlight_element", { selector: "#submit" }],
		["keyboard_action", { key: "Enter" }],
		["manage_artifact", { action: "update", filename: "report.md" }],
		["mouse_action", { action: "drag" }],
		["native_click", { selector: "#submit" }],
		["native_type", { text: "hello" }],
		["navigate_to", { action: "goToUrl", url: "https://example.com" }],
		["open_links_in_tabs", { urls: ["https://example.com"] }],
		["patch_artifact", { filename: "report.md", patch: "@@ -1 +1 @@" }],
		["pointer_action", { action: "click" }],
		["scroll_page", { direction: "down" }],
		["type_text", { selector: "#name", text: "Ada" }],
		["notebook_edit", { file_path: "analysis.ipynb" }],
		["gh_pr", { action: "create", title: "Native event fix" }],
		["gh_pr", { action: "comment", pr: 774 }],
		["gh_pr", { action: "checkout", pr: 774 }],
		["gh_issue", { action: "close", issue: 123 }],
		["gh_repo", { action: "clone", repo: "evalops/maestro" }],
		["gh_repo", { action: "fork", repo: "evalops/maestro" }],
		["mcp__filesystem__edit", { path: "src/index.ts" }],
		["mcp__filesystem__write", { path: "src/index.ts" }],
		["mcp__fathom-cua__click", { element_ref: "button-1" }],
		["mcp__fathom-cua__type_text", { text: "hello" }],
		["mcp__fathom-cua__press_key", { key: "Enter" }],
	])(
		"classifies %s tool executions as resource mutations",
		(toolName, args) => {
			const projected = project([
				{
					type: "tool_execution_start",
					toolCallId: `tool-call-${toolName}`,
					toolExecutionId: `tool-exec-${toolName}`,
					toolName,
					args,
				},
			]);

			expect(projected[0]?.action).toMatchObject({
				tool_name: toolName,
				mutates_resource: true,
				safe_args_summary: {
					operation: "mutate",
				},
			});
		},
	);

	it.each([
		["background_tasks", { action: "list" }],
		["background_tasks", { action: "logs", taskId: "task-1" }],
		["browser_operator", { phase: "observe", goal: "Read page state" }],
		["capture_console_errors", {}],
		["capture_network", {}],
		["capture_screenshot", {}],
		["collect_diagnostics", {}],
		["extract_document", { url: "https://example.com/report.pdf" }],
		["extract_links", {}],
		["extract_table_data", {}],
		["find_on_page", { text: "Done" }],
		["gh_repo", { action: "view", repo: "evalops/maestro" }],
		["list_mcp_tools", {}],
		["navigate_to", { action: "listTabs" }],
		["read_page", {}],
		["search_page", { query: "Done" }],
		["wait_for_selector", { selector: "#result" }],
	])("keeps %s read-only action executions non-mutating", (toolName, args) => {
		const projected = project([
			{
				type: "tool_execution_start",
				toolCallId: `tool-call-${toolName}-${args.action}`,
				toolExecutionId: `tool-exec-${toolName}-${args.action}`,
				toolName,
				args,
			},
		]);

		expect(projected[0]?.action).toMatchObject({
			tool_name: toolName,
			mutates_resource: false,
			safe_args_summary: {
				operation: "read_or_unknown",
			},
		});
	});

	it.each([
		["mcp__fathom-cua__get_app_state", {}],
		["mcp__fathom-cua__list_apps", {}],
	])(
		"keeps %s desktop observe tool executions non-mutating",
		(toolName, args) => {
			const projected = project([
				{
					type: "tool_execution_start",
					toolCallId: `tool-call-${toolName}`,
					toolExecutionId: `tool-exec-${toolName}`,
					toolName,
					args,
				},
			]);

			expect(projected[0]?.action).toMatchObject({
				tool_name: toolName,
				mutates_resource: false,
				safe_args_summary: {
					operation: "read_or_unknown",
				},
			});
		},
	);

	it("preserves explicit governed denial status instead of generic execution failure", () => {
		const projected = project([
			{
				type: "tool_execution_end",
				toolCallId: "tool-call-denied",
				toolExecutionId: "tool-exec-denied",
				errorCode: "governance_denied",
				governedOutcome: "denied",
				toolName: "bash",
				result: toolResult(),
				isError: true,
			},
		]);

		expect(projected[0]).toMatchObject({
			event_type: "tool.completed",
			action: {
				status: "denied",
				tool_call_id: "tool-call-denied",
				tool_execution_id: "tool-exec-denied",
			},
		});
	});

	it("detects tampered and omitted events from the schema-compatible evidence signature chain", () => {
		const projected = project();
		expect(verifyAgentWorkforceNativeEventChain(projected)).toEqual({
			valid: true,
		});

		const tampered = structuredClone(projected);
		tampered[2]!.action.tool_name = "write";
		expect(verifyAgentWorkforceNativeEventChain(tampered)).toMatchObject({
			valid: false,
			reason: "hash_mismatch",
			index: 2,
		});

		const omitted = projected.filter((_event, index) => index !== 2);
		expect(verifyAgentWorkforceNativeEventChain(omitted)).toMatchObject({
			valid: false,
			reason: "sequence_gap",
			index: 2,
		});

		const malformedSignature = structuredClone(projected);
		malformedSignature[0]!.evidence.signature =
			"sha256-chain:v1:%E0%A4%A:1:root:bad-hash";
		expect(
			verifyAgentWorkforceNativeEventChain(malformedSignature),
		).toMatchObject({
			valid: false,
			reason: "signature_malformed",
			index: 0,
		});
	});
});
