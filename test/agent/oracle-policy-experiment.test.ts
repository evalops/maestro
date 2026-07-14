import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assignConfiguredOraclePolicyExperiment,
	assignOraclePolicyExperiment,
	getOraclePolicyExperimentConfig,
} from "../../src/agent/oracle-policy-experiment.js";

const baseInput = {
	experimentId: "oracle-policy-2026-07",
	sessionId: "session-42",
	allocation: 0.5,
	controlVersion: "oracle-v1",
	treatmentVersion: "oracle-v2",
};

describe("assignOraclePolicyExperiment", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("resolves complete host configuration and rejects partial configuration", () => {
		expect(getOraclePolicyExperimentConfig()).toBeUndefined();
		vi.stubEnv("MAESTRO_ORACLE_EXPERIMENT_ID", "oracle-july");
		expect(() => getOraclePolicyExperimentConfig()).toThrow(
			/requires allocation/i,
		);
		vi.stubEnv("MAESTRO_ORACLE_EXPERIMENT_ALLOCATION", "1");
		vi.stubEnv("MAESTRO_ORACLE_EXPERIMENT_CONTROL_VERSION", "oracle-v1");
		vi.stubEnv("MAESTRO_ORACLE_EXPERIMENT_TREATMENT_VERSION", "oracle-v2");
		expect(assignConfiguredOraclePolicyExperiment("session-a")).toMatchObject({
			experimentId: "oracle-july",
			arm: "treatment",
			policyVersion: "oracle-v2",
		});
	});

	it("returns the same assignment for the same experiment and session", () => {
		const first = assignOraclePolicyExperiment(baseInput);
		const second = assignOraclePolicyExperiment(baseInput);

		expect(second).toEqual(first);
		expect(first.bucket).toBeGreaterThanOrEqual(0);
		expect(first.bucket).toBeLessThan(1);
	});

	it("isolates assignments between experiments", () => {
		const first = assignOraclePolicyExperiment(baseInput);
		const second = assignOraclePolicyExperiment({
			...baseInput,
			experimentId: "oracle-policy-2026-08",
		});

		expect(second.bucket).not.toBe(first.bucket);
	});

	it("respects the allocation boundaries", () => {
		expect(
			assignOraclePolicyExperiment({ ...baseInput, allocation: 0 }).arm,
		).toBe("control");
		expect(
			assignOraclePolicyExperiment({ ...baseInput, allocation: 1 }).arm,
		).toBe("treatment");
	});

	it("projects the policy version selected by the assigned arm", () => {
		expect(
			assignOraclePolicyExperiment({ ...baseInput, allocation: 0 }),
		).toMatchObject({ arm: "control", policyVersion: "oracle-v1" });
		expect(
			assignOraclePolicyExperiment({ ...baseInput, allocation: 1 }),
		).toMatchObject({ arm: "treatment", policyVersion: "oracle-v2" });
	});

	it("rejects invalid allocations", () => {
		expect(() =>
			assignOraclePolicyExperiment({ ...baseInput, allocation: -0.1 }),
		).toThrow(/allocation/i);
		expect(() =>
			assignOraclePolicyExperiment({ ...baseInput, allocation: 1.1 }),
		).toThrow(/allocation/i);
	});
});
