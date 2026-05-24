import type { SwarmState, SwarmTeammate } from "../agent/swarm/types.js";
import type {
	A2ATaskLedgerEntry,
	A2ATaskLedgerFile,
} from "./a2a-task-ledger.js";
import { isTerminalA2AState } from "./a2a-task-ledger.js";

export const A2A_COMPLETION_AUDIT_SCHEMA =
	"evalops.maestro.a2a-completion-audit.v1";

export type A2ACompletionEvidenceKey =
	| "status"
	| "artifact"
	| "task"
	| "workGraph"
	| "push"
	| "correlation";

export interface A2ACompletionAuditLane {
	laneId: string;
	parentTaskId?: string;
	a2aTaskId: string;
	a2aMessageId?: string;
	contextId?: string;
	peer: string;
	status?: string;
	terminal: boolean;
	evidence: Record<A2ACompletionEvidenceKey, boolean>;
	missingEvidence: A2ACompletionEvidenceKey[];
}

export interface A2ACompletionAudit {
	schema: typeof A2A_COMPLETION_AUDIT_SCHEMA;
	swarmId: string;
	generatedAt: string;
	complete: boolean;
	counts: {
		remoteLanes: number;
		completeLanes: number;
		incompleteLanes: number;
		pushCoveredLanes: number;
		workGraphCoveredLanes: number;
	};
	lanes: A2ACompletionAuditLane[];
}

export interface BuildA2ACompletionAuditInput {
	swarm: SwarmState;
	ledger: A2ATaskLedgerFile;
	pushEvidenceKeys?: ReadonlySet<string>;
	pushTaskIds?: ReadonlySet<string>;
	generatedAt?: string;
}

const EVIDENCE_ORDER: A2ACompletionEvidenceKey[] = [
	"status",
	"artifact",
	"task",
	"workGraph",
	"push",
	"correlation",
];

type A2AAuditA2A = NonNullable<SwarmTeammate["a2a"]>;

interface A2AAuditLaneSource {
	laneId: string;
	parentTaskId?: string;
	completedTasks: string[];
	a2a: A2AAuditA2A;
	ledgerEntry?: A2ATaskLedgerEntry;
}

export function buildA2ACompletionAudit(
	input: BuildA2ACompletionAuditInput,
): A2ACompletionAudit {
	const remoteLanes = buildRemoteLaneSources(input);
	const remoteTaskIdCounts = countRemoteTaskIds(remoteLanes);
	const lanes = remoteLanes.map((lane) =>
		buildLaneAudit(input, lane, remoteTaskIdCounts),
	);
	const completeLanes = lanes.filter(
		(lane) => lane.terminal && lane.missingEvidence.length === 0,
	).length;
	const pushCoveredLanes = lanes.filter((lane) => lane.evidence.push).length;
	const workGraphCoveredLanes = lanes.filter(
		(lane) => lane.evidence.workGraph,
	).length;
	return {
		schema: A2A_COMPLETION_AUDIT_SCHEMA,
		swarmId: input.swarm.id,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		complete: lanes.length === completeLanes,
		counts: {
			remoteLanes: lanes.length,
			completeLanes,
			incompleteLanes: lanes.length - completeLanes,
			pushCoveredLanes,
			workGraphCoveredLanes,
		},
		lanes,
	};
}

export function a2aPushEvidenceKey(peer: string, taskId: string): string {
	return `${peer}\u0000${taskId}`;
}

export function a2aDelegationLaneId(
	peer: string,
	parentTaskId: string,
): string {
	return `a2a:${encodeURIComponent(peer)}:${encodeURIComponent(parentTaskId)}`;
}

function buildRemoteLaneSources(
	input: BuildA2ACompletionAuditInput,
): A2AAuditLaneSource[] {
	const teammateLanes = input.swarm.teammates
		.filter(hasA2ATask)
		.map((teammate) => {
			const ledgerEntry = findLedgerEntry(input.ledger, teammate.a2a);
			const parentTaskId = parentTaskIdForLane(
				teammate.completedTasks,
				ledgerEntry,
				teammate.a2a,
			);
			return {
				laneId: parentTaskId
					? a2aDelegationLaneId(teammate.a2a.peer, parentTaskId)
					: teammate.id,
				parentTaskId,
				completedTasks: teammate.completedTasks,
				a2a: teammate.a2a,
				ledgerEntry,
			};
		});
	const seen = new Set(teammateLanes.map((lane) => laneKey(lane.a2a)));
	const ledgerOnlyLanes = input.ledger.tasks
		.filter((entry) => entry.kind === "delegation")
		.filter((entry) => stringMetadata(entry, "swarmId") === input.swarm.id)
		.filter((entry) => !seen.has(a2aPushEvidenceKey(entry.peer, entry.taskId)))
		.map((entry) => {
			const parentTaskId = parentTaskIdForLedger(entry);
			return {
				laneId: parentTaskId
					? a2aDelegationLaneId(entry.peer, parentTaskId)
					: fallbackRemoteLaneId(entry.peer, entry.taskId),
				parentTaskId,
				completedTasks: [],
				a2a: {
					peer: entry.peer,
					peerDisplayName: entry.peerDisplayName,
					source: "registry" as const,
					taskId: entry.taskId,
					contextId: entry.contextId,
					messageId: entry.messageId ?? "",
					role: entry.role,
				},
				ledgerEntry: entry,
			};
		});
	return [...teammateLanes, ...ledgerOnlyLanes];
}

