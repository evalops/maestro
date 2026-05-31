import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	runAgentTrajectoryScenarioFile,
	type AgentTrajectoryScenarioResult,
} from "../../src/server/agent-trajectory-scenarios.js";
import {
	createFermataTestSuiteWithPlatform,
	requireFermataEvalServiceConfig,
	runFermataTestSuiteWithPlatform,
} from "../../src/platform/fermata-eval-client.js";
import {
	buildFermataCreateScenarioSuiteRequest,
	buildFermataRunScenarioSuiteRequest,
	type FermataScenarioSuiteLLMPairwiseJudgeOptions,
	type FermataScenarioSuiteLLMJudgeOptions,
} from "../../src/platform/fermata-scenario-suite.js";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"test",
	"fixtures",
	"agent-trajectory-scenarios",
);

function argValue(name: string): string | undefined {
	const prefix = `${name}=`;
	for (const [index, value] of process.argv.entries()) {
		if (value === name) {
			return process.argv[index + 1];
		}
		if (value.startsWith(prefix)) {
			return value.slice(prefix.length);
		}
	}
	return undefined;
}

function hasArg(name: string): boolean {
	const prefix = `${name}=`;
	return process.argv.some((value) => value === name || value.startsWith(prefix));
}

function expectedResultPath(scenarioPath: string): string {
	return scenarioPath.replace(/\.json$/u, ".result.json");
}

function readExpectedResult(path: string): AgentTrajectoryScenarioResult {
	if (!existsSync(path)) {
		throw new Error(`Missing committed scenario result fixture: ${path}`);
	}
	return JSON.parse(readFileSync(path, "utf8")) as AgentTrajectoryScenarioResult;
}

function envValue(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function hasEnvValue(...names: string[]): boolean {
	return names.some((name) => Boolean(process.env[name]?.trim()));
}

function parseNumberOption(value: string | undefined, label: string): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`${label} must be a number`);
	}
	return parsed;
}

function parseBooleanOption(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
			return true;
		case "0":
		case "false":
		case "no":
			return false;
		default:
			throw new Error(`Invalid boolean value ${value}`);
	}
}

function llmRubricFromArgs(): string | undefined {
	const inline =
		argValue("--llm-rubric") ?? envValue("FERMATA_LLM_RUBRIC", "MAESTRO_FERMATA_LLM_RUBRIC");
	if (inline) return inline;
	const rubricFile =
		argValue("--llm-rubric-file") ??
		envValue("FERMATA_LLM_RUBRIC_FILE", "MAESTRO_FERMATA_LLM_RUBRIC_FILE");
	if (!rubricFile) return undefined;
	return readFileSync(resolve(rubricFile), "utf8").trim();
}

function llmPairwiseRubricFromArgs(): string | undefined {
	const inline =
		argValue("--llm-pairwise-rubric") ??
		envValue(
			"FERMATA_LLM_PAIRWISE_RUBRIC",
			"MAESTRO_FERMATA_LLM_PAIRWISE_RUBRIC",
		);
	if (inline) return inline;
	const rubricFile =
		argValue("--llm-pairwise-rubric-file") ??
		envValue(
			"FERMATA_LLM_PAIRWISE_RUBRIC_FILE",
			"MAESTRO_FERMATA_LLM_PAIRWISE_RUBRIC_FILE",
		);
	if (!rubricFile) return undefined;
	return readFileSync(resolve(rubricFile), "utf8").trim();
}

