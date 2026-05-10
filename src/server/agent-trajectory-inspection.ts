import type { ComposerRunTimelineItem } from "@evalops/contracts";
import type {
	AgentTrajectoryReplayDelta,
	AgentTrajectoryReplayReport,
} from "./agent-trajectory-replay.js";
import type {
	AgentTrajectoryScoreFinding,
	AgentTrajectoryScoreReport,
} from "./agent-trajectory-scorers.js";
import type {
	AgentTrajectoryEvent,
	AgentTrajectoryReport,
} from "./agent-trajectory.js";

export const AGENT_TRAJECTORY_INSPECTION_SCHEMA =
	"evalops.maestro.agent-trajectory-inspection.v1";

type EvidenceAnchor = AgentTrajectoryEvent["evidence"][number];

export interface AgentTrajectoryInspectionEvidenceAnchor
	extends EvidenceAnchor {
	redacted: true;
	label: string;
}

export interface AgentTrajectoryInspectionTimelineItem {
	id: string;
	timestamp: string;
	type: string;
	status: ComposerRunTimelineItem["status"];
	visibility: ComposerRunTimelineItem["visibility"];
	source: ComposerRunTimelineItem["source"];
	title: string;
	summary?: string;
	role?: ComposerRunTimelineItem["role"];
	toolName?: string;
	pendingRequestKind?: ComposerRunTimelineItem["pendingRequestKind"];
	platformOperation?: ComposerRunTimelineItem["platformOperation"];
	metadataKeys: string[];
	redacted: true;
}

export interface AgentTrajectoryInspectionEvent {
	id: string;
	sequence: number;
	timestamp: string;
	kind: AgentTrajectoryEvent["kind"];
	phase: AgentTrajectoryEvent["phase"];
	actor: AgentTrajectoryEvent["actor"];
	type: string;
	status: AgentTrajectoryEvent["status"];
	visibility: AgentTrajectoryEvent["visibility"];
	source: AgentTrajectoryEvent["source"];
	title: string;
	summary?: string;
	toolName?: string;
	relatedIds: string[];
	timelineItemIds: string[];
	evidence: AgentTrajectoryInspectionEvidenceAnchor[];
}

export interface AgentTrajectoryInspectionReplayDelta {
	id: string;
	severity: AgentTrajectoryReplayDelta["severity"];
	ruleId: string;
	message: string;
	eventId?: string;
	timelineItemIds: string[];
	evidence: AgentTrajectoryInspectionEvidenceAnchor[];
}

export interface AgentTrajectoryInspectionScoreFinding {
	ruleId: string;
	status: AgentTrajectoryScoreFinding["status"];
	severity: AgentTrajectoryScoreFinding["severity"];
	message: string;
	eventIds: string[];
	timelineItemIds: string[];
	evidence: AgentTrajectoryInspectionEvidenceAnchor[];
	remediation: string;
}

export interface AgentTrajectoryInspectionFinalAnswer {
	eventId: string;
	timelineItemIds: string[];
	title: string;
	summary?: string;
	redacted: true;
}

export interface AgentTrajectoryInspectionReport {
	schemaVersion: typeof AGENT_TRAJECTORY_INSPECTION_SCHEMA;
	trajectorySchemaVersion: AgentTrajectoryReport["schemaVersion"];
	replaySchemaVersion: AgentTrajectoryReplayReport["schemaVersion"];
	scoreSchemaVersion: AgentTrajectoryScoreReport["schemaVersion"];
	run: AgentTrajectoryReport["run"];
	redaction: {
		default: "redacted";
		omitted: string[];
	};
	counts: {
		timelineItems: number;
		events: number;
		replayDeltas: number;
		scoreFindings: number;
		scoreFailures: number;
		scoreWarnings: number;
		jumpTargets: number;
	};
	finalAnswer?: AgentTrajectoryInspectionFinalAnswer;
	timelineItems: AgentTrajectoryInspectionTimelineItem[];
	events: AgentTrajectoryInspectionEvent[];
	replayDeltas: AgentTrajectoryInspectionReplayDelta[];
	scoreFindings: AgentTrajectoryInspectionScoreFinding[];
}

export interface BuildAgentTrajectoryInspectionReportOptions {
	timelineItems: ComposerRunTimelineItem[];
	trajectory: AgentTrajectoryReport;
	replay: AgentTrajectoryReplayReport;
	score: AgentTrajectoryScoreReport;
}

function redactedEvidence(
	evidence: EvidenceAnchor[],
): AgentTrajectoryInspectionEvidenceAnchor[] {
	return evidence
		.map((anchor) => ({
			...anchor,
			redacted: true as const,
			label: `${anchor.kind}:${anchor.id}`,
		}))
		.sort((left, right) => {
			const kindDelta = left.kind.localeCompare(right.kind);
			return kindDelta === 0 ? left.id.localeCompare(right.id) : kindDelta;
		});
}

function timelineItemIdsForEvidence(evidence: EvidenceAnchor[]): string[] {
	return evidence
		.filter((anchor) => anchor.kind === "timeline_item")
		.map((anchor) => anchor.id)
		.sort();
}

function timelineItemIdsForEvents(
	eventIds: string[],
	eventsById: Map<string, AgentTrajectoryInspectionEvent>,
): string[] {
	const ids = new Set<string>();
	for (const eventId of eventIds) {
		const event = eventsById.get(eventId);
		for (const timelineItemId of event?.timelineItemIds ?? []) {
			ids.add(timelineItemId);
		}
	}
	return [...ids].sort();
}

