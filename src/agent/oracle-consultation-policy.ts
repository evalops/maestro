import type { AgentProfileLevel } from "./profiles.js";

export const ORACLE_CONSULTATION_POLICY_VERSION =
	"evalops.maestro.oracle-consultation.v1";

export type OracleConsultationMode = "available" | "recommended" | "required";

export interface OracleConsultationPolicyInput {
	profileLevel: AgentProfileLevel;
	taskType: string;
	taskSummary?: string;
	priorFailures?: number;
}

export interface OracleConsultationDecision {
	policyVersion: typeof ORACLE_CONSULTATION_POLICY_VERSION;
	evalSuite: "oracle-consultation-policy-v1";
	mode: OracleConsultationMode;
	reasons: string[];
}

const CONSULTATION_TASK_TYPES = new Set([
	"architecture",
	"code_review",
	"discovery",
	"incident_response",
	"migration",
	"planning",
	"security_review",
]);

const UNCERTAINTY_PATTERN =
	/\b(?:ambiguous|unclear|uncertain|trade-?offs?|cross[- ]cutting|multiple approaches|data loss|irreversible|root cause unknown)\b/i;

export function recommendOracleConsultation(
	input: OracleConsultationPolicyInput,
): OracleConsultationDecision {
	const reasons: string[] = [];
	const priorFailures = Math.max(0, Math.floor(input.priorFailures ?? 0));
	let mode: OracleConsultationMode = "available";

	if (input.profileLevel === "ultra") {
		mode = "required";
		reasons.push("ultra_profile");
	} else if (input.profileLevel === "high") {
		mode = "recommended";
		reasons.push("high_profile");
	}

	if (CONSULTATION_TASK_TYPES.has(input.taskType.trim().toLowerCase())) {
		if (mode === "available") mode = "recommended";
		reasons.push("consultation_task_type");
	}

	if (input.taskSummary && UNCERTAINTY_PATTERN.test(input.taskSummary)) {
		if (mode === "available") mode = "recommended";
		reasons.push("uncertainty_signal");
	}

	if (priorFailures >= 2) {
		mode = input.profileLevel === "low" ? "recommended" : "required";
		reasons.push("repeated_failures");
	}

	if (reasons.length === 0) reasons.push("oracle_available_on_demand");
	return {
		policyVersion: ORACLE_CONSULTATION_POLICY_VERSION,
		evalSuite: "oracle-consultation-policy-v1",
		mode,
		reasons,
	};
}

export function formatOracleConsultationDirective(
	decision: OracleConsultationDecision,
): string {
	const instruction =
		decision.mode === "required"
			? "You MUST consult the read-only Oracle once before committing to the plan or final answer. Incorporate or explicitly rebut its advice."
			: decision.mode === "recommended"
				? "Consult the read-only Oracle once before committing to the plan or final answer unless the task has become clearly bounded; if you skip it, state the concrete reason."
				: "The read-only Oracle is available on demand.";
	return [
		`Oracle consultation policy (${decision.policyVersion})`,
		instruction,
		`Triggers: ${decision.reasons.join(", ")}.`,
	].join("\n");
}

export function applyOracleConsultationDirective(
	agent: { queueNextRunSystemPromptAddition(text: string): void },
	decision: OracleConsultationDecision | undefined,
): boolean {
	if (!decision || decision.mode === "available") return false;
	agent.queueNextRunSystemPromptAddition(
		formatOracleConsultationDirective(decision),
	);
	return true;
}
