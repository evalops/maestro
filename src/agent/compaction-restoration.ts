import { createHookMessage } from "./custom-messages.js";
import {
	getCurrentPlanFilePath,
	isPlanModeActive,
	readPlanFile,
} from "./plan-mode.js";
import type { AppMessage } from "./types.js";

export const PLAN_FILE_COMPACTION_CUSTOM_TYPE = "plan-file";
export const PLAN_MODE_COMPACTION_CUSTOM_TYPE = "plan-mode";

function buildPlanFileCompactionContent(
	filePath: string,
	planContent: string,
): string {
	return [
		"# Active plan file restored after compaction",
		"",
		`Plan file: ${filePath}`,
		"",
		"Current plan contents:",
		planContent,
	].join("\n");
}

function buildPlanFileCompactionMessage(
	filePath: string,
	planContent: string,
): AppMessage {
	return createHookMessage(
		PLAN_FILE_COMPACTION_CUSTOM_TYPE,
		buildPlanFileCompactionContent(filePath, planContent),
		false,
		{ filePath },
		new Date().toISOString(),
	);
}

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

function hasPlanFileCompactionMessage(
	messages: AppMessage[],
	filePath: string,
	planContent: string,
): boolean {
	const expectedContent = buildPlanFileCompactionContent(filePath, planContent);
	return messages.some((message) => {
		if (
			message.role !== "hookMessage" ||
			message.customType !== PLAN_FILE_COMPACTION_CUSTOM_TYPE
		) {
			return false;
		}

		const details = message.details;
		if (
			typeof details === "object" &&
			details !== null &&
			"filePath" in details &&
			typeof details.filePath === "string" &&
			details.filePath !== filePath
		) {
			return false;
		}

		return message.content === expectedContent;
	});
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

export function collectPlanMessagesForCompaction(
	messages: AppMessage[],
): AppMessage[] {
	if (!isPlanModeActive()) {
		return [];
	}

	const filePath = getCurrentPlanFilePath();
	if (!filePath) {
		return [];
	}

	const restoredMessages: AppMessage[] = [];
	const planContent = readPlanFile();
	if (
		typeof planContent === "string" &&
		planContent.length > 0 &&
		!hasPlanFileCompactionMessage(messages, filePath, planContent)
	) {
		restoredMessages.push(
			buildPlanFileCompactionMessage(filePath, planContent),
		);
	}

	if (!hasPlanModeCompactionMessage(messages, filePath)) {
		restoredMessages.push(buildPlanModeCompactionMessage(filePath));
	}

	return restoredMessages;
}

export function collectPlanModeMessagesForCompaction(
	messages: AppMessage[],
): AppMessage[] {
	return collectPlanMessagesForCompaction(messages).filter(
		(message) =>
			message.role === "hookMessage" &&
			message.customType === PLAN_MODE_COMPACTION_CUSTOM_TYPE,
	);
}