const llmJudgeOptionalConfig = [
	{
		args: ["--llm-rubric", "--llm-rubric-file"],
		env: [
			"FERMATA_LLM_RUBRIC",
			"MAESTRO_FERMATA_LLM_RUBRIC",
			"FERMATA_LLM_RUBRIC_FILE",
			"MAESTRO_FERMATA_LLM_RUBRIC_FILE",
		],
	},
	{
		args: ["--llm-verifier-judge-id"],
		env: ["FERMATA_LLM_VERIFIER_JUDGE_ID", "MAESTRO_FERMATA_LLM_VERIFIER_JUDGE_ID"],
	},
	{
		args: ["--llm-min-score"],
		env: ["FERMATA_LLM_MIN_SCORE", "MAESTRO_FERMATA_LLM_MIN_SCORE"],
	},
	{
		args: ["--llm-repeat"],
		env: ["FERMATA_LLM_REPEAT", "MAESTRO_FERMATA_LLM_REPEAT"],
	},
	{
		args: ["--llm-quorum"],
		env: ["FERMATA_LLM_QUORUM", "MAESTRO_FERMATA_LLM_QUORUM"],
	},
	{
		args: ["--llm-require-calibrated"],
		env: [
			"FERMATA_LLM_REQUIRE_CALIBRATED",
			"MAESTRO_FERMATA_LLM_REQUIRE_CALIBRATED",
		],
	},
	{
		args: ["--llm-min-validation-accuracy"],
		env: [
			"FERMATA_LLM_MIN_VALIDATION_ACCURACY",
			"MAESTRO_FERMATA_LLM_MIN_VALIDATION_ACCURACY",
		],
	},
	{
		args: ["--llm-min-validation-count"],
		env: [
			"FERMATA_LLM_MIN_VALIDATION_COUNT",
			"MAESTRO_FERMATA_LLM_MIN_VALIDATION_COUNT",
		],
	},
	{
		args: ["--llm-record-validation"],
		env: ["FERMATA_LLM_RECORD_VALIDATION", "MAESTRO_FERMATA_LLM_RECORD_VALIDATION"],
	},
	{
		args: ["--llm-advisory"],
		env: ["FERMATA_LLM_ADVISORY", "MAESTRO_FERMATA_LLM_ADVISORY"],
	},
	{
		args: ["--llm-rubric-version"],
		env: ["FERMATA_LLM_RUBRIC_VERSION", "MAESTRO_FERMATA_LLM_RUBRIC_VERSION"],
	},
	{
		args: ["--llm-calibration-cohort"],
		env: ["FERMATA_LLM_CALIBRATION_COHORT", "MAESTRO_FERMATA_LLM_CALIBRATION_COHORT"],
	},
] as const;

const llmPairwiseJudgeOptionalConfig = [
	{
		args: ["--llm-pairwise-rubric", "--llm-pairwise-rubric-file"],
		env: [
			"FERMATA_LLM_PAIRWISE_RUBRIC",
			"MAESTRO_FERMATA_LLM_PAIRWISE_RUBRIC",
			"FERMATA_LLM_PAIRWISE_RUBRIC_FILE",
			"MAESTRO_FERMATA_LLM_PAIRWISE_RUBRIC_FILE",
		],
	},
	{
		args: ["--llm-pairwise-verifier-judge-id"],
		env: [
			"FERMATA_LLM_PAIRWISE_VERIFIER_JUDGE_ID",
			"MAESTRO_FERMATA_LLM_PAIRWISE_VERIFIER_JUDGE_ID",
		],
	},
	{
		args: ["--llm-pairwise-baseline-label"],
		env: [
			"FERMATA_LLM_PAIRWISE_BASELINE_LABEL",
			"MAESTRO_FERMATA_LLM_PAIRWISE_BASELINE_LABEL",
		],
	},
	{
		args: ["--llm-pairwise-candidate-label"],
		env: [
			"FERMATA_LLM_PAIRWISE_CANDIDATE_LABEL",
			"MAESTRO_FERMATA_LLM_PAIRWISE_CANDIDATE_LABEL",
		],
	},
	{
		args: ["--llm-pairwise-min-score"],
		env: [
			"FERMATA_LLM_PAIRWISE_MIN_SCORE",
			"MAESTRO_FERMATA_LLM_PAIRWISE_MIN_SCORE",
		],
	},
	{
		args: ["--llm-pairwise-repeat"],
		env: ["FERMATA_LLM_PAIRWISE_REPEAT", "MAESTRO_FERMATA_LLM_PAIRWISE_REPEAT"],
	},
	{
		args: ["--llm-pairwise-quorum"],
		env: ["FERMATA_LLM_PAIRWISE_QUORUM", "MAESTRO_FERMATA_LLM_PAIRWISE_QUORUM"],
	},
	{
		args: ["--llm-pairwise-require-calibrated"],
		env: [
			"FERMATA_LLM_PAIRWISE_REQUIRE_CALIBRATED",
			"MAESTRO_FERMATA_LLM_PAIRWISE_REQUIRE_CALIBRATED",
		],
	},
	{
		args: ["--llm-pairwise-min-validation-accuracy"],
		env: [
			"FERMATA_LLM_PAIRWISE_MIN_VALIDATION_ACCURACY",
			"MAESTRO_FERMATA_LLM_PAIRWISE_MIN_VALIDATION_ACCURACY",
		],
	},
	{
		args: ["--llm-pairwise-min-validation-count"],
		env: [
			"FERMATA_LLM_PAIRWISE_MIN_VALIDATION_COUNT",
			"MAESTRO_FERMATA_LLM_PAIRWISE_MIN_VALIDATION_COUNT",
		],
	},
	{
		args: ["--llm-pairwise-record-validation"],
		env: [
			"FERMATA_LLM_PAIRWISE_RECORD_VALIDATION",
			"MAESTRO_FERMATA_LLM_PAIRWISE_RECORD_VALIDATION",
		],
	},
	{
		args: ["--llm-pairwise-advisory"],
		env: [
			"FERMATA_LLM_PAIRWISE_ADVISORY",
			"MAESTRO_FERMATA_LLM_PAIRWISE_ADVISORY",
		],
	},
	{
		args: ["--llm-pairwise-rubric-version"],
		env: [
			"FERMATA_LLM_PAIRWISE_RUBRIC_VERSION",
			"MAESTRO_FERMATA_LLM_PAIRWISE_RUBRIC_VERSION",
		],
	},
	{
		args: ["--llm-pairwise-calibration-cohort"],
		env: [
			"FERMATA_LLM_PAIRWISE_CALIBRATION_COHORT",
			"MAESTRO_FERMATA_LLM_PAIRWISE_CALIBRATION_COHORT",
		],
	},
] as const;

