export const AGENT_RUN_SUMMARY_SCHEMA = "evalops.maestro.agent-run-summary.v1";

export type AgentRunSummaryStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export interface AgentRunSummaryUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	estimatedCostUsd?: number;
}

export interface AgentRunSummaryArtifact {
	kind: string;
	path?: string;
	url?: string;
	description?: string;
}

export interface AgentRunSummaryInput {
	id: string;
	status: AgentRunSummaryStatus;
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	sessionId?: string;
	transcriptPath?: string;
	summary?: string;
	result?: string;
	error?: string;
	usage?: AgentRunSummaryUsage;
	artifacts?: AgentRunSummaryArtifact[];
	truncated?: boolean;
	rawOutputPath?: string;
}

export interface AgentRunSummary extends AgentRunSummaryInput {
	schemaVersion: typeof AGENT_RUN_SUMMARY_SCHEMA;
}

export function buildAgentRunSummary(
	input: AgentRunSummaryInput,
): AgentRunSummary {
	return {
		schemaVersion: AGENT_RUN_SUMMARY_SCHEMA,
		...input,
		artifacts: input.artifacts?.filter(hasArtifactPointer),
	};
}

function hasArtifactPointer(artifact: AgentRunSummaryArtifact): boolean {
	return Boolean(
		artifact.kind.trim() &&
			(artifact.path?.trim() ||
				artifact.url?.trim() ||
				artifact.description?.trim()),
	);
}
