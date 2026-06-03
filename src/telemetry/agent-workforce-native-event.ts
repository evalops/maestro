import { createHash, randomUUID } from "node:crypto";
import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
} from "../agent/action-approval.js";
import type {
	AgentEvent,
	AppMessage,
	AssistantMessage,
	ToolResultMessage,
	Usage,
} from "../agent/types.js";
import type {
	MaestroCorrelation,
	MaestroPrincipal,
} from "./maestro-event-bus.js";

export const AGENT_WORKFORCE_NATIVE_EVENT_SCHEMA_VERSION =
	"agent_workforce_native_event.v1" as const;

export type AgentWorkforceNativeEventType =
	| "run.started"
	| "run.completed"
	| "turn.started"
	| "turn.completed"
	| "tool.attempted"
	| "tool.completed"
	| "policy.checked"
	| "approval.requested"
	| "approval.resolved"
	| "model.usage"
	| "evidence.missing";

export type AgentWorkforceEvidenceAuthority =
	| "platform_native"
	| "native_observed"
	| "mcp_observed"
	| "hook_observed"
	| "provider_proxy_observed"
	| "self_reported";

export type AgentWorkforceCredentialDeclaredAuthority =
	| "identity"
	| "secret_broker"
	| "llm_gateway_vault"
	| "local_env"
	| "provider_proxy"
	| "self_reported"
	| "unknown";

export type AgentWorkforceCredentialProofStatus =
	| "proven"
	| "missing"
	| "self_reported"
	| "external_unverified";

export type AgentWorkforceVerifiedCredentialAuthority = Extract<
	AgentWorkforceCredentialDeclaredAuthority,
	"identity" | "secret_broker" | "llm_gateway_vault"
>;

export type AgentWorkforceVerifiedRevocationStatus = "active" | "not_revoked";

export type AgentWorkforceEvidenceKind =
	| "native_event"
	| "agent_runtime"
	| "agent_registry"
	| "identity"
	| "secret_broker"
	| "llm_gateway"
	| "meter"
	| "approval"
	| "policy"
	| "source_event";

export type AgentWorkforceCredentialJoinKind = Extract<
	AgentWorkforceEvidenceKind,
	| "identity"
	| "agent_runtime"
	| "agent_registry"
	| "secret_broker"
	| "llm_gateway"
	| "meter"
>;

export interface AgentWorkforceEvidenceRef {
	kind: AgentWorkforceEvidenceKind;
	ref: string;
	observed_at?: string;
}

export interface AgentWorkforceCredentialJoinRef {
	kind: AgentWorkforceCredentialJoinKind;
	id: string;
	service?: string;
	evidence_id?: string;
	verified?: boolean;
	observed_at?: string;
	expires_at?: string;
	ttl_seconds?: number;
	revocation_status?: "active" | "not_revoked" | "revoked" | "unknown";
}

export interface AgentWorkforceDeclaredCredential {
	credential_id?: string;
	credential_subject?: string;
	credential_assumption_ref?: string;
	grant_id?: string;
	provider_ref_id?: string;
	credential_name?: string;
	provider?: string;
	scope?: string;
	source?: string;
	declared_authority?: AgentWorkforceCredentialDeclaredAuthority;
}

export interface AgentWorkforceEmitter {
	emitter: "evalops/maestro";
	component: "maestro.telemetry.event_bus";
	emitter_owner: "maestro.provider_event_bus";
	emitter_version?: string;
	agent_type: "maestro";
	surface: "desktop" | "cli" | "hosted" | "mcp" | "provider_proxy" | "unknown";
}

export interface AgentWorkforceSourceAuthority {
	declared_authority: AgentWorkforceEvidenceAuthority;
	evidence_authority: AgentWorkforceEvidenceAuthority;
	provenance_verified: boolean;
	authority_ref?: string;
	join_correlation_id?: string;
	verified_by?: AgentWorkforceCredentialJoinKind[];
}

export interface AgentWorkforceTenant {
	organization_id: string;
	workspace_id: string;
}

export interface AgentWorkforceAssociatedHuman {
	subject: string;
	user_id?: string;
	auth_session_id?: string;
	delegation_chain?: string[];
}

export interface AgentWorkforceRun {
	run_id: string;
	agent_run_id?: string;
	agent_run_step_id?: string;
	turn_id?: string;
	thread_id?: string;
	maestro_session_id?: string;
	codex_thread_id?: string;
	codex_turn_id?: string;
	trace_id?: string;
	traceparent?: string;
}

export interface AgentWorkforceTimelineCorrelation {
	source_event_ref?: string;
	native_action_correlation_id: string;
	platform_action_correlation_id?: string;
	credential_join_correlation_id?: string;
}