function hasPartialLLMJudgeConfig(): boolean {
	return llmJudgeOptionalConfig.some(
		({ args, env }) => args.some(hasArg) || hasEnvValue(...env),
	);
}

function hasPartialLLMPairwiseJudgeConfig(): boolean {
	return llmPairwiseJudgeOptionalConfig.some(
		({ args, env }) => args.some(hasArg) || hasEnvValue(...env),
	);
}

export function llmJudgeOptionsFromArgs():
	| FermataScenarioSuiteLLMJudgeOptions
	| undefined {
	const judgeId =
		argValue("--llm-judge-id") ??
		envValue("FERMATA_LLM_JUDGE_ID", "MAESTRO_FERMATA_LLM_JUDGE_ID");
	if (!judgeId) {
		if (hasPartialLLMJudgeConfig()) {
			throw new Error(
				"Fermata LLM judge suite config requires --llm-judge-id, FERMATA_LLM_JUDGE_ID, or MAESTRO_FERMATA_LLM_JUDGE_ID",
			);
		}
		return undefined;
	}
	const rubric = llmRubricFromArgs();
	if (!rubric) {
		throw new Error(
			"Fermata LLM judge suite requires --llm-rubric, --llm-rubric-file, FERMATA_LLM_RUBRIC, or FERMATA_LLM_RUBRIC_FILE",
		);
	}
	return {
		judgeId,
		verifierJudgeId:
			argValue("--llm-verifier-judge-id") ??
			envValue(
				"FERMATA_LLM_VERIFIER_JUDGE_ID",
				"MAESTRO_FERMATA_LLM_VERIFIER_JUDGE_ID",
			),
		rubric,
		minScore: parseNumberOption(
			argValue("--llm-min-score") ??
				envValue("FERMATA_LLM_MIN_SCORE", "MAESTRO_FERMATA_LLM_MIN_SCORE"),
			"--llm-min-score",
		),
		repeat: parseNumberOption(
			argValue("--llm-repeat") ??
				envValue("FERMATA_LLM_REPEAT", "MAESTRO_FERMATA_LLM_REPEAT"),
			"--llm-repeat",
		),
		quorum: parseNumberOption(
			argValue("--llm-quorum") ??
				envValue("FERMATA_LLM_QUORUM", "MAESTRO_FERMATA_LLM_QUORUM"),
			"--llm-quorum",
		),
		requireCalibratedJudge: parseBooleanOption(
			argValue("--llm-require-calibrated") ??
				envValue(
					"FERMATA_LLM_REQUIRE_CALIBRATED",
					"MAESTRO_FERMATA_LLM_REQUIRE_CALIBRATED",
				),
		),
		minJudgeValidationAccuracy: parseNumberOption(
			argValue("--llm-min-validation-accuracy") ??
				envValue(
					"FERMATA_LLM_MIN_VALIDATION_ACCURACY",
					"MAESTRO_FERMATA_LLM_MIN_VALIDATION_ACCURACY",
				),
			"--llm-min-validation-accuracy",
		),
		minJudgeValidationCount: parseNumberOption(
			argValue("--llm-min-validation-count") ??
				envValue(
					"FERMATA_LLM_MIN_VALIDATION_COUNT",
					"MAESTRO_FERMATA_LLM_MIN_VALIDATION_COUNT",
				),
			"--llm-min-validation-count",
		),
		recordJudgeValidation:
			parseBooleanOption(
				argValue("--llm-record-validation") ??
					envValue(
						"FERMATA_LLM_RECORD_VALIDATION",
						"MAESTRO_FERMATA_LLM_RECORD_VALIDATION",
					),
			) ?? true,
		advisoryOnly: parseBooleanOption(
			argValue("--llm-advisory") ??
				envValue("FERMATA_LLM_ADVISORY", "MAESTRO_FERMATA_LLM_ADVISORY"),
		),
		rubricVersion:
			argValue("--llm-rubric-version") ??
			envValue(
				"FERMATA_LLM_RUBRIC_VERSION",
				"MAESTRO_FERMATA_LLM_RUBRIC_VERSION",
			),
		calibrationCohort:
			argValue("--llm-calibration-cohort") ??
			envValue(
				"FERMATA_LLM_CALIBRATION_COHORT",
				"MAESTRO_FERMATA_LLM_CALIBRATION_COHORT",
			),
	};
}

