/**
 * Type definitions for session management.
 * Extracted to eliminate 'any' types and improve type safety.
 */

import type { AppMessage } from "../agent/types.js";
import type { SessionModelMetadata } from "./metadata-cache.js";

/**
 * Base session entry
 */
interface BaseSessionEntry {
	timestamp: string;
}

/**
 * Session header entry (first line in JSONL file)
 */
export interface SessionHeaderEntry extends BaseSessionEntry {
	type: "session";
	id: string;
	cwd: string;
	model: string;
	modelMetadata?: SessionModelMetadata;
	thinkingLevel: string;
	systemPrompt?: string;
	tools?: SessionToolInfo[];
	/** Path to parent session file if this session was branched */
	branchedFrom?: string;
}

export interface SessionToolInfo {
	name: string;
	label?: string;
	description?: string;
}

/**
 * Message entry containing conversation messages
 */
export interface SessionMessageEntry extends BaseSessionEntry {
	type: "message";
	message: AppMessage;
}

/**
 * Attachment extraction entry (append-only cache for extracted text)
 */
export interface AttachmentExtractedEntry extends BaseSessionEntry {
	type: "attachment_extract";
	attachmentId: string;
	extractedText: string;
}

/**
 * Thinking level change event
 */
export interface ThinkingLevelChangeEntry extends BaseSessionEntry {
	type: "thinking_level_change";
	thinkingLevel: string;
}

/**
 * Model change event
 */
export interface ModelChangeEntry extends BaseSessionEntry {
	type: "model_change";
	model: string;
	modelMetadata?: SessionModelMetadata;
}

/**
 * Session metadata entry (summary, favorite status, title, tags)
 */
export interface SessionMetaEntry extends BaseSessionEntry {
	type: "session_meta";
	summary?: string;
	favorite?: boolean;
	title?: string;
	tags?: string[];
}

/**
 * Compaction entry recording when context was compacted.
 *
 * When context window usage approaches limits, older messages are summarized
 * and this entry records the compaction event. The session loader uses this
 * to reconstruct the conversation with the summary replacing compacted messages.
 */
export interface CompactionEntry extends BaseSessionEntry {
	type: "compaction";
	/** Generated summary of the compacted messages */
	summary: string;
	/** Index of the first entry to keep (entries before this were summarized) */
	firstKeptEntryIndex: number;
	/** Token count before compaction (for metrics/debugging) */
	tokensBefore: number;
	/** Whether this was auto-triggered vs manual /compact command */
	auto?: boolean;
	/** Custom instructions provided to focus the summary (if any) */
	customInstructions?: string;
}

/**
 * Union type of all possible session entry types
 */
export type SessionEntry =
	| SessionHeaderEntry
	| SessionMessageEntry
	| AttachmentExtractedEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| SessionMetaEntry
	| CompactionEntry;

/**
 * Type guard to check if an entry is a session header
 */
export function isSessionHeaderEntry(
	entry: unknown,
): entry is SessionHeaderEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "session" &&
		"id" in entry &&
		typeof entry.id === "string"
	);
}

/**
 * Type guard to check if an entry is a message
 */
export function isSessionMessageEntry(
	entry: unknown,
): entry is SessionMessageEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "message" &&
		"message" in entry
	);
}

/**
 * Type guard to check if an entry is an attachment extraction
 */
export function isAttachmentExtractedEntry(
	entry: unknown,
): entry is AttachmentExtractedEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "attachment_extract" &&
		"attachmentId" in entry &&
		typeof (entry as AttachmentExtractedEntry).attachmentId === "string" &&
		"extractedText" in entry &&
		typeof (entry as AttachmentExtractedEntry).extractedText === "string"
	);
}

/**
 * Type guard to check if an entry is a thinking level change
 */
export function isThinkingLevelChangeEntry(
	entry: unknown,
): entry is ThinkingLevelChangeEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "thinking_level_change" &&
		"thinkingLevel" in entry &&
		typeof entry.thinkingLevel === "string"
	);
}

/**
 * Type guard to check if an entry is a model change
 */
export function isModelChangeEntry(entry: unknown): entry is ModelChangeEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "model_change" &&
		"model" in entry &&
		typeof entry.model === "string"
	);
}

/**
 * Type guard to check if an entry is session metadata
 */
export function isSessionMetaEntry(entry: unknown): entry is SessionMetaEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "session_meta"
	);
}

/**
 * Type guard to check if an entry is a compaction event
 */
export function isCompactionEntry(entry: unknown): entry is CompactionEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "compaction" &&
		"summary" in entry &&
		typeof (entry as CompactionEntry).summary === "string" &&
		"firstKeptEntryIndex" in entry &&
		typeof (entry as CompactionEntry).firstKeptEntryIndex === "number"
	);
}

/**
 * Parse a JSONL line into a typed session entry
 * @throws {SessionParseError} if the line is invalid JSON or doesn't match any entry type
 */
export function parseSessionEntry(line: string): SessionEntry {
	try {
		const parsed: unknown = JSON.parse(line);

		if (isSessionHeaderEntry(parsed)) return parsed;
		if (isSessionMessageEntry(parsed)) return parsed;
		if (isAttachmentExtractedEntry(parsed)) return parsed;
		if (isThinkingLevelChangeEntry(parsed)) return parsed;
		if (isModelChangeEntry(parsed)) return parsed;
		if (isSessionMetaEntry(parsed)) return parsed;
		if (isCompactionEntry(parsed)) return parsed;

		throw new SessionParseError(
			`Unknown entry type: ${typeof parsed === "object" && parsed !== null && "type" in parsed ? (parsed as { type: unknown }).type : "unknown"}`,
		);
	} catch (error) {
		if (error instanceof SessionParseError) throw error;
		throw new SessionParseError(
			`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Safely parse a session entry, returning null on failure
 */
export function tryParseSessionEntry(line: string): SessionEntry | null {
	try {
		return parseSessionEntry(line);
	} catch {
		return null;
	}
}

/**
 * Error thrown when session entry parsing fails
 */
export class SessionParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionParseError";
	}
}

/**
 * Session metadata for display/search
 */
export interface SessionMetadata {
	path: string;
	id: string;
	created: Date;
	modified: Date;
	size: number;
	messageCount: number;
	firstMessage: string;
	summary: string;
	favorite: boolean;
	allMessagesText: string;
	title?: string;
	tags?: string[];
}

/**
 * Session summary returned by listSessions()
 */
export interface SessionSummary {
	id: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	favorite: boolean;
	tags?: string[];
}
