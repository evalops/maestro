import {
	type HeadlessPendingRequestRestoreState,
	collectHeadlessClientRequestMessagesForCompaction,
} from "../agent/compaction-restoration.js";
import type { AppMessage } from "../agent/types.js";
import { withMcpPostKeepMessages } from "../mcp/prompt-recovery.js";

interface HeadlessCompactionRestoreState {
	pending_client_tools: readonly HeadlessPendingRequestRestoreState[];
	pending_user_inputs: readonly HeadlessPendingRequestRestoreState[];
}

type HeadlessStateGetter = () => HeadlessCompactionRestoreState;

export function withHeadlessPostKeepMessages(
	getState: HeadlessStateGetter,
): (preservedMessages: AppMessage[]) => Promise<AppMessage[]> {
	return withMcpPostKeepMessages((preservedMessages) => {
		const state = getState();
		return collectHeadlessClientRequestMessagesForCompaction(
			preservedMessages,
			{
				pendingClientTools: state.pending_client_tools,
				pendingUserInputs: state.pending_user_inputs,
			},
		);
	});
}
