import { validateAgentTrajectoryReport } from "./agent-trajectory-validation.js";
import type {
	AgentTrajectoryEvent,
	AgentTrajectoryEventKind,
	AgentTrajectoryPhase,
	AgentTrajectoryReport,
} from "./agent-trajectory.js";

export const AGENT_TRAJECTORY_REPLAY_SCHEMA =
	"evalops.maestro.agent-trajectory-replay.v1";

export type AgentTrajectoryReplaySeverity = "error" | "warning";

export interface AgentTrajectoryReplayDelta {
	id: string;
	severity: AgentTrajectoryReplaySeverity;
	ruleId: string;
	sequence?: number;
	eventId?: string;
	phase?: AgentTrajectoryPhase;
	kind?: AgentTrajectoryEventKind;
	expected?: string;
	observed?: string;
	message: string;
	evidence: AgentTrajectoryEvent["evidence"];
}

export interface AgentTrajectoryReplayPhaseSummary {
	phase: AgentTrajectoryPhase;
	events: number;
	firstSequence: number;
	lastSequence: number;
}

export interface AgentTrajectoryReplayToolSummary {
	toolCallId: string;
	toolName?: string;
	requestedSequence?: number;
	resultSequences: number[];
	terminalStatus?: "completed" | "failed";
	evidence: AgentTrajectoryEvent["evidence"];
}

export interface AgentTrajectoryReplayReport {
	schemaVersion: typeof AGENT_TRAJECTORY_REPLAY_SCHEMA;
	trajectorySchemaVersion: AgentTrajectoryReport["schemaVersion"];
	run: AgentTrajectoryReport["run"];
	deterministic: true;
	counts: {
		events: number;
		deltas: number;
		errors: number;
		warnings: number;
		toolCalls: number;
		phases: number;
	};
	phases: AgentTrajectoryReplayPhaseSummary[];
	toolCalls: AgentTrajectoryReplayToolSummary[];
	deltas: AgentTrajectoryReplayDelta[];
}

export interface AgentTrajectoryReplayToolExpectation {
	terminalStatus?: "completed" | "failed";
	requiredArtifactIds?: string[];
}

export interface ReplayAgentTrajectoryOptions {
	expectedTools?: Record<string, AgentTrajectoryReplayToolExpectation>;
}

interface ToolState {
	toolCallId: string;
	toolName?: string;
	requestedSequence?: number;
	resultSequences: number[];
	terminalStatus?: "completed" | "failed";
	evidence: AgentTrajectoryEvent["evidence"];
	artifactIds: Set<string>;
}

function evidenceIds(
	event: AgentTrajectoryEvent,
	kind: AgentTrajectoryEvent["evidence"][number]["kind"],
): string[] {
	return event.evidence
		.filter((anchor) => anchor.kind === kind)
		.map((anchor) => anchor.id)
		.sort();
}

function firstEvidenceId(
	event: AgentTrajectoryEvent,
	kind: AgentTrajectoryEvent["evidence"][number]["kind"],
): string | undefined {
	return evidenceIds(event, kind)[0];
}

