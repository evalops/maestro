import type { AppMessage, ImageContent, TextContent } from "../agent/types.js";

export const CURRENT_SESSION_VERSION = 2;

export interface SessionModelMetadata {
	provider: string;
	modelId: string;
	providerName?: string;
	name?: string;
	baseUrl?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	source?: "builtin" | "custom";
}

export interface SessionToolInfo {
	name: string;
	label?: string;
	description?: string;
}

export interface SessionHeaderEntry {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	model?: string;
	modelMetadata?: SessionModelMetadata;
	thinkingLevel?: string;
	systemPrompt?: string;
	tools?: SessionToolInfo[];
	branchedFrom?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AppMessage;
}

export interface AttachmentExtractedEntry {
	type: "attachment_extract";
	timestamp: string;
	attachmentId: string;
	extractedText: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	model: string;
	modelMetadata?: SessionModelMetadata;
}

export interface SessionMetaEntry {
	type: "session_meta";
	timestamp: string;
	summary?: string;
	favorite?: boolean;
	title?: string;
	tags?: string[];
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	fromHook?: boolean;
	auto?: boolean;
	customInstructions?: string;
	/** Legacy compaction index (v1 sessions). */
	firstKeptEntryIndex?: number;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export type SessionTreeEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry;

export type SessionEntry =
	| SessionHeaderEntry
	| SessionTreeEntry
	| SessionMetaEntry
	| AttachmentExtractedEntry;

export interface SessionTreeNode {
	entry: SessionTreeEntry;
	children: SessionTreeNode[];
	label?: string;
}

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

export interface SessionSummary {
	id: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	favorite: boolean;
	tags?: string[];
}

export function parseSessionEntry(line: string): SessionEntry {
	const trimmed = line.trim();
	if (!trimmed) {
		throw new Error("Empty session entry");
	}
	const parsed = JSON.parse(trimmed) as SessionEntry;
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Invalid session entry");
	}
	if (typeof (parsed as { type?: unknown }).type !== "string") {
		throw new Error("Session entry missing type");
	}
	return parsed;
}

export function tryParseSessionEntry(line: string): SessionEntry | null {
	try {
		return parseSessionEntry(line);
	} catch {
		return null;
	}
}

export function isSessionHeaderEntry(
	entry: SessionEntry,
): entry is SessionHeaderEntry {
	return entry.type === "session";
}

export function isSessionTreeEntry(
	entry: SessionEntry,
): entry is SessionTreeEntry {
	return (
		entry.type !== "session" &&
		entry.type !== "session_meta" &&
		entry.type !== "attachment_extract"
	);
}
