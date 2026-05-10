import type {
	AgentTrajectoryEvent,
	AgentTrajectoryReport,
} from "./agent-trajectory.js";

export interface AgentTrajectoryValidationResult {
	valid: boolean;
	failures: string[];
}

function pushFailure(failures: string[], message: string): void {
	failures.push(message);
}

function hasEvidenceKind(
	event: AgentTrajectoryEvent,
	kind: AgentTrajectoryEvent["evidence"][number]["kind"],
): boolean {
	return event.evidence.some((anchor) => anchor.kind === kind);
}

function evidenceIds(
	event: AgentTrajectoryEvent,
	kind: AgentTrajectoryEvent["evidence"][number]["kind"],
): string[] {
	return event.evidence
		.filter((anchor) => anchor.kind === kind)
		.map((anchor) => anchor.id);
}

function validateCounts(
	report: AgentTrajectoryReport,
	failures: string[],
): void {
	if (report.counts.events !== report.events.length) {
		pushFailure(
			failures,
			`counts.events=${report.counts.events} does not match events.length=${report.events.length}`,
		);
	}

	let evidenceAnchors = 0;
	const byKind: Record<string, number> = {};
	const byPhase: Record<string, number> = {};
	const byStatus: Record<string, number> = {};
	for (const event of report.events) {
		byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
		byPhase[event.phase] = (byPhase[event.phase] ?? 0) + 1;
		byStatus[event.status] = (byStatus[event.status] ?? 0) + 1;
		evidenceAnchors += event.evidence.length;
	}

	if (report.counts.evidenceAnchors !== evidenceAnchors) {
		pushFailure(
			failures,
			`counts.evidenceAnchors=${report.counts.evidenceAnchors} does not match evidence anchors=${evidenceAnchors}`,
		);
	}

	for (const [label, expected] of [
		["byKind", byKind],
		["byPhase", byPhase],
		["byStatus", byStatus],
	] as const) {
		const actual = report.counts[label];
		for (const key of new Set([
			...Object.keys(actual),
			...Object.keys(expected),
		])) {
			if ((actual[key] ?? 0) !== (expected[key] ?? 0)) {
				pushFailure(
					failures,
					`counts.${label}.${key}=${actual[key] ?? 0} does not match events=${expected[key] ?? 0}`,
				);
			}
		}
	}
}

function validateEventShape(
	report: AgentTrajectoryReport,
	failures: string[],
): void {
	const ids = new Set<string>();
	for (const [index, event] of report.events.entries()) {
		const expectedSequence = index + 1;
		if (event.sequence !== expectedSequence) {
			pushFailure(
				failures,
				`${event.id} has sequence=${event.sequence}; expected ${expectedSequence}`,
			);
		}
		if (ids.has(event.id)) {
			pushFailure(failures, `duplicate event id: ${event.id}`);
		}
		ids.add(event.id);
		if (!hasEvidenceKind(event, "timeline_item")) {
			pushFailure(failures, `${event.id} is missing timeline_item evidence`);
		}
		if (
			(event.type === "tool.completed" || event.type === "tool.failed") &&
			!hasEvidenceKind(event, "tool_call")
		) {
			pushFailure(failures, `${event.id} is missing tool_call evidence`);
		}
		if (
			event.summary &&
			/sk-[A-Za-z0-9_-]{8,}|BEGIN [A-Z ]+PRIVATE KEY/u.test(event.summary)
		) {
			pushFailure(failures, `${event.id} summary appears to contain a secret`);
		}
	}
}

function validateToolOrdering(
	report: AgentTrajectoryReport,
	failures: string[],
): void {
	const requested = new Set<string>();
	for (const event of report.events) {
		if (event.type === "tool.requested") {
			for (const id of evidenceIds(event, "tool_call")) {
				requested.add(id);
			}
			continue;
		}
		if (
			event.type !== "tool.completed" &&
			event.type !== "tool.failed" &&
			event.type !== "file.changed" &&
			event.type !== "diagnostic.delta"
		) {
			continue;
		}
		for (const id of evidenceIds(event, "tool_call")) {
			if (!requested.has(id)) {
				pushFailure(
					failures,
					`${event.id} references tool_call ${id} before a matching tool.requested event`,
				);
			}
		}
	}
}

export function validateAgentTrajectoryReport(
	report: AgentTrajectoryReport,
): AgentTrajectoryValidationResult {
	const failures: string[] = [];
	validateCounts(report, failures);
	validateEventShape(report, failures);
	validateToolOrdering(report, failures);
	return {
		valid: failures.length === 0,
		failures,
	};
}
