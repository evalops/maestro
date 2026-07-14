import { createHash } from "node:crypto";
import { ENV_VARS, getEnvString } from "../config/env-vars.js";

export type OraclePolicyExperimentArm = "control" | "treatment";

export interface OraclePolicyExperimentInput {
	experimentId: string;
	sessionId: string;
	/** Fraction of sessions assigned to treatment, in the inclusive range 0..1. */
	allocation: number;
	controlVersion: string;
	treatmentVersion: string;
}

export interface OraclePolicyExperimentAssignment {
	readonly experimentId: string;
	readonly arm: OraclePolicyExperimentArm;
	readonly policyVersion: string;
	readonly bucket: number;
}

export interface OraclePolicyExperimentConfig {
	experimentId: string;
	allocation: number;
	controlVersion: string;
	treatmentVersion: string;
}

const BUCKET_BYTES = 6;
const BUCKET_SPACE = 2 ** (BUCKET_BYTES * 8);

/** Deterministically assign a session to one immutable Oracle policy arm. */
export function assignOraclePolicyExperiment(
	input: OraclePolicyExperimentInput,
): OraclePolicyExperimentAssignment {
	if (
		!Number.isFinite(input.allocation) ||
		input.allocation < 0 ||
		input.allocation > 1
	) {
		throw new RangeError(
			"Oracle experiment allocation must be between 0 and 1",
		);
	}

	const digest = createHash("sha256")
		.update(input.experimentId)
		.update("\0")
		.update(input.sessionId)
		.digest();
	const bucket = digest.readUIntBE(0, BUCKET_BYTES) / BUCKET_SPACE;
	const arm: OraclePolicyExperimentArm =
		input.allocation === 1 ||
		(input.allocation !== 0 && bucket < input.allocation)
			? "treatment"
			: "control";

	return Object.freeze({
		experimentId: input.experimentId,
		arm,
		policyVersion:
			arm === "treatment" ? input.treatmentVersion : input.controlVersion,
		bucket,
	});
}

/** Resolve the optional host-configured experiment. Partial configs fail closed. */
export function getOraclePolicyExperimentConfig():
	| OraclePolicyExperimentConfig
	| undefined {
	const experimentId = getEnvString(ENV_VARS.ORACLE_EXPERIMENT_ID);
	if (!experimentId) return undefined;
	const allocationValue = getEnvString(ENV_VARS.ORACLE_EXPERIMENT_ALLOCATION);
	const controlVersion = getEnvString(
		ENV_VARS.ORACLE_EXPERIMENT_CONTROL_VERSION,
	);
	const treatmentVersion = getEnvString(
		ENV_VARS.ORACLE_EXPERIMENT_TREATMENT_VERSION,
	);
	const allocation = Number(allocationValue);
	if (
		!allocationValue ||
		!Number.isFinite(allocation) ||
		allocation < 0 ||
		allocation > 1 ||
		!controlVersion ||
		!treatmentVersion
	) {
		throw new Error(
			"Oracle experiment requires allocation in 0..1 plus control and treatment versions",
		);
	}
	return Object.freeze({
		experimentId,
		allocation,
		controlVersion,
		treatmentVersion,
	});
}

export function assignConfiguredOraclePolicyExperiment(
	sessionId: string,
): OraclePolicyExperimentAssignment | undefined {
	const config = getOraclePolicyExperimentConfig();
	return config
		? assignOraclePolicyExperiment({ ...config, sessionId })
		: undefined;
}
