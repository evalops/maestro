import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	llmJudgeOptionsFromArgs,
	llmPairwiseJudgeOptionsFromArgs,
} from "../../scripts/evals/run-platform-fermata-scenario-suite.js";
import {
	buildFermataCreateScenarioSuiteRequest,
	buildFermataRunScenarioSuiteRequest,
} from "../../src/platform/fermata-scenario-suite.js";
import {
	type AgentTrajectoryScenarioResult,
	runAgentTrajectoryScenarioFile,
} from "../../src/server/agent-trajectory-scenarios.js";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"agent-trajectory-scenarios",
);

function loadScenarioResult(name: string): AgentTrajectoryScenarioResult {
	return JSON.parse(
		readFileSync(join(fixturesDir, `${name}.result.json`), "utf8"),
	) as AgentTrajectoryScenarioResult;
}

function runScenario(name: string): AgentTrajectoryScenarioResult {
	return runAgentTrajectoryScenarioFile(join(fixturesDir, `${name}.json`), {
		baseDir: fixturesDir,
	});
}

const originalArgv = process.argv;

function setScriptArgs(...args: string[]): void {
	process.argv = ["node", "run-platform-fermata-scenario-suite.ts", ...args];
}

describe("Fermata scenario suite builder", () => {
	afterEach(() => {
		process.argv = originalArgv;
		vi.unstubAllEnvs();
	});

	it("turns the real local trajectory fixture into replay-backed Fermata cases", () => {
		const expected = loadScenarioResult("local-diagnostic-success");
		const actual = runScenario("local-diagnostic-success");

		const request = buildFermataCreateScenarioSuiteRequest(
			{
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
			},
			expected,
			actual,
		);

		expect(request).toMatchObject({
			organizationId: "org_evalops",
			workspaceId: "ws_evalops",
			name: "Maestro scenario: local-diagnostic-success",
			metadata: expect.objectContaining({
				source: "maestro.agent_trajectory_scenario_result",
				scenario_id: "local-diagnostic-success",
				actual_observed_outcome: "pass",
				evidence_event_type: "maestro.events.eval.scored",
			}),
		});
		expect(request.cases).toHaveLength(19);
		expect(request.cases[0]).toMatchObject({
			id: "local-diagnostic-success.observed-outcome",
			expectedOutput: "pass",
			metadata: expect.objectContaining({
				actual_output: "pass",
				case_kind: "scenario_observed_outcome",
			}),
			assertions: [
				expect.objectContaining({
					kind: "ASSERTION_KIND_EQUALS",
					expected: "pass",
				}),
			],
		});
		expect(
			request.cases.every(
				(testCase) => typeof testCase.metadata?.actual_output === "string",
			),
		).toBe(true);
	});

	it("adds a native agent trajectory case over real replay-backed scenario results", () => {
		const expected = loadScenarioResult("local-diagnostic-success");
		const actual = runScenario("local-diagnostic-success");

		const request = buildFermataCreateScenarioSuiteRequest(
			{
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
			},
			expected,
			actual,
		);

		const trajectoryCase = request.cases.find(
			(testCase) =>
				testCase.metadata?.case_kind === "scenario_agent_trajectory",
		);
		expect(trajectoryCase).toMatchObject({
			id: "local-diagnostic-success.agent-trajectory.native-trajectory-guard",
			expectedOutput: expect.stringContaining('"local-diagnostic-success"'),
			metadata: expect.objectContaining({
				actual_output: expect.stringContaining('"local-diagnostic-success"'),
				source: "maestro.agent_trajectory_scenario_result",
				scenario_id: "local-diagnostic-success",
				actual_run_id: actual.run.id,
				expected_run_id: expected.run.id,
				ci_tier: "core-regression",
			}),
			assertions: [
				expect.objectContaining({
					id: "local-diagnostic-success.agent-trajectory.native-trajectory-guard.agent-trajectory",
					kind: "ASSERTION_KIND_AGENT_TRAJECTORY",
					agentTrajectory: {
						requiredEvents: expect.arrayContaining([
							"session.started",
							"tool.completed",
						]),
						requiredAssertionStatuses: expect.arrayContaining([
							{ id: "replay-clean", status: "pass" },
							{ id: "efficiency-budget", status: "pass" },
						]),
						maxEvents: expected.counts.events,
						maxToolCalls: expected.counts.toolCalls,
						maxReplayDeltas: expected.counts.replayDeltas,
						maxScoreFailures: expected.counts.scoreFailures,
						maxScoreWarnings: expected.counts.scoreWarnings,
						requireIdempotentReplay: true,
						forbidDuplicateExternalActions: true,
						requiredTraceJoinKeys: expected.platform.traceJoinKeys,
					},
				}),
			],
		});
	});

	it("keeps negative real fixtures explicit instead of hiding them from the suite", () => {
		const expected = loadScenarioResult("adversarial-unsafe-tool-negative");
		const actual = runScenario("adversarial-unsafe-tool-negative");
		const request = buildFermataCreateScenarioSuiteRequest(
			{
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
			},
			expected,
			actual,
		);

		const negativeCase = request.cases.find((testCase) =>
			testCase.id?.endsWith("privileged-edit-forbidden"),
		);
		expect(request.cases[0]).toMatchObject({
			expectedOutput: "fail",
			metadata: expect.objectContaining({
				actual_output: "fail",
			}),
		});
		expect(negativeCase).toMatchObject({
			expectedOutput: "fail",
			metadata: expect.objectContaining({
				actual_output: "fail",
				case_kind: "scenario_assertion_status",
				assertion_kind: "event.forbidden",
			}),
		});
	});

	it("adds a strict cataloged Fermata LLM rubric judge case over real trajectory fixtures", () => {
		const expected = loadScenarioResult("local-diagnostic-success");
		const actual = runScenario("local-diagnostic-success");

		const request = buildFermataCreateScenarioSuiteRequest(
			{
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
			},
			expected,
			actual,
			{
				llmJudge: {
					judgeId: "primary-quality",
					verifierJudgeId: "verifier-quality",
					rubric:
						"The actual Maestro trajectory result must be semantically equivalent to the committed result and grounded in real assertion evidence.",
					minScore: 0.8,
					repeat: 2,
					quorum: 2,
					requireCalibratedJudge: true,
					minJudgeValidationAccuracy: 0.9,
					minJudgeValidationCount: 5,
				},
			},
		);

		expect(request.cases).toHaveLength(20);
		const llmCase = request.cases.find(
			(testCase) => testCase.metadata?.case_kind === "scenario_llm_rubric",
		);
		expect(llmCase?.id).toBe(
			"local-diagnostic-success.llm-rubric.semantic-trajectory-quality",
		);
		expect(llmCase?.metadata).toMatchObject({
			source: "maestro.agent_trajectory_scenario_result",
			scenario_id: "local-diagnostic-success",
			expected_assertion_count: expected.counts.assertions,
			actual_assertion_count: actual.counts.assertions,
		});
		expect(llmCase?.assertions[0]).toMatchObject({
			id: "local-diagnostic-success.llm-rubric.semantic-trajectory-quality.llm-rubric",
			kind: "ASSERTION_KIND_LLM_RUBRIC",
			llmRubric: {
				judgeId: "primary-quality",
				verifierJudgeId: "verifier-quality",
				rubric:
					"The actual Maestro trajectory result must be semantically equivalent to the committed result and grounded in real assertion evidence.",
				minScore: 0.8,
				repeat: 2,
				quorum: 2,
				recordJudgeValidation: true,
				requireCalibratedJudge: true,
				minJudgeValidationAccuracy: 0.9,
				minJudgeValidationCount: 5,
			},
		});
		expect(llmCase?.expectedOutput).toContain('"scenario"');
		expect(llmCase?.metadata?.actual_output).toEqual(
			expect.stringContaining('"local-diagnostic-success"'),
		);
	});

	it("adds a native pairwise LLM rubric case comparing real baseline and candidate trajectories", () => {
		const expected = loadScenarioResult("local-diagnostic-success");
		const actual = {
			...runScenario("local-diagnostic-success"),
			run: {
				...expected.run,
				id: "local-diagnostic-success-candidate",
			},
		};

		const request = buildFermataCreateScenarioSuiteRequest(
			{
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
			},
			expected,
			actual,
			{
				llmPairwiseJudge: {
					judgeId: "pairwise-quality",
					verifierJudgeId: "pairwise-verifier",
					rubric:
						"Prefer the Maestro trajectory that is more grounded, complete, and actionable.",
					baselineLabel: "committed",
					candidateLabel: "candidate",
					minScore: 0.7,
					repeat: 2,
					quorum: 2,
					requireCalibratedJudge: true,
					minJudgeValidationAccuracy: 0.9,
					minJudgeValidationCount: 5,
				},
			},
		);

		expect(request.cases).toHaveLength(20);
		const pairwiseCase = request.cases.find(
			(testCase) =>
				testCase.metadata?.case_kind === "scenario_llm_pairwise_rubric",
		);
		expect(pairwiseCase?.id).toBe(
			"local-diagnostic-success.llm-pairwise-rubric.semantic-trajectory-preference",
		);
		expect(pairwiseCase?.expectedOutput).toEqual(
			expect.stringContaining('"local-diagnostic-success"'),
		);
		expect(pairwiseCase?.metadata).toMatchObject({
			actual_output: expect.stringContaining(
				"local-diagnostic-success-candidate",
			),
			source: "maestro.agent_trajectory_scenario_result",
			scenario_id: "local-diagnostic-success",
			baseline_run_id: expected.run.id,
			candidate_run_id: "local-diagnostic-success-candidate",
		});
		expect(pairwiseCase?.assertions[0]).toMatchObject({
			id: "local-diagnostic-success.llm-pairwise-rubric.semantic-trajectory-preference.llm-pairwise-rubric",
			kind: "ASSERTION_KIND_LLM_PAIRWISE_RUBRIC",
			llmPairwiseRubric: {
				judgeId: "pairwise-quality",
				verifierJudgeId: "pairwise-verifier",
				rubric:
					"Prefer the Maestro trajectory that is more grounded, complete, and actionable.",
				baselineLabel: "committed",
				candidateLabel: "candidate",
				minScore: 0.7,
				repeat: 2,
				quorum: 2,
				recordJudgeValidation: true,
				requireCalibratedJudge: true,
				minJudgeValidationAccuracy: 0.9,
				minJudgeValidationCount: 5,
			},
		});
	});

	it("marks optional LLM judges as advisory calibrated trajectory monitors", () => {
		const expected = loadScenarioResult("local-diagnostic-success");
		const actual = {
			...runScenario("local-diagnostic-success"),
			run: {
				...expected.run,
				id: "local-diagnostic-success-candidate",
			},
		};

		const request = buildFermataCreateScenarioSuiteRequest(
			{
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
			},
			expected,
			actual,
			{
				llmJudge: {
					judgeId: "semantic-drift",
					rubric:
						"Flag semantic quality drift after native trajectory invariants pass.",
					advisoryOnly: true,
					rubricVersion: "trajectory-quality/v2",
					calibrationCohort: "maestro-agent-trajectory-v1",
				},
				llmPairwiseJudge: {
					judgeId: "semantic-preference",
					rubric:
						"Prefer the candidate only when it is semantically stronger than the baseline.",
					advisoryOnly: true,
					rubricVersion: "trajectory-preference/v2",
					calibrationCohort: "maestro-agent-trajectory-v1",
				},
			},
		);

		expect(request.cases).toHaveLength(21);
		const llmCase = request.cases.find(
			(testCase) => testCase.metadata?.case_kind === "scenario_llm_rubric",
		);
		expect(llmCase).toMatchObject({
			metadata: expect.objectContaining({
				judge_mode: "advisory",
				rubric_version: "trajectory-quality/v2",
				calibration_cohort: "maestro-agent-trajectory-v1",
			}),
			assertions: [
				expect.objectContaining({
					llmRubric: expect.objectContaining({
						advisoryOnly: true,
						rubricVersion: "trajectory-quality/v2",
						calibrationCohort: "maestro-agent-trajectory-v1",
					}),
					metadata: expect.objectContaining({
						judge_mode: "advisory",
						rubric_version: "trajectory-quality/v2",
						calibration_cohort: "maestro-agent-trajectory-v1",
					}),
				}),
			],
		});
		const pairwiseCase = request.cases.find(
			(testCase) =>
				testCase.metadata?.case_kind === "scenario_llm_pairwise_rubric",
		);
		expect(pairwiseCase).toMatchObject({
			metadata: expect.objectContaining({
				judge_mode: "advisory",
				rubric_version: "trajectory-preference/v2",
				calibration_cohort: "maestro-agent-trajectory-v1",
			}),
			assertions: [
				expect.objectContaining({
					llmPairwiseRubric: expect.objectContaining({
						advisoryOnly: true,
						rubricVersion: "trajectory-preference/v2",
						calibrationCohort: "maestro-agent-trajectory-v1",
					}),
					metadata: expect.objectContaining({
						judge_mode: "advisory",
						rubric_version: "trajectory-preference/v2",
						calibration_cohort: "maestro-agent-trajectory-v1",
					}),
				}),
			],
		});
	});

	it("fails closed for invalid Fermata LLM judge options", () => {
		const expected = loadScenarioResult("local-diagnostic-success");
		const actual = runScenario("local-diagnostic-success");

		expect(() =>
			buildFermataCreateScenarioSuiteRequest(
				{ organizationId: "org_evalops", workspaceId: "ws_evalops" },
				expected,
				actual,
				{
					llmJudge: {
						judgeId: "",
						rubric: "must be grounded",
					},
				},
			),
		).toThrow("requires judgeId");
		expect(() =>
			buildFermataCreateScenarioSuiteRequest(
				{ organizationId: "org_evalops", workspaceId: "ws_evalops" },
				expected,
				actual,
				{
					llmJudge: {
						judgeId: "primary-quality",
						rubric: "must be grounded",
						repeat: 1,
						quorum: 2,
					},
				},
			),
		).toThrow("quorum cannot exceed repeat");
	});

	it("fails closed when partial Fermata LLM judge CLI config omits the judge id", () => {
		setScriptArgs("--llm-rubric", "must be grounded");

		expect(() => llmJudgeOptionsFromArgs()).toThrow("requires --llm-judge-id");
	});

	it("fails closed when partial Fermata LLM judge env config omits the judge id", () => {
		setScriptArgs();
		vi.stubEnv("FERMATA_LLM_REPEAT", "3");

		expect(() => llmJudgeOptionsFromArgs()).toThrow("requires --llm-judge-id");
	});

	it("fails closed when partial Fermata pairwise LLM judge CLI config omits the judge id", () => {
		setScriptArgs(
			"--llm-pairwise-rubric",
			"candidate must beat the real baseline",
		);

		expect(() => llmPairwiseJudgeOptionsFromArgs()).toThrow(
			"requires --llm-pairwise-judge-id",
		);
	});

	it("parses Fermata pairwise LLM judge CLI config", () => {
		setScriptArgs(
			"--llm-pairwise-judge-id",
			"pairwise-quality",
			"--llm-pairwise-verifier-judge-id",
			"pairwise-verifier",
			"--llm-pairwise-rubric",
			"prefer the grounded trajectory",
			"--llm-pairwise-baseline-label",
			"committed",
			"--llm-pairwise-candidate-label",
			"candidate",
			"--llm-pairwise-min-score",
			"0.7",
			"--llm-pairwise-repeat",
			"3",
			"--llm-pairwise-quorum",
			"2",
			"--llm-pairwise-record-validation",
			"false",
			"--llm-pairwise-advisory",
			"true",
			"--llm-pairwise-rubric-version",
			"trajectory-preference/v2",
			"--llm-pairwise-calibration-cohort",
			"maestro-agent-trajectory-v1",
		);

		expect(llmPairwiseJudgeOptionsFromArgs()).toMatchObject({
			judgeId: "pairwise-quality",
			verifierJudgeId: "pairwise-verifier",
			rubric: "prefer the grounded trajectory",
			baselineLabel: "committed",
			candidateLabel: "candidate",
			minScore: 0.7,
			repeat: 3,
			quorum: 2,
			recordJudgeValidation: false,
			advisoryOnly: true,
			rubricVersion: "trajectory-preference/v2",
			calibrationCohort: "maestro-agent-trajectory-v1",
		});
	});

	it("parses Fermata advisory LLM judge CLI config", () => {
		setScriptArgs(
			"--llm-judge-id",
			"semantic-drift",
			"--llm-rubric",
			"flag semantic drift",
			"--llm-advisory",
			"true",
			"--llm-rubric-version",
			"trajectory-quality/v2",
			"--llm-calibration-cohort",
			"maestro-agent-trajectory-v1",
		);

		expect(llmJudgeOptionsFromArgs()).toMatchObject({
			judgeId: "semantic-drift",
			rubric: "flag semantic drift",
			advisoryOnly: true,
			rubricVersion: "trajectory-quality/v2",
			calibrationCohort: "maestro-agent-trajectory-v1",
		});
	});

	it("builds a typed candidate run request without REST or local-runner fallback fields", () => {
		const expected = loadScenarioResult("hosted-degraded-recovery");
		const actual = {
			...runScenario("hosted-degraded-recovery"),
			run: {
				...expected.run,
				id: "hosted-degraded-recovery-actual",
			},
			scenario: {
				...expected.scenario,
				observedOutcome: "warn",
			},
		};
		const request = buildFermataRunScenarioSuiteRequest(
			{
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
			},
			"suite_real_1",
			expected,
			actual,
		);

		expect(request).toMatchObject({
			suiteId: "suite_real_1",
			organizationId: "org_evalops",
			workspaceId: "ws_evalops",
			maxConcurrency: 1,
			stopOnFirstFailure: false,
			candidates: [
				expect.objectContaining({
					candidateId: "maestro-recorded.hosted-degraded-recovery",
					model: "maestro-agent-trajectory-replay",
				}),
			],
		});
		expect(request.metadata).toMatchObject({
			expected_run_id: expected.run.id,
			actual_run_id: "hosted-degraded-recovery-actual",
			committed_observed_outcome: expected.scenario.observedOutcome,
			actual_observed_outcome: "warn",
		});
		expect(request.runContext).toMatchObject({
			source: "maestro.agent_trajectory_scenario_result",
			scenarioId: "hosted-degraded-recovery",
		});
		expect(request.runContext).not.toHaveProperty("actual");
		expect(request.runContext).not.toHaveProperty("actual_output");
	});
});
