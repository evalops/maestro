import { describe, expect, it } from "vitest";
import {
	LlmJudgeVerificationSchema,
	aggregateJudgeOutcome,
	normalizeParsedJudgePayload,
	parseStructuredJson,
} from "../../scripts/evals/llm-judge/core";

describe("llm judge core", () => {
	it("passes when the majority verdict passes with sufficient quality", () => {
		const result = aggregateJudgeOutcome(
			[
				{ finalPassVerdict: "pass", qualityScore: 0.9 },
				{ finalPassVerdict: "pass", qualityScore: 0.8 },
				{ finalPassVerdict: "fail", qualityScore: 0.4 },
			],
			0.75,
			true,
		);

		expect(result.passedVotes).toBe(2);
		expect(result.failedVotes).toBe(1);
		expect(result.finalPassVerdict).toBe("pass");
		expect(result.pass).toBe(true);
	});

	it("fails when the average quality score is below the minimum threshold", () => {
		const result = aggregateJudgeOutcome(
			[
				{ finalPassVerdict: "pass", qualityScore: 0.7 },
				{ finalPassVerdict: "pass", qualityScore: 0.72 },
				{ finalPassVerdict: "fail", qualityScore: 0.2 },
			],
			0.75,
			true,
		);

		expect(result.finalPassVerdict).toBe("pass");
		expect(result.pass).toBe(false);
	});

	it("fails when the deterministic regression check already failed", () => {
		const result = aggregateJudgeOutcome(
			[{ finalPassVerdict: "pass", qualityScore: 0.95 }],
			0.75,
			false,
		);

		expect(result.finalPassVerdict).toBe("pass");
		expect(result.pass).toBe(false);
	});

	it("extracts JSON objects from fenced or prefixed model output", () => {
		const parsed = parseStructuredJson(
			'Here is the result:\n```json\n{"passVerdict":"pass"}\n```',
		);

		expect(parsed).toEqual({ passVerdict: "pass" });
	});

	it("normalizes Claude-style verifier typos and strips extra keys", () => {
		const normalized = normalizeParsedJudgePayload(
			{
				reasoningText: "Looks good",
				verdictAgrement: "agree",
				verifiedPassVerdict: "pass",
				verifiedQualityScore: "1",
				criticalIssueList: [],
				extra: "ignore me",
			},
			LlmJudgeVerificationSchema,
		);

		expect(normalized).toEqual({
			reasoningText: "Looks good",
			verdictAgreement: "agree",
			verifiedPassVerdict: "pass",
			verifiedQualityScore: 1,
			criticalIssueList: [],
		});
	});
});