export function llmPairwiseJudgeOptionsFromArgs():
	| FermataScenarioSuiteLLMPairwiseJudgeOptions
	| undefined {
	const judgeId =
		argValue("--llm-pairwise-judge-id") ??
		envValue(
			"FERMATA_LLM_PAIRWISE_JUDGE_ID",
			"MAESTRO_FERMATA_LLM_PAIRWISE_JUDGE_ID",
		);
	if (!judgeId) {
		if (hasPartialLLMPairwiseJudgeConfig()) {
			throw new Error(
				"Fermata pairwise LLM judge suite config requires --llm-pairwise-judge-id, FERMATA_LLM_PAIRWISE_JUDGE_ID, or MAESTRO_FERMATA_LLM_PAIRWISE_JUDGE_ID",
			);
		}
		return undefined;
	}
	const rubric = llmPairwiseRubricFromArgs();
	if (!rubric) {
		throw new Error(
			"Fermata pairwise LLM judge suite requires --llm-pairwise-rubric, --llm-pairwise-rubric-file, FERMATA_LLM_PAIRWISE_RUBRIC, or FERMATA_LLM_PAIRWISE_RUBRIC_FILE",
		);
	}
	return {
		judgeId,
		verifierJudgeId:
			argValue("--llm-pairwise-verifier-judge-id") ??
			envValue(
				"FERMATA_LLM_PAIRWISE_VERIFIER_JUDGE_ID",
				"MAESTRO_FERMATA_LLM_PAIRWISE_VERIFIER_JUDGE_ID",
			),
		rubric,
		baselineLabel:
			argValue("--llm-pairwise-baseline-label") ??
			envValue(
				"FERMATA_LLM_PAIRWISE_BASELINE_LABEL",
				"MAESTRO_FERMATA_LLM_PAIRWISE_BASELINE_LABEL",
			),
		candidateLabel:
			argValue("--llm-pairwise-candidate-label") ??
			envValue(
				"FERMATA_LLM_PAIRWISE_CANDIDATE_LABEL",
				"MAESTRO_FERMATA_LLM_PAIRWISE_CANDIDATE_LABEL",
			),
		minScore: parseNumberOption(
			argValue("--llm-pairwise-min-score") ??
				envValue(
					"FERMATA_LLM_PAIRWISE_MIN_SCORE",
					"MAESTRO_FERMATA_LLM_PAIRWISE_MIN_SCORE",
				),
			"--llm-pairwise-min-score",
		),
		repeat: parseNumberOption(
			argValue("--llm-pairwise-repeat") ??
				envValue(
					"FERMATA_LLM_PAIRWISE_REPEAT",
					"MAESTRO_FERMATA_LLM_PAIRWISE_REPEAT",
				),
			"--llm-pairwise-repeat",
		),
		quorum: parseNumberOption(
			argValue("--llm-pairwise-quorum") ??
				envValue(
					"FERMATA_LLM_PAIRWISE_QUORUM",
					"MAESTRO_FERMATA_LLM_PAIRWISE_QUORUM",
				),
			"--llm-pairwise-quorum",
		),
		requireCalibratedJudge: parseBooleanOption(
			argValue("--llm-pairwise-require-calibrated") ??
				envValue(
					"FERMATA_LLM_PAIRWISE_REQUIRE_CALIBRATED",
					"MAESTRO_FERMATA_LLM_PAIRWISE_REQUIRE_CALIBRATED",
				),
		),
		minJudgeValidationAccuracy: parseNumberOption(
			argValue("--llm-pairwise-min-validation-accuracy") ??
				envValue(
					"FERMATA_LLM_PAIRWISE_MIN_VALIDATION_ACCURACY",
					"MAESTRO_FERMATA_LLM_PAIRWISE_MIN_VALIDATION_ACCURACY",
				),
			"--llm-pairwise-min-validation-accuracy",
		),
		minJudgeValidationCount: parseNumberOption(
			argValue("--llm-pairwise-min-validation-count") ??
				envValue(
					"FERMATA_LLM_PAIRWISE_MIN_VALIDATION_COUNT",
					"MAESTRO_FERMATA_LLM_PAIRWISE_MIN_VALIDATION_COUNT",
				),
			"--llm-pairwise-min-validation-count",
		),
		recordJudgeValidation:
			parseBooleanOption(
				argValue("--llm-pairwise-record-validation") ??
					envValue(
						"FERMATA_LLM_PAIRWISE_RECORD_VALIDATION",
						"MAESTRO_FERMATA_LLM_PAIRWISE_RECORD_VALIDATION",
					),
			) ?? true,
		advisoryOnly: parseBooleanOption(
			argValue("--llm-pairwise-advisory") ??
				envValue(
					"FERMATA_LLM_PAIRWISE_ADVISORY",
					"MAESTRO_FERMATA_LLM_PAIRWISE_ADVISORY",
				),
		),
		rubricVersion:
			argValue("--llm-pairwise-rubric-version") ??
			envValue(
				"FERMATA_LLM_PAIRWISE_RUBRIC_VERSION",
				"MAESTRO_FERMATA_LLM_PAIRWISE_RUBRIC_VERSION",
			),
		calibrationCohort:
			argValue("--llm-pairwise-calibration-cohort") ??
			envValue(
				"FERMATA_LLM_PAIRWISE_CALIBRATION_COHORT",
				"MAESTRO_FERMATA_LLM_PAIRWISE_CALIBRATION_COHORT",
			),
	};
}

