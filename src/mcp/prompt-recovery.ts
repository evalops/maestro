import { collectMcpMessagesForCompaction } from "../agent/compaction-restoration.js";
import type { AppMessage } from "../agent/types.js";
import { mcpManager } from "./index.js";

type PostKeepMessagesCollector = (
	preservedMessages: AppMessage[],
) => AppMessage[] | Promise<AppMessage[]>;

export function collectCurrentMcpMessagesForCompaction(
	preservedMessages: AppMessage[],
): AppMessage[] {
	return collectMcpMessagesForCompaction(
		preservedMessages,
		mcpManager.getStatus().servers,
	);
}

export function withMcpPostKeepMessages(
	getAdditionalMessages?: PostKeepMessagesCollector,
): (preservedMessages: AppMessage[]) => Promise<AppMessage[]> {
	return async (preservedMessages) => [
		...collectCurrentMcpMessagesForCompaction(preservedMessages),
		...((await getAdditionalMessages?.(preservedMessages)) ?? []),
	];
}
