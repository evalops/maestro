import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	MAESTRO_SCENARIO_SCHEMA,
	MAESTRO_SCENARIO_WORKSPACE_MANIFEST_SCHEMA,
	type MaestroScenario,
	type MaestroScenarioAssertion,
	type MaestroScenarioExternalRefs,
	type MaestroScenarioGateTier,
	type MaestroScenarioOutcome,
	type MaestroScenarioPlatformLink,
	type MaestroScenarioReleaseGate,
	type MaestroScenarioRequiredArtifact,
	type MaestroScenarioReviewLabel,
	type MaestroScenarioSeverity,
	type MaestroScenarioToolAdapterMode,
	type MaestroScenarioWorkspaceHydrationMode,
	type MaestroScenarioWorkspaceManifest,
	type MaestroScenarioWorkspaceSource,
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
	MAESTRO_SCENARIO_WORKSPACE_MANIFEST_SCHEMA,
	MAESTRO_SCENARIO_SCHEMA,
	type MaestroScenario,
	type MaestroScenarioAssertion,
	type MaestroScenarioExternalRefs,
	type MaestroScenarioGateTier,
	type MaestroScenarioOutcome,
	type MaestroScenarioPlatformLink,
	type MaestroScenarioReleaseGate,
	type MaestroScenarioReviewLabel,
	type MaestroScenarioRequiredArtifact,
	type MaestroScenarioSeverity,
	type MaestroScenarioWorkspaceManifest,
	type MaestroScenarioWorkspaceHydrationMode,
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

export interface AgentTrajectoryScenarioWorkspaceSummary {
	manifestId: string;
	source: MaestroScenarioWorkspaceManifest["source"];
	recordedAt: string;
	hydrationMode: MaestroScenarioWorkspaceHydrationMode;
	files: number;
	toolAdapters: number;
}

export interface AgentTrajectoryScenarioReleaseGateSummary
	extends MaestroScenarioReleaseGate {
	satisfied: boolean;
	missingArtifacts: MaestroScenarioRequiredArtifact[];
	budgetViolations: string[];
	policyViolations: string[];
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
	externalRefs?: MaestroScenarioExternalRefs;
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
		workspaceFiles: number;
		toolAdapters: number;
	};
	platform: MaestroScenarioPlatformLink & {
		evidenceEventType: "maestro.events.eval.scored";
	};
	releaseGate?: AgentTrajectoryScenarioReleaseGateSummary;
	workspace?: AgentTrajectoryScenarioWorkspaceSummary;
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
	workspaceManifest?: MaestroScenarioWorkspaceManifest;
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
	"workspace.manifest",
	"efficiency.budget",
	"provenance.chain",
	"human.review",
	"external.refs",
	"trajectory.diff",
]);

const EXTERNAL_REF_FIELDS = [
	"ensembleTranscriptIds",
	"platformTraceIds",
	"platformWorkEnvelopeIds",
	"slackThreadRefs",
	"evidenceArtifactIds",
] as const satisfies readonly (keyof MaestroScenarioExternalRefs)[];

const RELEASE_GATE_TIERS = [
	"smoke",
	"regression",
	"gauntlet",
] as const satisfies readonly MaestroScenarioGateTier[];

const REQUIRED_ARTIFACTS = [
	"trajectory",
	"replay",
	"score",
	"inspection",
	"workspace_manifest",
] as const satisfies readonly MaestroScenarioRequiredArtifact[];

const HYDRATION_MODES = [
	"manifest_only",
	"fixture_workspace",
	"frozen_archive",
] as const satisfies readonly MaestroScenarioWorkspaceHydrationMode[];

const WORKSPACE_SOURCES = [
	"production",
	"canary",
	"fixture",
	"synthetic",
] as const satisfies readonly MaestroScenarioWorkspaceSource[];

const TOOL_ADAPTER_MODES = [
	"recorded",
	"mocked",
	"sandboxed",
	"disabled",
] as const satisfies readonly MaestroScenarioToolAdapterMode[];

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

function requireOptionalString(value: unknown, name: string): void {
	if (value !== undefined) {
		requireString(value, name);
	}
}

function requireStringArray(value: unknown, name: string): void {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || item.length === 0)
	) {
		throw new Error(`${name} must contain non-empty strings`);
	}
}

function requireOptionalStringArray(value: unknown, name: string): void {
	if (value !== undefined) {
		requireStringArray(value, name);
	}
}

