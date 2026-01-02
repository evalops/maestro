import type {
	AppMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	HookMessage,
	ImageContent,
	Message,
	TextContent,
	UserMessage,
} from "./types.js";

export const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
export const BRANCH_SUMMARY_PREFIX =
	"The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
export const BRANCH_SUMMARY_SUFFIX = "\n</summary>";

function normalizeContent(
	content: string | (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return content;
}

export function createHookMessage<T = unknown>(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: T | undefined,
	timestamp: string,
): HookMessage<T> {
	return {
		role: "hookMessage",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createBranchSummaryMessage(
	summary: string,
	fromId: string,
	timestamp: string,
): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function hookMessageToUserMessage(message: HookMessage): UserMessage {
	return {
		role: "user",
		content: normalizeContent(message.content),
		timestamp: message.timestamp,
	};
}

export function branchSummaryToUserMessage(
	message: BranchSummaryMessage,
): UserMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX,
			},
		],
		timestamp: message.timestamp,
	};
}

export function compactionSummaryToUserMessage(
	message: CompactionSummaryMessage,
): UserMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text:
					COMPACTION_SUMMARY_PREFIX +
					message.summary +
					COMPACTION_SUMMARY_SUFFIX,
			},
		],
		timestamp: message.timestamp,
	};
}

export function isCoreMessage(message: AppMessage): message is Message {
	return (
		message.role === "user" ||
		message.role === "assistant" ||
		message.role === "toolResult"
	);
}

export function convertAppMessageToLlm(
	message: AppMessage,
): Message | undefined {
	if (message.role === "hookMessage") {
		return hookMessageToUserMessage(message);
	}
	if (message.role === "branchSummary") {
		return branchSummaryToUserMessage(message);
	}
	if (message.role === "compactionSummary") {
		return compactionSummaryToUserMessage(message);
	}
	if (
		message.role === "user" ||
		message.role === "assistant" ||
		message.role === "toolResult"
	) {
		return message as Message;
	}
	return undefined;
}

export function convertAppMessagesToLlm(messages: AppMessage[]): Message[] {
	const result: Message[] = [];
	for (const message of messages) {
		const converted = convertAppMessageToLlm(message);
		if (converted) {
			result.push(converted);
		}
	}
	return result;
}
