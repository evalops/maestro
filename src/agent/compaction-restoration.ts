import { createHookMessage } from "./custom-messages.js";
import { getCurrentPlanFilePath, isPlanModeActive } from "./plan-mode.js";
import type { AppMessage } from "./types.js";

export const PLAN_MODE_COMPACTION_CUSTOM_TYPE = "plan-mode";

function buildPlanModeCompactionMessage(filePath: string): AppMessage {
	return createHookMessage(
		PLAN_MODE_COMPACTION_CUSTOM_TYPE,
		[
			"# Plan mode remains active after compaction",
			"",
			`Plan file: ${filePath}`,
			"",
			"Continue operating in plan mode.",
			"Treat the active plan file as the source of truth for outstanding work, and read or update it as needed before continuing implementation.",
		].join("\n"),
		false,
		{ filePath },
		new Date().toISOString(),
	);
}

function hasPlanModeCompactionMessage(
	messages: AppMessage[],
	filePath: string,
): boolean {
	return messages.some((message) => {
		if (
			message.role !== "hookMessage" ||
			message.customType !== PLAN_MODE_COMPACTION_CUSTOM_TYPE
		) {
			return false;
		}

		const details = message.details;
		if (
			typeof details === "object" &&
			details !== null &&
			"filePath" in details &&
			typeof details.filePath === "string"
		) {
			return details.filePath === filePath;
		}

		return (
			typeof message.content === "string" &&
			message.content.includes(`Plan file: ${filePath}`)
		);
	});
}

export function collectPlanModeMessagesForCompaction(
	messages: AppMessage[],
): AppMessage[] {
	if (!isPlanModeActive()) {
		return [];
	}

	const filePath = getCurrentPlanFilePath();
	if (!filePath || hasPlanModeCompactionMessage(messages, filePath)) {
		return [];
	}

	return [buildPlanModeCompactionMessage(filePath)];
}
