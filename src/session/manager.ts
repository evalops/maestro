/**
 * Session Manager - Conversation Persistence and Recovery
 *
 * This module manages session state persistence for the Composer CLI, enabling
 * users to continue conversations across restarts, branch from previous points,
 * and maintain conversation history for auditing and review.
 *
 * ## Storage Architecture
 *
 * Sessions are stored as JSONL (JSON Lines) files in a user-specific directory:
 *
 * ```
 * ~/.composer/agent/sessions/
 * └── --home-user-projects-myapp--/
 *     ├── 2024-01-15T10-30-00-000Z_uuid1.jsonl
 *     ├── 2024-01-15T14-45-00-000Z_uuid2.jsonl
 *     └── ...
 * ```
 *
 * The directory structure uses a sanitized version of the working directory
 * to separate sessions by project. This allows different projects to have
 * independent session histories.
 *
 * ## JSONL Format
 *
 * Each line in a session file is a JSON object representing an entry:
 *
 * ```jsonl
 * {"type":"session","id":"uuid","timestamp":"...","cwd":"/path/to/project","model":"anthropic/claude-opus-4-5-20251101"}
 * {"type":"message","timestamp":"...","message":{"role":"user","content":"Hello"}}
 * {"type":"message","timestamp":"...","message":{"role":"assistant","content":[...]}}
 * {"type":"thinking_level_change","timestamp":"...","thinkingLevel":"high"}
 * {"type":"model_change","timestamp":"...","model":"openai/gpt-4o"}
 * {"type":"session_meta","timestamp":"...","summary":"Discussed project setup","favorite":true}
 * ```
 *
 * ## Entry Types
 *
 * | Type                   | Purpose                                          |
 * |------------------------|--------------------------------------------------|
 * | session                | Session header with ID, cwd, model, tools        |
 * | message                | User or assistant message                        |
 * | thinking_level_change  | Record when thinking level is changed            |
 * | model_change           | Record when model is switched                    |
 * | session_meta           | Metadata: summary, title, tags, favorite flag    |
 *
 * ## Lazy Initialization
 *
 * Sessions are not initialized until the first message exchange completes.
 * This prevents creating empty session files when users immediately exit
 * or encounter errors. Messages are queued in memory until initialization.
 *
 * ## Buffered Writing
 *
 * Writes are batched for performance using `SessionFileWriter`. The buffer
 * is flushed:
 * - When batch size is reached (configurable)
 * - On explicit flush() calls
 * - On process exit (SIGINT, SIGTERM, beforeExit, uncaughtException)
 *
 * ## Metadata Caching
 *
 * `SessionMetadataCache` tracks the current model and thinking level without
 * re-reading the entire session file. This is updated as entries are written
 * and seeded from existing files when resuming sessions.
 *
 * @module session/manager
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
} from "node:fs";
import { join, resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { AgentState, AppMessage } from "../agent/types.js";
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
	type CompactionEntry,
	type ModelChangeEntry,
	type SessionEntry,
	type SessionHeaderEntry,
	type SessionMessageEntry,
	type SessionMetaEntry,
	type SessionMetadata,
	type SessionSummary,
	type ThinkingLevelChangeEntry,
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

function applyAttachmentExtracts(
	message: AppMessage,
	extractedById: Map<string, string>,
): AppMessage {
	const attachments = (message as { attachments?: unknown }).attachments;
	if (!Array.isArray(attachments) || attachments.length === 0) {
		return message;
	}

	let changed = false;
	const nextAttachments = attachments.map((att) => {
		if (!att || typeof att !== "object") return att;
		const record = att as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id : "";
		if (!id) return att;
		const extracted = extractedById.get(id);
		if (!extracted) return att;
		if (record.extractedText === extracted) return att;
		changed = true;
		return { ...record, extractedText: extracted };
	});

	if (!changed) return message;
	return {
		...(message as unknown as Record<string, unknown>),
		attachments: nextAttachments,
	} as AppMessage;
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

function buildSessionFileInfo(
	entries: SessionEntry[],
	stats: Stats,
): SessionFileInfo | null {
	if (entries.length === 0) {
		return null;
	}

	let sessionId = "";
	let created = stats.birthtime;
	let messageCount = 0;
	let summary: string | undefined;
	let title: string | undefined;
	let tags: string[] | undefined;
	let favorite = false;
	const appMessages: AppMessage[] = [];
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
			case "message":
				if (entry.message) {
					messageCount++;
					appMessages.push(entry.message as AppMessage);
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

	const normalizedMessages = extractedById.size
		? appMessages.map((message) =>
				applyAttachmentExtracts(message, extractedById),
			)
		: appMessages;

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
	CompactionEntry,
	SessionHeaderEntry,
	SessionMessageEntry,
	SessionMetaEntry,
	SessionToolInfo,
} from "./types.js";

type PendingSessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry;

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
 *
 * Handles all aspects of session lifecycle:
 * - Creating new sessions
 * - Continuing/resuming existing sessions
 * - Saving messages and state changes
 * - Loading session history
 * - Session branching for "undo" functionality
 * - Session metadata (favorites, tags, summaries)
 *
 * ## Usage
 *
 * ```typescript
 * // Create new session
 * const manager = new SessionManager();
 *
 * // Continue most recent session
 * const manager = new SessionManager(true);
 *
 * // Load specific session
 * const manager = new SessionManager(false, "/path/to/session.jsonl");
 *
 * // Save messages as they're exchanged
 * manager.saveMessage(userMessage);
 * manager.saveMessage(assistantMessage);
 *
 * // Initialize session after first exchange
 * if (manager.shouldInitializeSession(messages)) {
 *   manager.startSession(agentState);
 * }
 * ```
 *
 * ## Session Lifecycle
 *
 * 1. **Pre-initialization**: Messages queued in memory
 * 2. **Initialization**: Session file created with header
 * 3. **Active**: Messages written to file
 * 4. **Completed**: File remains for future resumption
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
	/** Messages waiting to be written (before initialization) */
	private pendingMessages: PendingSessionEntry[] = [];
	/** Buffered file writer for efficient I/O */
	private writer?: SessionFileWriter;
	/** Snapshot of agent state for recovery purposes */
	private agentSnapshot?: AgentState;
	/** Metadata for the last used model */
	private lastModelMetadata?: SessionModelMetadata;
	/** Cache for current model/thinking level */
	private metadataCache = new SessionMetadataCache();

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
			this.loadSessionId();
			// Mark as initialized since we're loading an existing session
			this.sessionInitialized = existsSync(this.sessionFile);
		} else if (continueSession) {
			const mostRecent = this.findMostRecentlyModifiedSession();
			if (mostRecent) {
				this.sessionFile = mostRecent;
				this.loadSessionId();
				// Mark as initialized since we're loading an existing session
				this.sessionInitialized = true;
			} else {
				this.initNewSession();
			}
		} else {
			this.initNewSession();
		}

		this.initializeWriter();
		this.metadataCache.seedFromFile(this.sessionFile);
	}

	/** Disable session saving (for --no-session mode) */
	disable() {
		this.enabled = false;
		this.writer?.flushSync();
		this.writer?.dispose();
		this.writer = undefined;
		this.pendingMessages = [];
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
		// Replace all path separators and colons (for Windows drive letters) with dashes
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
	}

	startFreshSession(): void {
		if (!this.enabled) {
			return;
		}
		this.writer?.flushSync();
		this.writer?.dispose();
		this.writer = undefined;
		this.pendingMessages = [];
		this.sessionInitialized = false;
		this.metadataCache = new SessionMetadataCache();
		this.initNewSession();
		this.initializeWriter();
	}

	/**
	 * Reset session state for /clear command - clears pending messages and starts new session
	 */
	reset(): void {
		// Dispose of old writer
		this.writer?.flushSync();
		this.writer?.dispose();
		this.writer = undefined;

		// Clear state
		this.pendingMessages = [];
		this.sessionInitialized = false;
		this.metadataCache = new SessionMetadataCache();
		this.agentSnapshot = undefined;
		this.lastModelMetadata = undefined;

		// Start new session
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

	private loadSessionId(): void {
		const entries = safeReadSessionEntries(this.sessionFile);
		const sessionEntry = entries.find(
			(entry): entry is SessionHeaderEntry => entry.type === "session",
		);

		this.sessionId = sessionEntry?.id ?? uuidv4();
	}

	startSession(state: AgentState): void {
		if (!this.enabled || this.sessionInitialized) return;
		this.sessionInitialized = true;

		const modelKeyFromState = `${state.model.provider}/${state.model.id}`;
		const pendingModelChange = this.getLatestPendingModelChange();
		const pendingThinkingLevel = this.getLatestPendingThinkingLevel();
		const sessionModelKey = pendingModelChange?.model ?? modelKeyFromState;
		const primaryMetadata =
			pendingModelChange?.modelMetadata ??
			(sessionModelKey === modelKeyFromState
				? toSessionModelMetadata(state.model as RegisteredModel)
				: undefined);
		const fallbackMetadata = this.resolveModelMetadata(sessionModelKey);
		const entry: SessionHeaderEntry = {
			type: "session",
			id: this.sessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			model: sessionModelKey,
			modelMetadata: primaryMetadata ?? fallbackMetadata,
			thinkingLevel: pendingThinkingLevel ?? state.thinkingLevel,
			systemPrompt: state.systemPrompt,
			tools: state.tools.map((tool) => ({
				name: tool.name,
				label: tool.label,
				description: tool.description,
			})),
		};
		this.metadataCache.apply(entry);
		this.writer?.write(entry);

		// Write any queued messages
		for (const msg of this.pendingMessages) {
			this.writer?.write(msg);
		}
		this.pendingMessages = [];
		this.writer?.flushSync();
	}

	saveMessage(message: AppMessage): void {
		if (!this.enabled) return;
		const entry: SessionMessageEntry = {
			type: "message",
			timestamp: new Date().toISOString(),
			message,
		};

		this.queueEntry(entry);
	}

	saveThinkingLevelChange(thinkingLevel: string): void {
		if (!this.enabled) return;
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this.metadataCache.apply(entry);

		this.queueEntry(entry);
	}

	saveModelChange(model: string, metadata?: SessionModelMetadata): void {
		if (!this.enabled) return;
		const entry: ModelChangeEntry = {
			type: "model_change",
			timestamp: new Date().toISOString(),
			model,
			modelMetadata: metadata,
		};
		this.metadataCache.apply(entry);

		this.queueEntry(entry);
	}

	/**
	 * Save a compaction event to the session file.
	 *
	 * This records when context was compacted, including the generated summary
	 * and metadata about the compaction. The session loader uses this to
	 * reconstruct conversations with summaries replacing compacted messages.
	 *
	 * @param summary - Generated summary of compacted messages
	 * @param firstKeptEntryIndex - Index of first entry to keep
	 * @param tokensBefore - Token count before compaction
	 * @param options - Additional options (auto, customInstructions)
	 */
	saveCompaction(
		summary: string,
		firstKeptEntryIndex: number,
		tokensBefore: number,
		options?: { auto?: boolean; customInstructions?: string },
	): void {
		if (!this.enabled) return;
		const entry: CompactionEntry = {
			type: "compaction",
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryIndex,
			tokensBefore,
			auto: options?.auto,
			customInstructions: options?.customInstructions,
		};

		// Compaction entries are written directly (not queued) since they should
		// persist immediately after the compaction operation completes
		if (this.sessionInitialized) {
			this.writer?.write(entry);
			this.writer?.flushSync();
		}
	}

	/**
	 * Find the most recent compaction entry in the current session.
	 *
	 * @returns The most recent compaction entry or null if none exists
	 */
	findLatestCompaction(): CompactionEntry | null {
		this.writer?.flushSync();
		const entries = safeReadSessionEntries(this.sessionFile);
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].type === "compaction") {
				return entries[i] as CompactionEntry;
			}
		}
		return null;
	}

	private getLatestPendingThinkingLevel(): string | undefined {
		for (let i = this.pendingMessages.length - 1; i >= 0; i--) {
			const entry = this.pendingMessages[i];
			if (entry.type === "thinking_level_change") {
				return entry.thinkingLevel;
			}
		}
		return undefined;
	}

	private getLatestPendingModelChange(): ModelChangeEntry | undefined {
		for (let i = this.pendingMessages.length - 1; i >= 0; i--) {
			const entry = this.pendingMessages[i];
			if (entry.type === "model_change") {
				return entry;
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

	private queueEntry(entry: PendingSessionEntry): void {
		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
			return;
		}
		this.writer?.write(entry);
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
	): void {
		if (!existsSync(targetFile)) return;
		if (!payload.attachmentId || !payload.extractedText) return;
		const entry: AttachmentExtractedEntry = {
			type: "attachment_extract",
			timestamp: new Date().toISOString(),
			attachmentId: payload.attachmentId,
			extractedText: payload.extractedText,
		};
		try {
			appendFileSync(targetFile, `${JSON.stringify(entry)}\n`);
		} catch (error) {
			logger.error(
				"Failed to append attachment extraction",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
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
		this.appendAttachmentExtractEntry(sessionPath, {
			attachmentId,
			extractedText: text,
		});
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

	loadMessages(): AppMessage[] {
		this.writer?.flushSync();
		const entries = safeReadSessionEntries(this.sessionFile);
		const extractedById = new Map<string, string>();
		const messages: AppMessage[] = [];

		for (const entry of entries) {
			if (entry.type === "attachment_extract") {
				if (entry.attachmentId && entry.extractedText) {
					extractedById.set(entry.attachmentId, entry.extractedText);
				}
				continue;
			}
			if (entry.type === "message" && entry.message) {
				messages.push(entry.message as AppMessage);
			}
		}

		if (extractedById.size === 0) return messages;

		return messages.map((message) =>
			applyAttachmentExtracts(message, extractedById),
		);
	}

	loadThinkingLevel(): string {
		return this.metadataCache.getThinkingLevel();
	}

	loadModel(): string | null {
		return this.metadataCache.getModel();
	}

	loadModelMetadata(): SessionModelMetadata | undefined {
		return this.metadataCache.getModelMetadata() ?? this.lastModelMetadata;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string {
		return this.sessionFile;
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
		if (this.writer) {
			void this.writer.flush();
		}
		this.sessionFile = path;
		this.loadSessionId();
		// Mark as initialized since we're loading an existing session
		this.sessionInitialized = existsSync(path);
		this.initializeWriter();
		this.metadataCache.seedFromFile(this.sessionFile);
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
	createBranchedSession(state: AgentState, branchFromIndex: number): string {
		// Validate branchFromIndex bounds
		if (branchFromIndex < 0 || branchFromIndex > state.messages.length) {
			throw new Error(
				`Invalid branchFromIndex: ${branchFromIndex}. Must be between 0 and ${state.messages.length}`,
			);
		}

		// Create a new session ID for the branch
		const newSessionId = uuidv4();
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const newSessionFile = join(
			this.sessionDir,
			`${timestamp}_${newSessionId}.jsonl`,
		);
		const tempFile = `${newSessionFile}.tmp`;

		// Use transactional write (temp file + atomic rename)
		try {
			// Write session header with branch source tracking
			const modelKey = state.model
				? `${state.model.provider}/${state.model.id}`
				: "unknown/unknown";
			const entry: SessionHeaderEntry = {
				type: "session",
				id: newSessionId,
				timestamp: new Date().toISOString(),
				cwd: process.cwd(),
				model: modelKey,
				modelMetadata: this.lastModelMetadata,
				thinkingLevel: state.thinkingLevel,
				branchedFrom: this.sessionFile, // Track parent session for lineage
			};
			appendFileSync(tempFile, `${JSON.stringify(entry)}\n`);

			// Write messages up to (but not including) the branch point
			if (branchFromIndex > 0) {
				const messagesToWrite = state.messages.slice(0, branchFromIndex);
				for (const message of messagesToWrite) {
					const messageEntry: SessionMessageEntry = {
						type: "message",
						timestamp: new Date().toISOString(),
						message,
					};
					appendFileSync(tempFile, `${JSON.stringify(messageEntry)}\n`);
				}
			}

			// Atomic rename to final location
			renameSync(tempFile, newSessionFile);
		} catch (error) {
			// Cleanup temp file on failure
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
			} catch (e) {
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
			title: info.title ?? info.summary, // Prefer title over summary
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

		// Write summary as title if provided
		if (options?.title && this.enabled) {
			const entry: SessionMetaEntry = {
				type: "session_meta",
				timestamp: new Date().toISOString(),
				title: options.title,
			};
			this.writer?.write(entry);
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
