import { printEvalSuiteReport } from "./shared";
import {
	loadQuickSettingsEvalCases,
	runQuickSettingsEvalSuite,
} from "./quick-settings/core";

const cases = loadQuickSettingsEvalCases();
const results = runQuickSettingsEvalSuite(cases);
const summary = printEvalSuiteReport("quick-settings-evals", results);

if (summary.failed > 0) {
	process.exitCode = 1;
}
