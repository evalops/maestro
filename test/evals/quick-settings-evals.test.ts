import { describe, expect, it } from "vitest";
import {
	loadQuickSettingsEvalCases,
	runQuickSettingsEvalSuite,
	summarizeQuickSettingsEvalResults,
} from "../../scripts/evals/quick-settings/core";

describe("quick settings evals", () => {
	it("keeps the quick settings regression corpus green", () => {
		const cases = loadQuickSettingsEvalCases();
		const results = runQuickSettingsEvalSuite(cases);
		const summary = summarizeQuickSettingsEvalResults(results);

		expect(summary.total).toBeGreaterThanOrEqual(10);
		expect(summary.failed).toBe(0);
	});
});
