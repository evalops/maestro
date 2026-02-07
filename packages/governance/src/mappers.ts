/**
 * Internal mappers between governance types and Composer internals.
 *
 * These functions bridge the agent-agnostic GovernanceToolCall type to
 * the Composer-specific ActionApprovalContext type used by the existing
 * safety pipeline. This module is NOT exported from the package.
 *
 * @internal
 */

import type { ActionApprovalContext } from "../../../src/agent/action-approval.js";
import type { GovernanceToolCall, GovernanceVerdict } from "./types.js";

/**
 * Convert a GovernanceToolCall to an ActionApprovalContext for the firewall.
 */
export function toApprovalContext(
	toolCall: GovernanceToolCall,
): ActionApprovalContext {
	return {
		toolName: toolCall.toolName,
		args: toolCall.args,
		metadata: toolCall.metadata
			? {
					annotations: toolCall.metadata.annotations,
				}
			: undefined,
		user: toolCall.user,
		session: toolCall.session,
		userIntent: toolCall.userIntent,
	};
}

/**
 * Convert an ActionFirewallVerdict action string to a GovernanceVerdict.
 */
export function toGovernanceVerdict(
	action: "allow" | "require_approval" | "block",
): GovernanceVerdict {
	return action;
}