function requireOptionalNonNegativeInteger(value: unknown, name: string): void {
	if (
		value !== undefined &&
		(!Number.isInteger(value) || (value as number) < 0)
	) {
		throw new Error(`${name} must be a non-negative integer`);
	}
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

function validateWorkspaceManifest(
	manifest: MaestroScenarioWorkspaceManifest,
	label: string,
): void {
	requireString(manifest.id, `${label}.id`);
	requireString(manifest.recordedAt, `${label}.recordedAt`);
	if (!WORKSPACE_SOURCES.includes(manifest.source)) {
		throw new Error(
			`${label}.source must be one of: ${WORKSPACE_SOURCES.join(", ")}`,
		);
	}
	requireOptionalString(manifest.workspaceRoot, `${label}.workspaceRoot`);
	if (!isObject(manifest.hydration)) {
		throw new Error(`${label}.hydration must be an object`);
	}
	if (!HYDRATION_MODES.includes(manifest.hydration.mode)) {
		throw new Error(
			`${label}.hydration.mode must be one of: ${HYDRATION_MODES.join(", ")}`,
		);
	}
	requireOptionalString(
		manifest.hydration.archiveUri,
		`${label}.hydration.archiveUri`,
	);
	requireOptionalString(
		manifest.hydration.rootPath,
		`${label}.hydration.rootPath`,
	);
	if (!Array.isArray(manifest.files)) {
		throw new Error(`${label}.files must be an array`);
	}
	for (const [index, file] of manifest.files.entries()) {
		const fileLabel = `${label}.files[${index}]`;
		if (!isObject(file)) {
			throw new Error(`${fileLabel} must be an object`);
		}
		requireString(file.path, `${fileLabel}.path`);
		requireOptionalString(file.sha256, `${fileLabel}.sha256`);
		requireOptionalNonNegativeInteger(file.sizeBytes, `${fileLabel}.sizeBytes`);
		requireOptionalString(file.purpose, `${fileLabel}.purpose`);
	}
	if (!Array.isArray(manifest.toolAdapters)) {
		throw new Error(`${label}.toolAdapters must be an array`);
	}
	for (const [index, adapter] of manifest.toolAdapters.entries()) {
		const adapterLabel = `${label}.toolAdapters[${index}]`;
		if (!isObject(adapter)) {
			throw new Error(`${adapterLabel} must be an object`);
		}
		requireString(adapter.tool, `${adapterLabel}.tool`);
		if (!TOOL_ADAPTER_MODES.includes(adapter.mode)) {
			throw new Error(
				`${adapterLabel}.mode must be one of: ${TOOL_ADAPTER_MODES.join(", ")}`,
			);
		}
		requireOptionalString(adapter.fixturePath, `${adapterLabel}.fixturePath`);
		requireOptionalString(adapter.rationale, `${adapterLabel}.rationale`);
	}
	if (!isObject(manifest.redaction)) {
		throw new Error(`${label}.redaction must be an object`);
	}
	if (typeof manifest.redaction.secretsRemoved !== "boolean") {
		throw new Error(`${label}.redaction.secretsRemoved must be a boolean`);
	}
	if (typeof manifest.redaction.rawPromptsIncluded !== "boolean") {
		throw new Error(`${label}.redaction.rawPromptsIncluded must be a boolean`);
	}
	requireOptionalStringArray(
		manifest.redaction.notes,
		`${label}.redaction.notes`,
	);
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
	if (source.workspaceManifestPath) {
		const manifestPath = resolvePath(source.workspaceManifestPath);
		const workspaceManifest = loadTypedJson<MaestroScenarioWorkspaceManifest>(
			manifestPath,
			MAESTRO_SCENARIO_WORKSPACE_MANIFEST_SCHEMA,
			"workspace manifest",
		);
		validateWorkspaceManifest(
			workspaceManifest,
			`workspace manifest at ${manifestPath}`,
		);
		inputs.workspaceManifest = workspaceManifest;
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
	if (scenario.source.workspaceManifestPath !== undefined) {
		requireString(
			scenario.source.workspaceManifestPath,
			`${label}.source.workspaceManifestPath`,
		);
	}
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
	if (scenario.releaseGate !== undefined) {
		if (!isObject(scenario.releaseGate)) {
			throw new Error(`${label}.releaseGate must be an object`);
		}
		if (typeof scenario.releaseGate.releaseBlocking !== "boolean") {
			throw new Error(`${label}.releaseGate.releaseBlocking must be a boolean`);
		}
		if (!RELEASE_GATE_TIERS.includes(scenario.releaseGate.tier)) {
			throw new Error(
				`${label}.releaseGate.tier must be one of: ${RELEASE_GATE_TIERS.join(", ")}`,
			);
		}
		if (
			!Array.isArray(scenario.releaseGate.requiredArtifacts) ||
			scenario.releaseGate.requiredArtifacts.length === 0
		) {
			throw new Error(
				`${label}.releaseGate.requiredArtifacts must not be empty`,
			);
		}
		const unknownArtifacts = scenario.releaseGate.requiredArtifacts.filter(
			(artifact) => !REQUIRED_ARTIFACTS.includes(artifact),
		);
		if (unknownArtifacts.length > 0) {
			throw new Error(
				`${label}.releaseGate.requiredArtifacts contains unknown artifact(s): ${unknownArtifacts.join(", ")}`,
			);
		}
		if (
			scenario.releaseGate.releaseBlocking &&
			!scenario.releaseGate.requiredArtifacts.includes("workspace_manifest")
		) {
			throw new Error(
				`${label}.releaseGate release-blocking scenarios must require workspace_manifest`,
			);
		}
		if (
			scenario.releaseGate.requiredArtifacts.includes("inspection") &&
			!scenario.source.inspectionPath
		) {
			throw new Error(
				`${label}.releaseGate requires inspection but source.inspectionPath is missing`,
			);
		}
		if (
			scenario.releaseGate.requiredArtifacts.includes("workspace_manifest") &&
			!scenario.source.workspaceManifestPath
		) {
			throw new Error(
				`${label}.releaseGate requires workspace_manifest but source.workspaceManifestPath is missing`,
			);
		}
		requireOptionalNonNegativeInteger(
			scenario.releaseGate.maxEvents,
			`${label}.releaseGate.maxEvents`,
		);
		requireOptionalNonNegativeInteger(
			scenario.releaseGate.maxToolCalls,
			`${label}.releaseGate.maxToolCalls`,
		);
		requireOptionalNonNegativeInteger(
			scenario.releaseGate.maxReplayDeltas,
			`${label}.releaseGate.maxReplayDeltas`,
		);
		requireOptionalNonNegativeInteger(
			scenario.releaseGate.maxScoreFailures,
			`${label}.releaseGate.maxScoreFailures`,
		);
		requireOptionalNonNegativeInteger(
			scenario.releaseGate.maxScoreWarnings,
			`${label}.releaseGate.maxScoreWarnings`,
		);
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
	if (scenario.externalRefs !== undefined) {
		if (!isObject(scenario.externalRefs)) {
			throw new Error(`${label}.externalRefs must be an object`);
		}
		let refs = 0;
		for (const field of EXTERNAL_REF_FIELDS) {
			const values = scenario.externalRefs[field];
			if (values === undefined) continue;
			if (
				!Array.isArray(values) ||
				values.some((value) => typeof value !== "string" || value.length === 0)
			) {
				throw new Error(
					`${label}.externalRefs.${field} must contain non-empty strings`,
				);
			}
			refs += values.length;
		}
		if (refs === 0) {
			throw new Error(`${label}.externalRefs must contain at least one ref`);
		}
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
	let hasWorkspaceManifestAssertion = false;
	let hasWarningWorkspaceManifestAssertion = false;
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
		if (kind === "workspace.manifest") {
			hasWorkspaceManifestAssertion = true;
			hasWarningWorkspaceManifestAssertion =
				hasWarningWorkspaceManifestAssertion ||
				assertion.severity === "warning";
			if (!scenario.source.workspaceManifestPath) {
				throw new Error(
					`${label}.assertions[].kind workspace.manifest requires source.workspaceManifestPath`,
				);
			}
			requireOptionalStringArray(
				assertion.requiredWorkspaceFiles,
				`${label}.assertions[].requiredWorkspaceFiles`,
			);
			requireOptionalStringArray(
				assertion.requiredToolAdapters,
				`${label}.assertions[].requiredToolAdapters`,
			);
			if (
				assertion.requiredHydrationModes !== undefined &&
				(!Array.isArray(assertion.requiredHydrationModes) ||
					assertion.requiredHydrationModes.some(
						(mode) => !HYDRATION_MODES.includes(mode),
					))
			) {
				throw new Error(
					`${label}.assertions[].requiredHydrationModes must contain known hydration modes`,
				);
			}
			if (
				assertion.requiredReleaseGateTier !== undefined &&
				!RELEASE_GATE_TIERS.includes(assertion.requiredReleaseGateTier)
			) {
				throw new Error(
					`${label}.assertions[].requiredReleaseGateTier must be one of: ${RELEASE_GATE_TIERS.join(", ")}`,
				);
			}
			requireOptionalNonNegativeInteger(
				assertion.minWorkspaceFiles,
				`${label}.assertions[].minWorkspaceFiles`,
			);
			requireOptionalNonNegativeInteger(
				assertion.minToolAdapters,
				`${label}.assertions[].minToolAdapters`,
			);
		}
		if (
			kind === "external.refs" &&
			(!Array.isArray(assertion.requiredExternalRefKinds) ||
				assertion.requiredExternalRefKinds.length === 0)
		) {
			throw new Error(
				`${label}.assertions[].requiredExternalRefKinds must not be empty for external.refs`,
			);
		}
		if (kind === "external.refs") {
			const unknownKinds = (assertion.requiredExternalRefKinds ?? []).filter(
				(refKind) => !EXTERNAL_REF_FIELDS.includes(refKind),
			);
			if (unknownKinds.length > 0) {
				throw new Error(
					`${label}.assertions[].requiredExternalRefKinds contains unknown external ref kind(s): ${unknownKinds.join(", ")}`,
				);
			}
			if (
				assertion.requiredExternalRefs !== undefined &&
				(!Array.isArray(assertion.requiredExternalRefs) ||
					assertion.requiredExternalRefs.some(
						(ref) => typeof ref !== "string" || ref.length === 0,
					))
			) {
				throw new Error(
					`${label}.assertions[].requiredExternalRefs must contain non-empty strings for external.refs`,
				);
			}
		}
	}
	if (
		scenario.releaseGate?.releaseBlocking === true &&
		scenario.releaseGate.requiredArtifacts.includes("workspace_manifest") &&
		!hasWorkspaceManifestAssertion
	) {
		throw new Error(
			`${label}.releaseGate release-blocking workspace_manifest gates must include a workspace.manifest assertion`,
		);
	}
	if (
		scenario.releaseGate?.releaseBlocking === true &&
		scenario.releaseGate.requiredArtifacts.includes("workspace_manifest") &&
		hasWarningWorkspaceManifestAssertion
	) {
		throw new Error(
			`${label}.releaseGate release-blocking workspace_manifest assertions must use error severity`,
		);
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

function workspaceEvidence(
	manifest: MaestroScenarioWorkspaceManifest,
): AgentTrajectoryScenarioEvidence[] {
	return [
		{
			kind: "workspace_manifest",
			id: manifest.id,
			source: "scenario",
			label: `workspace_manifest:${manifest.id}`,
		},
		...manifest.toolAdapters.map((adapter) => ({
			kind: "tool_adapter",
			id: adapter.tool,
			source: "scenario" as const,
			label: `tool_adapter:${adapter.tool}:${adapter.mode}`,
		})),
	];
}

function buildWorkspaceSummary(
	manifest: MaestroScenarioWorkspaceManifest | undefined,
): AgentTrajectoryScenarioWorkspaceSummary | undefined {
	if (!manifest) return undefined;
	return {
		manifestId: manifest.id,
		source: manifest.source,
		recordedAt: manifest.recordedAt,
		hydrationMode: manifest.hydration.mode,
		files: manifest.files.length,
		toolAdapters: manifest.toolAdapters.length,
	};
}

function hasRequiredArtifact(
	artifact: MaestroScenarioRequiredArtifact,
	inputs: ScenarioInputs,
): boolean {
	switch (artifact) {
		case "trajectory":
			return true;
		case "replay":
			return true;
		case "score":
			return true;
		case "inspection":
			return inputs.inspection !== undefined;
		case "workspace_manifest":
			return inputs.workspaceManifest !== undefined;
	}
}

function workspaceReleasePolicyViolations(
	gate: MaestroScenarioReleaseGate,
	inputs: ScenarioInputs,
): string[] {
	if (!gate.requiredArtifacts.includes("workspace_manifest")) {
		return [];
	}
	const manifest = inputs.workspaceManifest;
	if (!manifest) {
		return [];
	}
	return [
		manifest.redaction.secretsRemoved !== true
			? "workspace manifest did not confirm secret redaction"
			: undefined,
		manifest.redaction.rawPromptsIncluded !== false
			? "workspace manifest did not confirm raw prompts were excluded"
			: undefined,
	].filter((value): value is string => value !== undefined);
}

function buildReleaseGateSummary(
	scenario: MaestroScenario,
	inputs: ScenarioInputs,
): AgentTrajectoryScenarioReleaseGateSummary | undefined {
	const gate = scenario.releaseGate;
	if (!gate) return undefined;
	const observedToolCalls = countToolCalls(inputs.trajectory);
	const observedFailures = scoreFailures(inputs.score);
	const observedWarnings = scoreWarnings(inputs.score);
	const missingArtifacts = gate.requiredArtifacts.filter(
		(artifact) => !hasRequiredArtifact(artifact, inputs),
	);
	const budgetViolations = [
		gate.maxEvents !== undefined &&
		inputs.trajectory.counts.events > gate.maxEvents
			? `events ${inputs.trajectory.counts.events}/${gate.maxEvents}`
			: undefined,
		gate.maxToolCalls !== undefined && observedToolCalls > gate.maxToolCalls
			? `toolCalls ${observedToolCalls}/${gate.maxToolCalls}`
			: undefined,
		gate.maxReplayDeltas !== undefined &&
		inputs.replay.counts.deltas > gate.maxReplayDeltas
			? `replayDeltas ${inputs.replay.counts.deltas}/${gate.maxReplayDeltas}`
			: undefined,
		gate.maxScoreFailures !== undefined &&
		observedFailures > gate.maxScoreFailures
			? `scoreFailures ${observedFailures}/${gate.maxScoreFailures}`
			: undefined,
		gate.maxScoreWarnings !== undefined &&
		observedWarnings > gate.maxScoreWarnings
			? `scoreWarnings ${observedWarnings}/${gate.maxScoreWarnings}`
			: undefined,
	].filter((value): value is string => value !== undefined);
	const policyViolations = workspaceReleasePolicyViolations(gate, inputs);
	return {
		...gate,
		satisfied:
			missingArtifacts.length === 0 &&
			budgetViolations.length === 0 &&
			policyViolations.length === 0,
		missingArtifacts,
		budgetViolations,
		policyViolations,
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
		case "workspace.manifest": {
			const manifest = inputs.workspaceManifest;
			if (!manifest) {
				return fail(
					assertion,
					"workspace.manifest requires source.workspaceManifestPath.",
				);
			}
			const requiredFiles = assertion.requiredWorkspaceFiles ?? [];
			const requiredAdapters = assertion.requiredToolAdapters ?? [];
			const missingFiles = requiredFiles.filter(
				(path) => !manifest.files.some((file) => file.path === path),
			);
			const missingAdapters = requiredAdapters.filter(
				(tool) =>
					!manifest.toolAdapters.some((adapter) => adapter.tool === tool),
			);
			const allowedHydrationModes = assertion.requiredHydrationModes ?? [];
			const hydrationRejected =
				allowedHydrationModes.length > 0 &&
				!allowedHydrationModes.includes(manifest.hydration.mode);
			const releaseGateRejected =
				assertion.requiredReleaseGateTier !== undefined &&
				scenario.releaseGate?.tier !== assertion.requiredReleaseGateTier;
			const fileFloor = assertion.minWorkspaceFiles ?? 0;
			const adapterFloor = assertion.minToolAdapters ?? 0;
			const floorFailures = [
				manifest.files.length < fileFloor
					? `workspace files ${manifest.files.length}/${fileFloor}`
					: undefined,
				manifest.toolAdapters.length < adapterFloor
					? `tool adapters ${manifest.toolAdapters.length}/${adapterFloor}`
					: undefined,
			].filter((value): value is string => value !== undefined);
			const failures = [
				...missingFiles.map((path) => `missing file ${path}`),
				...missingAdapters.map((tool) => `missing tool adapter ${tool}`),
				hydrationRejected
					? `hydration mode ${manifest.hydration.mode} not allowed`
					: undefined,
				releaseGateRejected
					? `release tier ${scenario.releaseGate?.tier ?? "none"} did not match ${assertion.requiredReleaseGateTier}`
					: undefined,
				...floorFailures,
				manifest.redaction.secretsRemoved !== true
					? "workspace manifest did not confirm secret redaction"
					: undefined,
				manifest.redaction.rawPromptsIncluded !== false
					? "workspace manifest did not confirm raw prompts were excluded"
					: undefined,
			].filter((value): value is string => value !== undefined);
			return failures.length === 0
				? result(
						assertion,
						"pass",
						`Workspace manifest ${manifest.id} is release-gate ready (${manifest.files.length} file(s), ${manifest.toolAdapters.length} tool adapter(s), ${manifest.hydration.mode}).`,
						workspaceEvidence(manifest),
					)
				: fail(
						assertion,
						`Workspace manifest is not release-gate ready: ${failures.join("; ")}.`,
						workspaceEvidence(manifest),
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
		case "external.refs": {
			const externalRefs = scenario.externalRefs;
			if (!externalRefs) {
				return fail(assertion, "external.refs requires scenario.externalRefs.");
			}
			const missingKinds = (assertion.requiredExternalRefKinds ?? []).filter(
				(kind) => {
					const values = externalRefs[kind];
					return !Array.isArray(values) || values.length === 0;
				},
			);
			const flattenedRefs = new Set(
				EXTERNAL_REF_FIELDS.flatMap((field) => externalRefs[field] ?? []),
			);
			const missingRefs = (assertion.requiredExternalRefs ?? []).filter(
				(ref) => !flattenedRefs.has(ref),
			);
			const missing = [...missingKinds, ...missingRefs];
			return missing.length === 0
				? result(
						assertion,
						"pass",
						`External refs present for ${(assertion.requiredExternalRefKinds ?? []).join(", ")}.`,
						scenarioEvidence(scenario.id, "external-refs"),
					)
				: fail(
						assertion,
						`Missing external refs: ${missing.join(", ")}.`,
						scenarioEvidence(scenario.id, "external-refs"),
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
	const releaseGate = buildReleaseGateSummary(scenario, inputs);
	const workspace = buildWorkspaceSummary(inputs.workspaceManifest);
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
		...(scenario.externalRefs ? { externalRefs: scenario.externalRefs } : {}),
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
			workspaceFiles: inputs.workspaceManifest?.files.length ?? 0,
			toolAdapters: inputs.workspaceManifest?.toolAdapters.length ?? 0,
		},
		platform: {
			...scenario.platform,
			evidenceEventType: "maestro.events.eval.scored",
		},
		...(releaseGate ? { releaseGate } : {}),
		...(workspace ? { workspace } : {}),
		assumptions: scenario.assumptions,
		assertions,
		provenance: buildProvenance(inputs.trajectory),
		...(diff ? { diff } : {}),
	};
}

export function scenarioResultToJunit(
	result: AgentTrajectoryScenarioResult,
): string {
	const outcomeMatches =
		result.scenario.observedOutcome === result.scenario.expectedOutcome;
	const failures = result.assertions.filter(
		(assertion) => assertion.status === "fail",
	);
	const testcases = result.assertions
		.map((assertion) => {
			const failure =
				!outcomeMatches && assertion.status === "fail"
					? `\n\t\t<failure message="${escapeXml(assertion.message)}">${escapeXml(
							JSON.stringify(assertion.evidence),
						)}</failure>\n\t`
					: "";
			const expectedFailureOutput =
				outcomeMatches && assertion.status === "fail"
					? `\n\t\t<system-out>${escapeXml(
							[
								`Expected failing assertion observed: ${assertion.message}`,
								JSON.stringify(assertion.evidence),
							].join("\n"),
						)}</system-out>\n\t`
					: "";
			return `\t<testcase classname="${escapeXml(result.scenario.id)}" name="${escapeXml(assertion.id)}">${failure}${expectedFailureOutput}</testcase>`;
		})
		.join("\n");
	const outcomeFailure =
		!outcomeMatches && failures.length === 0
			? `\t<testcase classname="${escapeXml(result.scenario.id)}" name="scenario-outcome">\n\t\t<failure message="${escapeXml(
					`Observed outcome ${result.scenario.observedOutcome}; expected ${result.scenario.expectedOutcome}.`,
				)}"></failure>\n\t</testcase>\n`
			: "";
	const failureCount = outcomeMatches ? 0 : Math.max(1, failures.length);
	const testCount = result.counts.assertions + (outcomeFailure ? 1 : 0);
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(
		result.scenario.id,
	)}" tests="${testCount}" failures="${failureCount}" warnings="${result.counts.warnings}">\n${outcomeFailure}${testcases}\n</testsuite>\n`;
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