export interface AgentWorkforceAction {
	sequence: number;
	tool_call_id?: string;
	tool_execution_id?: string;
	action_kind:
		| "run"
		| "turn"
		| "model"
		| "tool"
		| "command"
		| "file_change"
		| "mcp"
		| "approval"
		| "policy"
		| "usage"
		| "unknown";
	tool_name?: string;
	mutates_resource?: boolean;
	resource_refs?: string[];
	safe_args_summary?: Record<string, unknown>;
	safe_args_hash?: string;
	status: "attempted" | "completed" | "failed" | "denied" | "skipped";
}

export interface AgentWorkforcePolicy {
	policy_decision_ref?: string;
	approval_ref?: string;
	decision?:
		| "allow"
		| "deny"
		| "require_approval"
		| "auto_approved"
		| "unknown";
	risk?: "low" | "medium" | "high" | "critical" | "unknown";
}

export interface AgentWorkforceVerifiedProvenance {
	authority: AgentWorkforceVerifiedCredentialAuthority;
	authority_ref: string;
	join_correlation_id: string;
	observed_at: string;
	expires_at: string;
	ttl_seconds: number;
	revocation_status: AgentWorkforceVerifiedRevocationStatus;
	joined_evidence_refs: AgentWorkforceEvidenceRef[];
}

export interface AgentWorkforcePlatformCredentialAuthority {
	source: "platform_ingestion" | "platform_resolver";
	credential_subject?: string;
	credential_assumption_ref?: string;
	credential_assumption_id?: string;
	grant_id?: string;
	provider_ref_id?: string;
	credential_name?: string;
	verified_provenance: AgentWorkforceVerifiedProvenance;
}

export interface AgentWorkforceCredentialAssumption {
	credential_subject: string;
	credential_assumption_ref?: string;
	credential_assumption_id?: string;
	grant_id?: string;
	provider_ref_id?: string;
	credential_name?: string;
	proof_status: AgentWorkforceCredentialProofStatus;
	declared_authority: AgentWorkforceCredentialDeclaredAuthority;
	provenance_verified: boolean;
	verified_provenance?: AgentWorkforceVerifiedProvenance;
}

export interface AgentWorkforceModelUsage {
	meter_usage_ref?: string;
	provider?: string;
	model?: string;
	request_id?: string;
	input_tokens?: number;
	cached_input_tokens?: number;
	output_tokens?: number;
	reasoning_output_tokens?: number;
	total_cost_usd?: number;
}

export interface AgentWorkforceMissingEvidence {
	code:
		| "credential_assumption.unproven"
		| "credential_assumption.join_missing"
		| "credential_assumption.freshness_missing"
		| "credential_assumption.revocation_status_missing"
		| "source_authority.platform_join_missing";
	severity: "blocking_for_platform_native" | "warning" | "info";
	owner:
		| "platform.identity"
		| "platform.agent_runtime"
		| "platform.agent_registry"
		| "platform.secret_broker"
		| "platform.llm_gateway"
		| "platform.meter"
		| "emitter.owner";
	detail?: string;
}

export interface AgentWorkforceEvidence {
	refs: AgentWorkforceEvidenceRef[];
	source_event_ref?: string;
	signature?: string;
	missing_evidence: AgentWorkforceMissingEvidence[];
}

export interface AgentWorkforceNativeEvent {
	schema_version: typeof AGENT_WORKFORCE_NATIVE_EVENT_SCHEMA_VERSION;
	envelope_id: string;
	event_type: AgentWorkforceNativeEventType;
	observed_at: string;
	emitter: AgentWorkforceEmitter;
	source_authority: AgentWorkforceSourceAuthority;
	tenant: AgentWorkforceTenant;
	agent_instance_id: string;
	associated_human: AgentWorkforceAssociatedHuman;
	run: AgentWorkforceRun;
	timeline_correlation: AgentWorkforceTimelineCorrelation;
	action: AgentWorkforceAction;
	policy?: AgentWorkforcePolicy;
	credential_assumption: AgentWorkforceCredentialAssumption;
	model_usage?: AgentWorkforceModelUsage;
	evidence: AgentWorkforceEvidence;
}

export interface AgentWorkforceNativeProjectionOptions {
	correlation: Partial<MaestroCorrelation> & {
		workspace_id?: string;
		session_id?: string;
	};
	principal?: MaestroPrincipal;
	threadId?: string;
	turnId?: string;
	chainId?: string;
	sourceRecordId?: string;
	emitterVersion?: string;
	surface?: AgentWorkforceEmitter["surface"];
	declaredCredential?: AgentWorkforceDeclaredCredential;
	credentialJoinRefs?: AgentWorkforceCredentialJoinRef[];
	platformCredentialAuthority?: AgentWorkforcePlatformCredentialAuthority;
	clock?: () => Date;
	makeEnvelopeId?: (event: AgentEvent, sequence: number) => string;
}

