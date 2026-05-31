import type {
	AgentTrajectoryEvent,
	AgentTrajectoryEventKind,
	AgentTrajectoryPhase,
	AgentTrajectoryReport,
} from "./agent-trajectory.js";

export const AGENT_TRAJECTORY_SCORE_SCHEMA =
	"evalops.maestro.agent-trajectory-score.v1";

export type AgentTrajectoryScoreSeverity = "error" | "warning";
export type AgentTrajectoryScoreStatus = "pass" | "fail" | "warn";

export interface AgentTrajectoryScorerRule {
	id: string;
	severity: AgentTrajectoryScoreSeverity;
	description: string;
	anyEvent?: AgentTrajectoryEventSelector;
	forbidEvent?: AgentTrajectoryEventSelector;
	toolTerminalStatus?: {
		toolCallId: string;
		status: "completed" | "failed";
	};
	requireArtifact?: {
		toolCallId: string;
		artifactId: string;
	};
	approvalBeforeToolResult?: {
		toolCallId: string;
	};
	recoveryAfterFailedTool?: {
		toolCallId: string;
	};
	childRunCompleted?: {
		parentAgentRunId: string;
		childAgentRunId: string;
	};
	finalEvidenceCoverage?: true;
}

export interface AgentTrajectoryEventSelector {
	kind?: AgentTrajectoryEventKind;
	phase?: AgentTrajectoryPhase;
	type?: string;
	status?: AgentTrajectoryEvent["status"];
	toolName?: string;
	source?: AgentTrajectoryEvent["source"];
}

export interface AgentTrajectoryScoreFinding {
	ruleId: string;
	status: AgentTrajectoryScoreStatus;
	severity: AgentTrajectoryScoreSeverity;
	message: string;
	eventIds: string[];
	evidence: AgentTrajectoryEvent["evidence"];
	remediation: string;
}

export interface AgentTrajectoryScoreReport {
	schemaVersion: typeof AGENT_TRAJECTORY_SCORE_SCHEMA;
	trajectorySchemaVersion: AgentTrajectoryReport["schemaVersion"];
	run: AgentTrajectoryReport["run"];
	counts: {
		rules: number;
		passed: number;
		failed: number;
		warnings: number;
	};
	findings: AgentTrajectoryScoreFinding[];
}

function eventMatches(
	event: AgentTrajectoryEvent,
	selector: AgentTrajectoryEventSelector,
): boolean {
	return (
		(selector.kind === undefined || event.kind === selector.kind) &&
		(selector.phase === undefined || event.phase === selector.phase) &&
		(selector.type === undefined || event.type === selector.type) &&
		(selector.status === undefined || event.status === selector.status) &&
		(selector.toolName === undefined || event.toolName === selector.toolName) &&
		(selector.source === undefined || event.source === selector.source)
	);
}

function evidenceIds(
	event: AgentTrajectoryEvent,
	kind: AgentTrajectoryEvent["evidence"][number]["kind"],
): string[] {
	return event.evidence
		.filter((anchor) => anchor.kind === kind)
		.map((anchor) => anchor.id);
}

function eventsForTool(
	report: AgentTrajectoryReport,
	toolCallId: string,
): AgentTrajectoryEvent[] {
	return report.events.filter((event) =>
		evidenceIds(event, "tool_call").includes(toolCallId),
	);
}

function eventReferencesId(
	event: AgentTrajectoryEvent,
	kind: AgentTrajectoryEvent["evidence"][number]["kind"],
	id: string,
): boolean {
	return evidenceIds(event, kind).includes(id);
}

function eventIsCompatibleWithParentRun(
	event: AgentTrajectoryEvent,
	parentAgentRunId: string,
): boolean {
	const parentIds = evidenceIds(event, "parent_agent_run");
	return parentIds.length === 0 || parentIds.includes(parentAgentRunId);
}

function eventReferencesChildRun(
	event: AgentTrajectoryEvent,
	childAgentRunId: string,
): boolean {
	return (
		eventReferencesId(event, "child_agent_run", childAgentRunId) ||
		eventReferencesId(event, "agent_run", childAgentRunId)
	);
}

