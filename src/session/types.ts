/**
 * Type definitions for session management.
 * Extracted to eliminate 'any' types and improve type safety.
 */

import type { AppMessage } from "../agent/types.js";
import type { SessionModelMetadata } from "./manager.js";

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
 * Session metadata entry (summary, favorite status)
 */
export interface SessionMetaEntry extends BaseSessionEntry {
	type: "session_meta";
	summary?: string;
	favorite?: boolean;
}

/**
 * Union type of all possible session entry types
 */
export type SessionEntry =
	| SessionHeaderEntry
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| SessionMetaEntry;

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
 * Parse a JSONL line into a typed session entry
 * @throws {SessionParseError} if the line is invalid JSON or doesn't match any entry type
 */
export function parseSessionEntry(line: string): SessionEntry {
	try {
		const parsed: unknown = JSON.parse(line);

		if (isSessionHeaderEntry(parsed)) return parsed;
		if (isSessionMessageEntry(parsed)) return parsed;
		if (isThinkingLevelChangeEntry(parsed)) return parsed;
		if (isModelChangeEntry(parsed)) return parsed;
		if (isSessionMetaEntry(parsed)) return parsed;

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
}
