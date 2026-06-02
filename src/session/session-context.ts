/**
 * Session Context Rebuilding
 * Pure functions for reconstructing conversation context from session entries.
 * Handles tree traversal, compaction, attachment normalization, and metadata extraction.
 */

import type { Stats } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import type { AppMessage } from "../agent/types.js";
import {
	buildConversationModel,
	isRenderableUserMessage,
	renderMessageToPlainText,
} from "../conversation/render-model.js";
import { migrateToCurrentVersion } from "./migration.js";
import {
	buildSessionContextFromEntries,
	selectSessionMessagesForView,
} from "./session-context-core.js";
import { applyAttachmentExtracts } from "./session-sanitize.js";
import type { SessionEntry, SessionMessagesView } from "./types.js";
import { tryParseSessionEntry } from "./types.js";

export {
	buildSessionContextFromEntries,
	extractTextFromContent,
	generateEntryId,
	isLikelyCompactionSummary,
	selectSessionMessagesForView,
} from "./session-context-core.js";
export type { SessionContextSnapshot } from "./session-context-core.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionFileInfo {
	id: string;
	cwd?: string;
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
	archived: boolean;
	archivedAt?: string;
	firstMessage: string;
	allMessagesText: string;
	messagesView: SessionMessagesView;
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
// Session File Info
// ─────────────────────────────────────────────────────────────────────────────

export function buildSessionFileInfo(
	entries: SessionEntry[],
	stats: Stats,
	options: { messagesView?: SessionMessagesView } = {},
): SessionFileInfo | null {
	if (entries.length === 0) {
		return null;
	}
	migrateToCurrentVersion(entries);

	let sessionId = "";
	let cwd: string | undefined;
	let subject: string | undefined;
	let created = stats.birthtime;
	let summary: string | undefined;
	let resumeSummary: string | undefined;
	let memoryExtractionHash: string | undefined;
	let title: string | undefined;
	let tags: string[] | undefined;
	let favorite = false;
	let archived = false;
	let archivedAt: string | undefined;
	const extractedById = new Map<string, string>();

	for (const entry of entries) {
		switch (entry.type) {
			case "session":
				if (!sessionId) {
					sessionId = entry.id;
					created = new Date(entry.timestamp);
				}
				if (typeof entry.cwd === "string" && entry.cwd.trim()) {
					cwd = entry.cwd;
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
				if (typeof entry.archived === "boolean") {
					archived = entry.archived;
					archivedAt =
						entry.archived &&
						typeof entry.archivedAt === "string" &&
						entry.archivedAt.trim()
							? entry.archivedAt
							: undefined;
				}
				break;
			default:
				break;
		}
	}

	const messageCount = entries.filter(
		(entry) => entry.type === "message",
	).length;
	const messagesView = options.messagesView ?? "full";

	if (messagesView === "notLoaded") {
		return {
			id: sessionId || "unknown",
			cwd,
			subject,
			created,
			messages: [],
			messageCount,
			summary,
			resumeSummary,
			memoryExtractionHash,
			title,
			tags,
			favorite,
			archived,
			archivedAt,
			firstMessage: "",
			allMessagesText: "",
			messagesView,
		};
	}

	const context = buildSessionContextFromEntries(entries);

	const normalizedMessages = extractedById.size
		? context.messages.map((message) =>
				applyAttachmentExtracts(message, extractedById),
			)
		: context.messages;
	const selectedMessages = selectSessionMessagesForView(
		normalizedMessages,
		messagesView,
	);

	const renderables = buildConversationModel(selectedMessages);
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
		cwd,
		subject,
		created,
		messages: selectedMessages,
		messageCount,
		summary,
		resumeSummary,
		memoryExtractionHash,
		title,
		tags,
		favorite,
		archived,
		archivedAt,
		firstMessage,
		allMessagesText,
		messagesView,
	};
}
