/**
 * Session Manager - Conversation Persistence and Recovery
 *
 * Sessions are stored as JSONL (JSON Lines) files. Each entry is append-only and
 * may include tree metadata (id/parentId) to support branching and navigation.
 *
 * Tree entries form a conversation tree where the "leaf" pointer tracks the
 * active branch. The session file is append-only; branching updates the leaf
 * pointer without modifying history.
 */

import {
	type Stats,
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createHookMessage,
} from "../agent/custom-messages.js";
import type {
	AgentState,
	AppMessage,
	Attachment,
	ImageContent,
	TextContent,
	UserMessageWithAttachments,
} from "../agent/types.js";
import { getAgentDir } from "../config/constants.js";
import {
	buildConversationModel,
	isRenderableUserMessage,
	renderMessageToPlainText,
} from "../conversation/render-model.js";
import { getRegisteredModels } from "../models/registry.js";
import type { RegisteredModel } from "../models/registry.js";
import { createLogger } from "../utils/logger.js";
import { SessionFileWriter } from "./file-writer.js";
import {
	SessionMetadataCache,
	type SessionModelMetadata,
} from "./metadata-cache.js";
import {
	type AttachmentExtractedEntry,
	type BranchSummaryEntry,
	CURRENT_SESSION_VERSION,
	type CompactionEntry,
	type CustomEntry,
	type CustomMessageEntry,
	type LabelEntry,
	type ModelChangeEntry,
	type SessionEntry,
	type SessionHeaderEntry,
	type SessionMessageEntry,
	type SessionMetaEntry,
	type SessionMetadata,
	type SessionSummary,
	type SessionTreeEntry,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
	isSessionTreeEntry,
	tryParseSessionEntry,
} from "./types.js";

const logger = createLogger("session-manager");

interface SessionFileInfo {
	id: string;
	created: Date;
	messages: AppMessage[];
	messageCount: number;
	summary?: string;
	title?: string;
	tags?: string[];
	favorite: boolean;
	firstMessage: string;
	allMessagesText: string;
}

interface SessionContextSnapshot {
	messages: AppMessage[];
	messageEntries: SessionTreeEntry[];
	thinkingLevel: string;
	model: string | null;
	modelMetadata?: SessionModelMetadata;
}

function isMessageWithAttachments(
	message: AppMessage,
): message is UserMessageWithAttachments & { attachments: Attachment[] } {
	return (
		typeof message === "object" &&
		message !== null &&
		"attachments" in message &&
		Array.isArray((message as { attachments?: unknown }).attachments)
	);
}

function applyAttachmentExtracts(
	message: AppMessage,
	extractedById: Map<string, string>,
): AppMessage {
	if (!isMessageWithAttachments(message) || message.attachments.length === 0) {
		return message;
	}
	const attachments = message.attachments;

	let changed = false;
	const nextAttachments = attachments.map((att) => {
		if (!att || typeof att !== "object") return att;
		const id = typeof att.id === "string" ? att.id : "";
		if (!id) return att;
		const extracted = extractedById.get(id);
		if (!extracted) return att;
		if (att.extractedText === extracted) return att;
		changed = true;
		return { ...att, extractedText: extracted };
	});

	if (!changed) return message;
	return { ...message, attachments: nextAttachments };
}

function extractTextFromContent(
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

function isLikelyCompactionSummary(message: AppMessage): boolean {
	if (message.role !== "assistant") return false;
	const text = extractTextFromContent(message.content).trim();
	if (!text) return false;
	return (
		text.includes("Another language model started to solve this problem") ||
		text.includes("(Compacted") ||
		text.includes("_Local summary of prior discussion")
	);
}

function generateEntryId(existing: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = uuidv4().slice(0, 8);
		if (!existing.has(id)) {
			return id;
		}
	}
	return uuidv4();
}

