import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	MAESTRO_SCENARIO_SCHEMA,
	type MaestroScenario,
	type MaestroScenarioAssertion,
	type MaestroScenarioOutcome,
	type MaestroScenarioPlatformLink,
	type MaestroScenarioReviewLabel,
	type MaestroScenarioSeverity,
} from "@evalops/contracts";
import type { AgentTrajectoryInspectionReport } from "./agent-trajectory-inspection.js";
import type { AgentTrajectoryReplayReport } from "./agent-trajectory-replay.js";
import type { AgentTrajectoryScoreReport } from "./agent-trajectory-scorers.js";
import type {
	AgentTrajectoryEvent,
	AgentTrajectoryReport,
} from "./agent-trajectory.js";
import { escapeXml } from "./junit-xml.js";

export const AGENT_TRAJECTORY_SCENARIO_RESULT_SCHEMA =
	"evalops.maestro.agent-trajectory-scenario-result.v1";
export {
	MAESTRO_SCENARIO_SCHEMA,
	type MaestroScenario,
	type MaestroScenarioAssertion,
	type MaestroScenarioOutcome,
	type MaestroScenarioPlatformLink,
	type MaestroScenarioReviewLabel,
	type MaestroScenarioSeverity,
} from "@evalops/contracts";

export type AgentTrajectoryScenarioStatus = "pass" | "fail" | "warn";

export interface AgentTrajectoryScenarioEvidence {
	kind: string;
	id: string;
	source: "trajectory" | "replay" | "score" | "inspection" | "scenario";
	label: string;
}

export interface AgentTrajectoryScenarioAssertionResult {
	id: string;
	kind: MaestroScenarioAssertion["kind"];
	status: AgentTrajectoryScenarioStatus;
	severity: MaestroScenarioSeverity;
	message: string;
	evidence: AgentTrajectoryScenarioEvidence[];
}

export interface AgentTrajectoryScenarioProvenanceStep {
	eventId: string;
	eventType: string;
	phase: AgentTrajectoryEvent["phase"];
	actor: AgentTrajectoryEvent["actor"];
	evidence: AgentTrajectoryScenarioEvidence[];
}

export interface AgentTrajectoryScenarioDiff {
	baselineRunId: string;
	candidateRunId: string;
	eventsDelta: number;
	toolCallsDelta: number;
	scoreFailuresDelta: number;
}

export interface AgentTrajectoryScenarioResult {
	schemaVersion: typeof AGENT_TRAJECTORY_SCENARIO_RESULT_SCHEMA;
	scenarioSchemaVersion: typeof MAESTRO_SCENARIO_SCHEMA;
	scenario: {
		id: string;
		title: string;
		expectedOutcome: MaestroScenarioOutcome;
		observedOutcome: MaestroScenarioOutcome;
		reviewLabels: MaestroScenarioReviewLabel[];
	};
	run: AgentTrajectoryReport["run"] & {
		scenarioId: string;
		replay: true;
	};
	counts: {
		assertions: number;
		passed: number;
		failed: number;
		warnings: number;
		events: number;
		toolCalls: number;
		replayDeltas: number;
		scoreFailures: number;
		scoreWarnings: number;
	};
	platform: MaestroScenarioPlatformLink & {
		evidenceEventType: "maestro.events.eval.scored";
	};
	assumptions: MaestroScenario["assumptions"];
	assertions: AgentTrajectoryScenarioAssertionResult[];
	provenance: AgentTrajectoryScenarioProvenanceStep[];
	diff?: AgentTrajectoryScenarioDiff;
}

interface ScenarioInputs {
	trajectory: AgentTrajectoryReport;
	replay: AgentTrajectoryReplayReport;
	score: AgentTrajectoryScoreReport;
	inspection?: AgentTrajectoryInspectionReport;
	baselineTrajectory?: AgentTrajectoryReport;
	candidateTrajectory?: AgentTrajectoryReport;
	baselineScore?: AgentTrajectoryScoreReport;
	candidateScore?: AgentTrajectoryScoreReport;
}