function printSummary(
	response: Awaited<ReturnType<typeof runFermataTestSuiteWithPlatform>>,
): void {
	console.log(
		`[platform-fermata-scenario-suite] ${response.passedCases ?? 0}/${
			response.totalCases ?? 0
		} cases passed; score=${response.score ?? 0}`,
	);
	for (const summary of response.candidateSummaries ?? []) {
		console.log(
			`[candidate] ${summary.candidateId ?? summary.model ?? "candidate"} ${
				summary.passedCases ?? 0
			}/${summary.totalCases ?? 0} passed (${(
				(summary.passRate ?? 0) * 100
			).toFixed(1)}%)`,
		);
	}
	for (const summary of response.assertionSummaries ?? []) {
		if (summary.passed) continue;
		console.log(
			`[assertion-fail] ${summary.assertionId ?? "assertion"} failed ${
				summary.failedResults ?? 0
			}/${summary.totalResults ?? 0}`,
		);
	}
}

async function main(): Promise<void> {
	const scenarioPath = resolve(
		argValue("--scenario") ?? join(fixturesDir, "local-diagnostic-success.json"),
	);
	const expectedPath = resolve(
		argValue("--expected-result") ?? expectedResultPath(scenarioPath),
	);
	const baseDir = resolve(argValue("--base-dir") ?? dirname(scenarioPath));
	const config = await requireFermataEvalServiceConfig();
	const expected = readExpectedResult(expectedPath);
	const actual = runAgentTrajectoryScenarioFile(scenarioPath, { baseDir });
	const llmJudge = llmJudgeOptionsFromArgs();
	const llmPairwiseJudge = llmPairwiseJudgeOptionsFromArgs();
	const createRequest = buildFermataCreateScenarioSuiteRequest(
		config,
		expected,
		actual,
		{ llmJudge, llmPairwiseJudge },
	);
	const created = await createFermataTestSuiteWithPlatform(config, createRequest);
	const suiteId = created.suite?.id;
	if (!suiteId) {
		throw new Error("Fermata CreateTestSuite response did not include suite.id");
	}
	const runRequest = buildFermataRunScenarioSuiteRequest(
		config,
		suiteId,
		expected,
		actual,
	);
	const response = await runFermataTestSuiteWithPlatform(config, runRequest);
	printSummary(response);
	if (!response.passed) {
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
