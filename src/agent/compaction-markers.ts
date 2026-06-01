import type { AppMessage } from "./types.js";

export const COMPACTION_RESUME_PROMPT =
	"Use the above summary to resume the plan from where we left off.";

function extractMessageText(message: AppMessage): string {
	const content =
		message.role === "assistant" || message.role === "user"
			? message.content
			: undefined;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "thinking") return part.thinking;
			return "";
		})
		.filter((part): part is string => Boolean(part))
		.join(" ");
}

export function isDecoratedCompactionSummaryText(text: string): boolean {
	const normalized = text.trim();
	if (!normalized) return false;
	return (
		normalized.includes(
			"Another language model started to solve this problem",
		) ||
		normalized.includes("(Compacted") ||
		normalized.includes("_Local summary of prior discussion")
	);
}

export function isDecoratedCompactionSummaryMessage(
	message: AppMessage,
): boolean {
	if (message.role !== "assistant") return false;
	return isDecoratedCompactionSummaryText(extractMessageText(message));
}

export function isCompactionResumePromptText(text: string): boolean {
	return text.trim() === COMPACTION_RESUME_PROMPT;
}

export function isCompactionResumePromptMessage(message: AppMessage): boolean {
	if (message.role !== "user") return false;
	return isCompactionResumePromptText(extractMessageText(message));
}
