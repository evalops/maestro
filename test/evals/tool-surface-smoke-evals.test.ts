import { describe, expect, it } from "vitest";
import {
	loadToolSurfaceEvalCases,
	runToolSurfaceEvalSuite,
	summarizeToolSurfaceEvalResults,
} from "../../scripts/evals/tool-surface-smoke/core";

describe("tool surface smoke evals", () => {
	it("keeps the broader default tool surface smoke corpus green", async () => {
		const cases = loadToolSurfaceEvalCases();
		const results = await runToolSurfaceEvalSuite(cases);
		const summary = summarizeToolSurfaceEvalResults(results);

		expect(summary.total).toBeGreaterThanOrEqual(12);
		expect(summary.failed).toBe(0);
	});
});