function metadataKeys(item: ComposerRunTimelineItem): string[] {
	const metadata = item.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return [];
	}
	return Object.keys(metadata).sort();
}

function inspectTimelineItem(
	item: ComposerRunTimelineItem,
): AgentTrajectoryInspectionTimelineItem {
	return {
		id: item.id,
		timestamp: item.timestamp,
		type: item.type,
		status: item.status,
		visibility: item.visibility,
		source: item.source,
		title: item.title,
		...(item.summary ? { summary: item.summary } : {}),
		...(item.role ? { role: item.role } : {}),
		...(item.toolName ? { toolName: item.toolName } : {}),
		...(item.pendingRequestKind
			? { pendingRequestKind: item.pendingRequestKind }
			: {}),
		...(item.platformOperation
			? { platformOperation: item.platformOperation }
			: {}),
		metadataKeys: metadataKeys(item),
		redacted: true,
	};
}

function inspectEvent(
	event: AgentTrajectoryEvent,
): AgentTrajectoryInspectionEvent {
	return {
		id: event.id,
		sequence: event.sequence,
		timestamp: event.timestamp,
		kind: event.kind,
		phase: event.phase,
		actor: event.actor,
		type: event.type,
		status: event.status,
		visibility: event.visibility,
		source: event.source,
		title: event.title,
		...(event.summary ? { summary: event.summary } : {}),
		...(event.toolName ? { toolName: event.toolName } : {}),
		relatedIds: event.relatedIds ?? [],
		timelineItemIds: timelineItemIdsForEvidence(event.evidence),
		evidence: redactedEvidence(event.evidence),
	};
}

function finalAnswerFromEvents(
	events: AgentTrajectoryInspectionEvent[],
): AgentTrajectoryInspectionFinalAnswer | undefined {
	const reversedEvents = [...events].reverse();
	const event =
		reversedEvents.find(
			(candidate) =>
				candidate.actor === "assistant" &&
				candidate.type === "message.assistant",
		) ??
		reversedEvents.find(
			(candidate) =>
				candidate.phase === "finish" || candidate.phase === "recover",
		);
	if (!event) return undefined;
	return {
		eventId: event.id,
		timelineItemIds: event.timelineItemIds,
		title: event.title,
		...(event.summary ? { summary: event.summary } : {}),
		redacted: true,
	};
}

export function buildAgentTrajectoryInspectionReport({
	timelineItems,
	trajectory,
	replay,
	score,
}: BuildAgentTrajectoryInspectionReportOptions): AgentTrajectoryInspectionReport {
	const events = trajectory.events.map(inspectEvent);
	const finalAnswer = finalAnswerFromEvents(events);
	const eventsById = new Map(events.map((event) => [event.id, event]));
	const replayDeltas = replay.deltas.map((delta) => ({
		id: delta.id,
		severity: delta.severity,
		ruleId: delta.ruleId,
		message: delta.message,
		...(delta.eventId ? { eventId: delta.eventId } : {}),
		timelineItemIds: delta.eventId
			? timelineItemIdsForEvents([delta.eventId], eventsById)
			: timelineItemIdsForEvidence(delta.evidence),
		evidence: redactedEvidence(delta.evidence),
	}));
	const scoreFindings = score.findings.map((finding) => ({
		ruleId: finding.ruleId,
		status: finding.status,
		severity: finding.severity,
		message: finding.message,
		eventIds: finding.eventIds,
		timelineItemIds: timelineItemIdsForEvents(finding.eventIds, eventsById),
		evidence: redactedEvidence(finding.evidence),
		remediation: finding.remediation,
	}));
	const jumpTargets = new Set<string>();
	for (const event of events) {
		for (const timelineItemId of event.timelineItemIds) {
			jumpTargets.add(`${event.id}->${timelineItemId}`);
		}
	}
	for (const delta of replayDeltas) {
		for (const timelineItemId of delta.timelineItemIds) {
			jumpTargets.add(`${delta.id}->${timelineItemId}`);
		}
	}
	for (const finding of scoreFindings) {
		for (const timelineItemId of finding.timelineItemIds) {
			jumpTargets.add(`${finding.ruleId}->${timelineItemId}`);
		}
	}

	return {
		schemaVersion: AGENT_TRAJECTORY_INSPECTION_SCHEMA,
		trajectorySchemaVersion: trajectory.schemaVersion,
		replaySchemaVersion: replay.schemaVersion,
		scoreSchemaVersion: score.schemaVersion,
		run: trajectory.run,
		redaction: {
			default: "redacted",
			omitted: [
				"raw prompts",
				"raw tool arguments",
				"raw tool outputs",
				"full file diffs",
				"timeline metadata values",
				"secrets",
			],
		},
		counts: {
			timelineItems: timelineItems.length,
			events: events.length,
			replayDeltas: replayDeltas.length,
			scoreFindings: scoreFindings.length,
			scoreFailures: score.counts.failed,
			scoreWarnings: score.counts.warnings,
			jumpTargets: jumpTargets.size,
		},
		...(finalAnswer ? { finalAnswer } : {}),
		timelineItems: timelineItems.map(inspectTimelineItem),
		events,
		replayDeltas,
		scoreFindings,
	};
}