const AGENT_TRAJECTORY_SCENARIO_ASSERTION_KINDS = new Set<
	MaestroScenarioAssertion["kind"]
>([
	"event.exists",
	"event.forbidden",
	"replay.deltas",
	"score.finding",
	"inspection.redaction",
	"efficiency.budget",
	"provenance.chain",
	"human.review",
	"trajectory.diff",
]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${name} must be a non-empty string`);
	}
	return value;
}

function loadTypedJson<T>(
	path: string,
	schemaVersion: string,
	name: string,
): T {
	const value = readJson(path);
	if (
		!isObject(value) ||
		(value.schemaVersion !== schemaVersion &&
			value.trajectorySchemaVersion !== schemaVersion)
	) {
		throw new Error(
			`${name} at ${path} must use schemaVersion ${schemaVersion}`,
		);
	}
	return value as T;
}

export function parseAgentTrajectoryScenario(
	value: unknown,
	label: string,
): MaestroScenario {
	if (!isObject(value)) {
		throw new Error(`Scenario ${label} must be a JSON object`);
	}
	const schemaVersion = value.schemaVersion;
	if (schemaVersion !== MAESTRO_SCENARIO_SCHEMA) {
		throw new Error(
			`Scenario ${label} must use schemaVersion ${MAESTRO_SCENARIO_SCHEMA}`,
		);
	}
	const scenario = value as unknown as MaestroScenario;
	validateAgentTrajectoryScenario(scenario, label);
	return scenario;
}

export function loadAgentTrajectoryScenario(path: string): MaestroScenario {
	return parseAgentTrajectoryScenario(readJson(path), path);
}

export function loadAgentTrajectoryScenarioInputs(
	scenario: MaestroScenario,
	baseDir: string,
): ScenarioInputs {
	const resolvePath = (path: string) => resolve(baseDir, path);
	const source = scenario.source;
	const inputs: ScenarioInputs = {
		trajectory: loadTypedJson<AgentTrajectoryReport>(
			resolvePath(source.trajectoryPath),
			"evalops.maestro.agent-trajectory.v1",
			"trajectory",
		),
		replay: loadTypedJson<AgentTrajectoryReplayReport>(
			resolvePath(source.replayPath),
			"evalops.maestro.agent-trajectory-replay.v1",
			"trajectory replay",
		),
		score: loadTypedJson<AgentTrajectoryScoreReport>(
			resolvePath(source.scorePath),
			"evalops.maestro.agent-trajectory-score.v1",
			"trajectory score",
		),
	};
	if (source.inspectionPath) {
		inputs.inspection = loadTypedJson<AgentTrajectoryInspectionReport>(
			resolvePath(source.inspectionPath),
			"evalops.maestro.agent-trajectory-inspection.v1",
			"trajectory inspection",
		);
	}
	if (source.baselineTrajectoryPath) {
		inputs.baselineTrajectory = loadTypedJson<AgentTrajectoryReport>(
			resolvePath(source.baselineTrajectoryPath),
			"evalops.maestro.agent-trajectory.v1",
			"baseline trajectory",
		);
	}
	if (source.candidateTrajectoryPath) {
		inputs.candidateTrajectory = loadTypedJson<AgentTrajectoryReport>(
			resolvePath(source.candidateTrajectoryPath),
			"evalops.maestro.agent-trajectory.v1",
			"candidate trajectory",
		);
	}
	if (source.baselineScorePath) {
		inputs.baselineScore = loadTypedJson<AgentTrajectoryScoreReport>(
			resolvePath(source.baselineScorePath),
			"evalops.maestro.agent-trajectory-score.v1",
			"baseline score",
		);
	}
	if (source.candidateScorePath) {
		inputs.candidateScore = loadTypedJson<AgentTrajectoryScoreReport>(
			resolvePath(source.candidateScorePath),
			"evalops.maestro.agent-trajectory-score.v1",
			"candidate score",
		);
	}
	return inputs;
}

export function validateAgentTrajectoryScenario(
	scenario: MaestroScenario,
	label = scenario.id,
): void {
	requireString(scenario.id, `${label}.id`);
	requireString(scenario.title, `${label}.title`);
	requireString(scenario.description, `${label}.description`);
	if (
		scenario.expectedOutcome !== undefined &&
		scenario.expectedOutcome !== "pass" &&
		scenario.expectedOutcome !== "fail"
	) {
		throw new Error(`${label}.expectedOutcome must be pass or fail`);
	}
	if (!isObject(scenario.source)) {
		throw new Error(`${label}.source must be an object`);
	}
	requireString(
		scenario.source.trajectoryPath,
		`${label}.source.trajectoryPath`,
	);
	requireString(scenario.source.replayPath, `${label}.source.replayPath`);
	requireString(scenario.source.scorePath, `${label}.source.scorePath`);
	if (
		Boolean(scenario.source.baselineTrajectoryPath) !==
		Boolean(scenario.source.candidateTrajectoryPath)
	) {
		throw new Error(
			`${label}.source baselineTrajectoryPath and candidateTrajectoryPath must be provided together`,
		);
	}
	if (
		Boolean(scenario.source.baselineScorePath) !==
		Boolean(scenario.source.candidateScorePath)
	) {
		throw new Error(
			`${label}.source baselineScorePath and candidateScorePath must be provided together`,
		);
	}
	if (!Array.isArray(scenario.assertions) || scenario.assertions.length === 0) {
		throw new Error(`${label}.assertions must contain at least one assertion`);
	}
	if (!Array.isArray(scenario.reviewLabels)) {
		throw new Error(`${label}.reviewLabels must be an array`);
	}
	if (!isObject(scenario.platform)) {
		throw new Error(`${label}.platform must be an object`);
	}
	if (
		!Array.isArray(scenario.platform.traceJoinKeys) ||
		scenario.platform.traceJoinKeys.length === 0
	) {
		throw new Error(`${label}.platform.traceJoinKeys must not be empty`);
	}
	if (!isObject(scenario.assumptions)) {
		throw new Error(`${label}.assumptions must be an object`);
	}
	requireString(scenario.assumptions.workflow, `${label}.assumptions.workflow`);
	requireString(
		scenario.assumptions.correctnessModel,
		`${label}.assumptions.correctnessModel`,
	);
	requireString(
		scenario.assumptions.threatModel,
		`${label}.assumptions.threatModel`,
	);
	if (
		!Array.isArray(scenario.assumptions.researchBasis) ||
		scenario.assumptions.researchBasis.length === 0
	) {
		throw new Error(`${label}.assumptions.researchBasis must not be empty`);
	}
	for (const assertion of scenario.assertions) {
		requireString(assertion.id, `${label}.assertions[].id`);
		const kind = requireString(assertion.kind, `${label}.assertions[].kind`);
		if (
			!AGENT_TRAJECTORY_SCENARIO_ASSERTION_KINDS.has(
				kind as MaestroScenarioAssertion["kind"],
			)
		) {
			throw new Error(
				`${label}.assertions[].kind must be one of: ${Array.from(
					AGENT_TRAJECTORY_SCENARIO_ASSERTION_KINDS,
				).join(", ")}`,
			);
		}
		if (
			kind === "trajectory.diff" &&
			assertion.maxAddedScoreFailures !== undefined &&
			(!scenario.source.baselineScorePath ||
				!scenario.source.candidateScorePath)
		) {
			throw new Error(
				`${label}.assertions[].maxAddedScoreFailures requires baselineScorePath and candidateScorePath`,
			);
		}
	}
}

function eventMatches(
	event: AgentTrajectoryEvent,
	selector: NonNullable<MaestroScenarioAssertion["selector"]>,
): boolean {
	return (
		(selector.kind === undefined || event.kind === selector.kind) &&
		(selector.phase === undefined || event.phase === selector.phase) &&
		(selector.type === undefined || event.type === selector.type) &&
		(selector.status === undefined || event.status === selector.status) &&
		(selector.toolName === undefined || event.toolName === selector.toolName) &&
		(selector.source === undefined || event.source === selector.source) &&
		(selector.actor === undefined || event.actor === selector.actor)
	);
}

function evidenceFromEvents(
	events: AgentTrajectoryEvent[],
): AgentTrajectoryScenarioEvidence[] {
	const seen = new Set<string>();
	const evidence: AgentTrajectoryScenarioEvidence[] = [];
	for (const event of events) {
		const eventKey = `trajectory:event:${event.id}`;
		if (!seen.has(eventKey)) {
			seen.add(eventKey);
			evidence.push({
				kind: "trajectory_event",
				id: event.id,
				source: "trajectory",
				label: `${event.type}:${event.id}`,
			});
		}
		for (const anchor of event.evidence) {
			const key = `trajectory:${anchor.kind}:${anchor.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			evidence.push({
				kind: anchor.kind,
				id: anchor.id,
				source: "trajectory",
				label: `${anchor.kind}:${anchor.id}`,
			});
		}
	}
	return evidence.sort((left, right) => left.label.localeCompare(right.label));
}

