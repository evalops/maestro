import type {
	ComposerRunTimelineItem,
	ComposerRunTimelineResponse,
	ComposerRunTimelineStatus,
	ComposerRunTimelineVisibility,
} from "@evalops/contracts";
import type { AgentTrajectoryReplayReport } from "./agent-trajectory-replay.js";
import type {
	AgentTrajectoryEvent,
	AgentTrajectoryReport,
} from "./agent-trajectory.js";

export const AGENT_RUNTIME_LEDGER_SCHEMA =
	"evalops.maestro.agent-runtime-ledger.v1";
export const AGENT_RUNTIME_REPLAY_SUMMARY_SCHEMA =
	"evalops.maestro.agent-runtime-replay-summary.v1";
export const AGENT_RUNTIME_PROMOTION_PLAN_SCHEMA =
	"evalops.maestro.agent-runtime-promotion-plan.v1";

export type AgentRuntimeLedgerEntryKind =
	| "run"
	| "message"
	| "model_call"
	| "tool_call"
	| "tool_result"
	| "wait"
	| "checkpoint"
	| "artifact"
	| "evidence"
	| "governance"
	| "context"
	| "child_run"
	| "runtime";

export type AgentRuntimeLedgerState =
	| "pending"
	| "running"
	| "waiting"
	| "blocked"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "skipped";

export interface AgentRuntimeLedgerEntry {
	id: string;
	sequence: number;
	timestamp: string;
	kind: AgentRuntimeLedgerEntryKind;
	phase: AgentTrajectoryEvent["phase"];
	actor: AgentTrajectoryEvent["actor"];
	type: string;
	state: AgentRuntimeLedgerState;
	title: string;
	visibility: ComposerRunTimelineVisibility;
	source: ComposerRunTimelineItem["source"];
	timelineItemId?: string;
	trajectoryEventId: string;
	toolName?: string;
	summary?: string;
	relatedIds: string[];
	evidence: AgentTrajectoryEvent["evidence"];
	platformShape: {
		stepKind: string;
		workItemKind: string;
		waitType?: string;
	};
}

export interface AgentRuntimeLedgerReport {
	schemaVersion: typeof AGENT_RUNTIME_LEDGER_SCHEMA;
	run: {
		id: string;
		sessionId: string;
		source: ComposerRunTimelineResponse["source"];
		generatedAt: string;
		platformBacked: boolean;
		sessionFile?: string;
		cwd?: string;
		model?: string;
	};
	counts: {
		entries: number;
		promotionOperations: number;
		byKind: Record<string, number>;
		byState: Record<string, number>;
	};
	entries: AgentRuntimeLedgerEntry[];
	replay: AgentRuntimeLedgerReplaySummary;
	promotion: AgentRuntimePromotionPlan;
}

export interface AgentRuntimeLedgerReplaySummary {
	schemaVersion: typeof AGENT_RUNTIME_REPLAY_SUMMARY_SCHEMA;
	deterministic: boolean;
	events: number;
	deltas: number;
	errors: number;
	warnings: number;
	cursor: {
		startSequence?: number;
		endSequence?: number;
	};
}

export interface AgentRuntimePromotionPlan {
	schemaVersion: typeof AGENT_RUNTIME_PROMOTION_PLAN_SCHEMA;
	runId: string;
	sessionId: string;
	idempotencyKey: string;
	operations: AgentRuntimePromotionOperation[];
	warnings: string[];
}

export type AgentRuntimePromotionOperation =
	| {
			operation: "handle_trigger";
			id: string;
			payload: {
				sourceEventType: "maestro.local_ledger_promote";
				sourceEventId: string;
				idempotencyKey: string;
				sessionId: string;
				generatedAt: string;
			};
	  }
	| {
			operation: "record_run_step";
			id: string;
			ledgerEntryId: string;
			payload: {
				stepId: string;
				kind: string;
				state: AgentRuntimeLedgerState;
				title: string;
				timestamp: string;
				toolName?: string;
			};
	  }
	| {
			operation: "record_run_work_item";
			id: string;
			ledgerEntryId: string;
			payload: {
				workItemId: string;
				kind: string;
				state: AgentRuntimeLedgerState;
				title: string;
				timestamp: string;
			};
	  }
	| {
			operation: "wait_run";
			id: string;
			ledgerEntryId: string;
			payload: {
				waitId: string;
				waitType: string;
				title: string;
				timestamp: string;
			};
	  }
	| {
			operation: "complete_run" | "fail_run";
			id: string;
			payload: {
				state: "succeeded" | "failed";
				timestamp: string;
				reason?: string;
			};
	  };

