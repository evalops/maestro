import {
	loadBatchShapingEvalCases,
	runBatchShapingEvalSuite,
} from "./batch-shaping/core";
import { printEvalSuiteReport } from "./shared";

const cases = loadBatchShapingEvalCases();
const results = await runBatchShapingEvalSuite(cases);
const summary = printEvalSuiteReport("batch-shaping-evals", results);
const totalToolCallDelta = results.reduce(
	(total, result) => total + result.actual.improvement.modelToolCallCountDelta,
	0,
);
const totalMultiCallTurnDelta = results.reduce(
	(total, result) => total + result.actual.improvement.multiCallTurnDelta,
	0,
);
const privacyFailures = results.filter((result) => !result.actual.privacy.safe);

console.log(
	`[batch-shaping-evals] model tool-call delta ${totalToolCallDelta}; multi-call turn delta ${totalMultiCallTurnDelta}; privacy failures ${privacyFailures.length}`,
);

if (summary.failed > 0 || privacyFailures.length > 0) {
	process.exitCode = 1;
}
