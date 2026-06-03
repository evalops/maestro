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
				platform_action_correlation_id:
					"agentruntime:run-1:tool-exec-1:tool-call-1",
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
				output_tokens: 34,
				reasoning_output_tokens: 0,
				total_cost_usd: 0.00191,
			},
		});
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
