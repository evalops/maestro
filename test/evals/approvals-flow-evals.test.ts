import { describe, expect, it } from "vitest";
import {
	loadApprovalFlowEvalCases,
	runApprovalFlowEvalSuite,
	summarizeApprovalFlowEvalResults,
} from "../../scripts/evals/approvals-flow/core";

describe("approvals flow evals", () => {
	it("keeps the approvals flow regression corpus green", async () => {
		const cases = loadApprovalFlowEvalCases();
		const results = await runApprovalFlowEvalSuite(cases);
		const summary = summarizeApprovalFlowEvalResults(results);

		expect(summary.total).toBeGreaterThanOrEqual(8);
		expect(summary.failed).toBe(0);
	});
});
