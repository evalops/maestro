import type {
	AgentProfilePin,
	RoutingReceipt,
	RoutingReceiptExperiment,
	RoutingReceiptSource,
} from "@evalops/contracts";
import type { OracleConsultationDecision } from "./oracle-consultation-policy.js";
import type { AgentProfile } from "./profiles.js";

export interface AgentProfileSelectionInput {
	requestedProfile?: string;
	sessionPin?: AgentProfilePin;
	compatibilityProfile: string;
}

export interface AgentProfileSelection {
	requestedProfile: string;
	source: RoutingReceiptSource;
}

export interface RoutingReceiptDecision {
	decisionId: string;
	selectedModel: { provider: string; model: string };
	selectedProfile: AgentProfile;
	createdAt: string;
	oracleConsultation?: OracleConsultationDecision;
}

export interface RoutingReceiptContext extends AgentProfileSelection {
	fallbackReason?: string;
	fallbackModel?: { provider: string; model: string };
	experiment?: RoutingReceiptExperiment;
}

export function resolveAgentProfileSelection(
	input: AgentProfileSelectionInput,
): AgentProfileSelection {
	if (input.requestedProfile?.trim()) {
		return {
			requestedProfile: input.requestedProfile.trim(),
			source: "request",
		};
	}
	if (input.sessionPin?.profile.trim()) {
		return {
			requestedProfile: input.sessionPin.profile.trim(),
			source: "session",
		};
	}
	if (!input.compatibilityProfile.trim()) {
		throw new Error("A compatibility profile is required");
	}
	return {
		requestedProfile: input.compatibilityProfile.trim(),
		source: "compatibility_default",
	};
}

/** Project a routing decision into immutable historical turn metadata. */
export function createRoutingReceipt(
	decision: RoutingReceiptDecision,
	context: RoutingReceiptContext,
): RoutingReceipt {
	const oracle = decision.oracleConsultation
		? Object.freeze({
				policyVersion: decision.oracleConsultation.policyVersion,
				mode: decision.oracleConsultation.mode,
				reasons: Object.freeze([...decision.oracleConsultation.reasons]),
			})
		: undefined;
	const fallback = context.fallbackReason
		? Object.freeze({
				reason: context.fallbackReason,
				...(context.fallbackModel ?? {}),
			})
		: undefined;
	const experiment = context.experiment
		? Object.freeze({ ...context.experiment })
		: undefined;

	return Object.freeze({
		decisionId: decision.decisionId,
		requestedProfile: context.requestedProfile,
		source: context.source,
		resolvedProfileId: decision.selectedProfile.id,
		resolvedProfileVersion: decision.selectedProfile.version,
		provider: decision.selectedModel.provider,
		model: decision.selectedModel.model,
		reasoningEffort: decision.selectedProfile.primary.reasoningEffort,
		createdAt: decision.createdAt,
		...(oracle ? { oracle } : {}),
		...(fallback ? { fallback } : {}),
		...(experiment ? { experiment } : {}),
	});
}
