import type { AppMessage, ImageContent, TextContent } from "../agent/types.js";
import type { PromptMetadata } from "../prompts/types.js";

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
	subject?: string;
	model?: string;
	modelMetadata?: SessionModelMetadata;
	thinkingLevel?: string;
	systemPrompt?: string;
	promptMetadata?: PromptMetadata;
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
	resumeSummary?: string;
	memoryExtractionHash?: string;
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
	subject?: string;
	created: Date;
	modified: Date;
	size: number;
	messageCount: number;
	firstMessage: string;
	summary: string;
	resumeSummary?: string;
	favorite: boolean;
	allMessagesText: string;
}

export interface SessionSummary {
	id: string;
	subject?: string;
	title?: string;
	resumeSummary?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	favorite: boolean;
	tags?: string[];
}

/**
 * Tracks the state of session migrations across the session directory.
 * Persisted to disk to avoid re-running migrations on every startup.
 */
export interface SessionMigrationState {
	/** Migration version that was run */
	version: number;
	/** ISO timestamp of when migration last ran */
	lastRun: string;
	/** Number of sessions successfully migrated */
	successes: number;
	/** Number of sessions that failed migration */
	failures: number;
	/** Number of sessions that required normalization */
	normalized: number;
	/** Number of sessions skipped (already up to date) */
	skipped: number;
	/** Total sessions processed */
	total: number;
}

function renameOwnProperty(
	value: Record<string, unknown>,
	from: string,
	to: string,
): void {
	if (!(from in value) || to in value) return;
	value[to] = value[from];
	delete value[from];
}

function normalizeModelMetadata(value: unknown): void {
	if (!value || typeof value !== "object") return;
	const metadata = value as Record<string, unknown>;
	renameOwnProperty(metadata, "model_id", "modelId");
	renameOwnProperty(metadata, "provider_name", "providerName");
	renameOwnProperty(metadata, "base_url", "baseUrl");
	renameOwnProperty(metadata, "context_window", "contextWindow");
	renameOwnProperty(metadata, "max_tokens", "maxTokens");
}

function normalizeStopReasonValue(value: unknown): unknown {
	switch (value) {
		case "tool_use":
		case "tool_calls":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "end_turn":
		case "stop_sequence":
			return "stop";
		default:
			return value;
	}
}

function normalizeMessageContentBlocks(content: unknown): void {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type === "tool_call") {
			record.type = "toolCall";
		}
		if (record.type === "toolCall") {
			renameOwnProperty(record, "args", "arguments");
		}
		if (record.type === "thinking") {
			renameOwnProperty(record, "text", "thinking");
			renameOwnProperty(record, "signature", "thinkingSignature");
		}
	}
}

function normalizeSessionMessage(message: unknown): void {
	if (!message || typeof message !== "object") return;
	const record = message as Record<string, unknown>;
	if (record.role === "assistant") {
		renameOwnProperty(record, "stop_reason", "stopReason");
		record.stopReason = normalizeStopReasonValue(record.stopReason);
		normalizeMessageContentBlocks(record.content);
		return;
	}
	if (record.role === "toolResult") {
		renameOwnProperty(record, "tool_call_id", "toolCallId");
		renameOwnProperty(record, "tool_name", "toolName");
		renameOwnProperty(record, "is_error", "isError");
		if (typeof record.content === "string") {
			record.content = [{ type: "text", text: record.content }];
		}
	}
}

function normalizeSessionEntryShape(entry: SessionEntry): SessionEntry {
	const record = entry as unknown as Record<string, unknown>;
	switch (entry.type) {
		case "session":
			renameOwnProperty(record, "model_metadata", "modelMetadata");
			renameOwnProperty(record, "thinking_level", "thinkingLevel");
			renameOwnProperty(record, "system_prompt", "systemPrompt");
			renameOwnProperty(record, "branched_from", "branchedFrom");
			normalizeModelMetadata(record.modelMetadata);
			break;
		case "message":
			normalizeSessionMessage(record.message);
			break;
		case "thinking_level_change":
			renameOwnProperty(record, "thinking_level", "thinkingLevel");
			break;
		case "model_change":
			renameOwnProperty(record, "model_metadata", "modelMetadata");
			normalizeModelMetadata(record.modelMetadata);
			break;
		case "compaction":
			renameOwnProperty(record, "first_kept_entry_id", "firstKeptEntryId");
			renameOwnProperty(
				record,
				"first_kept_entry_index",
				"firstKeptEntryIndex",
			);
			renameOwnProperty(record, "tokens_before", "tokensBefore");
			renameOwnProperty(record, "custom_instructions", "customInstructions");
			break;
		default:
			break;
	}
	return entry;
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
	return normalizeSessionEntryShape(parsed);
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
