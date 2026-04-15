import { describe, expect, it } from "vitest";
import {
	evaluateSharedMemoryCaseOutput,
	loadSharedMemoryEvalCases,
	runSharedMemoryEvalSuite,
	summarizeSharedMemoryEvalResults,
} from "../../scripts/evals/shared-memory-integration/core";

describe("shared memory integration evals", () => {
	it("keeps the mock shared-memory integration corpus green", async () => {
		const cases = loadSharedMemoryEvalCases();
		const results = await runSharedMemoryEvalSuite(cases);
		const summary = summarizeSharedMemoryEvalResults(results);

		expect(summary.total).toBeGreaterThanOrEqual(4);
		expect(summary.failed).toBe(0);
	});

	it("returns immediately when a case expects no outbound requests", async () => {
		await expect(
			evaluateSharedMemoryCaseOutput({
				name: "no requests expected",
				updates: [],
				responses: [],
				expected: { requests: [] },
			}),
		).resolves.toEqual({ requests: [] });
	});
});
