import { describe, expect, it } from "vitest";
import { evaluateOraclePolicyRollout } from "../../src/agent/oracle-policy-rollout.js";

const baseInput = {
	experimentId: "oracle-policy-2026-07",
	expectedControlVersion: "oracle-v1",
	expectedTreatmentVersion: "oracle-v2",
	control: {
		policyVersion: "oracle-v1",
		verifiedSamples: 100,
		successes: 80,
		averageCostUsd: 1,
		averageLatencyMs: 1_000,
		safetyViolations: 0,
	},
	treatment: {
		policyVersion: "oracle-v2",
		verifiedSamples: 100,
		successes: 82,
		averageCostUsd: 1.05,
		averageLatencyMs: 1_050,
		safetyViolations: 0,
	},
};

describe("evaluateOraclePolicyRollout", () => {
	it("holds with a machine-readable reason for invalid thresholds", () => {
		const decision = evaluateOraclePolicyRollout({
			...baseInput,
			minVerifiedSamples: 0,
			maxSuccessRateRegression: -0.01,
			maxCostRatio: 0,
		});

		expect(decision).toMatchObject({ status: "hold", sufficient: false });
		expect(decision.reasons).toEqual(["invalid_thresholds"]);
	});

	it("holds until both arms have enough verified samples", () => {
		const decision = evaluateOraclePolicyRollout({
			...baseInput,
			treatment: { ...baseInput.treatment, verifiedSamples: 19, successes: 15 },
		});

		expect(decision).toMatchObject({ status: "hold", sufficient: false });
		expect(decision.reasons).toContain("insufficient_verified_samples");
	});

	it("holds when aggregate policy versions do not match the experiment", () => {
		const decision = evaluateOraclePolicyRollout({
			...baseInput,
			treatment: { ...baseInput.treatment, policyVersion: "oracle-v3" },
		});

		expect(decision).toMatchObject({ status: "hold", sufficient: false });
		expect(decision.reasons).toContain("mixed_policy_versions");
	});

	it("rolls back on any verified safety violation", () => {
		const decision = evaluateOraclePolicyRollout({
			...baseInput,
			treatment: { ...baseInput.treatment, safetyViolations: 1 },
		});

		expect(decision.status).toBe("rollback");
		expect(decision.reasons).toContain("treatment_safety_violation");
	});

	it("holds when treatment success regresses past the guardrail", () => {
		const decision = evaluateOraclePolicyRollout({
			...baseInput,
			treatment: { ...baseInput.treatment, successes: 74 },
		});

		expect(decision.status).toBe("hold");
		expect(decision.reasons).toContain("success_rate_regression");
	});

	it("holds when cost or latency exceeds its configured ratio", () => {
		const cost = evaluateOraclePolicyRollout({
			...baseInput,
			maxCostRatio: 1.1,
			treatment: { ...baseInput.treatment, averageCostUsd: 1.11 },
		});
		const latency = evaluateOraclePolicyRollout({
			...baseInput,
			maxLatencyRatio: 1.1,
			treatment: { ...baseInput.treatment, averageLatencyMs: 1_101 },
		});

		expect(cost.reasons).toContain("cost_ratio_exceeded");
		expect(latency.reasons).toContain("latency_ratio_exceeded");
	});

	it("promotes only when every verified outcome gate passes", () => {
		const decision = evaluateOraclePolicyRollout({
			...baseInput,
			maxCostRatio: 1.1,
			maxLatencyRatio: 1.1,
		});

		expect(decision).toMatchObject({ status: "promote", sufficient: true });
		expect(decision.reasons).toEqual(["all_rollout_gates_passed"]);
		expect(decision.metrics).toMatchObject({
			controlSuccessRate: 0.8,
			treatmentSuccessRate: 0.82,
			costRatio: 1.05,
			latencyRatio: 1.05,
		});
	});
});
