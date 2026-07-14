export type OraclePolicyRolloutStatus = "hold" | "promote" | "rollback";

export interface OraclePolicyVerifiedAggregate {
	policyVersion: string;
	verifiedSamples: number;
	successes: number;
	averageCostUsd: number;
	averageLatencyMs: number;
	safetyViolations: number;
}

export interface OraclePolicyRolloutInput {
	experimentId: string;
	expectedControlVersion: string;
	expectedTreatmentVersion: string;
	control: OraclePolicyVerifiedAggregate;
	treatment: OraclePolicyVerifiedAggregate;
	minVerifiedSamples?: number;
	maxSuccessRateRegression?: number;
	maxCostRatio?: number;
	maxLatencyRatio?: number;
}

export interface OraclePolicyRolloutMetrics {
	controlSuccessRate: number;
	treatmentSuccessRate: number;
	successRateDelta: number;
	costRatio: number;
	latencyRatio: number;
}

export interface OraclePolicyRolloutDecision {
	readonly experimentId: string;
	readonly status: OraclePolicyRolloutStatus;
	readonly sufficient: boolean;
	readonly reasons: readonly string[];
	readonly metrics: Readonly<OraclePolicyRolloutMetrics>;
}

export const DEFAULT_ORACLE_ROLLOUT_MIN_VERIFIED_SAMPLES = 20;
export const DEFAULT_ORACLE_ROLLOUT_MAX_SUCCESS_RATE_REGRESSION = 0.05;

function rate(numerator: number, denominator: number): number {
	return denominator > 0 ? numerator / denominator : 0;
}

function ratio(treatment: number, control: number): number {
	if (control > 0) return treatment / control;
	return treatment > 0 ? Number.POSITIVE_INFINITY : 1;
}

/**
 * Evaluate an Oracle policy experiment from verified outcome aggregates.
 * This function is advisory: it never mutates or activates a production policy.
 */
export function evaluateOraclePolicyRollout(
	input: OraclePolicyRolloutInput,
): OraclePolicyRolloutDecision {
	const minVerifiedSamples =
		input.minVerifiedSamples ?? DEFAULT_ORACLE_ROLLOUT_MIN_VERIFIED_SAMPLES;
	const maxSuccessRateRegression =
		input.maxSuccessRateRegression ??
		DEFAULT_ORACLE_ROLLOUT_MAX_SUCCESS_RATE_REGRESSION;
	const controlSuccessRate = rate(
		input.control.successes,
		input.control.verifiedSamples,
	);
	const treatmentSuccessRate = rate(
		input.treatment.successes,
		input.treatment.verifiedSamples,
	);
	const metrics = Object.freeze({
		controlSuccessRate,
		treatmentSuccessRate,
		successRateDelta: treatmentSuccessRate - controlSuccessRate,
		costRatio: ratio(
			input.treatment.averageCostUsd,
			input.control.averageCostUsd,
		),
		latencyRatio: ratio(
			input.treatment.averageLatencyMs,
			input.control.averageLatencyMs,
		),
	});

	const finish = (
		status: OraclePolicyRolloutStatus,
		sufficient: boolean,
		reasons: string[],
	): OraclePolicyRolloutDecision =>
		Object.freeze({
			experimentId: input.experimentId,
			status,
			sufficient,
			reasons: Object.freeze(reasons),
			metrics,
		});
	const hasInvalidThreshold =
		!Number.isInteger(minVerifiedSamples) ||
		minVerifiedSamples < 1 ||
		!Number.isFinite(maxSuccessRateRegression) ||
		maxSuccessRateRegression < 0 ||
		maxSuccessRateRegression > 1 ||
		(input.maxCostRatio !== undefined &&
			(!Number.isFinite(input.maxCostRatio) || input.maxCostRatio <= 0)) ||
		(input.maxLatencyRatio !== undefined &&
			(!Number.isFinite(input.maxLatencyRatio) || input.maxLatencyRatio <= 0));
	if (hasInvalidThreshold) {
		return finish("hold", false, ["invalid_thresholds"]);
	}

	if (
		input.control.policyVersion !== input.expectedControlVersion ||
		input.treatment.policyVersion !== input.expectedTreatmentVersion
	) {
		return finish("hold", false, ["mixed_policy_versions"]);
	}

	const safetyReasons: string[] = [];
	if (input.control.safetyViolations > 0) {
		safetyReasons.push("control_safety_violation");
	}
	if (input.treatment.safetyViolations > 0) {
		safetyReasons.push("treatment_safety_violation");
	}
	if (safetyReasons.length > 0) return finish("rollback", true, safetyReasons);

	if (
		input.control.verifiedSamples < minVerifiedSamples ||
		input.treatment.verifiedSamples < minVerifiedSamples
	) {
		return finish("hold", false, ["insufficient_verified_samples"]);
	}

	const gateReasons: string[] = [];
	if (metrics.successRateDelta < -maxSuccessRateRegression) {
		gateReasons.push("success_rate_regression");
	}
	if (
		input.maxCostRatio !== undefined &&
		metrics.costRatio > input.maxCostRatio
	) {
		gateReasons.push("cost_ratio_exceeded");
	}
	if (
		input.maxLatencyRatio !== undefined &&
		metrics.latencyRatio > input.maxLatencyRatio
	) {
		gateReasons.push("latency_ratio_exceeded");
	}

	return gateReasons.length > 0
		? finish("hold", true, gateReasons)
		: finish("promote", true, ["all_rollout_gates_passed"]);
}