function scenarioEvidence(
	id: string,
	label: string,
): AgentTrajectoryScenarioEvidence[] {
	return [
		{
			kind: "scenario",
			id,
			source: "scenario",
			label,
		},
	];
}

function result(
	assertion: MaestroScenarioAssertion,
	status: AgentTrajectoryScenarioStatus,
	message: string,
	evidence: AgentTrajectoryScenarioEvidence[] = [],
): AgentTrajectoryScenarioAssertionResult {
	return {
		id: assertion.id,
		kind: assertion.kind,
		status,
		severity: assertion.severity ?? "error",
		message,
		evidence,
	};
}

function fail(
	assertion: MaestroScenarioAssertion,
	message: string,
	evidence: AgentTrajectoryScenarioEvidence[] = [],
): AgentTrajectoryScenarioAssertionResult {
	const status = assertion.severity === "warning" ? "warn" : "fail";
	return result(assertion, status, message, evidence);
}

function countToolCalls(report: AgentTrajectoryReport): number {
	return report.events.filter((event) => event.type === "tool.requested")
		.length;
}

function scoreFailures(report: AgentTrajectoryScoreReport): number {
	return report.findings.filter((finding) => finding.status === "fail").length;
}

function scoreWarnings(report: AgentTrajectoryScoreReport): number {
	return report.findings.filter((finding) => finding.status === "warn").length;
}

