import { describe, expect, it } from "vitest";
import {
	loadPipelineToolEvalCases,
	runPipelineToolEvalSuite,
	summarizePipelineToolEvalResults,
} from "../../scripts/evals/pipeline-tool-integration/core";

describe("pipeline tool integration evals", () => {
	it("keeps the mock Pipeline integration corpus green", async () => {
		const cases = loadPipelineToolEvalCases();
		const results = await runPipelineToolEvalSuite(cases);
		const summary = summarizePipelineToolEvalResults(results);

		expect(summary.total).toBeGreaterThanOrEqual(4);
		expect(summary.failed).toBe(0);
	});
});
