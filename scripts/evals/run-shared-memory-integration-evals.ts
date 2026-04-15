import {
	loadSharedMemoryEvalCases,
	runSharedMemoryEvalSuite,
} from "./shared-memory-integration/core";
import { printEvalSuiteReport } from "./shared";

const cases = loadSharedMemoryEvalCases();
const results = await runSharedMemoryEvalSuite(cases);
const summary = printEvalSuiteReport("shared-memory-integration-evals", results);

if (summary.failed > 0) {
	process.exitCode = 1;
}
