import { describe, expect, it } from "vitest";
import {
	loadOpenRouterCompatEvalCases,
	runOpenRouterCompatEvalSuite,
	summarizeOpenRouterCompatEvalResults,
} from "../../scripts/evals/openrouter-compat/core";

describe("openrouter compat evals", () => {
	it("keeps the OpenRouter compatibility corpus green", () => {
		const cases = loadOpenRouterCompatEvalCases();
		const results = runOpenRouterCompatEvalSuite(cases);
		const summary = summarizeOpenRouterCompatEvalResults(results);

		expect(summary.total).toBeGreaterThanOrEqual(12);
		expect(summary.failed).toBe(0);
	});
});
