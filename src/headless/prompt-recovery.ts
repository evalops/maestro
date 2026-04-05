import {
	type HeadlessPendingRequestRestoreState,
	collectHeadlessRequestMessagesForCompaction,
} from "../agent/compaction-restoration.js";
import type { AppMessage } from "../agent/types.js";
import { withMcpPostKeepMessages } from "../mcp/prompt-recovery.js";

interface HeadlessCompactionRestoreState {
	pending_approvals: readonly HeadlessPendingRequestRestoreState[];
	pending_client_tools: readonly HeadlessPendingRequestRestoreState[];
	pending_user_inputs: readonly HeadlessPendingRequestRestoreState[];
	pending_tool_retries: readonly HeadlessPendingRequestRestoreState[];
}

type HeadlessStateGetter = () => HeadlessCompactionRestoreState;

export function withHeadlessPostKeepMessages(
	getState: HeadlessStateGetter,
): (preservedMessages: AppMessage[]) => Promise<AppMessage[]> {
	return withMcpPostKeepMessages((preservedMessages) => {
		const state = getState();
		return collectHeadlessRequestMessagesForCompaction(preservedMessages, {
			pendingApprovals: state.pending_approvals,
			pendingClientTools: state.pending_client_tools,
			pendingUserInputs: state.pending_user_inputs,
			pendingToolRetries: state.pending_tool_retries,
		});
	});
}