function readSessionEntries(filePath: string): SessionEntry[] {
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

function safeReadSessionEntries(
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

// Mutates entries in place to upgrade legacy session files.
function migrateV1ToV2(entries: SessionEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;
	const messageEntries: SessionMessageEntry[] = [];

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = CURRENT_SESSION_VERSION;
			continue;
		}
		if (!isSessionTreeEntry(entry)) {
			continue;
		}
		if (!entry.id || ids.has(entry.id)) {
			entry.id = generateEntryId(ids);
		}
		ids.add(entry.id);
		entry.parentId = prevId;
		prevId = entry.id;
		if (entry.type === "message") {
			messageEntries.push(entry);
		}
	}

	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		const compaction = entry as CompactionEntry & {
			firstKeptEntryIndex?: number;
		};
		if (
			typeof compaction.firstKeptEntryIndex === "number" &&
			!compaction.firstKeptEntryId
		) {
			const target = messageEntries[compaction.firstKeptEntryIndex];
			const fallback = messageEntries[0]?.id ?? compaction.id;
			compaction.firstKeptEntryId = target?.id ?? fallback;
		}
		delete compaction.firstKeptEntryIndex;
	}
}

function migrateToCurrentVersion(entries: SessionEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as
		| SessionHeaderEntry
		| undefined;
	const version = header?.version ?? 1;
	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) {
		migrateV1ToV2(entries);
	}

	return true;
}

function buildSessionContextFromEntries(
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
			const entry = path[i];
			if (entry.id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				appendMessage(entry);
			}
		}

		for (let i = compactionIdx + 1; i < path.length; i++) {
			appendMessage(path[i]);
		}
	} else {
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	return { messages, messageEntries, thinkingLevel, model, modelMetadata };
}

function buildSessionFileInfo(
	entries: SessionEntry[],
	stats: Stats,
): SessionFileInfo | null {
	if (entries.length === 0) {
		return null;
	}
	migrateToCurrentVersion(entries);

	let sessionId = "";
	let created = stats.birthtime;
	let summary: string | undefined;
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
		created,
		messages: normalizedMessages,
		messageCount,
		summary,
		title,
		tags,
		favorite,
		firstMessage,
		allMessagesText,
	};
}

// Re-export SessionModelMetadata for backward compatibility
export type { SessionModelMetadata } from "./metadata-cache.js";

export type {
	AttachmentExtractedEntry,
	BranchSummaryEntry,
	CompactionEntry,
	SessionHeaderEntry,
	SessionMessageEntry,
	SessionMetaEntry,
	SessionToolInfo,
	SessionTreeEntry,
	SessionTreeNode,
} from "./types.js";

export function toSessionModelMetadata(
	model: RegisteredModel,
): SessionModelMetadata {
	return {
		provider: model.provider,
		modelId: model.id,
		providerName: model.providerName,
		name: model.name,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		source: model.source,
	};
}

function findRegisteredModel(modelKey: string): RegisteredModel | undefined {
	const [provider, modelId] = modelKey.split("/");
	if (!provider || !modelId) {
		return undefined;
	}
	return getRegisteredModels().find(
		(entry) => entry.provider === provider && entry.id === modelId,
	);
}

/**
 * Main session management class.
 */
export class SessionManager {
	/** Unique identifier for this session (UUID v4) */
	private sessionId!: string;
	/** Absolute path to the session JSONL file */
	private sessionFile!: string;
	/** Directory containing all session files for current project */
	private sessionDir: string;
	/** Whether session persistence is enabled (disabled by --no-session) */
	private enabled = true;
	/** Whether the session header has been written */
	private sessionInitialized = false;
	/** Buffered file writer for efficient I/O */
	private writer?: SessionFileWriter;
	/** Snapshot of agent state for recovery purposes */
	private agentSnapshot?: AgentState;
	/** Metadata for the last used model */
	private lastModelMetadata?: SessionModelMetadata;
	/** Cache for current model/thinking level */
	private metadataCache = new SessionMetadataCache();

	private fileEntries: SessionEntry[] = [];
	private byId: Map<string, SessionTreeEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private flushed = false;
	private hasAssistantMessage = false;

	/**
	 * Creates a new SessionManager.
	 *
	 * @param continueSession - If true, loads the most recently modified session
	 * @param customSessionPath - Optional specific session file to load
	 */
	constructor(continueSession = false, customSessionPath?: string) {
		this.sessionDir = this.getSessionDirectory();

		if (customSessionPath) {
			// Use custom session file path
			this.sessionFile = resolve(customSessionPath);
			this.setSessionFile(this.sessionFile);
		} else if (continueSession) {
			const mostRecent = this.findMostRecentlyModifiedSession();
			if (mostRecent) {
				this.sessionFile = mostRecent;
				this.setSessionFile(this.sessionFile);
			} else {
				this.initNewSession();
			}
		} else {
			this.initNewSession();
		}

		this.initializeWriter();
		if (this.sessionInitialized) {
			this.metadataCache.seedFromFile(this.sessionFile);
		}
	}