function buildDiff(
	inputs: ScenarioInputs,
): AgentTrajectoryScenarioDiff | undefined {
	if (!inputs.baselineTrajectory || !inputs.candidateTrajectory)
		return undefined;
	return {
		baselineRunId: inputs.baselineTrajectory.run.id,
		candidateRunId: inputs.candidateTrajectory.run.id,
		eventsDelta:
			inputs.candidateTrajectory.counts.events -
			inputs.baselineTrajectory.counts.events,
		toolCallsDelta:
			countToolCalls(inputs.candidateTrajectory) -
			countToolCalls(inputs.baselineTrajectory),
		scoreFailuresDelta:
			inputs.baselineScore && inputs.candidateScore
				? scoreFailures(inputs.candidateScore) -
					scoreFailures(inputs.baselineScore)
				: 0,
	};
}

function evaluateAssertion(
	assertion: MaestroScenarioAssertion,
	scenario: MaestroScenario,
	inputs: ScenarioInputs,
	diff: AgentTrajectoryScenarioDiff | undefined,
): AgentTrajectoryScenarioAssertionResult {
	switch (assertion.kind) {
		case "event.exists": {
			if (!assertion.selector) {
				return fail(assertion, "event.exists requires a selector.");
			}
			const matches = inputs.trajectory.events.filter((event) =>
				eventMatches(event, assertion.selector ?? {}),
			);
			return matches.length > 0
				? result(
						assertion,
						"pass",
						`Matched ${matches.length} trajectory event(s).`,
						evidenceFromEvents(matches),
					)
				: fail(assertion, "No trajectory event matched the selector.");
		}
		case "event.forbidden": {
			if (!assertion.selector) {
				return fail(assertion, "event.forbidden requires a selector.");
			}
			const matches = inputs.trajectory.events.filter((event) =>
				eventMatches(event, assertion.selector ?? {}),
			);
			return matches.length === 0
				? result(assertion, "pass", "No forbidden trajectory event matched.")
				: fail(
						assertion,
						`Forbidden selector matched ${matches.length} trajectory event(s).`,
						evidenceFromEvents(matches),
					);
		}
		case "replay.deltas": {
			const maxDeltas = assertion.maxReplayDeltas ?? Number.POSITIVE_INFINITY;
			const maxErrors = assertion.maxReplayErrors ?? Number.POSITIVE_INFINITY;
			const failed =
				inputs.replay.counts.deltas > maxDeltas ||
				inputs.replay.counts.errors > maxErrors;
			return failed
				? fail(
						assertion,
						`Replay deltas exceeded budget: ${inputs.replay.counts.deltas}/${maxDeltas}, errors ${inputs.replay.counts.errors}/${maxErrors}.`,
						inputs.replay.deltas.map((delta) => ({
							kind: "replay_delta",
							id: delta.id,
							source: "replay",
							label: `${delta.ruleId}:${delta.id}`,
						})),
					)
				: result(
						assertion,
						"pass",
						`Replay stayed within delta and error budgets (${inputs.replay.counts.deltas} deltas, ${inputs.replay.counts.errors} errors).`,
					);
		}
		case "score.finding": {
			if (!assertion.ruleId) {
				return fail(assertion, "score.finding requires ruleId.");
			}
			const finding = inputs.score.findings.find(
				(item) => item.ruleId === assertion.ruleId,
			);
			if (!finding) {
				return fail(assertion, `Missing score finding ${assertion.ruleId}.`);
			}
			if (assertion.status && finding.status !== assertion.status) {
				return fail(
					assertion,
					`Score finding ${assertion.ruleId} was ${finding.status}; expected ${assertion.status}.`,
					evidenceFromEvents(
						inputs.trajectory.events.filter((event) =>
							finding.eventIds.includes(event.id),
						),
					),
				);
			}
			return result(
				assertion,
				"pass",
				`Score finding ${assertion.ruleId} matched ${finding.status}.`,
				evidenceFromEvents(
					inputs.trajectory.events.filter((event) =>
						finding.eventIds.includes(event.id),
					),
				),
			);
		}
		case "inspection.redaction": {
			if (!inputs.inspection) {
				return fail(assertion, "inspection.redaction requires inspectionPath.");
			}
			const inspectionJson = JSON.stringify(inputs.inspection);
			const leaked = (assertion.forbiddenTerms ?? []).filter((term) =>
				inspectionJson.includes(term),
			);
			const unredactedItem = inputs.inspection.timelineItems.find(
				(item) => item.redacted !== true,
			);
			if (leaked.length > 0 || unredactedItem) {
				return fail(
					assertion,
					`Inspection output was not fail-closed: ${leaked.length} forbidden term(s), unredacted item ${unredactedItem?.id ?? "none"}.`,
					scenarioEvidence(inputs.inspection.run.id, "inspection:redaction"),
				);
			}
			return result(
				assertion,
				"pass",
				"Inspection artifact stayed redacted and omitted forbidden terms.",
				scenarioEvidence(inputs.inspection.run.id, "inspection:redaction"),
			);
		}
		case "efficiency.budget": {
			const maxEvents = assertion.maxEvents ?? Number.POSITIVE_INFINITY;
			const maxToolCalls = assertion.maxToolCalls ?? Number.POSITIVE_INFINITY;
			const maxDeltas = assertion.maxReplayDeltas ?? Number.POSITIVE_INFINITY;
			const maxFailures =
				assertion.maxScoreFailures ?? Number.POSITIVE_INFINITY;
			const maxWarnings =
				assertion.maxScoreWarnings ?? Number.POSITIVE_INFINITY;
			const observedToolCalls = countToolCalls(inputs.trajectory);
			const observedFailures = scoreFailures(inputs.score);
			const observedWarnings = scoreWarnings(inputs.score);
			const exceeded =
				inputs.trajectory.counts.events > maxEvents ||
				observedToolCalls > maxToolCalls ||
				inputs.replay.counts.deltas > maxDeltas ||
				observedFailures > maxFailures ||
				observedWarnings > maxWarnings;
			const message = `Observed events=${inputs.trajectory.counts.events}, toolCalls=${observedToolCalls}, replayDeltas=${inputs.replay.counts.deltas}, scoreFailures=${observedFailures}, scoreWarnings=${observedWarnings}.`;
			return exceeded
				? fail(assertion, `Efficiency budget exceeded. ${message}`)
				: result(assertion, "pass", `Efficiency budget satisfied. ${message}`);
		}
		case "provenance.chain": {
			if (!assertion.eventId) {
				return fail(assertion, "provenance.chain requires eventId.");
			}
			const event = inputs.trajectory.events.find(
				(item) => item.id === assertion.eventId,
			);
			if (!event) {
				return fail(
					assertion,
					`Missing provenance event ${assertion.eventId}.`,
				);
			}
			const kinds = new Set(event.evidence.map((anchor) => anchor.kind));
			const missing = (assertion.requiredEvidenceKinds ?? []).filter(
				(kind) =>
					!kinds.has(kind as AgentTrajectoryEvent["evidence"][number]["kind"]),
			);
			return missing.length === 0
				? result(
						assertion,
						"pass",
						`Event ${assertion.eventId} includes required provenance anchors.`,
						evidenceFromEvents([event]),
					)
				: fail(
						assertion,
						`Event ${assertion.eventId} is missing provenance anchors: ${missing.join(", ")}.`,
						evidenceFromEvents([event]),
					);
		}
		case "human.review": {
			const missing = (assertion.requiredLabels ?? []).filter(
				(label) => !scenario.reviewLabels.includes(label),
			);
			return missing.length === 0
				? result(
						assertion,
						"pass",
						`Human review labels present: ${(assertion.requiredLabels ?? []).join(", ")}.`,
						scenarioEvidence(scenario.id, "human-review:labels"),
					)
				: fail(
						assertion,
						`Missing human review labels: ${missing.join(", ")}.`,
						scenarioEvidence(scenario.id, "human-review:labels"),
					);
		}
		case "trajectory.diff": {
			if (!diff) {
				return fail(
					assertion,
					"trajectory.diff requires baselineTrajectoryPath and candidateTrajectoryPath.",
				);
			}
			const exceeded =
				diff.eventsDelta >
					(assertion.maxAddedEvents ?? Number.POSITIVE_INFINITY) ||
				diff.toolCallsDelta >
					(assertion.maxAddedToolCalls ?? Number.POSITIVE_INFINITY) ||
				diff.scoreFailuresDelta >
					(assertion.maxAddedScoreFailures ?? Number.POSITIVE_INFINITY);
			const message = `Diff eventsDelta=${diff.eventsDelta}, toolCallsDelta=${diff.toolCallsDelta}, scoreFailuresDelta=${diff.scoreFailuresDelta}.`;
			return exceeded
				? fail(assertion, `Trajectory diff budget exceeded. ${message}`)
				: result(
						assertion,
						"pass",
						`Trajectory diff budget satisfied. ${message}`,
					);
		}
	}
	const _exhaustive: never = assertion.kind;
	return fail(assertion, `Unsupported scenario assertion kind: ${_exhaustive}`);
}

