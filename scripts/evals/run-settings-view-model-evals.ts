import {
	loadSettingsViewModelEvalCases,
	runSettingsViewModelEvalSuite,
} from "./settings-view-models/core";
import { printEvalSuiteReport } from "./shared";

const cases = loadSettingsViewModelEvalCases();
const results = runSettingsViewModelEvalSuite(cases);
const summary = printEvalSuiteReport("settings-view-model-evals", results);

if (summary.failed > 0) {
	process.exitCode = 1;
}
