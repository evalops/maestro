import type {
	CreateFermataTestSuiteRequest,
	FermataEvalServiceConfig,
	FermataLLMRubricAssertion,
	FermataTestCase,
	RunFermataTestSuiteRequest,
} from "./fermata-eval-client.js";

type AgentTrajectoryScenarioAssertionStatus = "pass" | "fail" | "warn";

interface AgentTrajectoryScenarioEvidence {
	kind: string;
	id: string;
	source: string;
	label: string;
}

interface AgentTrajectoryScenarioAssertionResult {
	id: string;
	kind: string;
	status: AgentTrajectoryScenarioAssertionStatus;
	severity: string;
	message: string;
	evidence: AgentTrajectoryScenarioEvidence[];
}

interface AgentTrajectoryScenarioResult {
	schemaVersion: string;
	scenarioSchemaVersion: string;
	scenario: {
		id: string;
		title: string;
		expectedOutcome: string;
		observedOutcome: string;
		reviewLabels: string[];
	};
	run: {
		id: string;
		sessionId: string;
		source?: string;
		platformBacked?: boolean;
		scenarioId?: string;
		replay?: boolean;
		generatedAt?: string;
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
	platform: {
		primitive: string;
		evidenceEventType: string;
		traceJoinKeys: string[];
		eventType?: string;
		rationale?: string;
	};
	assertions: AgentTrajectoryScenarioAssertionResult[];
}

const COUNT_KEYS = [
	"assertions",
	"passed",
	"failed",
	"warnings",
	"events",
	"toolCalls",
	"replayDeltas",
	"scoreFailures",
	"scoreWarnings",
] as const;

export interface FermataScenarioSuiteLLMJudgeOptions {
	judgeId: string;
	verifierJudgeId?: string;
	rubric: string;
	minScore?: number;
	repeat?: number;
	quorum?: number;
	recordJudgeValidation?: boolean;
	requireCalibratedJudge?: boolean;
	minJudgeValidationAccuracy?: number;
	minJudgeValidationCount?: number;
}

export interface FermataScenarioSuiteOptions {
	name?: string;
	description?: string;
	model?: string;
	candidateId?: string;
	candidateLabel?: string;
	evaluationId?: string;
	runIdPrefix?: string;
	lineageId?: string;
	traceId?: string;
	maxConcurrency?: number;
	metadata?: Record<string, unknown>;
	llmJudge?: FermataScenarioSuiteLLMJudgeOptions;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableId(...parts: string[]): string {
	const id = parts
		.join(".")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.replace(/--+/gu, "-");
	return id || "maestro-scenario";
}

function scenarioResultLabel(result: AgentTrajectoryScenarioResult): string {
	return `${result.scenario.id} (${result.run.id})`;
}

function requireSameScenario(
	expected: AgentTrajectoryScenarioResult,
	actual: AgentTrajectoryScenarioResult,
): void {
	if (expected.scenario.id !== actual.scenario.id) {
		throw new Error(
			`Fermata scenario suite requires matching scenario ids; expected ${scenarioResultLabel(
				expected,
			)}, received ${scenarioResultLabel(actual)}`,
		);
	}
	if (expected.schemaVersion !== actual.schemaVersion) {
		throw new Error(
			`Fermata scenario suite requires matching result schema versions for ${expected.scenario.id}`,
		);
	}
}

function serializeCaseInput(value: Record<string, unknown>): string {
	return JSON.stringify(value, null, "\t");
}

function assertionMap(
	result: AgentTrajectoryScenarioResult,
): Map<string, AgentTrajectoryScenarioAssertionResult> {
	return new Map(
		result.assertions.map((assertion) => [assertion.id, assertion]),
	);
}

function evidenceLabels(
	assertion: AgentTrajectoryScenarioAssertionResult | undefined,
): string[] {
	return (assertion?.evidence ?? []).map(
		(evidence) => `${evidence.source}:${evidence.kind}:${evidence.id}`,
	);
}

function requireNonEmpty(value: string | undefined, label: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(`Fermata scenario suite LLM judge requires ${label}`);
	}
	return trimmed;
}

function optionalPositiveNumber(
	value: number | undefined,
	label: string,
	max?: number,
): number | undefined {
	if (value === undefined) return undefined;
	if (
		!Number.isFinite(value) ||
		value <= 0 ||
		(max !== undefined && value > max)
	) {
		throw new Error(`Fermata scenario suite LLM judge ${label} is invalid`);
	}
	return value;
}

function optionalPositiveInteger(
	value: number | undefined,
	label: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Fermata scenario suite LLM judge ${label} is invalid`);
	}
	return value;
}

function llmRubricConfig(
	options: FermataScenarioSuiteLLMJudgeOptions,
): FermataLLMRubricAssertion {
	const repeat = optionalPositiveInteger(options.repeat, "repeat");
	const quorum = optionalPositiveInteger(options.quorum, "quorum");
	if (repeat !== undefined && quorum !== undefined && quorum > repeat) {
		throw new Error(
			"Fermata scenario suite LLM judge quorum cannot exceed repeat",
		);
	}
	return {
		judgeId: requireNonEmpty(options.judgeId, "judgeId"),
		verifierJudgeId: options.verifierJudgeId?.trim() || undefined,
		rubric: requireNonEmpty(options.rubric, "rubric"),
		minScore: optionalPositiveNumber(options.minScore, "minScore", 1),
		repeat,
		quorum,
		recordJudgeValidation: options.recordJudgeValidation ?? true,
		requireCalibratedJudge: options.requireCalibratedJudge,
		minJudgeValidationAccuracy: optionalPositiveNumber(
			options.minJudgeValidationAccuracy,
			"minJudgeValidationAccuracy",
			1,
		),
		minJudgeValidationCount: optionalPositiveInteger(
			options.minJudgeValidationCount,
			"minJudgeValidationCount",
		),
	};
}

function realScenarioResultJSON(result: AgentTrajectoryScenarioResult): string {
	return JSON.stringify(result, null, "\t");
}

function llmRubricCase(
	expected: AgentTrajectoryScenarioResult,
	actual: AgentTrajectoryScenarioResult,
	options: FermataScenarioSuiteLLMJudgeOptions,
): FermataTestCase {
	const scenarioId = expected.scenario.id;
	const id = stableId(scenarioId, "llm-rubric", "semantic-trajectory-quality");
	return {
		id,
		name: `${scenarioId} semantic trajectory quality`,
		input: serializeCaseInput({
			scenarioId,
			title: expected.scenario.title,
			platformPrimitive: actual.platform.primitive,
			expectedRunId: expected.run.id,
			actualRunId: actual.run.id,
			traceJoinKeys: actual.platform.traceJoinKeys,
			expectedAssertionIds: expected.assertions.map(
				(assertion) => assertion.id,
			),
			actualAssertionIds: actual.assertions.map((assertion) => assertion.id),
		}),
		expectedOutput: realScenarioResultJSON(expected),
		metadata: {
			actual_output: realScenarioResultJSON(actual),
			case_kind: "scenario_llm_rubric",
			scenario_id: scenarioId,
			expected_run_id: expected.run.id,
			actual_run_id: actual.run.id,
			expected_assertion_count: expected.counts.assertions,
			actual_assertion_count: actual.counts.assertions,
			source: "maestro.agent_trajectory_scenario_result",
		},
		assertions: [
			{
				id: `${id}.llm-rubric`,
				kind: "ASSERTION_KIND_LLM_RUBRIC",
				target: "response",
				description:
					"Cataloged Fermata LLM judge evaluates semantic trajectory quality against the committed real Maestro scenario result.",
				llmRubric: llmRubricConfig(options),
				metadata: {
					source: "maestro.agent_trajectory_scenario_result",
					case_kind: "scenario_llm_rubric",
				},
			},
		],
	};
}

function equalsCase(
	id: string,
	name: string,
	input: Record<string, unknown>,
	expected: string,
	actual: string,
	metadata: Record<string, unknown>,
): FermataTestCase {
	return {
		id,
		name,
		input: serializeCaseInput(input),
		expectedOutput: expected,
		metadata: {
			...metadata,
			actual_output: actual,
		},
		assertions: [
			{
				id: `${id}.equals`,
				kind: "ASSERTION_KIND_EQUALS",
				target: "response",
				expected,
				metadata: {
					source: "maestro.agent_trajectory_scenario_result",
				},
			},
		],
	};
}

function outcomeCase(
	expected: AgentTrajectoryScenarioResult,
	actual: AgentTrajectoryScenarioResult,
): FermataTestCase {
	const scenarioId = expected.scenario.id;
	return equalsCase(
		stableId(scenarioId, "observed-outcome"),
		`${scenarioId} observed outcome`,
		{
			scenarioId,
			title: expected.scenario.title,
			expectedOutcome: expected.scenario.expectedOutcome,
			committedObservedOutcome: expected.scenario.observedOutcome,
			actualObservedOutcome: actual.scenario.observedOutcome,
		},
		expected.scenario.observedOutcome,
		actual.scenario.observedOutcome,
		{
			case_kind: "scenario_observed_outcome",
			scenario_id: scenarioId,
			expected_outcome: expected.scenario.expectedOutcome,
			expected_observed_outcome: expected.scenario.observedOutcome,
			actual_observed_outcome: actual.scenario.observedOutcome,
			review_labels: actual.scenario.reviewLabels,
		},
	);
}

function countCases(
	expected: AgentTrajectoryScenarioResult,
	actual: AgentTrajectoryScenarioResult,
): FermataTestCase[] {
	return COUNT_KEYS.map((key) =>
		equalsCase(
			stableId(expected.scenario.id, "count", key),
			`${expected.scenario.id} ${key} count`,
			{
				scenarioId: expected.scenario.id,
				count: key,
				expected: expected.counts[key],
				actual: actual.counts[key],
			},
			String(expected.counts[key]),
			String(actual.counts[key]),
			{
				case_kind: "scenario_count",
				scenario_id: expected.scenario.id,
				count: key,
				expected_count: expected.counts[key],
				actual_count: actual.counts[key],
			},
		),
	);
}

function assertionCases(
	expected: AgentTrajectoryScenarioResult,
	actual: AgentTrajectoryScenarioResult,
): FermataTestCase[] {
	const actualById = assertionMap(actual);
	return expected.assertions.map((expectedAssertion) => {
		const actualAssertion = actualById.get(expectedAssertion.id);
		const actualStatus = actualAssertion?.status ?? "missing";
		return equalsCase(
			stableId(expected.scenario.id, "assertion", expectedAssertion.id),
			`${expected.scenario.id} ${expectedAssertion.id}`,
			{
				scenarioId: expected.scenario.id,
				assertionId: expectedAssertion.id,
				kind: expectedAssertion.kind,
				expectedStatus: expectedAssertion.status,
				actualStatus,
				expectedMessage: expectedAssertion.message,
				actualMessage: actualAssertion?.message ?? null,
			},
			expectedAssertion.status,
			actualStatus,
			{
				case_kind: "scenario_assertion_status",
				scenario_id: expected.scenario.id,
				assertion_id: expectedAssertion.id,
				assertion_kind: expectedAssertion.kind,
				severity: expectedAssertion.severity,
				expected_message: expectedAssertion.message,
				actual_message: actualAssertion?.message,
				expected_evidence: evidenceLabels(expectedAssertion),
				actual_evidence: evidenceLabels(actualAssertion),
			},
		);
	});
}

function suiteMetadata(
	expected: AgentTrajectoryScenarioResult,
	actual: AgentTrajectoryScenarioResult,
	extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
	return {
		source: "maestro.agent_trajectory_scenario_result",
		schema_version: actual.schemaVersion,
		scenario_schema_version: actual.scenarioSchemaVersion,
		scenario_id: actual.scenario.id,
		scenario_title: actual.scenario.title,
		expected_run_id: expected.run.id,
		actual_run_id: actual.run.id,
		expected_outcome: expected.scenario.expectedOutcome,
		committed_observed_outcome: expected.scenario.observedOutcome,
		actual_observed_outcome: actual.scenario.observedOutcome,
		platform_primitive: actual.platform.primitive,
		evidence_event_type: actual.platform.evidenceEventType,
		trace_join_keys: actual.platform.traceJoinKeys,
		...(isObject(extra) ? extra : {}),
	};
}

export function buildFermataCreateScenarioSuiteRequest(
	config: Pick<FermataEvalServiceConfig, "organizationId" | "workspaceId">,
	expected: AgentTrajectoryScenarioResult,
	actual: AgentTrajectoryScenarioResult,
	options: FermataScenarioSuiteOptions = {},
): CreateFermataTestSuiteRequest {
	requireSameScenario(expected, actual);
	if (!config.organizationId || !config.workspaceId) {
		throw new Error(
			"Fermata scenario suite requires organizationId and workspaceId",
		);
	}
	const scenarioId = expected.scenario.id;
	return {
		organizationId: config.organizationId,
		workspaceId: config.workspaceId,
		name: options.name ?? `Maestro scenario: ${scenarioId}`,
		description:
			options.description ??
			`Recorded Maestro agent trajectory scenario suite for ${scenarioId}.`,
		cases: [
			outcomeCase(expected, actual),
			...countCases(expected, actual),
			...assertionCases(expected, actual),
			...(options.llmJudge
				? [llmRubricCase(expected, actual, options.llmJudge)]
				: []),
		],
		metadata: suiteMetadata(expected, actual, options.metadata),
	};
}

export function buildFermataRunScenarioSuiteRequest(
	config: Pick<FermataEvalServiceConfig, "organizationId" | "workspaceId">,
	suiteId: string,
	expected: AgentTrajectoryScenarioResult,
	actual: AgentTrajectoryScenarioResult,
	options: FermataScenarioSuiteOptions = {},
): RunFermataTestSuiteRequest {
	if (!config.organizationId || !config.workspaceId) {
		throw new Error(
			"Fermata scenario suite run requires organizationId and workspaceId",
		);
	}
	const scenarioId = actual.scenario.id;
	const runId = stableId(scenarioId, actual.run.id);
	const model = options.model ?? "maestro-agent-trajectory-replay";
	return {
		suiteId,
		organizationId: config.organizationId,
		workspaceId: config.workspaceId,
		evaluationId: options.evaluationId ?? `maestro-${runId}`,
		runIdPrefix: options.runIdPrefix ?? stableId("maestro", scenarioId),
		lineageId: options.lineageId ?? actual.run.id,
		traceId: options.traceId,
		maxConcurrency: options.maxConcurrency ?? 1,
		stopOnFirstFailure: false,
		runContext: {
			source: "maestro.agent_trajectory_scenario_result",
			scenarioId,
			runId: actual.run.id,
			sessionId: actual.run.sessionId,
			platformPrimitive: actual.platform.primitive,
			traceJoinKeys: actual.platform.traceJoinKeys,
		},
		metadata: suiteMetadata(expected, actual, options.metadata),
		candidates: [
			{
				candidateId:
					options.candidateId ?? stableId("maestro-recorded", scenarioId),
				label: options.candidateLabel ?? "Maestro recorded trajectory",
				model,
				metadata: {
					source: "maestro.agent_trajectory_scenario_result",
					scenario_id: scenarioId,
					run_id: actual.run.id,
				},
			},
		],
	};
}
