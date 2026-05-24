import type {
	A2ACompletionAudit,
	A2ACompletionAuditLane,
} from "./a2a-completion-audit.js";

export const A2A_TELEMETRY_INSPECTION_SCHEMA =
	"evalops.maestro.a2a-telemetry-inspection.v1";

export interface A2ATelemetryCloudEventLike {
	type: string;
	time?: string;
	data?: Record<string, unknown>;
}

export interface A2ATelemetryInspectionLane {
	laneId: string;
	parentTaskId?: string;
	a2aTaskId?: string;
	a2aMessageId?: string;
	contextId?: string;
	peer?: string;
	peerAgentId?: string;
	source?: string;
	status?: string;
	eventTypes: string[];
	missingEventTypes: string[];
	missingEvidence: string[];
}

export interface A2ATelemetryInspection {
	schema: typeof A2A_TELEMETRY_INSPECTION_SCHEMA;
	swarmId: string;
	complete: boolean;
	counts: {
		events: number;
		lanes: number;
		selectedPeers: number;
		completedLanes: number;
		failedLanes: number;
		missingTelemetryLanes: number;
	};
	lanes: A2ATelemetryInspectionLane[];
}

export interface InspectA2ATelemetryInput {
	swarmId: string;
	events: A2ATelemetryCloudEventLike[];
	audit?: A2ACompletionAudit;
}

const PEER_SELECTED = "maestro.events.a2a.peer.selected";
const TASK_DISPATCHED = "maestro.events.a2a.task.dispatched";
const TASK_COMPLETED = "maestro.events.a2a.task.completed";
const TASK_FAILED = "maestro.events.a2a.task.failed";
const TASK_CANCELLED = "maestro.events.a2a.task.cancelled";

export function inspectA2ATelemetry(
	input: InspectA2ATelemetryInput,
): A2ATelemetryInspection {
	const events = input.events.filter(
		(event) => stringValue(event.data?.swarm_id) === input.swarmId,
	);
	const auditLanes = new Map(
		(input.audit?.lanes ?? []).map((lane) => [lane.laneId, lane]),
	);
	const laneEvents = new Map<string, A2ATelemetryCloudEventLike[]>();
	for (const event of events) {
		const laneId = stringValue(event.data?.lane_id);
		if (!laneId) {
			continue;
		}
		const list = laneEvents.get(laneId) ?? [];
		list.push(event);
		laneEvents.set(laneId, list);
	}
	for (const laneId of auditLanes.keys()) {
		if (!laneEvents.has(laneId)) {
			laneEvents.set(laneId, []);
		}
	}
	const lanes = [...laneEvents.entries()].map(([laneId, laneEventList]) =>
		inspectLane(laneId, laneEventList, auditLanes.get(laneId)),
	);
	const selectedPeers = new Set(
		lanes
			.map((lane) => lane.peerAgentId ?? lane.peer)
			.filter((value): value is string => Boolean(value)),
	);
	const missingTelemetryLanes = lanes.filter(
		(lane) => lane.missingEventTypes.length > 0,
	).length;
	const failedLanes = lanes.filter((lane) => isFailedLane(lane)).length;
	const completedLanes = lanes.filter((lane) => isCompletedLane(lane)).length;
	return {
		schema: A2A_TELEMETRY_INSPECTION_SCHEMA,
		swarmId: input.swarmId,
		complete:
			lanes.length > 0 &&
			missingTelemetryLanes === 0 &&
			lanes.every((lane) => lane.missingEvidence.length === 0) &&
			input.audit?.complete !== false,
		counts: {
			events: events.length,
			lanes: lanes.length,
			selectedPeers: selectedPeers.size,
			completedLanes,
			failedLanes,
			missingTelemetryLanes,
		},
		lanes,
	};
}

function inspectLane(
	laneId: string,
	events: A2ATelemetryCloudEventLike[],
	auditLane: A2ACompletionAuditLane | undefined,
): A2ATelemetryInspectionLane {
	const merged = mergeLaneEventData(events);
	const eventTypes = unique(events.map((event) => event.type));
	return {
		laneId,
		parentTaskId: stringValue(merged.parent_task_id) ?? auditLane?.parentTaskId,
		a2aTaskId: stringValue(merged.a2a_task_id) ?? auditLane?.a2aTaskId,
		a2aMessageId: stringValue(merged.a2a_message_id) ?? auditLane?.a2aMessageId,
		contextId: stringValue(merged.context_id) ?? auditLane?.contextId,
		peer: stringValue(merged.peer_name) ?? auditLane?.peer,
		peerAgentId: stringValue(merged.peer_agent_id),
		source: stringValue(merged.source),
		status: stringValue(merged.status) ?? auditLane?.status,
		eventTypes,
		missingEventTypes: missingEventTypes(events, eventTypes),
		missingEvidence: auditLane?.missingEvidence ?? [],
	};
}

function mergeLaneEventData(
	events: A2ATelemetryCloudEventLike[],
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const event of events) {
		Object.assign(merged, event.data);
	}
	return merged;
}

function missingEventTypes(
	events: A2ATelemetryCloudEventLike[],
	eventTypes: string[],
): string[] {
	const missing: string[] = [];
	if (!eventTypes.includes(PEER_SELECTED)) {
		missing.push(PEER_SELECTED);
	}
	if (
		!eventTypes.includes(TASK_DISPATCHED) &&
		!isPreDispatchTerminalFailure(events, eventTypes)
	) {
		missing.push(TASK_DISPATCHED);
	}
	if (!eventTypes.some((type) => isTerminalEventType(type))) {
		missing.push(TASK_COMPLETED);
	}
	return missing;
}

function isPreDispatchTerminalFailure(
	events: A2ATelemetryCloudEventLike[],
	eventTypes: string[],
): boolean {
	return (
		!eventTypes.includes(TASK_DISPATCHED) &&
		(eventTypes.includes(TASK_FAILED) || eventTypes.includes(TASK_CANCELLED)) &&
		events.every((event) => !stringValue(event.data?.a2a_task_id))
	);
}

function isTerminalEventType(type: string): boolean {
	return (
		type === TASK_COMPLETED || type === TASK_FAILED || type === TASK_CANCELLED
	);
}

function isCompletedLane(lane: A2ATelemetryInspectionLane): boolean {
	return (
		lane.eventTypes.includes(TASK_COMPLETED) ||
		(lane.status ?? "").toUpperCase().includes("COMPLETED")
	);
}

function isFailedLane(lane: A2ATelemetryInspectionLane): boolean {
	const status = (lane.status ?? "").toUpperCase();
	return (
		lane.eventTypes.includes(TASK_FAILED) ||
		lane.eventTypes.includes(TASK_CANCELLED) ||
		status.includes("FAILED") ||
		status.includes("CANCEL") ||
		status.includes("REJECTED")
	);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}
