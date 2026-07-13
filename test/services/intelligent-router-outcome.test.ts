import { describe, expect, it } from "vitest";
import { deriveRoutingOutcome } from "../../src/services/intelligent-router/outcome.js";

describe("intelligent router outcome evidence", () => {
	it("does not treat assistant completion as verified success", () => {
		expect(deriveRoutingOutcome({ assistantCompleted: true })).toEqual({
			verified: false,
			success: false,
			qualityScore: 0,
			reasons: ["assistant_completed_without_verification"],
		});
	});

	it("accepts an explicit passing verification result", () => {
		expect(
			deriveRoutingOutcome({
				assistantCompleted: true,
				verificationPassed: true,
			}),
		).toMatchObject({
			verified: true,
			success: true,
			qualityScore: 1,
			reasons: ["verification_passed"],
		});
	});

	it("treats retries and user rejection as verified failures", () => {
		expect(
			deriveRoutingOutcome({ assistantCompleted: true, userRejected: true }),
		).toMatchObject({ verified: true, success: false, qualityScore: 0 });
		expect(
			deriveRoutingOutcome({ assistantCompleted: true, userRetried: true }),
		).toMatchObject({ verified: true, success: false, qualityScore: 0 });
	});

	it("records total task cost and attempts", () => {
		expect(
			deriveRoutingOutcome({
				assistantCompleted: true,
				verificationPassed: true,
				attempts: 3,
				totalCostUsd: 0.42,
			}),
		).toMatchObject({ attempts: 3, totalCostUsd: 0.42 });
	});
});