	/** Disable session saving (for --no-session mode) */
	disable() {
		this.enabled = false;
		this.writer?.flushSync();
		this.writer?.dispose();
		this.writer = undefined;
		this.fileEntries = [];
		this.byId.clear();
		this.labelsById.clear();
		this.leafId = null;
	}

	private initializeWriter(): void {
		if (!this.enabled) {
			this.writer = undefined;
			return;
		}
		this.writer = new SessionFileWriter(this.sessionFile);
	}

	private getSessionDirectory(): string {
		const cwd = process.cwd();
		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

		const configDir = resolve(getAgentDir());
		const sessionDir = join(configDir, "sessions", safePath);
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}
		return sessionDir;
	}

	private initNewSession(): void {
		this.sessionId = uuidv4();
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		this.sessionFile = join(
			this.sessionDir,
			`${timestamp}_${this.sessionId}.jsonl`,
		);
		this.fileEntries = [];
		this.byId.clear();
		this.labelsById.clear();
		this.leafId = null;
		this.flushed = false;
		this.hasAssistantMessage = false;
		this.sessionInitialized = false;
		this.metadataCache.reset();
	}

	startFreshSession(): void {
		if (!this.enabled) {
			return;
		}
		this.writer?.flushSync();
		this.writer?.dispose();
		this.writer = undefined;
		this.agentSnapshot = undefined;
		this.lastModelMetadata = undefined;
		this.initNewSession();
		this.initializeWriter();
	}

	/**
	 * Reset session state for /clear command - clears pending messages and starts new session
	 */
	reset(): void {
		this.writer?.flushSync();
		this.writer?.dispose();
		this.writer = undefined;

		this.fileEntries = [];
		this.byId.clear();
		this.labelsById.clear();
		this.leafId = null;
		this.flushed = false;
		this.hasAssistantMessage = false;
		this.sessionInitialized = false;
		this.metadataCache.reset();
		this.agentSnapshot = undefined;
		this.lastModelMetadata = undefined;

		this.initNewSession();
		this.initializeWriter();
	}

	private findMostRecentlyModifiedSession(): string | null {
		try {
			const files = readdirSync(this.sessionDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => ({
					path: join(this.sessionDir, f),
					mtime: statSync(join(this.sessionDir, f)).mtime,
				}))
				.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

			return files[0]?.path || null;
		} catch {
			return null;
		}
	}

	private rebuildIndex(entries: SessionEntry[]): void {
		this.byId.clear();
		this.labelsById.clear();
		this.leafId = null;
		this.hasAssistantMessage = false;

		for (const entry of entries) {
			if (!isSessionTreeEntry(entry)) continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
				} else {
					this.labelsById.delete(entry.targetId);
				}
			}
			if (entry.type === "message" && entry.message.role === "assistant") {
				this.hasAssistantMessage = true;
			}
		}
	}

	private rewriteSessionFile(): void {
		if (!this.enabled || !this.sessionFile) return;
		const content = `${this.fileEntries.map((e) => JSON.stringify(e)).join("\n")}\n`;
		writeFileSync(this.sessionFile, content);
	}

	private persistEntry(entry: SessionEntry): void {
		if (!this.enabled || !this.writer || !this.sessionFile) return;
		if (!this.sessionInitialized) return;
		if (!this.hasAssistantMessage) return;

		if (!this.flushed) {
			for (const e of this.fileEntries) {
				this.writer.write(e);
			}
			this.writer.flushSync();
			this.flushed = true;
			return;
		}

		this.writer.write(entry);
	}

	private appendTreeEntry(entry: SessionTreeEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		if (entry.type === "label") {
			if (entry.label) {
				this.labelsById.set(entry.targetId, entry.label);
			} else {
				this.labelsById.delete(entry.targetId);
			}
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			this.hasAssistantMessage = true;
		}
		this.persistEntry(entry);
	}

	private createTreeEntryId(): string {
		return generateEntryId(this.byId);
	}

	startSession(state: AgentState): void {
		if (!this.enabled || this.sessionInitialized) return;

		const modelKeyFromState = `${state.model.provider}/${state.model.id}`;
		const latestModelChange = this.getLatestModelChange();
		const latestThinkingLevel = this.getLatestThinkingLevel();
		const sessionModelKey = latestModelChange?.model ?? modelKeyFromState;
		const primaryMetadata =
			latestModelChange?.modelMetadata ??
			(sessionModelKey === modelKeyFromState
				? toSessionModelMetadata(state.model as RegisteredModel)
				: undefined);
		const fallbackMetadata = this.resolveModelMetadata(sessionModelKey);
		const entry: SessionHeaderEntry = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			model: sessionModelKey,
			modelMetadata: primaryMetadata ?? fallbackMetadata,
			thinkingLevel: latestThinkingLevel ?? state.thinkingLevel,
			systemPrompt: state.systemPrompt,
			tools: state.tools.map((tool) => ({
				name: tool.name,
				label: tool.label,
				description: tool.description,
			})),
		};
		this.metadataCache.apply(entry);
		this.fileEntries.unshift(entry);
		this.sessionInitialized = true;

		if (this.hasAssistantMessage) {
			this.persistEntry(entry);
		}
	}

	saveMessage(message: AppMessage): void {
		if (!this.enabled) return;
		const entry: SessionMessageEntry = {
			type: "message",
			id: this.createTreeEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};

		this.appendTreeEntry(entry);
	}

	saveThinkingLevelChange(thinkingLevel: string): void {
		if (!this.enabled) return;
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: this.createTreeEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this.metadataCache.apply(entry);

		this.appendTreeEntry(entry);
	}

	saveModelChange(model: string, metadata?: SessionModelMetadata): void {
		if (!this.enabled) return;
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: this.createTreeEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			model,
			modelMetadata: metadata,
		};
		this.metadataCache.apply(entry);

		this.appendTreeEntry(entry);
	}

	appendCustomEntry(customType: string, data?: unknown): void {
		if (!this.enabled) return;
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: this.createTreeEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this.appendTreeEntry(entry);
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): void {
		if (!this.enabled) return;
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: this.createTreeEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this.appendTreeEntry(entry);
	}

	appendBranchSummary(
		summary: string,
		options?: { fromId?: string; details?: unknown; fromHook?: boolean },
	): void {
		if (!this.enabled) return;
		const fromId = options?.fromId ?? this.leafId ?? "root";
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: this.createTreeEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			fromId,
			summary,
			details: options?.details,
			fromHook: options?.fromHook,
		};
		this.appendTreeEntry(entry);
	}

	appendLabel(targetId: string, label: string | undefined): void {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: this.createTreeEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this.appendTreeEntry(entry);
	}

	/**
	 * Save a compaction event to the session file.
	 */
	saveCompaction(
		summary: string,
		firstKeptEntryIndex: number,
		tokensBefore: number,
		options?: {
			auto?: boolean;
			customInstructions?: string;
			firstKeptEntryId?: string;
		},
	): void {
		if (!this.enabled) return;
		const context = this.buildSessionContext();
		const resolvedEntry = options?.firstKeptEntryId
			? this.getEntry(options.firstKeptEntryId)
			: undefined;
		const targetEntry =
			resolvedEntry ?? context.messageEntries[firstKeptEntryIndex];
		const fallbackEntry = this.getEntries()[0];
		const firstKeptEntryId =
			targetEntry?.id ?? this.leafId ?? fallbackEntry?.id;
		if (!firstKeptEntryId) {
			logger.warn("Failed to resolve compaction cut point; skipping save");
			return;
		}
		const entry: CompactionEntry = {
			type: "compaction",
			id: this.createTreeEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			auto: options?.auto,
			customInstructions: options?.customInstructions,
		};

		this.appendTreeEntry(entry);
		this.writer?.flushSync();
	}

	/**
	 * Find the most recent compaction entry in the current session.
	 */
	findLatestCompaction(): CompactionEntry | null {
		for (let i = this.fileEntries.length - 1; i >= 0; i--) {
			const entry = this.fileEntries[i];
			if (entry.type === "compaction") {
				return entry as CompactionEntry;
			}
		}
		return null;
	}

	private getLatestThinkingLevel(): string | undefined {
		for (let i = this.fileEntries.length - 1; i >= 0; i--) {
			const entry = this.fileEntries[i];
			if (entry.type === "thinking_level_change") {
				return entry.thinkingLevel;
			}
		}
		return undefined;
	}

	private getLatestModelChange(): ModelChangeEntry | undefined {
		for (let i = this.fileEntries.length - 1; i >= 0; i--) {
			const entry = this.fileEntries[i];
			if (entry.type === "model_change") {
				return entry as ModelChangeEntry;
			}
		}
		return undefined;
	}

	private resolveModelMetadata(
		modelKey: string,
	): SessionModelMetadata | undefined {
		const registered = findRegisteredModel(modelKey);
		return registered ? toSessionModelMetadata(registered) : undefined;
	}

	private appendSessionMetaEntry(
		targetFile: string,
		meta: {
			summary?: string;
			favorite?: boolean;
			title?: string;
			tags?: string[];
		},
	): void {
		if (!existsSync(targetFile)) return;
		if (
			meta.summary === undefined &&
			meta.favorite === undefined &&
			meta.title === undefined &&
			meta.tags === undefined
		) {
			return;
		}
		const entry: SessionMetaEntry = {
			type: "session_meta",
			timestamp: new Date().toISOString(),
			...meta,
		};
		try {
			appendFileSync(targetFile, `${JSON.stringify(entry)}\n`);
		} catch (error) {
			logger.error(
				"Failed to append session metadata",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	private appendAttachmentExtractEntry(
		targetFile: string,
		payload: { attachmentId: string; extractedText: string },
	): AttachmentExtractedEntry | null {
		if (!existsSync(targetFile)) return null;
		if (!payload.attachmentId || !payload.extractedText) return null;
		const entry: AttachmentExtractedEntry = {
			type: "attachment_extract",
			timestamp: new Date().toISOString(),
			attachmentId: payload.attachmentId,
			extractedText: payload.extractedText,
		};
		try {
			appendFileSync(targetFile, `${JSON.stringify(entry)}\n`);
			return entry;
		} catch (error) {
			logger.error(
				"Failed to append attachment extraction",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		return null;
	}

	/**
	 * Persist extracted attachment text as an append-only cache entry.
	 */
	saveAttachmentExtraction(
		sessionPath: string,
		attachmentId: string,
		text: string,
	): void {
		if (!sessionPath || !existsSync(sessionPath)) return;
		const entry = this.appendAttachmentExtractEntry(sessionPath, {
			attachmentId,
			extractedText: text,
		});
		if (entry && sessionPath === this.sessionFile) {
			this.fileEntries.push(entry);
		}
	}

	saveSessionSummary(summary: string, sessionPath?: string): void {
		const trimmed = summary.trim();
		if (!trimmed) return;
		const target = sessionPath ?? this.sessionFile;
		if (!target || !existsSync(target)) return;
		this.appendSessionMetaEntry(target, { summary: trimmed });
	}

	setSessionFavorite(sessionPath: string, favorite: boolean): void {
		if (!sessionPath || !existsSync(sessionPath)) return;
		this.appendSessionMetaEntry(sessionPath, { favorite });
	}

	setSessionTitle(sessionPath: string, title: string): void {
		if (!sessionPath || !existsSync(sessionPath)) return;
		this.appendSessionMetaEntry(sessionPath, { title });
	}

	setSessionTags(sessionPath: string, tags: string[]): void {
		if (!sessionPath || !existsSync(sessionPath)) return;
		this.appendSessionMetaEntry(sessionPath, { tags });
	}

	buildSessionContext(
		leafId: string | null = this.leafId,
	): SessionContextSnapshot {
		return buildSessionContextFromEntries(this.fileEntries, {
			leafId,
			byId: this.byId,
			header: this.getHeader(),
		});
	}

	loadMessages(): AppMessage[] {
		const context = this.buildSessionContext();
		const extractedById = new Map<string, string>();
		for (const entry of this.fileEntries) {
			if (entry.type === "attachment_extract") {
				if (entry.attachmentId && entry.extractedText) {
					extractedById.set(entry.attachmentId, entry.extractedText);
				}
			}
		}
		if (extractedById.size === 0) return context.messages;
		return context.messages.map((message) =>
			applyAttachmentExtracts(message, extractedById),
		);
	}

	loadThinkingLevel(): string {
		return this.buildSessionContext().thinkingLevel;
	}

	loadModel(): string | null {
		return this.buildSessionContext().model;
	}

	loadModelMetadata(): SessionModelMetadata | undefined {
		const context = this.buildSessionContext();
		return context.modelMetadata ?? this.lastModelMetadata;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string {
		return this.sessionFile;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionTreeEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionTreeEntry | undefined {
		return this.byId.get(id);
	}

	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	getChildren(parentId: string): SessionTreeEntry[] {
		const children: SessionTreeEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	getBranch(fromId?: string | null): SessionTreeEntry[] {
		const path: SessionTreeEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.unshift(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return path;
	}

	getEntries(): SessionTreeEntry[] {
		return this.fileEntries.filter(isSessionTreeEntry);
	}

	getHeader(): SessionHeaderEntry | null {
		const header = this.fileEntries.find((e) => e.type === "session");
		return header ? (header as SessionHeaderEntry) : null;
	}

	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label });
		}

		for (const entry of entries) {
			const node = nodeMap.get(entry.id);
			if (!node) {
				continue;
			}
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
				continue;
			}
			const parent = nodeMap.get(entry.parentId);
			if (parent) {
				parent.children.push(node);
			} else {
				roots.push(node);
			}
		}

		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) {
				continue;
			}
			node.children.sort(
				(a, b) =>
					new Date(a.entry.timestamp).getTime() -
					new Date(b.entry.timestamp).getTime(),
			);
			stack.push(...node.children);
		}

		return roots;
	}

	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		options?: { fromId?: string; details?: unknown; fromHook?: boolean },
	): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: this.createTreeEntryId(),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: options?.fromId ?? branchFromId ?? "root",
			summary,
			details: options?.details,
			fromHook: options?.fromHook,
		};
		this.appendTreeEntry(entry);
		return entry.id;
	}

	resetLeaf(): void {
		this.leafId = null;
	}

	updateSnapshot(state: AgentState, metadata?: SessionModelMetadata): void {
		this.agentSnapshot = state;
		if (metadata) {
			this.lastModelMetadata = metadata;
		}
	}

	async flush(): Promise<void> {
		await this.writer?.flush();
	}

	/**
	 * Load all sessions for the current directory with metadata
	 */
	loadAllSessions(): SessionMetadata[] {
		this.writer?.flushSync();
		const sessions: SessionMetadata[] = [];

		try {
			const files = readdirSync(this.sessionDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => {
					const fullPath = join(this.sessionDir, f);
					const stats = statSync(fullPath);
					return { path: fullPath, stats };
				})
				.sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());

			for (const fileEntry of files) {
				const { path: file, stats } = fileEntry;
				try {
					const entries = safeReadSessionEntries(file, (error) => {
						logger.error(
							`Failed to read session file ${file}`,
							error instanceof Error ? error : undefined,
						);
					});
					const info = buildSessionFileInfo(entries, stats);
					if (!info) {
						continue;
					}
					const derivedSummary =
						info.summary || info.firstMessage || "(no summary)";

					sessions.push({
						path: file,
						id: info.id,
						created: info.created,
						modified: stats.mtime,
						size: stats.size,
						messageCount: info.messageCount,
						firstMessage: info.firstMessage || "(no messages)",
						summary: derivedSummary,
						favorite: info.favorite,
						allMessagesText: info.allMessagesText,
					});
				} catch (error) {
					logger.error(
						`Failed to process session file ${file}`,
						error instanceof Error ? error : undefined,
					);
				}
			}
		} catch (error) {
			logger.error(
				"Failed to load sessions",
				error instanceof Error ? error : undefined,
			);
		}

		return sessions;
	}

	getSessionFileById(sessionId: string): string | null {
		const match = this.loadAllSessions().find(
			(session) => session.id === sessionId,
		);
		return match?.path ?? null;
	}

	/**
	 * Set the session file to an existing session
	 */
	setSessionFile(path: string): void {
		this.writer?.flushSync();
		this.writer?.dispose();

		this.sessionFile = resolve(path);
		if (existsSync(this.sessionFile)) {
			const entries = safeReadSessionEntries(this.sessionFile);
			const migrated = migrateToCurrentVersion(entries);
			this.fileEntries = entries;
			this.sessionInitialized = entries.some((e) => e.type === "session");
			this.rebuildIndex(entries);
			if (migrated) {
				this.rewriteSessionFile();
			}
			const header = this.getHeader();
			this.sessionId = header?.id ?? uuidv4();
			this.flushed = true;
			this.metadataCache.seedFromFile(this.sessionFile);
		} else {
			this.initNewSession();
		}
		this.initializeWriter();
	}

	/**
	 * Check if we should initialize the session based on message history.
	 * Session is initialized when we have at least 1 user message and 1 assistant message.
	 */
	shouldInitializeSession(messages: AppMessage[]): boolean {
		if (this.sessionInitialized) return false;

		const userMessages = messages.filter((m) => m.role === "user");
		const assistantMessages = messages.filter((m) => m.role === "assistant");

		return userMessages.length >= 1 && assistantMessages.length >= 1;
	}

	/**
	 * Create a branched session from a specific message index.
	 * Returns the new session file path.
	 * @param state - Current agent state
	 * @param branchFromIndex - Index of the last message to include in the branch (exclusive)
	 */
	createBranchedSession(state: AgentState, branchFromIndex: number): string;
	/**
	 * Create a branched session from a specific tree entry id.
	 */
	createBranchedSession(leafId: string): string;
	createBranchedSession(
		stateOrLeafId: AgentState | string,
		branchFromIndex?: number,
	): string {
		if (typeof stateOrLeafId === "string") {
			return this.createBranchedSessionFromLeaf(stateOrLeafId);
		}
		if (typeof branchFromIndex !== "number") {
			throw new Error(
				"branchFromIndex is required when branching from AgentState",
			);
		}
		return this.createBranchedSessionFromState(stateOrLeafId, branchFromIndex);
	}

	private createBranchedSessionFromLeaf(leafId: string): string {
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		const pathWithoutLabels = path.filter((e) => e.type !== "label");
		const newSessionId = uuidv4();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(
			this.sessionDir,
			`${fileTimestamp}_${newSessionId}.jsonl`,
		);

		const context = this.buildSessionContext(leafId);
		const header: SessionHeaderEntry = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: process.cwd(),
			model: context.model ?? this.getHeader()?.model,
			modelMetadata: context.modelMetadata ?? this.getHeader()?.modelMetadata,
			thinkingLevel: context.thinkingLevel,
			systemPrompt: this.getHeader()?.systemPrompt,
			tools: this.getHeader()?.tools,
			branchedFrom: this.sessionFile,
		};

		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label });
			}
		}

		appendFileSync(newSessionFile, `${JSON.stringify(header)}\n`);
		for (const entry of pathWithoutLabels) {
			appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
		}
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id ?? null;
		const labelEntries: LabelEntry[] = [];
		for (const { targetId, label } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateEntryId(pathEntryIds),
				parentId,
				timestamp: new Date().toISOString(),
				targetId,
				label,
			};
			appendFileSync(newSessionFile, `${JSON.stringify(labelEntry)}\n`);
			pathEntryIds.add(labelEntry.id);
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}

		return newSessionFile;
	}

	private createBranchedSessionFromState(
		state: AgentState,
		branchFromIndex: number,
	): string {
		if (branchFromIndex < 0 || branchFromIndex > state.messages.length) {
			throw new Error(
				`Invalid branchFromIndex: ${branchFromIndex}. Must be between 0 and ${state.messages.length}`,
			);
		}

		const newSessionId = uuidv4();
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const newSessionFile = join(
			this.sessionDir,
			`${timestamp}_${newSessionId}.jsonl`,
		);
		const tempFile = `${newSessionFile}.tmp`;

		try {
			const modelKey = state.model
				? `${state.model.provider}/${state.model.id}`
				: "unknown/unknown";
			const entry: SessionHeaderEntry = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: newSessionId,
				timestamp: new Date().toISOString(),
				cwd: process.cwd(),
				model: modelKey,
				modelMetadata: this.lastModelMetadata,
				thinkingLevel: state.thinkingLevel,
				branchedFrom: this.sessionFile,
			};
			appendFileSync(tempFile, `${JSON.stringify(entry)}\n`);

			let parentId: string | null = null;
			if (branchFromIndex > 0) {
				const messagesToWrite = state.messages.slice(0, branchFromIndex);
				const ids = new Set<string>();
				for (const message of messagesToWrite) {
					const messageEntry: SessionMessageEntry = {
						type: "message",
						id: generateEntryId(ids),
						parentId,
						timestamp: new Date().toISOString(),
						message,
					};
					ids.add(messageEntry.id);
					parentId = messageEntry.id;
					appendFileSync(tempFile, `${JSON.stringify(messageEntry)}\n`);
				}
			}

			renameSync(tempFile, newSessionFile);
		} catch (error) {
			try {
				if (existsSync(tempFile)) {
					unlinkSync(tempFile);
				}
			} catch (_cleanupError) {
				// Ignore cleanup errors
			}
			throw error;
		}

		return newSessionFile;
	}

	/**
	 * List all sessions in the session directory
	 */
	async listSessions(options?: {
		limit?: number;
		offset?: number;
	}): Promise<SessionSummary[]> {
		this.writer?.flushSync();
		const files = readdirSync(this.sessionDir);
		const sessions = [];
		const sortedFiles = files
			.filter((f) => f.endsWith(".jsonl"))
			.map((file) => {
				const filePath = join(this.sessionDir, file);
				const stats = statSync(filePath);
				return { filePath, stats };
			})
			.sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());

		const offset = Math.max(0, options?.offset ?? 0);
		const limit = Math.max(1, options?.limit ?? sortedFiles.length);

		for (const [index, entry] of sortedFiles.entries()) {
			if (index < offset) continue;
			if (sessions.length >= limit) break;
			const { filePath, stats } = entry;

			try {
				const entries = safeReadSessionEntries(filePath);
				const info = buildSessionFileInfo(entries, stats);
				if (!info) continue;

				sessions.push({
					id: info.id,
					title: info.title ?? info.summary,
					createdAt: info.created.toISOString(),
					updatedAt: stats.mtime.toISOString(),
					messageCount: info.messageCount,
					favorite: info.favorite,
					tags: info.tags,
				});
			} catch {
				// Skip files that can't be read
			}
		}

		return sessions;
	}

	/**
	 * Load a session by ID
	 */
	async loadSession(sessionId: string): Promise<{
		id: string;
		title?: string;
		messages: AppMessage[];
		createdAt: string;
		updatedAt: string;
		messageCount: number;
		favorite: boolean;
		tags?: string[];
	} | null> {
		this.writer?.flushSync();
		const sessionFile = this.getSessionFileById(sessionId);
		if (!sessionFile) {
			return null;
		}

		const stats = statSync(sessionFile);
		const entries = safeReadSessionEntries(sessionFile);
		const info = buildSessionFileInfo(entries, stats);
		if (!info) {
			return null;
		}

		return {
			id: info.id,
			title: info.title ?? info.summary,
			messages: info.messages,
			createdAt: info.created.toISOString(),
			updatedAt: stats.mtime.toISOString(),
			messageCount: info.messageCount,
			favorite: info.favorite,
			tags: info.tags,
		};
	}

	/**
	 * Create a new session
	 */
	async createSession(options?: { title?: string }): Promise<{
		id: string;
		title?: string;
		messages: AppMessage[];
		createdAt: string;
		updatedAt: string;
		messageCount: number;
	}> {
		this.startFreshSession();

		if (options?.title && this.enabled) {
			const entry: SessionMetaEntry = {
				type: "session_meta",
				timestamp: new Date().toISOString(),
				title: options.title,
			};
			this.fileEntries.push(entry);
			this.persistEntry(entry);
		}

		const now = new Date().toISOString();
		return {
			id: this.sessionId,
			title: options?.title,
			messages: [],
			createdAt: now,
			updatedAt: now,
			messageCount: 0,
		};
	}

	/**
	 * Delete a session
	 */
	async deleteSession(sessionId: string): Promise<void> {
		const sessionFile = this.getSessionFileById(sessionId);
		if (!sessionFile) {
			throw new Error(`Session ${sessionId} not found`);
		}

		unlinkSync(sessionFile);
	}
}