export interface BuildAgentRuntimeLedgerOptions {
	session: {
		id: string;
		sessionFile?: string;
		cwd?: string;
		model?: string;
	};
	timeline: ComposerRunTimelineResponse;
	trajectory: AgentTrajectoryReport;
	replay: AgentTrajectoryReplayReport;
}

function increment(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

function timelineIdForEvent(event: AgentTrajectoryEvent): string | undefined {
	return event.evidence.find((anchor) => anchor.kind === "timeline_item")?.id;
}

function stateForStatus(
	status: ComposerRunTimelineStatus,
): AgentRuntimeLedgerState {
	switch (status) {
		case "completed":
		case "info":
		case "approved":
			return "succeeded";
		case "running":
			return "running";
		case "pending":
			return "waiting";
		case "denied":
			return "blocked";
		case "failed":
			return "failed";
		default:
			return "pending";
	}
}

function kindForEvent(
	event: AgentTrajectoryEvent,
): AgentRuntimeLedgerEntryKind {
	switch (event.kind) {
		case "session":
			return "run";
		case "message":
			return event.actor === "assistant" ? "model_call" : "message";
		case "tool":
			return event.type === "tool.completed" || event.type === "tool.failed"
				? "tool_result"
				: "tool_call";
		case "wait":
			return "wait";
		case "artifact":
			return "artifact";
		case "evidence":
			return "evidence";
		case "governance":
			return "governance";
		case "context":
			return event.type.startsWith("compaction.") ? "checkpoint" : "context";
		case "agent":
			return "child_run";
		case "runtime":
			return "runtime";
		default:
			return "runtime";
	}
}

function stepKindForEntry(
	entryKind: AgentRuntimeLedgerEntryKind,
	event: AgentTrajectoryEvent,
): string {
	if (entryKind === "model_call") return "AGENT_RUN_STEP_KIND_MODEL_CALL";
	if (entryKind === "tool_call") return "AGENT_RUN_STEP_KIND_TOOL_CALL_INTENT";
	if (entryKind === "tool_result") return "AGENT_RUN_STEP_KIND_TOOL_RESULT";
	if (entryKind === "wait" || entryKind === "governance") {
		return "AGENT_RUN_STEP_KIND_APPROVAL_WAIT";
	}
	if (event.status === "failed") return "AGENT_RUN_STEP_KIND_ERROR";
	return "AGENT_RUN_STEP_KIND_SYSTEM";
}

function workItemKindForEntry(kind: AgentRuntimeLedgerEntryKind): string {
	switch (kind) {
		case "message":
			return "AGENT_WORK_ITEM_KIND_USER_INPUT";
		case "model_call":
			return "AGENT_WORK_ITEM_KIND_MODEL_CALL";
		case "tool_call":
		case "tool_result":
			return "AGENT_WORK_ITEM_KIND_TOOL_CALL";
		case "child_run":
			return "AGENT_WORK_ITEM_KIND_CHILD_RUN";
		case "wait":
		case "governance":
			return "AGENT_WORK_ITEM_KIND_WAIT";
		case "checkpoint":
			return "AGENT_WORK_ITEM_KIND_RECOVERY";
		case "artifact":
		case "evidence":
			return "AGENT_WORK_ITEM_KIND_MEMORY";
		default:
			return "AGENT_WORK_ITEM_KIND_ROOT";
	}
}

function waitTypeForEntry(
	kind: AgentRuntimeLedgerEntryKind,
): string | undefined {
	if (kind === "wait" || kind === "governance") {
		return "AGENT_RUN_WAIT_TYPE_APPROVAL";
	}
	return undefined;
}

function buildLedgerEntries(
	trajectory: AgentTrajectoryReport,
): AgentRuntimeLedgerEntry[] {
	return trajectory.events.map((event) => {
		const kind = kindForEvent(event);
		const state = stateForStatus(event.status);
		return {
			id: `ledger:${event.id}`,
			sequence: event.sequence,
			timestamp: event.timestamp,
			kind,
			phase: event.phase,
			actor: event.actor,
			type: event.type,
			state,
			title: event.title,
			visibility: event.visibility,
			source: event.source,
			trajectoryEventId: event.id,
			...(timelineIdForEvent(event)
				? { timelineItemId: timelineIdForEvent(event) }
				: {}),
			...(event.toolName ? { toolName: event.toolName } : {}),
			...(event.summary ? { summary: event.summary } : {}),
			relatedIds: event.relatedIds ?? [],
			evidence: event.evidence,
			platformShape: {
				stepKind: stepKindForEntry(kind, event),
				workItemKind: workItemKindForEntry(kind),
				...(waitTypeForEntry(kind) ? { waitType: waitTypeForEntry(kind) } : {}),
			},
		};
	});
}

function replaySummary(
	replay: AgentTrajectoryReplayReport,
	entries: AgentRuntimeLedgerEntry[],
): AgentRuntimeLedgerReplaySummary {
	return {
		schemaVersion: AGENT_RUNTIME_REPLAY_SUMMARY_SCHEMA,
		deterministic: replay.counts.deltas === 0 && replay.counts.errors === 0,
		events: replay.counts.events,
		deltas: replay.counts.deltas,
		errors: replay.counts.errors,
		warnings: replay.counts.warnings,
		cursor: {
			...(entries[0] ? { startSequence: entries[0].sequence } : {}),
			...(entries.at(-1) ? { endSequence: entries.at(-1)?.sequence } : {}),
		},
	};
}

function terminalOperation(
	runId: string,
	entries: AgentRuntimeLedgerEntry[],
): AgentRuntimePromotionOperation {
	const last = entries.at(-1);
	const succeeded = last?.state === "succeeded" || last?.state === "skipped";
	return {
		operation: succeeded ? "complete_run" : "fail_run",
		id: `promote:${runId}:terminal`,
		payload: {
			state: succeeded ? "succeeded" : "failed",
			timestamp: last?.timestamp ?? new Date(0).toISOString(),
			...(succeeded
				? {}
				: {
						reason: `Final ledger entry ended in ${last?.state ?? "unknown"} state.`,
					}),
		},
	};
}

function buildPromotionPlan(
	runId: string,
	sessionId: string,
	generatedAt: string,
	entries: AgentRuntimeLedgerEntry[],
): AgentRuntimePromotionPlan {
	const idempotencyKey = `maestro-local-ledger:${sessionId}:${runId}`;
	const operations: AgentRuntimePromotionOperation[] = [
		{
			operation: "handle_trigger",
			id: `promote:${runId}:trigger`,
			payload: {
				sourceEventType: "maestro.local_ledger_promote",
				sourceEventId: sessionId,
				idempotencyKey,
				sessionId,
				generatedAt,
			},
		},
	];

	for (const entry of entries) {
		operations.push({
			operation: "record_run_step",
			id: `promote:${entry.id}:step`,
			ledgerEntryId: entry.id,
			payload: {
				stepId: entry.id,
				kind: entry.platformShape.stepKind,
				state: entry.state,
				title: entry.title,
				timestamp: entry.timestamp,
				...(entry.toolName ? { toolName: entry.toolName } : {}),
			},
		});
		operations.push({
			operation: "record_run_work_item",
			id: `promote:${entry.id}:work-item`,
			ledgerEntryId: entry.id,
			payload: {
				workItemId: entry.id,
				kind: entry.platformShape.workItemKind,
				state: entry.state,
				title: entry.title,
				timestamp: entry.timestamp,
			},
		});
		if (entry.platformShape.waitType) {
			operations.push({
				operation: "wait_run",
				id: `promote:${entry.id}:wait`,
				ledgerEntryId: entry.id,
				payload: {
					waitId: entry.id,
					waitType: entry.platformShape.waitType,
					title: entry.title,
					timestamp: entry.timestamp,
				},
			});
		}
	}

	operations.push(terminalOperation(runId, entries));

	return {
		schemaVersion: AGENT_RUNTIME_PROMOTION_PLAN_SCHEMA,
		runId,
		sessionId,
		idempotencyKey,
		operations,
		warnings: [
			"Promotion plan is dry-run only; no Platform AgentRuntime writes were performed.",
		],
	};
}

export function buildAgentRuntimeLedgerReport(
	options: BuildAgentRuntimeLedgerOptions,
): AgentRuntimeLedgerReport {
	const entries = buildLedgerEntries(options.trajectory);
	const byKind: Record<string, number> = {};
	const byState: Record<string, number> = {};
	for (const entry of entries) {
		increment(byKind, entry.kind);
		increment(byState, entry.state);
	}
	const runId = options.trajectory.run.id;
	const sessionId = options.trajectory.run.sessionId;
	const promotion = buildPromotionPlan(
		runId,
		sessionId,
		options.trajectory.run.generatedAt,
		entries,
	);

	return {
		schemaVersion: AGENT_RUNTIME_LEDGER_SCHEMA,
		run: {
			id: runId,
			sessionId,
			source: options.timeline.source,
			generatedAt: options.trajectory.run.generatedAt,
			platformBacked: options.trajectory.run.platformBacked,
			...(options.session.sessionFile
				? { sessionFile: options.session.sessionFile }
				: {}),
			...(options.session.cwd ? { cwd: options.session.cwd } : {}),
			...(options.session.model ? { model: options.session.model } : {}),
		},
		counts: {
			entries: entries.length,
			promotionOperations: promotion.operations.length,
			byKind,
			byState,
		},
		entries,
		replay: replaySummary(options.replay, entries),
		promotion,
	};
}
