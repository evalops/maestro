import type { AppMessage, ImageContent, TextContent } from "../agent/types.js";
import type { PromptProjectDocManifest } from "../config/index.js";
import type { UnifiedContextManifest } from "../context/manifest-types.js";
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
	provisional?: boolean;
	subject?: string;
	model?: string;
	modelMetadata?: SessionModelMetadata;
	thinkingLevel?: string;
	systemPrompt?: string;
	promptMetadata?: PromptMetadata;
	promptContextManifest?: PromptProjectDocManifest;
	unifiedContextManifest?: UnifiedContextManifest;
	tools?: SessionToolInfo[];
	branchedFrom?: string;
	parentSession?: string;
}

function resolveSessionPromptContextManifest(
	header:
		| Pick<
				SessionHeaderEntry,
				"promptContextManifest" | "unifiedContextManifest"
		  >
		| null
		| undefined,
): PromptProjectDocManifest | undefined {
	return (
		header?.promptContextManifest ?? header?.unifiedContextManifest?.projectDocs
	);
}

export function getPersistedSessionPromptContextManifest(
	header:
		| Pick<
				SessionHeaderEntry,
				"promptContextManifest" | "unifiedContextManifest"
		  >
		| null
		| undefined,
): PromptProjectDocManifest | undefined {
	return header?.unifiedContextManifest
		? undefined
		: resolveSessionPromptContextManifest(header);
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
	archived?: boolean;
	archivedAt?: string;
	appServerGoal?: {
		objective: string;
		status: "active" | "complete" | "cancelled";
		tokenBudget?: number;
		createdAt: string;
		updatedAt: string;
	} | null;
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
	title?: string;
	created: Date;
	modified: Date;
	size: number;
	messageCount: number;
	firstMessage: string;
	summary: string;
	resumeSummary?: string;
	memoryExtractionHash?: string;
	favorite: boolean;
	tags?: string[];
	archived?: boolean;
	archivedAt?: string;
	allMessagesText: string;
}

export type SessionMessagesView = "full" | "summary" | "notLoaded";

export interface SessionSummary {
	id: string;
	subject?: string;
	title?: string;
	summary?: string;
	resumeSummary?: string;
	memoryExtractionHash?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	favorite: boolean;
	tags?: string[];
	archived?: boolean;
	archivedAt?: string;
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

export {
	normalizeSessionEntry,
	normalizeStopReasonValue,
	parseSessionEntry,
	isSessionWireCompactionContextEntry,
	tryParseSessionEntry,
} from "./wire-format.js";

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