function buildProvenance(
	report: AgentTrajectoryReport,
): AgentTrajectoryScenarioProvenanceStep[] {
	return report.events
		.filter((event) => event.evidence.length > 0)
		.map((event) => ({
			eventId: event.id,
			eventType: event.type,
			phase: event.phase,
			actor: event.actor,
			evidence: evidenceFromEvents([event]),
		}));
}

export function evaluateAgentTrajectoryScenario(
	scenario: MaestroScenario,
	inputs: ScenarioInputs,
): AgentTrajectoryScenarioResult {
	const diff = buildDiff(inputs);
	const assertions = scenario.assertions.map((assertion) =>
		evaluateAssertion(assertion, scenario, inputs, diff),
	);
	const failed = assertions.filter((assertion) => assertion.status === "fail");
	const warnings = assertions.filter(
		(assertion) => assertion.status === "warn",
	);
	const observedOutcome: MaestroScenarioOutcome =
		failed.length > 0 ? "fail" : "pass";
	return {
		schemaVersion: AGENT_TRAJECTORY_SCENARIO_RESULT_SCHEMA,
		scenarioSchemaVersion: MAESTRO_SCENARIO_SCHEMA,
		scenario: {
			id: scenario.id,
			title: scenario.title,
			expectedOutcome: scenario.expectedOutcome ?? "pass",
			observedOutcome,
			reviewLabels: scenario.reviewLabels,
		},
		run: {
			...inputs.trajectory.run,
			scenarioId: scenario.id,
			replay: true,
		},
		counts: {
			assertions: assertions.length,
			passed: assertions.filter((assertion) => assertion.status === "pass")
				.length,
			failed: failed.length,
			warnings: warnings.length,
			events: inputs.trajectory.counts.events,
			toolCalls: countToolCalls(inputs.trajectory),
			replayDeltas: inputs.replay.counts.deltas,
			scoreFailures: scoreFailures(inputs.score),
			scoreWarnings: scoreWarnings(inputs.score),
		},
		platform: {
			...scenario.platform,
			evidenceEventType: "maestro.events.eval.scored",
		},
		assumptions: scenario.assumptions,
		assertions,
		provenance: buildProvenance(inputs.trajectory),
		...(diff ? { diff } : {}),
	};
}

export function scenarioResultToJunit(
	result: AgentTrajectoryScenarioResult,
): string {
	const failures = result.assertions.filter(
		(assertion) => assertion.status === "fail",
	);
	const testcases = result.assertions
		.map((assertion) => {
			const failure =
				assertion.status === "fail"
					? `\n\t\t<failure message="${escapeXml(assertion.message)}">${escapeXml(
							JSON.stringify(assertion.evidence),
						)}</failure>\n\t`
					: "";
			return `\t<testcase classname="${escapeXml(result.scenario.id)}" name="${escapeXml(assertion.id)}">${failure}</testcase>`;
		})
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(
		result.scenario.id,
	)}" tests="${result.counts.assertions}" failures="${failures.length}" warnings="${result.counts.warnings}">\n${testcases}\n</testsuite>\n`;
}

export function runAgentTrajectoryScenarioFile(
	path: string,
	options: { baseDir?: string } = {},
): AgentTrajectoryScenarioResult {
	const scenario = loadAgentTrajectoryScenario(path);
	const inputs = loadAgentTrajectoryScenarioInputs(
		scenario,
		options.baseDir ?? process.cwd(),
	);
	return evaluateAgentTrajectoryScenario(scenario, inputs);
}
