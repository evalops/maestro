import type { OraclePolicyExperimentAssignment } from "../agent/oracle-policy-experiment.js";
import { recordTelemetry } from "../telemetry.js";

export function recordOraclePolicyExperimentAssignment(input: {
	assignment: OraclePolicyExperimentAssignment;
	sessionId: string;
}): void {
	void recordTelemetry({
		type: "staged-rollout-surface",
		timestamp: new Date().toISOString(),
		event: "internal_gate_used",
		surfaceId: "oracle-policy-experiment",
		surfaceType: "internal_gate",
		metadata: {
			sessionId: input.sessionId,
			"oracle.experiment_id": input.assignment.experimentId,
			"oracle.arm": input.assignment.arm,
			"oracle.policy_version": input.assignment.policyVersion,
		},
	});
}
