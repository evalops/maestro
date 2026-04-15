import { describe, expect, it } from "vitest";
import {
	loadSettingsViewModelEvalCases,
	runSettingsViewModelEvalSuite,
	summarizeSettingsViewModelEvalResults,
} from "../../scripts/evals/settings-view-models/core";

describe("settings view-model evals", () => {
	it("keeps the settings regression corpus green", () => {
		const cases = loadSettingsViewModelEvalCases();
		const results = runSettingsViewModelEvalSuite(cases);
		const summary = summarizeSettingsViewModelEvalResults(results);

		expect(summary.total).toBeGreaterThanOrEqual(20);
		expect(summary.failed).toBe(0);
	});
});
