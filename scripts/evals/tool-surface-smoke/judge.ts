import type { ToolSurfaceEvalCase, ToolSurfaceEvalResult } from "./core";
import { runToolSurfaceEvalSuite } from "./core";
import {
	runVerifiedJudgeCase,
	summarizeVerifiedJudgeResults,
	type LlmJudgeRuntimeConfig,
	type VerifiedJudgeResult,
} from "../llm-judge/core";

export interface ToolSurfaceJudgeEvaluation {
	deterministic: ToolSurfaceEvalResult;
	judge: VerifiedJudgeResult;
	pass: boolean;
}

export interface ToolSurfaceJudgeSummary {
	total: number;
	passed: number;
	failed: number;
	deterministicFailed: number;
	judgeFailed: number;
	averageQualityScore: number;
}

export async function runToolSurfaceJudgeSuite(
	cases: ToolSurfaceEvalCase[],
	config?: LlmJudgeRuntimeConfig,
): Promise<ToolSurfaceJudgeEvaluation[]> {
	const deterministicResults = await runToolSurfaceEvalSuite(cases);
	const evaluations: ToolSurfaceJudgeEvaluation[] = [];

	for (const deterministic of deterministicResults) {
		const rubric = deterministic.testCase.judgeRubric?.trim();
		if (!rubric) {
			throw new Error(
				`Tool surface judge eval case is missing judgeRubric: ${deterministic.testCase.name}`,
			);
		}

		const judge = await runVerifiedJudgeCase(
			{
				suiteName: "tool-surface-smoke",
				caseName: deterministic.testCase.name,
				rubric,
				scenarioSummary: buildToolSurfaceScenarioSummary(deterministic.testCase),
				expectedSubset: deterministic.testCase.expected,
				observedOutput: deterministic.actual,
				deterministicPass: deterministic.pass,
				deterministicMismatch: deterministic.mismatch,
			},
			config,
		);

		evaluations.push({
			deterministic,
			judge,
			pass: deterministic.pass && judge.pass,
		});
	}

	return evaluations;
}

export function summarizeToolSurfaceJudgeResults(
	results: ToolSurfaceJudgeEvaluation[],
): ToolSurfaceJudgeSummary {
	const total = results.length;
	const passed = results.filter((result) => result.pass).length;
	const failed = total - passed;
	const deterministicFailed = results.filter(
		(result) => !result.deterministic.pass,
	).length;
	const judgeFailed = results.filter((result) => !result.judge.pass).length;
	const judgeSummary = summarizeVerifiedJudgeResults(
		results.map((result) => result.judge),
	);

	return {
		total,
		passed,
		failed,
		deterministicFailed,
		judgeFailed,
		averageQualityScore: judgeSummary.averageQualityScore,
	};
}

function buildToolSurfaceScenarioSummary(testCase: ToolSurfaceEvalCase): string {
	return [`Kind: ${testCase.kind}`, `Scenario: ${testCase.name}`].join("\n");
}
