/**
 * Session Context Rebuilding
 * Pure functions for reconstructing conversation context from session entries.
 * Handles tree traversal, compaction, attachment normalization, and metadata extraction.
 */

import type { Stats } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { isDecoratedCompactionSummaryMessage } from "../agent/compaction.js";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createHookMessage,
} from "../agent/custom-messages.js";
import type { AppMessage } from "../agent/types.js";
import {
	buildConversationModel,
	isRenderableUserMessage,
	renderMessageToPlainText,
} from "../conversation/render-model.js";
import type { SessionModelMetadata } from "./metadata-cache.js";
import { migrateToCurrentVersion } from "./migration.js";
import { applyAttachmentExtracts } from "./session-sanitize.js";
import type {
	CompactionEntry,
	SessionEntry,
	SessionHeaderEntry,
	SessionTreeEntry,
} from "./types.js";
import { isSessionTreeEntry, tryParseSessionEntry } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionFileInfo {
	id: string;
	subject?: string;
	created: Date;
	messages: AppMessage[];
	messageCount: number;
	summary?: string;
	resumeSummary?: string;
	memoryExtractionHash?: string;
	title?: string;
	tags?: string[];
	favorite: boolean;
	firstMessage: string;
	allMessagesText: string;
}

export interface SessionContextSnapshot {
	messages: AppMessage[];
	messageEntries: SessionTreeEntry[];
	thinkingLevel: string;
	model: string | null;
	modelMetadata?: SessionModelMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Entry ID Generation
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Entry Parsing
// ─────────────────────────────────────────────────────────────────────────────

export function readSessionEntries(filePath: string): SessionEntry[] {
	if (!existsSync(filePath)) {
		return [];
	}
	const contents = readFileSync(filePath, "utf8").trim();
	if (!contents) {
		return [];
	}

	const entries: SessionEntry[] = [];
	for (const line of contents.split("\n")) {
		const entry = tryParseSessionEntry(line);
		if (entry) {
			entries.push(entry);
		}
	}
	return entries;
}

export function safeReadSessionEntries(
	filePath: string,
	onError?: (error: unknown) => void,
): SessionEntry[] {
	try {
		return readSessionEntries(filePath);
	} catch (error) {
		onError?.(error);
		return [];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Rebuilding
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Session File Info
// ─────────────────────────────────────────────────────────────────────────────

export function buildSessionFileInfo(
	entries: SessionEntry[],
	stats: Stats,
): SessionFileInfo | null {
	if (entries.length === 0) {
		return null;
	}
	migrateToCurrentVersion(entries);

	let sessionId = "";
	let subject: string | undefined;
	let created = stats.birthtime;
	let summary: string | undefined;
	let resumeSummary: string | undefined;
	let memoryExtractionHash: string | undefined;
	let title: string | undefined;
	let tags: string[] | undefined;
	let favorite = false;
	const extractedById = new Map<string, string>();

	for (const entry of entries) {
		switch (entry.type) {
			case "session":
				if (!sessionId) {
					sessionId = entry.id;
					created = new Date(entry.timestamp);
				}
				if (typeof entry.subject === "string" && entry.subject) {
					subject = entry.subject;
				}
				break;
			case "attachment_extract":
				if (entry.attachmentId && entry.extractedText) {
					extractedById.set(entry.attachmentId, entry.extractedText);
				}
				break;
			case "session_meta":
				if (typeof entry.summary === "string" && entry.summary.trim()) {
					summary = entry.summary;
				}
				if (
					typeof entry.resumeSummary === "string" &&
					entry.resumeSummary.trim()
				) {
					resumeSummary = entry.resumeSummary;
				}
				if (
					typeof entry.memoryExtractionHash === "string" &&
					entry.memoryExtractionHash.trim()
				) {
					memoryExtractionHash = entry.memoryExtractionHash;
				}
				if (typeof entry.title === "string" && entry.title.trim()) {
					title = entry.title;
				}
				if (Array.isArray(entry.tags)) {
					tags = entry.tags;
				}
				if (typeof entry.favorite === "boolean") {
					favorite = entry.favorite;
				}
				break;
			default:
				break;
		}
	}

	const context = buildSessionContextFromEntries(entries);
	const messageCount = entries.filter(
		(entry) => entry.type === "message",
	).length;

	const normalizedMessages = extractedById.size
		? context.messages.map((message) =>
				applyAttachmentExtracts(message, extractedById),
			)
		: context.messages;

	const renderables = buildConversationModel(normalizedMessages);
	const firstRenderableUser = renderables.find((renderable) =>
		isRenderableUserMessage(renderable),
	);
	const firstMessage = firstRenderableUser
		? renderMessageToPlainText(firstRenderableUser)
		: "";
	const allMessagesText = renderables
		.map((renderable) => renderMessageToPlainText(renderable))
		.filter(Boolean)
		.join(" ");

	return {
		id: sessionId || "unknown",
		subject,
		created,
		messages: normalizedMessages,
		messageCount,
		summary,
		resumeSummary,
		memoryExtractionHash,
		title,
		tags,
		favorite,
		firstMessage,
		allMessagesText,
	};
}
