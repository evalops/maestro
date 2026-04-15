import {
	loadApprovalFlowEvalCases,
	runApprovalFlowEvalSuite,
} from "./approvals-flow/core";
import { printEvalSuiteReport } from "./shared";

const cases = loadApprovalFlowEvalCases();
const results = await runApprovalFlowEvalSuite(cases);
const summary = printEvalSuiteReport("approvals-flow-evals", results);

if (summary.failed > 0) {
	process.exitCode = 1;
}