export interface AgentWorkforceNativeChainVerification {
	valid: boolean;
	reason?:
		| "empty"
		| "signature_missing"
		| "signature_malformed"
		| "chain_id_mismatch"
		| "sequence_gap"
		| "previous_hash_mismatch"
		| "hash_mismatch";
	index?: number;
	expected?: string;
	actual?: string;
}

type PendingToolProjection = {
	action: Pick<
		AgentWorkforceAction,
		| "mutates_resource"
		| "resource_refs"
		| "safe_args_summary"
		| "safe_args_hash"
	>;
};

type ParsedChainSignature = {
	chainId: string;
	sequence: number;
	previousHash?: string;
	eventHash: string;
};

function hashStableValue(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "null";
	const valueType = typeof value;
	if (valueType === "string") return JSON.stringify(value);
	if (valueType === "number" || valueType === "boolean")
		return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (valueType === "object") {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(String(value));
}

function compactRecord<T extends Record<string, unknown>>(
	record: T,
): Partial<T> | undefined {
	const entries = Object.entries(record).filter(
		([, value]) =>
			value !== undefined && (!Array.isArray(value) || value.length > 0),
	);
	return entries.length > 0
		? (Object.fromEntries(entries) as Partial<T>)
		: undefined;
}

function eventHashPayload(event: AgentWorkforceNativeEvent): unknown {
	return {
		...event,
		evidence: {
			...event.evidence,
			signature: undefined,
		},
	};
}

function computeEventHash(event: AgentWorkforceNativeEvent): string {
	return hashStableValue(eventHashPayload(event));
}

function buildChainSignature(input: {
	chainId: string;
	sequence: number;
	previousHash?: string;
	eventHash: string;
}): string {
	return [
		"sha256-chain",
		"v1",
		encodeURIComponent(input.chainId),
		String(input.sequence),
		input.previousHash ?? "root",
		input.eventHash,
	].join(":");
}

function parseChainSignature(
	signature: string | undefined,
): ParsedChainSignature | null {
	if (!signature) return null;
	const parts = signature.split(":");
	if (parts.length !== 6 || parts[0] !== "sha256-chain" || parts[1] !== "v1") {
		return null;
	}
	const sequence = Number(parts[3]);
	if (!Number.isInteger(sequence) || sequence < 1) return null;
	let chainId: string;
	try {
		chainId = decodeURIComponent(parts[2] ?? "");
	} catch {
		return null;
	}
	return {
		chainId,
		sequence,
		previousHash: parts[4] === "root" ? undefined : parts[4],
		eventHash: parts[5] ?? "",
	};
}

function readString(
	record: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function safeHash(value: unknown): string {
	return `sha256:${hashStableValue(value)}`;
}

function resourceProjection(
	toolName: string | undefined,
	args?: Record<string, unknown>,
): PendingToolProjection["action"] {
	const lowerTool = toolName?.toLowerCase() ?? "";
	const filePath = readString(args, [
		"path",
		"file",
		"file_path",
		"filepath",
		"target_file",
		"directory",
		"cwd",
	]);
	const url = readString(args, ["url", "uri", "endpoint"]);
	const command = readString(args, ["cmd", "command", "script"]);
	const mutationTools = new Set([
		"write",
		"edit",
		"delete",
		"apply_patch",
		"bash",
		"shell",
		"exec",
		"git_cmd",
	]);
	const mutatesResource = mutationTools.has(lowerTool);
	const resourceKind = filePath
		? "file"
		: url
			? "url"
			: command
				? "command"
				: toolName
					? "tool"
					: "unknown";
	const resourceValue = filePath ?? url ?? command ?? toolName ?? "unknown";
	const argumentKeys = Object.keys(args ?? {}).sort();
	return {
		mutates_resource: mutatesResource,
		resource_refs: [`${resourceKind}:${safeHash(resourceValue)}`],
		safe_args_summary: {
			argument_keys: argumentKeys,
			resource_kind: resourceKind,
			operation: mutatesResource ? "mutate" : "read_or_unknown",
		},
		safe_args_hash: safeHash(args ?? {}),
	};
}

function messageTimestamp(message: AppMessage): string | undefined {
	const timestamp =
		"timestamp" in message && typeof message.timestamp === "number"
			? message.timestamp
			: undefined;
	return timestamp === undefined
		? undefined
		: new Date(timestamp).toISOString();
}

function approvalRequestTimestamp(
	request: ActionApprovalRequest,
): string | undefined {
	return typeof request.startedAtMs === "number"
		? new Date(request.startedAtMs).toISOString()
		: undefined;
}

function approvalDecisionTimestamp(
	decision: ActionApprovalDecision,
): string | undefined {
	return typeof decision.resolvedAtMs === "number"
		? new Date(decision.resolvedAtMs).toISOString()
		: undefined;
}

function eventObservedAt(event: AgentEvent, fallback: Date): string {
	switch (event.type) {
		case "message_start":
		case "message_update":
		case "message_end":
			return (
				messageTimestamp(event.message as AppMessage) ?? fallback.toISOString()
			);
		case "turn_end":
			return (
				messageTimestamp(event.message as AppMessage) ?? fallback.toISOString()
			);
		case "tool_execution_end":
			return new Date(event.result.timestamp).toISOString();
		case "action_approval_required":
			return approvalRequestTimestamp(event.request) ?? fallback.toISOString();
		case "action_approval_resolved":
			return (
				approvalDecisionTimestamp(event.decision) ??
				approvalRequestTimestamp(event.request) ??
				fallback.toISOString()
			);
		default:
			return fallback.toISOString();
	}
}

function isAssistantMessage(message: AppMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function nativeEventTypeFor(
	event: AgentEvent,
): AgentWorkforceNativeEventType | null {
	switch (event.type) {
		case "agent_start":
			return "run.started";
		case "agent_end":
			return "run.completed";
		case "turn_start":
			return "turn.started";
		case "turn_end":
			return "turn.completed";
		case "tool_execution_start":
			return "tool.attempted";
		case "tool_execution_end":
			return "tool.completed";
		case "action_approval_required":
			return "approval.requested";
		case "action_approval_resolved":
			return "approval.resolved";
		case "message_end":
			return isAssistantMessage(event.message as AppMessage)
				? "model.usage"
				: null;
		default:
			return null;
	}
}

function actionKindFor(event: AgentEvent): AgentWorkforceAction["action_kind"] {
	switch (event.type) {
		case "agent_start":
		case "agent_end":
			return "run";
		case "turn_start":
		case "turn_end":
			return "turn";
		case "tool_execution_start":
		case "tool_execution_end":
			return "tool";
		case "action_approval_required":
		case "action_approval_resolved":
			return "approval";
		case "message_end":
			return "usage";
		default:
			return "unknown";
	}
}

function actionStatusFor(event: AgentEvent): AgentWorkforceAction["status"] {
	switch (event.type) {
		case "agent_start":
		case "turn_start":
		case "tool_execution_start":
		case "action_approval_required":
			return "attempted";
		case "agent_end":
			return event.aborted ? "failed" : "completed";
		case "tool_execution_end":
			if (
				event.governedOutcome === "denied" ||
				event.errorCode === "approval_denied" ||
				event.errorCode === "governance_denied"
			) {
				return "denied";
			}
			return event.isError ? "failed" : "completed";
		case "action_approval_resolved":
			return event.decision.approved ? "completed" : "denied";
		default:
			return "completed";
	}
}

function usageFromAssistantMessage(
	message: AppMessage,
	requestId?: string,
): AgentWorkforceModelUsage | undefined {
	if (!isAssistantMessage(message)) return undefined;
	const usage = message.usage;
	return {
		provider: message.provider,
		model: message.model,
		request_id: requestId,
		input_tokens: usage.input,
		cached_input_tokens: usage.cacheRead,
		output_tokens: usage.output,
		reasoning_output_tokens: 0,
		total_cost_usd: usage.cost.total,
	};
}

function contentHashForToolResult(result: ToolResultMessage): string {
	return safeHash(result.content);
}

function credentialDeclaredAuthority(
	declared: AgentWorkforceDeclaredCredential | undefined,
): AgentWorkforceCredentialDeclaredAuthority {
	if (declared?.declared_authority) return declared.declared_authority;
	if (declared?.source === "secret_broker") return "secret_broker";
	if (declared?.source === "llm_gateway") return "llm_gateway_vault";
	if (declared?.source === "provider_proxy") return "provider_proxy";
	if (declared?.source === "self_reported") return "self_reported";
	if (declared?.credential_id || declared?.provider) return "local_env";
	return "unknown";
}

function platformCredentialAuthorityIsComplete(
	authority: AgentWorkforcePlatformCredentialAuthority | undefined,
	now: Date,
): authority is AgentWorkforcePlatformCredentialAuthority {
	if (!authority) return false;
	if (
		authority.source !== "platform_ingestion" &&
		authority.source !== "platform_resolver"
	) {
		return false;
	}
	const provenance = authority.verified_provenance;
	const authorityEvidenceKind =
		provenance.authority === "llm_gateway_vault"
			? "llm_gateway"
			: provenance.authority;
	const observedAtMs = Date.parse(provenance.observed_at);
	const expiresAtMs = Date.parse(provenance.expires_at);
	if (
		!provenance.authority_ref ||
		!provenance.join_correlation_id ||
		!provenance.observed_at ||
		!provenance.expires_at ||
		!Number.isFinite(observedAtMs) ||
		!Number.isFinite(expiresAtMs) ||
		observedAtMs > now.getTime() ||
		expiresAtMs <= now.getTime() ||
		typeof provenance.ttl_seconds !== "number" ||
		!Number.isFinite(provenance.ttl_seconds) ||
		provenance.ttl_seconds < 1 ||
		observedAtMs + provenance.ttl_seconds * 1000 <= now.getTime() ||
		(provenance.revocation_status !== "active" &&
			provenance.revocation_status !== "not_revoked")
	) {
		return false;
	}
	const joinedRefs = provenance.joined_evidence_refs;
	const hasKind = (kind: AgentWorkforceEvidenceKind) =>
		joinedRefs.some((ref) => ref.kind === kind && Boolean(ref.ref));
	return (
		joinedRefs.length >= 3 &&
		hasKind("identity") &&
		hasKind("agent_runtime") &&
		hasKind(authorityEvidenceKind)
	);
}

function credentialAssumption(
	options: AgentWorkforceNativeProjectionOptions,
	now: Date,
): AgentWorkforceCredentialAssumption {
	const declared = options.declaredCredential;
	const declaredAuthority = credentialDeclaredAuthority(declared);
	const platformAuthority = options.platformCredentialAuthority;
	if (platformCredentialAuthorityIsComplete(platformAuthority, now)) {
		const credentialSubject =
			platformAuthority.credential_subject ??
			declared?.credential_subject ??
			(options.correlation.agent_id
				? `agent:${options.correlation.agent_id}`
				: "unknown");
		return {
			credential_subject: credentialSubject,
			credential_assumption_ref:
				platformAuthority.credential_assumption_ref ??
				declared?.credential_assumption_ref ??
				platformAuthority.verified_provenance.authority_ref,
			credential_assumption_id:
				platformAuthority.credential_assumption_id ?? declared?.credential_id,
			grant_id: platformAuthority.grant_id ?? declared?.grant_id,
			provider_ref_id:
				platformAuthority.provider_ref_id ?? declared?.provider_ref_id,
			credential_name:
				platformAuthority.credential_name ?? declared?.credential_name,
			proof_status: "proven",
			declared_authority: platformAuthority.verified_provenance.authority,
			provenance_verified: true,
			verified_provenance: platformAuthority.verified_provenance,
		};
	}
	return {
		credential_subject: declared?.credential_subject ?? "unknown",
		credential_assumption_ref: declared?.credential_assumption_ref,
		credential_assumption_id: declared?.credential_id,
		grant_id: declared?.grant_id,
		provider_ref_id: declared?.provider_ref_id,
		credential_name: declared?.credential_name,
		proof_status: "missing",
		declared_authority: declaredAuthority,
		provenance_verified: false,
	};
}

function missingCredentialEvidence(
	assumption: AgentWorkforceCredentialAssumption,
): AgentWorkforceMissingEvidence[] {
	if (assumption.proof_status === "proven" && assumption.provenance_verified) {
		return [];
	}
	return [
		{
			code: "credential_assumption.unproven",
			severity: "blocking_for_platform_native",
			owner: "platform.secret_broker",
			detail:
				"Maestro emitted a runtime-observed native action timeline, but Platform has not joined it to credential authority evidence.",
		},
	];
}

function tenantFromOptions(
	options: AgentWorkforceNativeProjectionOptions,
): AgentWorkforceTenant {
	return {
		organization_id: options.correlation.organization_id ?? "unknown",
		workspace_id: options.correlation.workspace_id ?? process.cwd(),
	};
}

function associatedHumanFromOptions(
	options: AgentWorkforceNativeProjectionOptions,
): AgentWorkforceAssociatedHuman {
	const subject =
		options.principal?.subject ??
		(options.correlation.user_id
			? `user:${options.correlation.user_id}`
			: "unknown");
	return {
		subject,
		user_id: options.correlation.user_id ?? options.principal?.user_id,
	};
}

function runFromOptions(
	options: AgentWorkforceNativeProjectionOptions,
	currentTurnId: string | undefined,
	eventStepId: string | undefined,
): AgentWorkforceRun {
	const sessionId = options.correlation.session_id ?? "unknown";
	const agentRunId = options.correlation.agent_run_id;
	return {
		run_id: agentRunId ?? sessionId,
		agent_run_id: agentRunId,
		agent_run_step_id: eventStepId ?? options.correlation.agent_run_step_id,
		turn_id: options.turnId ?? currentTurnId,
		thread_id:
			options.threadId ?? options.correlation.conversation_id ?? sessionId,
		maestro_session_id: sessionId,
		trace_id: options.correlation.trace_id,
		traceparent: options.correlation.traceparent,
	};
}

function sourceEventRef(
	event: AgentEvent,
	run: AgentWorkforceRun,
	sequence: number,
): string {
	switch (event.type) {
		case "tool_execution_start":
			return `maestro.AgentEvent:tool_execution_start:${run.maestro_session_id ?? run.run_id}:${event.toolCallId}`;
		case "tool_execution_end":
			return `maestro.AgentEvent:tool_execution_end:${run.maestro_session_id ?? run.run_id}:${event.toolCallId}`;
		case "action_approval_required":
		case "action_approval_resolved":
			return `maestro.AgentEvent:${event.type}:${run.maestro_session_id ?? run.run_id}:${event.request.id}`;
		default:
			return `maestro.AgentEvent:${event.type}:${run.maestro_session_id ?? run.run_id}:${run.turn_id ?? "run"}:${sequence}`;
	}
}

function nativeActionCorrelationId(
	event: AgentEvent,
	run: AgentWorkforceRun,
	sequence: number,
): string {
	const base = [
		run.maestro_session_id ?? run.run_id,
		run.agent_run_id,
		run.agent_run_step_id,
		run.turn_id,
	]
		.filter(Boolean)
		.join("/");
	switch (event.type) {
		case "tool_execution_start":
		case "tool_execution_end":
			return `${base || run.run_id}/${event.toolCallId}`;
		case "action_approval_required":
		case "action_approval_resolved":
			return `${base || run.run_id}/${event.request.id}`;
		default:
			return `${base || run.run_id}/${event.type}:${sequence}`;
	}
}

function platformActionCorrelationId(
	run: AgentWorkforceRun,
	action: AgentWorkforceAction,
): string | undefined {
	if (!run.agent_run_id && !run.agent_run_step_id && !action.tool_call_id) {
		return undefined;
	}
	return [
		"agentruntime",
		run.agent_run_id ?? "unknown-run",
		run.agent_run_step_id ?? "unknown-step",
		action.tool_call_id,
	]
		.filter(Boolean)
		.join(":");
}

function evidenceRefs(input: {
	sourceRef: string;
	observedAt: string;
	run: AgentWorkforceRun;
	policy?: AgentWorkforcePolicy;
	modelUsage?: AgentWorkforceModelUsage;
	credentialJoinRefs: readonly AgentWorkforceCredentialJoinRef[];
	platformCredentialAuthority?: AgentWorkforcePlatformCredentialAuthority;
	now: Date;
}): AgentWorkforceEvidenceRef[] {
	const refs: AgentWorkforceEvidenceRef[] = [
		{
			kind: "native_event",
			ref: input.sourceRef,
			observed_at: input.observedAt,
		},
	];
	if (input.run.agent_run_id || input.run.agent_run_step_id) {
		refs.push({
			kind: "agent_runtime",
			ref: `agentruntime:${input.run.agent_run_id ?? "unknown-run"}:${input.run.agent_run_step_id ?? "unknown-step"}`,
			observed_at: input.observedAt,
		});
	}
	if (input.policy?.approval_ref) {
		refs.push({
			kind: "approval",
			ref: input.policy.approval_ref,
			observed_at: input.observedAt,
		});
	}
	if (input.modelUsage?.meter_usage_ref) {
		refs.push({
			kind: "meter",
			ref: input.modelUsage.meter_usage_ref,
			observed_at: input.observedAt,
		});
	}
	for (const ref of input.credentialJoinRefs) {
		refs.push({
			kind: ref.kind,
			ref: ref.evidence_id ?? ref.id,
			observed_at: ref.observed_at,
		});
	}
	if (
		platformCredentialAuthorityIsComplete(
			input.platformCredentialAuthority,
			input.now,
		)
	) {
		for (const ref of input.platformCredentialAuthority.verified_provenance
			.joined_evidence_refs) {
			if (
				!refs.some(
					(existing) => existing.kind === ref.kind && existing.ref === ref.ref,
				)
			) {
				refs.push(ref);
			}
		}
	}
	return refs;
}

function policyForEvent(
	event: AgentEvent,
	resolvedApprovalDecision?: ActionApprovalDecision,
): AgentWorkforcePolicy | undefined {
	switch (event.type) {
		case "action_approval_required":
			return {
				approval_ref:
					event.request.platform?.approvalRequestId ?? event.request.id,
				decision: "require_approval",
				risk: "unknown",
			};
		case "action_approval_resolved":
			return {
				approval_ref:
					event.request.platform?.approvalRequestId ?? event.request.id,
				decision: event.decision.approved ? "allow" : "deny",
				risk: "unknown",
			};
		case "tool_execution_end":
			return event.approvalRequestId
				? {
						approval_ref: event.approvalRequestId,
						decision: resolvedApprovalDecision
							? resolvedApprovalDecision.approved
								? "allow"
								: "deny"
							: "unknown",
						risk: "unknown",
					}
				: undefined;
		default:
			return undefined;
	}
}

function toolActionForStart(
	event: Extract<AgentEvent, { type: "tool_execution_start" }>,
): Pick<
	AgentWorkforceAction,
	| "tool_call_id"
	| "tool_execution_id"
	| "tool_name"
	| "mutates_resource"
	| "resource_refs"
	| "safe_args_summary"
	| "safe_args_hash"
> {
	return {
		tool_call_id: event.toolCallId,
		tool_execution_id: event.toolExecutionId,
		tool_name: event.toolName,
		...resourceProjection(event.toolName, event.args),
	};
}

function toolActionForEnd(
	event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	pendingTool: PendingToolProjection | undefined,
): Pick<
	AgentWorkforceAction,
	| "tool_call_id"
	| "tool_execution_id"
	| "tool_name"
	| "mutates_resource"
	| "resource_refs"
	| "safe_args_summary"
	| "safe_args_hash"
> {
	return {
		tool_call_id: event.toolCallId,
		tool_execution_id: event.toolExecutionId,
		tool_name: event.toolName,
		...(pendingTool?.action ?? {
			...resourceProjection(event.toolName),
			safe_args_hash: contentHashForToolResult(event.result),
		}),
	};
}

function approvalAction(
	event: Extract<
		AgentEvent,
		{ type: "action_approval_required" | "action_approval_resolved" }
	>,
): Pick<
	AgentWorkforceAction,
	| "tool_name"
	| "tool_execution_id"
	| "resource_refs"
	| "safe_args_summary"
	| "safe_args_hash"
> {
	const args =
		event.request.args && typeof event.request.args === "object"
			? (event.request.args as Record<string, unknown>)
			: undefined;
	return {
		tool_name: event.request.toolName,
		tool_execution_id: event.request.platform?.toolExecutionId,
		...resourceProjection(event.request.toolName, args),
	};
}

function eventStepId(event: AgentEvent): string | undefined {
	switch (event.type) {
		case "tool_execution_start":
		case "tool_execution_end":
			return event.toolExecutionId ?? event.toolCallId;
		case "action_approval_required":
		case "action_approval_resolved":
			return event.request.platform?.toolExecutionId;
		default:
			return undefined;
	}
}

function actionForEvent(
	event: AgentEvent,
	sequence: number,
	pendingTool: PendingToolProjection | undefined,
): AgentWorkforceAction {
	const base: AgentWorkforceAction = {
		sequence,
		action_kind: actionKindFor(event),
		status: actionStatusFor(event),
	};
	switch (event.type) {
		case "tool_execution_start":
			return { ...base, ...toolActionForStart(event) };
		case "tool_execution_end":
			return { ...base, ...toolActionForEnd(event, pendingTool) };
		case "action_approval_required":
		case "action_approval_resolved":
			return { ...base, ...approvalAction(event) };
		default:
			return base;
	}
}

export class AgentWorkforceNativeEventProjector {
	private sequence = 0;
	private previousEventHash: string | undefined;
	private currentTurnId: string | undefined;
	private turnOrdinal = 0;
	private readonly pendingTools = new Map<string, PendingToolProjection>();
	private readonly resolvedApprovals = new Map<
		string,
		ActionApprovalDecision
	>();

	constructor(
		private readonly options: AgentWorkforceNativeProjectionOptions,
	) {}

	project(event: AgentEvent): AgentWorkforceNativeEvent | null {
		const eventType = nativeEventTypeFor(event);
		if (!eventType) return null;

		if (event.type === "turn_start") {
			this.turnOrdinal += 1;
			this.currentTurnId =
				this.options.turnId ??
				`${this.options.correlation.session_id ?? "unknown"}:turn:${this.turnOrdinal}`;
		}

		if (event.type === "tool_execution_start") {
			this.pendingTools.set(event.toolCallId, {
				action: resourceProjection(event.toolName, event.args),
			});
		}
		const pendingTool =
			event.type === "tool_execution_end"
				? this.pendingTools.get(event.toolCallId)
				: undefined;
		if (event.type === "tool_execution_end") {
			this.pendingTools.delete(event.toolCallId);
		}
		if (event.type === "action_approval_resolved") {
			this.resolvedApprovals.set(event.request.id, event.decision);
			const platformApprovalId = event.request.platform?.approvalRequestId;
			if (platformApprovalId) {
				this.resolvedApprovals.set(platformApprovalId, event.decision);
			}
		}

		this.sequence += 1;
		const sequence = this.sequence;
		const now = this.options.clock?.() ?? new Date();
		const observedAt = eventObservedAt(event, now);
		const run = runFromOptions(
			this.options,
			this.currentTurnId,
			eventStepId(event),
		);
		const action = actionForEvent(event, sequence, pendingTool);
		const policy = policyForEvent(
			event,
			event.type === "tool_execution_end" && event.approvalRequestId
				? this.resolvedApprovals.get(event.approvalRequestId)
				: undefined,
		);
		const credential = credentialAssumption(this.options, now);
		const modelUsage =
			event.type === "message_end"
				? usageFromAssistantMessage(
						event.message as AppMessage,
						this.options.correlation.request_id,
					)
				: undefined;
		const sourceRef = sourceEventRef(event, run, sequence);
		const credentialJoinCorrelationId =
			credential.verified_provenance?.join_correlation_id;
		const eventEnvelope: AgentWorkforceNativeEvent = {
			schema_version: AGENT_WORKFORCE_NATIVE_EVENT_SCHEMA_VERSION,
			envelope_id:
				this.options.makeEnvelopeId?.(event, sequence) ??
				`awf_evt_maestro_${randomUUID()}`,
			event_type: eventType,
			observed_at: observedAt,
			emitter: {
				emitter: "evalops/maestro",
				component: "maestro.telemetry.event_bus",
				emitter_owner: "maestro.provider_event_bus",
				emitter_version: this.options.emitterVersion,
				agent_type: "maestro",
				surface: this.options.surface ?? "desktop",
			},
			source_authority: {
				declared_authority: "native_observed",
				evidence_authority: "native_observed",
				provenance_verified: false,
			},
			tenant: tenantFromOptions(this.options),
			agent_instance_id:
				this.options.correlation.agent_id ?? "maestro-agent-instance:unknown",
			associated_human: associatedHumanFromOptions(this.options),
			run,
			timeline_correlation: {
				source_event_ref: sourceRef,
				native_action_correlation_id: nativeActionCorrelationId(
					event,
					run,
					sequence,
				),
				platform_action_correlation_id: platformActionCorrelationId(
					run,
					action,
				),
				credential_join_correlation_id: credentialJoinCorrelationId,
			},
			action,
			policy,
			credential_assumption: credential,
			model_usage: modelUsage,
			evidence: {
				refs: evidenceRefs({
					sourceRef,
					observedAt,
					run,
					policy,
					modelUsage,
					credentialJoinRefs: this.options.credentialJoinRefs ?? [],
					platformCredentialAuthority: this.options.platformCredentialAuthority,
					now,
				}),
				source_event_ref: sourceRef,
				missing_evidence: missingCredentialEvidence(credential),
			},
		};
		const eventHash = computeEventHash(eventEnvelope);
		const chainId =
			this.options.chainId ??
			`maestro:${run.maestro_session_id ?? run.run_id}:${run.thread_id ?? "thread"}`;
		eventEnvelope.evidence.signature = buildChainSignature({
			chainId,
			sequence,
			previousHash: this.previousEventHash,
			eventHash,
		});
		this.previousEventHash = eventHash;
		return eventEnvelope;
	}
}

export function projectAgentWorkforceNativeEvents(
	events: readonly AgentEvent[],
	options: AgentWorkforceNativeProjectionOptions,
): AgentWorkforceNativeEvent[] {
	const projector = new AgentWorkforceNativeEventProjector(options);
	return events.flatMap((event) => {
		const projected = projector.project(event);
		return projected ? [projected] : [];
	});
}

export function verifyAgentWorkforceNativeEventChain(
	events: readonly AgentWorkforceNativeEvent[],
): AgentWorkforceNativeChainVerification {
	if (events.length === 0) return { valid: false, reason: "empty" };
	let chainId: string | undefined;
	let previousHash: string | undefined;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index]!;
		const signature = parseChainSignature(event.evidence.signature);
		if (!event.evidence.signature) {
			return { valid: false, reason: "signature_missing", index };
		}
		if (!signature) {
			return { valid: false, reason: "signature_malformed", index };
		}
		chainId ??= signature.chainId;
		if (signature.chainId !== chainId) {
			return {
				valid: false,
				reason: "chain_id_mismatch",
				index,
				expected: chainId,
				actual: signature.chainId,
			};
		}
		const expectedSequence = index + 1;
		if (
			signature.sequence !== expectedSequence ||
			event.action.sequence !== expectedSequence
		) {
			return {
				valid: false,
				reason: "sequence_gap",
				index,
				expected: String(expectedSequence),
				actual: `${signature.sequence}/${event.action.sequence}`,
			};
		}
		if (signature.previousHash !== previousHash) {
			return {
				valid: false,
				reason: "previous_hash_mismatch",
				index,
				expected: previousHash,
				actual: signature.previousHash,
			};
		}
		const expectedHash = computeEventHash(event);
		if (signature.eventHash !== expectedHash) {
			return {
				valid: false,
				reason: "hash_mismatch",
				index,
				expected: expectedHash,
				actual: signature.eventHash,
			};
		}
		previousHash = signature.eventHash;
	}
	return { valid: true };
}
