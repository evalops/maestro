import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createHookMessage,
} from "../agent/custom-messages.js";
import type { AppMessage } from "../agent/types.js";
import type { SessionManager } from "./manager.js";
import type { SessionTreeEntry } from "./types.js";

export interface BranchSummaryPlan {
	entries: SessionTreeEntry[];
	commonAncestorId: string | null;
}

export function collectEntriesForBranchSummary(
	session: Pick<SessionManager, "getBranch" | "getEntry">,
	oldLeafId: string | null,
	targetId: string,
): BranchSummaryPlan {
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	const oldPath = new Set(
		session.getBranch(oldLeafId).map((entry) => entry.id),
	);
	const targetPath = session.getBranch(targetId);

	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		const entry = targetPath[i]!;
		if (oldPath.has(entry.id)) {
			commonAncestorId = entry.id;
			break;
		}
	}

	const entries: SessionTreeEntry[] = [];
	let current: string | null = oldLeafId;
	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	entries.reverse();
	return { entries, commonAncestorId };
}

function getMessageFromEntry(entry: SessionTreeEntry): AppMessage | undefined {
	switch (entry.type) {
		case "message":
			if (entry.message.role === "toolResult") {
				return undefined;
			}
			return entry.message;
		case "custom_message":
			return createHookMessage(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
				entry.timestamp,
			);
		case "branch_summary":
			return createBranchSummaryMessage(
				entry.summary,
				entry.fromId,
				entry.timestamp,
			);
		case "compaction":
			return createCompactionSummaryMessage(
				entry.summary,
				entry.tokensBefore,
				entry.timestamp,
			);
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
			return undefined;
	}
}

export function buildBranchSummaryMessages(
	entries: SessionTreeEntry[],
	maxMessages = 40,
): AppMessage[] {
	const messages: AppMessage[] = [];
	for (const entry of entries) {
		const message = getMessageFromEntry(entry);
		if (message) {
			messages.push(message);
		}
	}
	if (maxMessages > 0 && messages.length > maxMessages) {
		return messages.slice(-maxMessages);
	}
	return messages;
}
