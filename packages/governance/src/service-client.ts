import {
	type ActionFirewallGovernanceServiceConfig,
	type ResolvedActionFirewallGovernanceServiceConfig,
	evaluateActionWithActionFirewallGovernanceService,
	resolveActionFirewallGovernanceServiceConfig,
} from "../../../src/safety/governance-service-client.js";
import { toApprovalContext } from "./mappers.js";
import type {
	GovernanceEvaluationResult,
	GovernanceToolCall,
} from "./types.js";

export type GovernanceServiceConfig = ActionFirewallGovernanceServiceConfig;
export type ResolvedGovernanceServiceConfig =
	ResolvedActionFirewallGovernanceServiceConfig;

export function resolveGovernanceServiceConfig(
	config: GovernanceServiceConfig | false | undefined,
	toolCall: GovernanceToolCall,
): ResolvedGovernanceServiceConfig | null {
	return resolveActionFirewallGovernanceServiceConfig(
		config,
		toApprovalContext(toolCall),
	);
}

export async function evaluateActionWithGovernanceService(
	config: ResolvedGovernanceServiceConfig,
	toolCall: GovernanceToolCall,
): Promise<GovernanceEvaluationResult | null> {
	const verdict = await evaluateActionWithActionFirewallGovernanceService(
		config,
		toApprovalContext(toolCall),
	);
	if (!verdict) {
		return null;
	}

	if (verdict.action === "allow") {
		return { verdict: "allow" };
	}

	return {
		verdict: verdict.action,
		reason: verdict.reason,
		ruleId: verdict.ruleId,
		triggeredBy: "policy",
	};
}
