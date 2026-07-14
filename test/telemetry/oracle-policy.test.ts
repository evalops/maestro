import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/telemetry.js", () => ({
	recordTelemetry: vi.fn(() => Promise.resolve()),
}));

import { recordTelemetry } from "../../src/telemetry.js";
import { recordOraclePolicyExperimentAssignment } from "../../src/telemetry/oracle-policy.js";

describe("Oracle policy experiment telemetry", () => {
	it("emits bounded assignment attributes", () => {
		recordOraclePolicyExperimentAssignment({
			sessionId: "session-1",
			assignment: {
				experimentId: "oracle-july",
				arm: "treatment",
				policyVersion: "oracle-v2",
				bucket: 0.25,
			},
		});

		expect(recordTelemetry).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "staged-rollout-surface",
				event: "internal_gate_used",
				metadata: {
					sessionId: "session-1",
					"oracle.experiment_id": "oracle-july",
					"oracle.arm": "treatment",
					"oracle.policy_version": "oracle-v2",
				},
			}),
		);
	});
});
