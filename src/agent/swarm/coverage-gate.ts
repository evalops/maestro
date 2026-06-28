/**
 * Swarm coverage gate
 *
 * Pre-dispatch check that refuses to start a swarm until its validation
 * contract is fully covered: every assertion claimed by exactly one feature,
 * no duplicate claims, and no claim referencing an unknown assertion.
 *
 * The gate is opt-in: a swarm configured without a validation contract passes
 * unconditionally, preserving existing behavior. When a contract is present,
 * the orchestrator must supply feature claims that cover it (see
 * ./orchestrator-prompt.ts).
 */

import {
	type CoverageReport,
	type FeatureClaim,
	type ValidationContract,
	checkCoverage,
} from "../validation-contract.js";

export interface SwarmCoverageGateInput {
	/** Mission validation contract; when absent the gate passes unconditionally. */
	validationContract?: ValidationContract;
	/** Feature claims to evaluate against the contract. */
	featureClaims?: FeatureClaim[];
}

export interface SwarmCoverageGateResult {
	/** True when there is no contract to gate, or coverage is complete. */
	ok: boolean;
	/** Coverage report, present only when a contract was evaluated. */
	report?: CoverageReport;
	/** Actionable failure message, present only when ok is false. */
	message?: string;
}

/**
 * Render an actionable, single-string explanation of why coverage failed.
 */
export function formatCoverageGateFailure(report: CoverageReport): string {
	const parts: string[] = [
		"Swarm refused to start: the validation contract is not fully covered.",
	];
	if (report.orphans.length > 0) {
		parts.push(
			`Unclaimed assertions (no feature fulfills them): ${report.orphans.join(", ")}.`,
		);
	}
	if (report.duplicates.length > 0) {
		parts.push(
			`Assertions claimed more than once or duplicated in the contract: ${report.duplicates.join(", ")}.`,
		);
	}
	if (report.unknownAssertions.length > 0) {
		parts.push(
			`Features reference assertions absent from the contract: ${report.unknownAssertions.join(", ")}.`,
		);
	}
	parts.push(
		"Every assertion must be claimed by exactly one feature before work begins.",
	);
	return parts.join(" ");
}

/**
 * Evaluate the coverage gate for a swarm. Passes unconditionally when no
 * validation contract is configured.
 */
export function evaluateSwarmCoverageGate(
	input: SwarmCoverageGateInput,
): SwarmCoverageGateResult {
	const { validationContract, featureClaims } = input;
	if (!validationContract) {
		return { ok: true };
	}
	const report = checkCoverage(validationContract, featureClaims ?? []);
	if (report.ok) {
		return { ok: true, report };
	}
	return { ok: false, report, message: formatCoverageGateFailure(report) };
}
