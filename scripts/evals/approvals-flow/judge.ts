import type { ApprovalFlowEvalCase, ApprovalFlowEvalResult } from "./core";
import { runApprovalFlowEvalSuite } from "./core";
import {
	runVerifiedJudgeCase,
	summarizeVerifiedJudgeResults,
	type LlmJudgeRuntimeConfig,
	type VerifiedJudgeResult,
} from "../llm-judge/core";

export interface ApprovalFlowJudgeEvaluation {
	deterministic: ApprovalFlowEvalResult;
	judge: VerifiedJudgeResult;
	pass: boolean;
}

export interface ApprovalFlowJudgeSummary {
	total: number;
	passed: number;
	failed: number;
	deterministicFailed: number;
	judgeFailed: number;
	averageQualityScore: number;
}

export async function runApprovalFlowJudgeSuite(
	cases: ApprovalFlowEvalCase[],
	config?: LlmJudgeRuntimeConfig,
): Promise<ApprovalFlowJudgeEvaluation[]> {
	const deterministicResults = await runApprovalFlowEvalSuite(cases);
	const evaluations: ApprovalFlowJudgeEvaluation[] = [];

	for (const deterministic of deterministicResults) {
		const rubric = deterministic.testCase.judgeRubric?.trim();
		if (!rubric) {
			throw new Error(
				`Approval flow judge eval case is missing judgeRubric: ${deterministic.testCase.name}`,
			);
		}

		const judge = await runVerifiedJudgeCase(
			{
				suiteName: "approvals-flow",
				caseName: deterministic.testCase.name,
				rubric,
				scenarioSummary: buildApprovalScenarioSummary(deterministic.testCase),
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

export function summarizeApprovalFlowJudgeResults(
	results: ApprovalFlowJudgeEvaluation[],
): ApprovalFlowJudgeSummary {
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

function buildApprovalScenarioSummary(testCase: ApprovalFlowEvalCase): string {
	const lines = [
		`Kind: ${testCase.kind}`,
		`Default approval mode: ${testCase.defaultApprovalMode}`,
	];

	if (testCase.sessionId) {
		lines.push(`Session ID: ${testCase.sessionId}`);
	}
	if (testCase.querySessionId) {
		lines.push(`Query session ID: ${testCase.querySessionId}`);
	}
	if (testCase.storedMode) {
		lines.push(`Stored session mode: ${testCase.storedMode}`);
	}
	if (testCase.headerApprovalMode) {
		lines.push(`Header approval mode: ${testCase.headerApprovalMode}`);
	}
	if (testCase.body) {
		lines.push(`Request body: ${JSON.stringify(testCase.body)}`);
	}

	return lines.join("\n");
}
