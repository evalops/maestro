export interface RoutingOutcomeEvidence {
	assistantCompleted: boolean;
	verificationPassed?: boolean;
	userAccepted?: boolean;
	userRejected?: boolean;
	userRetried?: boolean;
	attempts?: number;
	totalCostUsd?: number;
}

export interface RoutingOutcome {
	verified: boolean;
	success: boolean;
	qualityScore: number;
	reasons: string[];
	attempts?: number;
	totalCostUsd?: number;
}

export function deriveRoutingOutcome(
	evidence: RoutingOutcomeEvidence,
): RoutingOutcome {
	const shared = {
		...(evidence.attempts !== undefined
			? { attempts: Math.max(1, Math.floor(evidence.attempts)) }
			: {}),
		...(evidence.totalCostUsd !== undefined
			? { totalCostUsd: Math.max(0, evidence.totalCostUsd) }
			: {}),
	};
	if (evidence.userRejected) {
		return {
			verified: true,
			success: false,
			qualityScore: 0,
			reasons: ["user_rejected"],
			...shared,
		};
	}
	if (evidence.userRetried) {
		return {
			verified: true,
			success: false,
			qualityScore: 0,
			reasons: ["user_retried"],
			...shared,
		};
	}
	if (evidence.verificationPassed || evidence.userAccepted) {
		return {
			verified: true,
			success: true,
			qualityScore: 1,
			reasons: [
				evidence.verificationPassed ? "verification_passed" : "user_accepted",
			],
			...shared,
		};
	}
	return {
		verified: false,
		success: false,
		qualityScore: 0,
		reasons: [
			evidence.assistantCompleted
				? "assistant_completed_without_verification"
				: "assistant_did_not_complete",
		],
		...shared,
	};
}
