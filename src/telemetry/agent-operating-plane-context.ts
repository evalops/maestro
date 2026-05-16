import type { MaestroCorrelation } from "./maestro-event-bus.js";

export type AgentOperatingPlaneDataClassification =
	| "public"
	| "internal"
	| "customer"
	| "restricted";

export type AgentOperatingPlaneRetentionClass =
	| "ephemeral"
	| "operational_audit"
	| "security_audit"
	| "legal_hold";

export interface AgentOperatingPlaneCorrelationInput
	extends Partial<MaestroCorrelation> {
	workspace_id: string;
	session_id: string;
}

export interface AgentOperatingPlaneMetadataInput {
	dataClassification?: AgentOperatingPlaneDataClassification;
	retentionClass?: AgentOperatingPlaneRetentionClass;
	safeSummary?: string;
}

export interface AgentOperatingPlaneContextInput {
	correlation: AgentOperatingPlaneCorrelationInput;
	metadata?: AgentOperatingPlaneMetadataInput;
}

export interface AgentOperatingPlaneContext {
	correlation: MaestroCorrelation;
	metadata: Record<string, string>;
}

function cleanString(value: string | undefined): string | undefined {
	const cleanValue = value?.trim();
	return cleanValue ? cleanValue : undefined;
}

function compactStringRecord(
	record: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!record) return undefined;
	const compacted = Object.fromEntries(
		Object.entries(record)
			.map(([key, value]) => [key, cleanString(value)] as const)
			.filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
	);
	return Object.keys(compacted).length > 0 ? compacted : undefined;
}

export function buildAgentOperatingPlaneCorrelation(
	input: AgentOperatingPlaneCorrelationInput,
): MaestroCorrelation {
	return {
		organization_id: cleanString(input.organization_id),
		user_id: cleanString(input.user_id),
		workspace_id: cleanString(input.workspace_id) ?? "unknown",
		session_id: cleanString(input.session_id) ?? "unknown",
		agent_run_id: cleanString(input.agent_run_id),
		agent_run_step_id: cleanString(input.agent_run_step_id),
		agent_id: cleanString(input.agent_id),
		actor_id: cleanString(input.actor_id),
		principal_id: cleanString(input.principal_id),
		trace_id: cleanString(input.trace_id),
		traceparent: cleanString(input.traceparent),
		tracestate: cleanString(input.tracestate),
		request_id: cleanString(input.request_id),
		parent_event_id: cleanString(input.parent_event_id),
		remote_runner_session_id: cleanString(input.remote_runner_session_id),
		objective_id: cleanString(input.objective_id),
		conversation_id: cleanString(input.conversation_id),
		attributes: compactStringRecord(input.attributes),
	};
}

export function buildAgentOperatingPlaneMetadata(
	input: AgentOperatingPlaneMetadataInput = {},
): Record<string, string> {
	const metadata: Record<string, string> = {};
	const dataClassification = cleanString(input.dataClassification);
	const retentionClass = cleanString(input.retentionClass);
	const safeSummary = cleanString(input.safeSummary);
	if (dataClassification) metadata.data_classification = dataClassification;
	if (retentionClass) metadata.retention_class = retentionClass;
	if (safeSummary) metadata.safe_summary = safeSummary;
	return metadata;
}

export function buildAgentOperatingPlaneContext(
	input: AgentOperatingPlaneContextInput,
): AgentOperatingPlaneContext {
	return {
		correlation: buildAgentOperatingPlaneCorrelation(input.correlation),
		metadata: buildAgentOperatingPlaneMetadata(input.metadata),
	};
}
