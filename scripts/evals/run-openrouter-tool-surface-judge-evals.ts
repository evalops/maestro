import { loadToolSurfaceEvalCases } from "./tool-surface-smoke/core";
import {
	runToolSurfaceJudgeSuite,
	summarizeToolSurfaceJudgeResults,
} from "./tool-surface-smoke/judge";
import {
	formatLlmJudgeRuntimeConfig,
	resolveLlmJudgeRuntimeConfig,
} from "./llm-judge/core";

const config = resolveLlmJudgeRuntimeConfig();
const cases = loadToolSurfaceEvalCases();

console.log(
	`[openrouter-tool-surface-judge-evals] running ${cases.length} case(s); ${formatLlmJudgeRuntimeConfig(config)}`,
);

const results = await runToolSurfaceJudgeSuite(cases, config);

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

const summary = summarizeToolSurfaceJudgeResults(results);
console.log(
	`\n[openrouter-tool-surface-judge-evals] ${summary.passed}/${summary.total} passed avg=${summary.averageQualityScore.toFixed(3)} deterministicFailures=${summary.deterministicFailed} judgeFailures=${summary.judgeFailed}`,
);

if (summary.failed > 0) {
	throw new Error(
		`${summary.failed} tool-surface judge eval(s) failed (deterministic=${summary.deterministicFailed}, judge=${summary.judgeFailed}).`,
	);
}

console.log("[openrouter-tool-surface-judge-evals] all cases passed");
