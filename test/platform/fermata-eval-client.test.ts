import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFermataTestSuiteWithPlatform,
	requireFermataEvalServiceConfig,
	resolveFermataEvalServiceConfig,
	runFermataTestSuiteWithPlatform,
} from "../../src/platform/fermata-eval-client.js";
import {
	buildFermataCreateScenarioSuiteRequest,
	buildFermataRunScenarioSuiteRequest,
} from "../../src/platform/fermata-scenario-suite.js";
import {
	type AgentTrajectoryScenarioResult,
	runAgentTrajectoryScenarioFile,
} from "../../src/server/agent-trajectory-scenarios.js";

type CapturedRequest = {
	body?: Record<string, unknown>;
	headers: Record<string, string>;
	method?: string;
	pathname: string;
	url: string;
};

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"agent-trajectory-scenarios",
);

function headersToRecord(
	headers: HeadersInit | undefined,
): Record<string, string> {
	return Object.fromEntries(new Headers(headers).entries());
}

function parseRequestBody(
	body: BodyInit | null | undefined,
): Record<string, unknown> | undefined {
	return typeof body === "string"
		? (JSON.parse(body) as Record<string, unknown>)
		: undefined;
}

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

describe("Fermata eval Platform client", () => {
	let requests: CapturedRequest[];

	beforeEach(() => {
		requests = [];
		for (const name of [
			"FERMATA_SERVICE_URL",
			"MAESTRO_FERMATA_SERVICE_URL",
			"MAESTRO_FERMATA_EXECUTION_SERVICE_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"FERMATA_SERVICE_TOKEN",
			"MAESTRO_FERMATA_SERVICE_TOKEN",
			"MAESTRO_FERMATA_EXECUTION_SERVICE_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
			"FERMATA_SERVICE_ORGANIZATION_ID",
			"MAESTRO_FERMATA_ORGANIZATION_ID",
			"MAESTRO_FERMATA_EXECUTION_ORGANIZATION_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"EVALOPS_ORG_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"FERMATA_SERVICE_WORKSPACE_ID",
			"MAESTRO_FERMATA_WORKSPACE_ID",
			"MAESTRO_FERMATA_EXECUTION_WORKSPACE_ID",
			"MAESTRO_EVALOPS_WORKSPACE_ID",
			"EVALOPS_WORKSPACE_ID",
			"MAESTRO_WORKSPACE_ID",
			"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
		]) {
			vi.stubEnv(name, "");
		}
		vi.stubEnv(
			"FERMATA_SERVICE_URL",
			"https://platform.test/fermata.v1.FermataService/CreateTestSuite",
		);
		vi.stubEnv("FERMATA_SERVICE_TOKEN", "fermata-token");
		vi.stubEnv("FERMATA_SERVICE_ORGANIZATION_ID", "org_evalops");
		vi.stubEnv("FERMATA_SERVICE_WORKSPACE_ID", "ws_evalops");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const parsed = new URL(url);
				const body = parseRequestBody(init?.body);
				requests.push({
					body,
					headers: headersToRecord(init?.headers),
					method: init?.method,
					pathname: parsed.pathname,
					url,
				});

				if (parsed.pathname === "/fermata.v1.FermataService/CreateTestSuite") {
					return new Response(
						JSON.stringify({
							suite: {
								id: "suite_real_1",
								organizationId: body?.organizationId,
								workspaceId: body?.workspaceId,
								name: body?.name,
								cases: body?.cases,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (
					parsed.pathname === "/fermata.v1.FermataExecutionService/RunTestSuite"
				) {
					return new Response(
						JSON.stringify({
							evaluationId: body?.evaluationId,
							passed: true,
							score: 1,
							totalCases: 18,
							passedCases: 18,
							failedCases: 0,
							candidateSummaries: [
								{
									candidateId: "maestro-recorded.local-diagnostic-success",
									model: "maestro-agent-trajectory-replay",
									totalCases: 18,
									passedCases: 18,
									failedCases: 0,
									score: 1,
									passRate: 1,
									passed: true,
								},
							],
							assertionSummaries: [
								{
									assertionId:
										"local-diagnostic-success.observed-outcome.equals",
									totalResults: 1,
									passedResults: 1,
									failedResults: 0,
									score: 1,
									passRate: 1,
									passed: true,
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				throw new Error(`Unexpected Fermata request: ${url}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("requires explicit Fermata service configuration", async () => {
		await expect(resolveFermataEvalServiceConfig()).resolves.toMatchObject({
			baseUrl: "https://platform.test",
			token: "fermata-token",
			organizationId: "org_evalops",
			workspaceId: "ws_evalops",
			maxAttempts: 1,
		});

		vi.stubEnv("FERMATA_SERVICE_URL", "");
		vi.stubEnv("FERMATA_SERVICE_TOKEN", "");
		await expect(requireFermataEvalServiceConfig()).rejects.toThrow(
			"Fermata eval integration requires FERMATA_SERVICE_URL",
		);
	});

	it("creates and runs a real Maestro scenario suite through Connect RPC paths", async () => {
		const config = await requireFermataEvalServiceConfig();
		const expected = loadScenarioResult("local-diagnostic-success");
		const actual = runScenario("local-diagnostic-success");
		const createRequest = buildFermataCreateScenarioSuiteRequest(
			config,
			expected,
			actual,
		);

		const created = await createFermataTestSuiteWithPlatform(
			config,
			createRequest,
		);
		const runRequest = buildFermataRunScenarioSuiteRequest(
			config,
			created.suite.id ?? "missing-suite-id",
			expected,
			actual,
		);
		const response = await runFermataTestSuiteWithPlatform(config, runRequest);

		expect(response).toMatchObject({
			passed: true,
			totalCases: 18,
			candidateSummaries: [
				expect.objectContaining({
					candidateId: "maestro-recorded.local-diagnostic-success",
					passRate: 1,
				}),
			],
		});
		expect(requests.map((request) => request.pathname)).toEqual([
			"/fermata.v1.FermataService/CreateTestSuite",
			"/fermata.v1.FermataExecutionService/RunTestSuite",
		]);
		expect(
			requests.some((request) => request.pathname.startsWith("/v1/")),
		).toBe(false);
		expect(requests[0]).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				authorization: "Bearer fermata-token",
				"connect-protocol-version": "1",
				"x-organization-id": "org_evalops",
			}),
			body: expect.objectContaining({
				organizationId: "org_evalops",
				workspaceId: "ws_evalops",
				cases: expect.arrayContaining([
					expect.objectContaining({
						id: "local-diagnostic-success.observed-outcome",
						metadata: expect.objectContaining({
							actual_output: "pass",
						}),
					}),
				]),
			}),
		});
		expect(requests[1]?.body).toMatchObject({
			suiteId: "suite_real_1",
			organizationId: "org_evalops",
			workspaceId: "ws_evalops",
			metadata: expect.objectContaining({
				expected_run_id: expected.run.id,
				actual_run_id: actual.run.id,
				committed_observed_outcome: expected.scenario.observedOutcome,
				actual_observed_outcome: actual.scenario.observedOutcome,
			}),
			candidates: [
				expect.objectContaining({
					candidateId: "maestro-recorded.local-diagnostic-success",
				}),
			],
		});
	});

	it("sends native Fermata LLM rubric assertions through the Connect create-suite payload", async () => {
		const config = await requireFermataEvalServiceConfig();
		const expected = loadScenarioResult("local-diagnostic-success");
		const actual = runScenario("local-diagnostic-success");
		const createRequest = buildFermataCreateScenarioSuiteRequest(
			config,
			expected,
			actual,
			{
				llmJudge: {
					judgeId: "primary-quality",
					verifierJudgeId: "verifier-quality",
					rubric:
						"The actual Maestro trajectory must match the committed result semantically.",
					minScore: 0.8,
					recordJudgeValidation: true,
				},
			},
		);

		await createFermataTestSuiteWithPlatform(config, createRequest);

		expect(requests).toHaveLength(1);
		const llmCase = (
			requests[0]?.body?.cases as Array<{
				metadata?: Record<string, unknown>;
				assertions?: Array<Record<string, unknown>>;
			}>
		).find(
			(testCase) => testCase.metadata?.case_kind === "scenario_llm_rubric",
		);
		expect(llmCase?.assertions?.[0]).toMatchObject({
			kind: "ASSERTION_KIND_LLM_RUBRIC",
			llmRubric: {
				judgeId: "primary-quality",
				verifierJudgeId: "verifier-quality",
				rubric:
					"The actual Maestro trajectory must match the committed result semantically.",
				minScore: 0.8,
				recordJudgeValidation: true,
			},
		});
		expect(requests[0]?.pathname).toBe(
			"/fermata.v1.FermataService/CreateTestSuite",
		);
	});

	it("sends native Fermata pairwise LLM rubric assertions through the Connect create-suite payload", async () => {
		const config = await requireFermataEvalServiceConfig();
		const expected = loadScenarioResult("local-diagnostic-success");
		const actual = runScenario("local-diagnostic-success");
		const createRequest = buildFermataCreateScenarioSuiteRequest(
			config,
			expected,
			actual,
			{
				llmPairwiseJudge: {
					judgeId: "pairwise-quality",
					verifierJudgeId: "pairwise-verifier",
					rubric:
						"Prefer the Maestro trajectory with stronger real-world task completion.",
					baselineLabel: "committed",
					candidateLabel: "candidate",
					minScore: 0.7,
					recordJudgeValidation: true,
				},
			},
		);

		await createFermataTestSuiteWithPlatform(config, createRequest);

		expect(requests).toHaveLength(1);
		const pairwiseCase = (
			requests[0]?.body?.cases as Array<{
				metadata?: Record<string, unknown>;
				assertions?: Array<Record<string, unknown>>;
			}>
		).find(
			(testCase) =>
				testCase.metadata?.case_kind === "scenario_llm_pairwise_rubric",
		);
		expect(pairwiseCase?.assertions?.[0]).toMatchObject({
			kind: "ASSERTION_KIND_LLM_PAIRWISE_RUBRIC",
			llmPairwiseRubric: {
				judgeId: "pairwise-quality",
				verifierJudgeId: "pairwise-verifier",
				rubric:
					"Prefer the Maestro trajectory with stronger real-world task completion.",
				baselineLabel: "committed",
				candidateLabel: "candidate",
				minScore: 0.7,
				recordJudgeValidation: true,
			},
		});
		expect(requests[0]?.pathname).toBe(
			"/fermata.v1.FermataService/CreateTestSuite",
		);
	});

	it("sends native Fermata agent trajectory assertions through the Connect create-suite payload", async () => {
		const config = await requireFermataEvalServiceConfig();
		const expected = loadScenarioResult("local-diagnostic-success");
		const actual = runScenario("local-diagnostic-success");
		const createRequest = buildFermataCreateScenarioSuiteRequest(
			config,
			expected,
			actual,
		);

		await createFermataTestSuiteWithPlatform(config, createRequest);

		expect(requests).toHaveLength(1);
		const trajectoryCase = (
			requests[0]?.body?.cases as Array<{
				metadata?: Record<string, unknown>;
				assertions?: Array<Record<string, unknown>>;
			}>
		).find(
			(testCase) =>
				testCase.metadata?.case_kind === "scenario_agent_trajectory",
		);
		expect(trajectoryCase?.assertions?.[0]).toMatchObject({
			kind: "ASSERTION_KIND_AGENT_TRAJECTORY",
			agentTrajectory: {
				requiredEvents: expect.arrayContaining([
					"session.started",
					"tool.completed",
				]),
				requiredAssertionStatuses: expect.arrayContaining([
					{ id: "replay-clean", status: "pass" },
				]),
				maxEvents: expected.counts.events,
				maxToolCalls: expected.counts.toolCalls,
				maxReplayDeltas: expected.counts.replayDeltas,
				maxScoreFailures: expected.counts.scoreFailures,
				requireIdempotentReplay: true,
				forbidDuplicateExternalActions: true,
				requiredTraceJoinKeys: expected.platform.traceJoinKeys,
			},
		});
		expect(requests[0]?.pathname).toBe(
			"/fermata.v1.FermataService/CreateTestSuite",
		);
	});
});