function eventsForChildRun(
	report: AgentTrajectoryReport,
	parentAgentRunId: string,
	childAgentRunId: string,
): AgentTrajectoryEvent[] {
	return report.events.filter(
		(event) =>
			eventReferencesChildRun(event, childAgentRunId) &&
			eventIsCompatibleWithParentRun(event, parentAgentRunId),
	);
}

function mergeEvidence(
	events: AgentTrajectoryEvent[],
): AgentTrajectoryEvent["evidence"] {
	const seen = new Set<string>();
	const anchors: AgentTrajectoryEvent["evidence"] = [];
	for (const event of events) {
		for (const anchor of event.evidence) {
			const key = `${anchor.kind}:${anchor.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			anchors.push(anchor);
		}
	}
	return anchors.sort((a, b) => {
		const kindDelta = a.kind.localeCompare(b.kind);
		return kindDelta === 0 ? a.id.localeCompare(b.id) : kindDelta;
	});
}

function passFinding(
	rule: AgentTrajectoryScorerRule,
	message: string,
	events: AgentTrajectoryEvent[] = [],
): AgentTrajectoryScoreFinding {
	return {
		ruleId: rule.id,
		status: "pass",
		severity: rule.severity,
		message,
		eventIds: events.map((event) => event.id),
		evidence: mergeEvidence(events),
		remediation: "No action required.",
	};
}

function failFinding(
	rule: AgentTrajectoryScorerRule,
	message: string,
	remediation: string,
	events: AgentTrajectoryEvent[] = [],
): AgentTrajectoryScoreFinding {
	return {
		ruleId: rule.id,
		status: rule.severity === "warning" ? "warn" : "fail",
		severity: rule.severity,
		message,
		eventIds: events.map((event) => event.id),
		evidence: mergeEvidence(events),
		remediation,
	};
}

function terminalStatusForTool(
	events: AgentTrajectoryEvent[],
): "completed" | "failed" | undefined {
	const terminal = [...events]
		.reverse()
		.find(
			(event) =>
				event.type === "tool.completed" || event.type === "tool.failed",
		);
	if (!terminal) return undefined;
	return terminal.type === "tool.completed" ? "completed" : "failed";
}

function scoreRule(
	report: AgentTrajectoryReport,
	rule: AgentTrajectoryScorerRule,
): AgentTrajectoryScoreFinding {
	if (rule.anyEvent) {
		const matches = report.events.filter((event) =>
			eventMatches(event, rule.anyEvent as AgentTrajectoryEventSelector),
		);
		return matches.length > 0
			? passFinding(
					rule,
					`Matched required event selector ${rule.id}.`,
					matches,
				)
			: failFinding(
					rule,
					`No trajectory event matched required selector ${rule.id}.`,
					"Add or preserve a trajectory event matching this required behavior.",
				);
	}

	if (rule.forbidEvent) {
		const matches = report.events.filter((event) =>
			eventMatches(event, rule.forbidEvent as AgentTrajectoryEventSelector),
		);
		return matches.length === 0
			? passFinding(rule, `No forbidden event matched selector ${rule.id}.`)
			: failFinding(
					rule,
					`Found ${matches.length} forbidden trajectory event(s).`,
					"Remove the forbidden action or update the scenario policy if it is intentionally allowed.",
					matches,
				);
	}

	if (rule.toolTerminalStatus) {
		const events = eventsForTool(report, rule.toolTerminalStatus.toolCallId);
		const observed = terminalStatusForTool(events);
		return observed === rule.toolTerminalStatus.status
			? passFinding(
					rule,
					`Tool ${rule.toolTerminalStatus.toolCallId} reached ${observed}.`,
					events,
				)
			: failFinding(
					rule,
					`Tool ${rule.toolTerminalStatus.toolCallId} reached ${observed ?? "no terminal status"}; expected ${rule.toolTerminalStatus.status}.`,
					"Preserve the expected terminal tool outcome or update the scenario expectation.",
					events,
				);
	}

	if (rule.requireArtifact) {
		const events = eventsForTool(report, rule.requireArtifact.toolCallId);
		const matches = events.filter((event) =>
			evidenceIds(event, "artifact").includes(
				rule.requireArtifact?.artifactId ?? "",
			),
		);
		return matches.length > 0
			? passFinding(
					rule,
					`Tool ${rule.requireArtifact.toolCallId} produced required artifact ${rule.requireArtifact.artifactId}.`,
					matches,
				)
			: failFinding(
					rule,
					`Tool ${rule.requireArtifact.toolCallId} did not produce required artifact ${rule.requireArtifact.artifactId}.`,
					"Ensure the run links the required artifact before completion.",
					events,
				);
	}

	if (rule.approvalBeforeToolResult) {
		const events = eventsForTool(
			report,
			rule.approvalBeforeToolResult.toolCallId,
		);
		const approval = events.find(
			(event) =>
				event.type === "wait.pending" &&
				evidenceIds(event, "approval_request").length > 0,
		);
		const result = events.find(
			(event) =>
				event.type === "tool.completed" || event.type === "tool.failed",
		);
		return approval && result && approval.sequence < result.sequence
			? passFinding(
					rule,
					`Approval wait preceded tool result for ${rule.approvalBeforeToolResult.toolCallId}.`,
					[approval, result],
				)
			: failFinding(
					rule,
					`Tool ${rule.approvalBeforeToolResult.toolCallId} did not show approval evidence before terminal result.`,
					"Emit approval wait evidence before resuming or failing the governed tool call.",
					events,
				);
	}

	if (rule.recoveryAfterFailedTool) {
		const events = eventsForTool(
			report,
			rule.recoveryAfterFailedTool.toolCallId,
		);
		const failed = events.find((event) => event.type === "tool.failed");
		const recovery = events.find(
			(event) =>
				event.phase === "recover" &&
				failed !== undefined &&
				event.sequence > failed.sequence,
		);
		return failed && recovery
			? passFinding(
					rule,
					`Recovery followed failed tool ${rule.recoveryAfterFailedTool.toolCallId}.`,
					[failed, recovery],
				)
			: failFinding(
					rule,
					`No recovery event followed failed tool ${rule.recoveryAfterFailedTool.toolCallId}.`,
					"Emit a recovery-phase event after the failed tool result or mark the scenario as non-recoverable.",
					events,
				);
	}

	if (rule.childRunCompleted) {
		const events = eventsForChildRun(
			report,
			rule.childRunCompleted.parentAgentRunId,
			rule.childRunCompleted.childAgentRunId,
		);
		const started = events.find((event) => event.type === "agent.run.started");
		const completed = events.find(
			(event) => event.type === "agent.run.completed",
		);
		return started && completed && started.sequence < completed.sequence
			? passFinding(
					rule,
					`Child agent run ${rule.childRunCompleted.childAgentRunId} completed under parent ${rule.childRunCompleted.parentAgentRunId}.`,
					[started, completed],
				)
			: failFinding(
					rule,
					`Child agent run ${rule.childRunCompleted.childAgentRunId} did not complete under parent ${rule.childRunCompleted.parentAgentRunId}.`,
					"Preserve child-run start and completion events with agent_run evidence, and include parent_agent_run/child_agent_run anchors when the timeline source provides them.",
					events,
				);
	}

	if (rule.finalEvidenceCoverage) {
		const finalEvent = report.events.at(-1);
		if (finalEvent?.evidence.some(Boolean)) {
			return passFinding(rule, "Final trajectory event has evidence anchors.", [
				finalEvent,
			]);
		}
		return failFinding(
			rule,
			"Final trajectory event is missing evidence anchors.",
			"Keep a timeline anchor on the final answer or terminal runtime event.",
			finalEvent ? [finalEvent] : [],
		);
	}

	return failFinding(
		rule,
		`Rule ${rule.id} has no supported deterministic predicate.`,
		"Use one of the supported scorer predicates.",
	);
}

export function scoreAgentTrajectoryReport(
	report: AgentTrajectoryReport,
	rules: AgentTrajectoryScorerRule[],
): AgentTrajectoryScoreReport {
	const findings = rules.map((rule) => scoreRule(report, rule));
	const failed = findings.filter((finding) => finding.status === "fail").length;
	const warnings = findings.filter(
		(finding) => finding.status === "warn",
	).length;
	return {
		schemaVersion: AGENT_TRAJECTORY_SCORE_SCHEMA,
		trajectorySchemaVersion: report.schemaVersion,
		run: report.run,
		counts: {
			rules: rules.length,
			passed: findings.filter((finding) => finding.status === "pass").length,
			failed,
			warnings,
		},
		findings,
	};
}
