import type {
	ComposerRunTimelineItem,
	ComposerRunTimelineResponse,
	ComposerRunTimelineStatus,
	ComposerRunTimelineVisibility,
} from "@evalops/contracts";

export const AGENT_TRAJECTORY_SCHEMA = "evalops.maestro.agent-trajectory.v1";

export type AgentTrajectoryEventKind =
	| "session"
	| "message"
	| "tool"
	| "evidence"
	| "governance"
	| "context"
	| "wait"
	| "artifact"
	| "runtime";

export type AgentTrajectoryPhase =
	| "setup"
	| "observe"
	| "think"
	| "act"
	| "verify"
	| "govern"
	| "wait"
	| "recover"
	| "finish";

export type AgentTrajectoryActor =
	| "user"
	| "assistant"
	| "tool"
	| "runtime"
	| "platform"
	| "system";

export interface AgentTrajectoryEvidenceAnchor {
	kind:
		| "timeline_item"
		| "tool_call"
		| "tool_execution"
		| "approval_request"
		| "pending_request"
		| "artifact";
	id: string;
}

export interface AgentTrajectoryEvent {
	id: string;
	sequence: number;
	timestamp: string;
	kind: AgentTrajectoryEventKind;
	phase: AgentTrajectoryPhase;
	actor: AgentTrajectoryActor;
	type: string;
	status: ComposerRunTimelineStatus;
	visibility: ComposerRunTimelineVisibility;
	source: ComposerRunTimelineItem["source"];
	title: string;
	summary?: string;
	toolName?: string;
	relatedIds?: string[];
	evidence: AgentTrajectoryEvidenceAnchor[];
}

export interface AgentTrajectoryReport {
	schemaVersion: typeof AGENT_TRAJECTORY_SCHEMA;
	run: {
		id: string;
		sessionId: string;
		source: ComposerRunTimelineResponse["source"];
		generatedAt: string;
		platformBacked: boolean;
	};
	counts: {
		events: number;
		evidenceAnchors: number;
		byKind: Record<string, number>;
		byPhase: Record<string, number>;
		byStatus: Record<string, number>;
	};
	events: AgentTrajectoryEvent[];
}

interface BuildAgentTrajectoryOptions {
	runId?: string;
}

function increment(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

function kindForTimelineItem(
	item: ComposerRunTimelineItem,
): AgentTrajectoryEventKind {
	if (item.type.startsWith("session.")) return "session";
	if (item.type.startsWith("message.")) return "message";
	if (item.type.startsWith("tool.")) return "tool";
	if (item.type.startsWith("file.") || item.type.startsWith("diagnostic.")) {
		return "evidence";
	}
	if (item.type.startsWith("policy.")) return "governance";
	if (item.type === "wait.pending") return "wait";
	if (item.type.startsWith("artifact.")) return "artifact";
	if (
		item.type.startsWith("compaction.") ||
		item.type.startsWith("branch.") ||
		item.type.startsWith("model.") ||
		item.type.startsWith("thinking.")
	) {
		return "context";
	}
	return "runtime";
}

function phaseForTimelineItem(
	item: ComposerRunTimelineItem,
): AgentTrajectoryPhase {
	switch (kindForTimelineItem(item)) {
		case "session":
		case "context":
			return "setup";
		case "message":
			return item.role === "assistant" ? "think" : "observe";
		case "tool":
			return item.type === "tool.requested" ? "act" : "verify";
		case "evidence":
		case "artifact":
			return "verify";
		case "governance":
			return "govern";
		case "wait":
			return "wait";
		case "runtime":
			return item.status === "failed" ? "recover" : "finish";
	}
}

function actorForTimelineItem(
	item: ComposerRunTimelineItem,
): AgentTrajectoryActor {
	if (item.role === "user") return "user";
	if (item.role === "assistant") return "assistant";
	if (item.role === "tool") return "tool";
	if (item.source === "platform") return "platform";
	if (item.type === "tool.requested") return "assistant";
	if (
		item.type.startsWith("session.") ||
		item.type.startsWith("compaction.") ||
		item.type.startsWith("branch.") ||
		item.type.startsWith("model.") ||
		item.type.startsWith("thinking.")
	) {
		return "system";
	}
	return "runtime";
}

function pushAnchor(
	anchors: AgentTrajectoryEvidenceAnchor[],
	kind: AgentTrajectoryEvidenceAnchor["kind"],
	id: string | undefined,
): void {
	if (!id) return;
	anchors.push({ kind, id });
}

function evidenceForTimelineItem(
	item: ComposerRunTimelineItem,
): AgentTrajectoryEvidenceAnchor[] {
	const anchors: AgentTrajectoryEvidenceAnchor[] = [];
	pushAnchor(anchors, "timeline_item", item.id);
	pushAnchor(anchors, "tool_call", item.toolCallId);
	pushAnchor(anchors, "tool_execution", item.toolExecutionId);
	pushAnchor(anchors, "approval_request", item.approvalRequestId);
	pushAnchor(anchors, "pending_request", item.pendingRequestId);
	pushAnchor(anchors, "artifact", item.artifactId);
	return anchors;
}

function relatedIdsForTimelineItem(item: ComposerRunTimelineItem): string[] {
	return [
		item.toolCallId,
		item.toolExecutionId,
		item.approvalRequestId,
		item.pendingRequestId,
		item.artifactId,
	]
		.filter((id): id is string => typeof id === "string" && id.length > 0)
		.sort();
}

export function buildAgentTrajectoryReport(
	timeline: ComposerRunTimelineResponse,
	options: BuildAgentTrajectoryOptions = {},
): AgentTrajectoryReport {
	const events = timeline.items.map((item, index): AgentTrajectoryEvent => {
		const relatedIds = relatedIdsForTimelineItem(item);
		const status = item.status ?? "info";
		return {
			id: `trajectory:${item.id}`,
			sequence: index + 1,
			timestamp: item.timestamp,
			kind: kindForTimelineItem(item),
			phase: phaseForTimelineItem(item),
			actor: actorForTimelineItem(item),
			type: item.type,
			status,
			visibility: item.visibility,
			source: item.source,
			title: item.title,
			...(item.summary ? { summary: item.summary } : {}),
			...(item.toolName ? { toolName: item.toolName } : {}),
			...(relatedIds.length > 0 ? { relatedIds } : {}),
			evidence: evidenceForTimelineItem(item),
		};
	});

	const byKind: Record<string, number> = {};
	const byPhase: Record<string, number> = {};
	const byStatus: Record<string, number> = {};
	let evidenceAnchors = 0;
	for (const event of events) {
		increment(byKind, event.kind);
		increment(byPhase, event.phase);
		increment(byStatus, event.status);
		evidenceAnchors += event.evidence.length;
	}

	return {
		schemaVersion: AGENT_TRAJECTORY_SCHEMA,
		run: {
			id: options.runId ?? timeline.sessionId,
			sessionId: timeline.sessionId,
			source: timeline.source,
			generatedAt: timeline.generatedAt,
			platformBacked: timeline.platformBacked,
		},
		counts: {
			events: events.length,
			evidenceAnchors,
			byKind,
			byPhase,
			byStatus,
		},
		events,
	};
}
