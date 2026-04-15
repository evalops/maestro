import { loadApprovalFlowEvalCases } from "./approvals-flow/core";
import {
	runApprovalFlowJudgeSuite,
	summarizeApprovalFlowJudgeResults,
} from "./approvals-flow/judge";
import {
	formatLlmJudgeRuntimeConfig,
	resolveLlmJudgeRuntimeConfig,
} from "./llm-judge/core";

const config = resolveLlmJudgeRuntimeConfig();
const cases = loadApprovalFlowEvalCases();

console.log(
	`[openrouter-approvals-judge-evals] running ${cases.length} case(s); ${formatLlmJudgeRuntimeConfig(config)}`,
);

const results = await runApprovalFlowJudgeSuite(cases, config);

for (const result of results) {
	const leadPair = result.judge.pairs[0];
	console.log(
		`\n[${result.pass ? "PASS" : "FAIL"}] ${result.deterministic.testCase.name}`,
	);
	console.log(
		`[deterministic] ${result.deterministic.pass ? "PASS" : "FAIL"}${result.deterministic.mismatch ? ` ${result.deterministic.mismatch}` : ""}`,
	);
	console.log(
		`[judge] votes=${result.judge.passedVotes}/${result.judge.pairs.length} avg=${result.judge.averageQualityScore.toFixed(3)} verdict=${result.judge.finalPassVerdict}`,
	);
	if (leadPair) {
		console.log(`[judge] reasoning=${leadPair.judge.reasoningText}`);
		if (leadPair.judge.issueList.length > 0) {
			console.log(`[judge] issues=${leadPair.judge.issueList.join(" | ")}`);
		}
		console.log(`[verify] reasoning=${leadPair.verification.reasoningText}`);
		if (leadPair.verification.criticalIssueList.length > 0) {
			console.log(
				`[verify] critical=${leadPair.verification.criticalIssueList.join(" | ")}`,
			);
		}
	}
}

const summary = summarizeApprovalFlowJudgeResults(results);
console.log(
	`\n[openrouter-approvals-judge-evals] ${summary.passed}/${summary.total} passed avg=${summary.averageQualityScore.toFixed(3)} deterministicFailures=${summary.deterministicFailed} judgeFailures=${summary.judgeFailed}`,
);

if (summary.failed > 0) {
	throw new Error(
		`${summary.failed} approval judge eval(s) failed (deterministic=${summary.deterministicFailed}, judge=${summary.judgeFailed}).`,
	);
}

console.log("[openrouter-approvals-judge-evals] all cases passed");
