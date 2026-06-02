/**
 * Pure session context rebuilding helpers.
 *
 * Keep this module free of session file migration, catalog rendering, and
 * filesystem imports so fresh exec can rebuild in-memory context without
 * pulling the full history/catalog path before the first JSON event.
 */

import { v4 as uuidv4 } from "uuid";
import { isDecoratedCompactionSummaryMessage } from "../agent/compaction-markers.js";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createHookMessage,
} from "../agent/custom-messages.js";
import type { AppMessage } from "../agent/types.js";
import type { SessionModelMetadata } from "./metadata-cache.js";
import type {
	CompactionEntry,
	SessionEntry,
	SessionHeaderEntry,
	SessionMessagesView,
	SessionTreeEntry,
} from "./types.js";
import { isSessionTreeEntry } from "./types.js";

export interface SessionContextSnapshot {
	messages: AppMessage[];
	messageEntries: SessionTreeEntry[];
	thinkingLevel: string;
	model: string | null;
	modelMetadata?: SessionModelMetadata;
}

export function extractTextFromContent(
	content: string | { type: string; text?: string }[],
): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(block) => block.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text)
			.join(" ");
	}
	return "";
}

export function isLikelyCompactionSummary(message: AppMessage): boolean {
	return isDecoratedCompactionSummaryMessage(message);
}

export function generateEntryId(existing: {
	has(id: string): boolean;
}): string {
	for (let i = 0; i < 100; i++) {
		const id = uuidv4().slice(0, 8);
		if (!existing.has(id)) {
			return id;
		}
	}
	return uuidv4();
}

export function buildSessionContextFromEntries(
	entries: SessionEntry[],
	options?: {
		leafId?: string | null;
		byId?: Map<string, SessionTreeEntry>;
		header?: SessionHeaderEntry | null;
	},
): SessionContextSnapshot {
	const treeEntries = entries.filter(isSessionTreeEntry);
	const byId = options?.byId ?? new Map<string, SessionTreeEntry>();
	if (!options?.byId) {
		for (const entry of treeEntries) {
			byId.set(entry.id, entry);
		}
	}

	const header =
		options?.header ??
		(entries.find((e) => e.type === "session") as SessionHeaderEntry | null);
	let thinkingLevel = header?.thinkingLevel ?? "off";
	let model = header?.model ?? null;
	let modelMetadata = header?.modelMetadata;

	if (options?.leafId === null) {
		return {
			messages: [],
			messageEntries: [],
			thinkingLevel,
			model,
			modelMetadata,
		};
	}

	let leaf: SessionTreeEntry | undefined;
	if (options?.leafId) {
		leaf = byId.get(options.leafId);
	}
	if (!leaf) {
		leaf = treeEntries[treeEntries.length - 1];
	}

	if (!leaf) {
		return {
			messages: [],
			messageEntries: [],
			thinkingLevel,
			model,
			modelMetadata,
		};
	}

	const path: SessionTreeEntry[] = [];
	let current: SessionTreeEntry | undefined = leaf;
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}

	let compaction: CompactionEntry | null = null;
	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = entry.model;
			if (entry.modelMetadata) {
				modelMetadata = entry.modelMetadata;
			}
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = `${entry.message.provider}/${entry.message.model}`;
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	const messages: AppMessage[] = [];
	const messageEntries: SessionTreeEntry[] = [];

	const appendMessage = (entry: SessionTreeEntry) => {
		if (entry.type === "message") {
			messages.push(entry.message);
			messageEntries.push(entry);
			return;
		}
		if (entry.type === "custom_message") {
			messages.push(
				createHookMessage(
					entry.customType,
					entry.content,
					entry.display,
					entry.details,
					entry.timestamp,
				),
			);
			messageEntries.push(entry);
			return;
		}
		if (entry.type === "branch_summary" && entry.summary) {
			messages.push(
				createBranchSummaryMessage(
					entry.summary,
					entry.fromId,
					entry.timestamp,
				),
			);
			messageEntries.push(entry);
		}
	};

	if (compaction) {
		const compactionIdx = path.findIndex(
			(entry) => entry.type === "compaction" && entry.id === compaction.id,
		);
		const hasStoredSummary = path
			.slice(compactionIdx + 1)
			.some(
				(entry) =>
					entry.type === "message" && isLikelyCompactionSummary(entry.message),
			);

		if (!hasStoredSummary) {
			messages.push(
				createCompactionSummaryMessage(
					compaction.summary,
					compaction.tokensBefore,
					compaction.timestamp,
				),
			);
			messageEntries.push(compaction);
		}

		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i]!;
			if (entry.id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				appendMessage(entry);
			}
		}

		for (let i = compactionIdx + 1; i < path.length; i++) {
			appendMessage(path[i]!);
		}
	} else {
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	return { messages, messageEntries, thinkingLevel, model, modelMetadata };
}

export function selectSessionMessagesForView(
	messages: AppMessage[],
	view: SessionMessagesView = "full",
): AppMessage[] {
	if (view === "notLoaded") {
		return [];
	}
	if (view === "full" || messages.length <= 2) {
		return messages;
	}
	const firstUser = messages.find((message) => message.role === "user");
	const lastMessage = messages.at(-1);
	const selected: AppMessage[] = [];
	if (firstUser) {
		selected.push(firstUser);
	}
	if (lastMessage && lastMessage !== firstUser) {
		selected.push(lastMessage);
	}
	return selected.length > 0 ? selected : messages.slice(0, 1);
}
