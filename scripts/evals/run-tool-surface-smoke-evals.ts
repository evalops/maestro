import {
	loadToolSurfaceEvalCases,
	runToolSurfaceEvalSuite,
} from "./tool-surface-smoke/core";
import { printEvalSuiteReport } from "./shared";

const cases = loadToolSurfaceEvalCases();
const results = await runToolSurfaceEvalSuite(cases);
const summary = printEvalSuiteReport("tool-surface-smoke-evals", results);

if (summary.failed > 0) {
	process.exitCode = 1;
}