function hasA2ATask(
	teammate: SwarmTeammate,
): teammate is SwarmTeammate & { a2a: A2AAuditA2A } {
	return Boolean(teammate.a2a?.taskId);
}

function laneKey(a2a: A2AAuditA2A): string {
	return a2aPushEvidenceKey(a2a.peer, a2a.taskId);
}

function findLedgerEntry(
	ledger: A2ATaskLedgerFile,
	a2a: A2AAuditA2A,
): A2ATaskLedgerEntry | undefined {
	return ledger.tasks.find(
		(entry) => entry.taskId === a2a.taskId && entry.peer === a2a.peer,
	);
}

function buildLaneAudit(
	input: BuildA2ACompletionAuditInput,
	lane: A2AAuditLaneSource,
	remoteTaskIdCounts: ReadonlyMap<string, number>,
): A2ACompletionAuditLane {
	const { a2a, ledgerEntry } = lane;
	const parentTaskId =
		lane.parentTaskId ??
		parentTaskIdForLane(lane.completedTasks, ledgerEntry, a2a);
	const status = ledgerEntry?.state;
	const evidence: Record<A2ACompletionEvidenceKey, boolean> = {
		status: Boolean(status),
		artifact: hasArtifactEvidence(ledgerEntry),
		task: Boolean(ledgerEntry),
		workGraph: Boolean(ledgerEntry?.workGraph),
		push: hasPushEvidence(input, a2a, remoteTaskIdCounts),
		correlation: hasCorrelationEvidence(
			input.swarm.id,
			parentTaskId,
			a2a,
			ledgerEntry,
		),
	};
	const missingEvidence = EVIDENCE_ORDER.filter((key) => !evidence[key]);
	return {
		laneId: lane.laneId,
		parentTaskId,
		a2aTaskId: a2a.taskId,
		a2aMessageId: a2a.messageId,
		contextId: a2a.contextId ?? ledgerEntry?.contextId,
		peer: a2a.peer,
		status,
		terminal: Boolean(status && isTerminalA2AState(status)),
		evidence,
		missingEvidence,
	};
}

function countRemoteTaskIds(lanes: A2AAuditLaneSource[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const lane of lanes) {
		const taskId = lane.a2a.taskId;
		counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
	}
	return counts;
}

function hasPushEvidence(
	input: BuildA2ACompletionAuditInput,
	a2a: NonNullable<SwarmTeammate["a2a"]>,
	remoteTaskIdCounts: ReadonlyMap<string, number>,
): boolean {
	const exactKey = a2aPushEvidenceKey(a2a.peer, a2a.taskId);
	if (input.pushEvidenceKeys?.has(exactKey)) {
		return true;
	}
	if ((remoteTaskIdCounts.get(a2a.taskId) ?? 0) > 1) {
		return false;
	}
	return input.pushTaskIds?.has(a2a.taskId) ?? false;
}

function parentTaskIdForLedger(
	ledgerEntry: A2ATaskLedgerEntry | undefined,
): string | undefined {
	return (
		stringMetadata(ledgerEntry, "taskId") ??
		stringMetadata(ledgerEntry, "task_id")
	);
}

function parentTaskIdForLane(
	completedTasks: string[],
	ledgerEntry: A2ATaskLedgerEntry | undefined,
	a2a?: A2AAuditA2A,
): string | undefined {
	const ledgerParentTaskId = parentTaskIdForLedger(ledgerEntry);
	const a2aParentTaskId = a2a?.parentTaskId;
	if (ledgerEntry?.state && !isCompletedA2AState(ledgerEntry.state)) {
		return ledgerParentTaskId ?? a2aParentTaskId ?? lastValue(completedTasks);
	}
	return lastValue(completedTasks) ?? ledgerParentTaskId ?? a2aParentTaskId;
}

function isCompletedA2AState(state: string): boolean {
	return /COMPLETED/u.test(state.toUpperCase().replace(/[\s-]+/gu, "_"));
}

function lastValue(values: string[]): string | undefined {
	return values.length > 0 ? values[values.length - 1] : undefined;
}

function fallbackRemoteLaneId(peer: string, taskId: string): string {
	return `a2a:${encodeURIComponent(peer)}:remote:${encodeURIComponent(taskId)}`;
}

function hasArtifactEvidence(entry: A2ATaskLedgerEntry | undefined): boolean {
	return Boolean(
		entry?.responseText?.trim() ||
			entry?.transcript.some(
				(item) => item.role === "agent" && item.text.trim().length > 0,
			),
	);
}

function hasCorrelationEvidence(
	swarmId: string,
	parentTaskId: string | undefined,
	a2a: NonNullable<SwarmTeammate["a2a"]>,
	entry: A2ATaskLedgerEntry | undefined,
): boolean {
	if (!entry) {
		return false;
	}
	const ledgerParentTaskId =
		stringMetadata(entry, "taskId") ?? stringMetadata(entry, "task_id");
	return Boolean(
		a2a.messageId &&
			entry.messageId === a2a.messageId &&
			(a2a.contextId ? entry.contextId === a2a.contextId : entry.contextId) &&
			stringMetadata(entry, "swarmId") === swarmId &&
			parentTaskId &&
			ledgerParentTaskId === parentTaskId,
	);
}

function stringMetadata(
	entry: A2ATaskLedgerEntry | undefined,
	key: string,
): string | undefined {
	const value = entry?.metadata?.[key];
	return typeof value === "string" ? value : undefined;
}
