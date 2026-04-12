import {
	loadPipelineToolEvalCases,
	runPipelineToolEvalSuite,
} from "./pipeline-tool-integration/core";
import { printEvalSuiteReport } from "./shared";

const cases = loadPipelineToolEvalCases();
const results = await runPipelineToolEvalSuite(cases);
const summary = printEvalSuiteReport("pipeline-tool-integration-evals", results);

if (summary.failed > 0) {
	process.exitCode = 1;
}
