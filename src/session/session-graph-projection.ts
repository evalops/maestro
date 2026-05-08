import type { AppMessage, ToolCall } from "../agent/types.js";
import { migrateToCurrentVersion } from "./migration.js";
import type {
	CompactionEntry,
	SessionEntry,
	SessionHeaderEntry,
	SessionTreeEntry,
} from "./types.js";
import { isSessionTreeEntry } from "./types.js";

export interface SessionGraphCompactionSpan {
	id: string;
	firstKeptEntryId: string;
	summary: string;
	tokensBefore: number;
	sourceEntryIds: string[];
}

export interface SessionGraphTurn {
	id: string;
	parentTurnId?: string;
	status: "completed";
	startedAt: string;
	completedAt: string;
	entries: SessionTreeEntry[];
	sourceEntryIds: string[];
	toolCallIds: string[];
}

export interface SessionGraphProjection {
	threadId: string;
	branchId: string;
	leafEntryId?: string;
	activeEntries: SessionTreeEntry[];
	activeEntryIds: string[];
	turns: SessionGraphTurn[];
	compactionSpans: SessionGraphCompactionSpan[];
}

export interface SessionGraphProjectionOptions {
	leafId?: string | null;
}

export function buildSessionGraphProjection(
	entries: SessionEntry[],
	options: SessionGraphProjectionOptions = {},
): SessionGraphProjection {
	migrateToCurrentVersion(entries);
	const header = entries.find(
		(entry): entry is SessionHeaderEntry => entry.type === "session",
	);
	const threadId = header?.id ?? "unknown";
	const activePath = activeTreeEntriesFromSessionEntries(entries, options);
	const leafEntryId = activePath.at(-1)?.id;
	const { activeEntries, compactionSpans } = applyCompactionWindow(activePath);

	return {
		threadId,
		branchId: `${threadId}:${leafEntryId ?? "empty"}`,
		leafEntryId,
		activeEntries,
		activeEntryIds: activeEntries.map((entry) => entry.id),
		turns: buildTurnsFromActiveEntries(activeEntries),
		compactionSpans,
	};
}

function activeTreeEntriesFromSessionEntries(
	entries: SessionEntry[],
	options: SessionGraphProjectionOptions,
): SessionTreeEntry[] {
	const treeEntries = entries.filter(isSessionTreeEntry);
	const entriesById = new Map(treeEntries.map((entry) => [entry.id, entry]));

	if (options.leafId === null) {
		return [];
	}

	const leaf = options.leafId
		? entriesById.get(options.leafId)
		: treeEntries.at(-1);
	if (!leaf) {
		return [];
	}

	const activePath: SessionTreeEntry[] = [];
	const seen = new Set<string>();
	let current: SessionTreeEntry | undefined = leaf;

	while (current && !seen.has(current.id)) {
		activePath.unshift(current);
		seen.add(current.id);
		if (!current.parentId || current.parentId === current.id) {
			break;
		}
		current = entriesById.get(current.parentId);
	}

	return activePath;
}

function applyCompactionWindow(activePath: SessionTreeEntry[]): {
	activeEntries: SessionTreeEntry[];
	compactionSpans: SessionGraphCompactionSpan[];
} {
	const compactionIndex = lastIndexOfCompaction(activePath);
	if (compactionIndex === -1) {
		return { activeEntries: activePath, compactionSpans: [] };
	}

	const compaction = activePath[compactionIndex];
	if (!isCompactionEntry(compaction)) {
		return { activeEntries: activePath, compactionSpans: [] };
	}

	const firstKeptIndex = activePath.findIndex(
		(entry, index) =>
			index < compactionIndex && entry.id === compaction.firstKeptEntryId,
	);
	const windowStart = firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex;
	const sourceEnd = firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex;

	return {
		activeEntries: activePath.slice(windowStart),
		compactionSpans: [
			{
				id: compaction.id,
				firstKeptEntryId: compaction.firstKeptEntryId,
				summary: compaction.summary,
				tokensBefore: compaction.tokensBefore,
				sourceEntryIds: activePath.slice(0, sourceEnd).map((entry) => entry.id),
			},
		],
	};
}

function lastIndexOfCompaction(entries: SessionTreeEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.type === "compaction") {
			return index;
		}
	}
	return -1;
}

function isCompactionEntry(
	entry: SessionTreeEntry | undefined,
): entry is CompactionEntry {
	return entry?.type === "compaction";
}

function buildTurnsFromActiveEntries(
	activeEntries: SessionTreeEntry[],
): SessionGraphTurn[] {
	const turns: SessionGraphTurn[] = [];
	let current: SessionGraphTurn | null = null;
	let previousTurnId: string | undefined;

	for (const entry of activeEntries) {
		const startsUserTurn =
			entry.type === "message" && entry.message.role === "user";
		if (startsUserTurn && current?.entries.length) {
			turns.push(current);
			previousTurnId = current.id;
			current = null;
		}
		if (!current) {
			current = {
				id: startsUserTurn ? entry.id : `turn-${entry.id}`,
				parentTurnId: previousTurnId,
				status: "completed",
				startedAt: entry.timestamp,
				completedAt: entry.timestamp,
				entries: [],
				sourceEntryIds: [],
				toolCallIds: [],
			};
		}
		current.entries.push(entry);
		current.sourceEntryIds.push(entry.id);
		current.completedAt = entry.timestamp;
		for (const toolCallId of extractToolCallIds(entry)) {
			if (!current.toolCallIds.includes(toolCallId)) {
				current.toolCallIds.push(toolCallId);
			}
		}
	}

	if (current?.entries.length) {
		turns.push(current);
	}

	return turns;
}

function extractToolCallIds(entry: SessionTreeEntry): string[] {
	if (entry.type !== "message") {
		return [];
	}
	const message = entry.message as AppMessage;
	if (message.role === "assistant") {
		return message.content
			.filter((content): content is ToolCall => content.type === "toolCall")
			.map((toolCall) => toolCall.id);
	}
	if (message.role === "toolResult") {
		return [message.toolCallId];
	}
	return [];
}