function mergeEvidence(
	target: AgentTrajectoryEvent["evidence"],
	source: AgentTrajectoryEvent["evidence"],
): AgentTrajectoryEvent["evidence"] {
	const seen = new Set(target.map((anchor) => `${anchor.kind}:${anchor.id}`));
	for (const anchor of source) {
		const key = `${anchor.kind}:${anchor.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		target.push(anchor);
	}
	return target.sort((a, b) => {
		const kindDelta = a.kind.localeCompare(b.kind);
		return kindDelta === 0 ? a.id.localeCompare(b.id) : kindDelta;
	});
}

function delta(
	deltas: AgentTrajectoryReplayDelta[],
	params: Omit<AgentTrajectoryReplayDelta, "id">,
): void {
	deltas.push({
		id: `delta:${String(deltas.length + 1).padStart(3, "0")}`,
		...params,
	});
}

function ensureToolState(
	tools: Map<string, ToolState>,
	toolCallId: string,
	event: AgentTrajectoryEvent,
): ToolState {
	let state = tools.get(toolCallId);
	if (!state) {
		state = {
			toolCallId,
			toolName: event.toolName,
			resultSequences: [],
			evidence: [],
			artifactIds: new Set<string>(),
		};
		tools.set(toolCallId, state);
	}
	if (!state.toolName && event.toolName) {
		state.toolName = event.toolName;
	}
	mergeEvidence(state.evidence, event.evidence);
	return state;
}

function summarizePhases(
	events: AgentTrajectoryEvent[],
): AgentTrajectoryReplayPhaseSummary[] {
	const byPhase = new Map<
		AgentTrajectoryPhase,
		AgentTrajectoryReplayPhaseSummary
	>();
	for (const event of events) {
		const existing = byPhase.get(event.phase);
		if (existing) {
			existing.events += 1;
			existing.lastSequence = event.sequence;
			continue;
		}
		byPhase.set(event.phase, {
			phase: event.phase,
			events: 1,
			firstSequence: event.sequence,
			lastSequence: event.sequence,
		});
	}
	return [...byPhase.values()].sort(
		(a, b) => a.firstSequence - b.firstSequence,
	);
}

function summarizeTools(
	tools: Map<string, ToolState>,
): AgentTrajectoryReplayToolSummary[] {
	return [...tools.values()]
		.map((tool) => ({
			toolCallId: tool.toolCallId,
			...(tool.toolName ? { toolName: tool.toolName } : {}),
			...(tool.requestedSequence !== undefined
				? { requestedSequence: tool.requestedSequence }
				: {}),
			resultSequences: [...tool.resultSequences].sort((a, b) => a - b),
			...(tool.terminalStatus ? { terminalStatus: tool.terminalStatus } : {}),
			evidence: [...tool.evidence],
		}))
		.sort((a, b) => {
			const sequenceA = a.requestedSequence ?? Number.MAX_SAFE_INTEGER;
			const sequenceB = b.requestedSequence ?? Number.MAX_SAFE_INTEGER;
			if (sequenceA !== sequenceB) return sequenceA - sequenceB;
			return a.toolCallId.localeCompare(b.toolCallId);
		});
}

export function replayAgentTrajectoryReport(
	report: AgentTrajectoryReport,
	options: ReplayAgentTrajectoryOptions = {},
): AgentTrajectoryReplayReport {
	const deltas: AgentTrajectoryReplayDelta[] = [];
	const validation = validateAgentTrajectoryReport(report);
	for (const failure of validation.failures) {
		delta(deltas, {
			severity: "error",
			ruleId: "trajectory.validation",
			message: failure,
			evidence: [],
		});
	}

	const tools = new Map<string, ToolState>();
	for (const event of report.events) {
		const toolCallIds = evidenceIds(event, "tool_call");
		const artifactIds = evidenceIds(event, "artifact");
		if (event.type === "tool.requested") {
			const toolCallId = firstEvidenceId(event, "tool_call");
			if (!toolCallId) continue;
			const state = ensureToolState(tools, toolCallId, event);
			if (state.requestedSequence !== undefined) {
				delta(deltas, {
					severity: "error",
					ruleId: "tool.duplicate_request",
					sequence: event.sequence,
					eventId: event.id,
					phase: event.phase,
					kind: event.kind,
					expected: "one tool.requested per tool call",
					observed: `previous request at sequence ${state.requestedSequence}`,
					message: `Tool call ${toolCallId} was requested more than once.`,
					evidence: event.evidence,
				});
			}
			state.requestedSequence = event.sequence;
		}

		if (event.type === "tool.completed" || event.type === "tool.failed") {
			const toolCallId = firstEvidenceId(event, "tool_call");
			if (!toolCallId) continue;
			const state = ensureToolState(tools, toolCallId, event);
			const terminalStatus =
				event.type === "tool.completed" ? "completed" : "failed";
			if (
				state.terminalStatus !== undefined &&
				state.terminalStatus !== terminalStatus
			) {
				delta(deltas, {
					severity: "error",
					ruleId: "tool.conflicting_terminal_status",
					sequence: event.sequence,
					eventId: event.id,
					phase: event.phase,
					kind: event.kind,
					expected: state.terminalStatus,
					observed: terminalStatus,
					message: `Tool call ${toolCallId} has conflicting terminal statuses.`,
					evidence: event.evidence,
				});
			}
			state.terminalStatus = terminalStatus;
			state.resultSequences.push(event.sequence);
		}

		for (const toolCallId of toolCallIds) {
			const state = ensureToolState(tools, toolCallId, event);
			for (const artifactId of artifactIds) {
				state.artifactIds.add(artifactId);
			}
		}
	}

	for (const [toolCallId, expectation] of Object.entries(
		options.expectedTools ?? {},
	).sort(([left], [right]) => left.localeCompare(right))) {
		const state = tools.get(toolCallId);
		if (!state) {
			delta(deltas, {
				severity: "error",
				ruleId: "tool.expected_missing",
				expected: toolCallId,
				observed: "missing",
				message: `Expected tool call ${toolCallId} was not present in the trajectory.`,
				evidence: [],
			});
			continue;
		}
		if (
			expectation.terminalStatus &&
			state.terminalStatus !== expectation.terminalStatus
		) {
			delta(deltas, {
				severity: "error",
				ruleId: "tool.terminal_status_mismatch",
				expected: expectation.terminalStatus,
				observed: state.terminalStatus ?? "missing",
				message: `Tool call ${toolCallId} terminal status did not match replay expectation.`,
				evidence: state.evidence,
			});
		}
		for (const artifactId of expectation.requiredArtifactIds ?? []) {
			if (state.artifactIds.has(artifactId)) continue;
			delta(deltas, {
				severity: "error",
				ruleId: "tool.required_artifact_missing",
				expected: artifactId,
				observed: "missing",
				message: `Tool call ${toolCallId} did not produce required artifact ${artifactId}.`,
				evidence: state.evidence,
			});
		}
	}

	const errors = deltas.filter((item) => item.severity === "error").length;
	const warnings = deltas.filter((item) => item.severity === "warning").length;
	const phases = summarizePhases(report.events);
	const toolCalls = summarizeTools(tools);
	return {
		schemaVersion: AGENT_TRAJECTORY_REPLAY_SCHEMA,
		trajectorySchemaVersion: report.schemaVersion,
		run: report.run,
		deterministic: true,
		counts: {
			events: report.events.length,
			deltas: deltas.length,
			errors,
			warnings,
			toolCalls: toolCalls.length,
			phases: phases.length,
		},
		phases,
		toolCalls,
		deltas,
	};
}
