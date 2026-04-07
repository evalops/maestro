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
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";
import type {
	AgentState,
	AppMessage,
	ImageContent,
	TextContent,
} from "../agent/types.js";
import { SESSION_CONFIG, getAgentDir } from "../config/constants.js";
import { getRegisteredModels } from "../models/registry.js";
import type { RegisteredModel } from "../models/registry.js";
import { queueSharedMemoryUpdate } from "../shared-memory/client.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnvPath } from "../utils/path-expansion.js";
import { SessionFileWriter } from "./file-writer.js";
import {
	SessionMetadataCache,
	type SessionModelMetadata,
} from "./metadata-cache.js";
import {
	migrateToCurrentVersion,
	registerActiveSessionFile,
	scheduleSessionMigration,
	unregisterActiveSessionFile,
} from "./migration.js";
import { sanitizeSessionScope } from "./scope.js";
import {
	createBranchedSessionFromLeaf as createBranchedSessionFromLeafFn,
	createBranchedSessionFromState as createBranchedSessionFromStateFn,
} from "./session-branch.js";
import { SessionCatalog } from "./session-catalog.js";
import {
	type SessionContextSnapshot,
	buildSessionContextFromEntries,
	generateEntryId,
	safeReadSessionEntries,
} from "./session-context.js";
import {
	applyAttachmentExtracts,
	sanitizeMessageForSession,
} from "./session-sanitize.js";
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
} from "./types.js";

export interface SessionManagerOptions {
	/** Override the base session directory (before per-cwd scoping). */
	sessionDir?: string;
	/** Optional scope key (e.g., auth subject) for per-user session isolation. */
	sessionScope?: string;
}

const logger = createLogger("session-manager");

// Re-export SessionModelMetadata for backward compatibility
export type { SessionModelMetadata } from "./metadata-cache.js";

export type {
	AttachmentExtractedEntry,
	BranchSummaryEntry,
	CompactionEntry,
	SessionHeaderEntry,
	SessionMessageEntry,
	SessionMetaEntry,
	SessionMigrationState,
	SessionToolInfo,
	SessionTreeEntry,
	SessionTreeNode,
} from "./types.js";

export {
	getMigrationState,
	registerActiveSessionFile,
	resetMigrationState,
	runSessionMigration,
	scheduleSessionMigration,
	unregisterActiveSessionFile,
} from "./migration.js";

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
	/** Optional scope for per-user session isolation */
	private sessionScope?: string;
	/** Optional override for base session directory */
	private sessionDirOverride?: string;
	/** Whether session persistence is enabled (disabled by --no-session) */
	private enabled = true;
	/** Whether the session header has been written */
	private sessionInitialized = false;
	/** Buffered file writer for efficient I/O */
	private writer?: SessionFileWriter;
	/** Snapshot of agent state for recovery purposes */
	private _agentSnapshot?: AgentState;
	/** Metadata for the last used model */
	private lastModelMetadata?: SessionModelMetadata;
	/** Cache for current model/thinking level */
	private metadataCache = new SessionMetadataCache();
	private readonly catalog: SessionCatalog;

	private fileEntries: SessionEntry[] = [];
	private byId: Map<string, SessionTreeEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private flushed = false;
	private _hasAssistantMessage = false;

	/**
	 * Creates a new SessionManager.
	 *
	 * @param continueSession - If true, loads the most recently modified session
	 * @param customSessionPath - Optional specific session file to load
	 * @param options - Optional session directory/scope overrides
	 */
	constructor(
		continueSession = false,
		customSessionPath?: string,
		options: SessionManagerOptions = {},
	) {
		this.sessionScope = options.sessionScope;
		this.sessionDirOverride = options.sessionDir;
		this.sessionDir = this.getSessionDirectory();
		this.catalog = new SessionCatalog({
			sessionDir: this.sessionDir,
			beforeRead: () => this.writer?.flushSync(),
			getCurrentSessionId: () => this.sessionId,
		});

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
		// Unregister session file before disabling
		if (this.sessionFile) {
			unregisterActiveSessionFile(this.sessionFile);
		}
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

		const baseOverride =
			resolveEnvPath(this.sessionDirOverride) ??
			resolveEnvPath(process.env.MAESTRO_SESSION_DIR);
		const baseDir =
			baseOverride ??
			SESSION_CONFIG.DEFAULT_DIR ??
			join(getAgentDir(), "sessions");

		const scope = this.sessionScope
			? sanitizeSessionScope(this.sessionScope)
			: "";
		const sessionDir = scope
			? join(baseDir, scope, safePath)
			: join(baseDir, safePath);
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
		// Register new session file to prevent migration race conditions
		registerActiveSessionFile(this.sessionFile);
		this.fileEntries = [];
		this.byId.clear();
		this.labelsById.clear();
		this.leafId = null;
		this.flushed = false;
		this._hasAssistantMessage = false;
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
		this._agentSnapshot = undefined;
		this.lastModelMetadata = undefined;
		// Unregister old session file before creating new one
		if (this.sessionFile) {
			unregisterActiveSessionFile(this.sessionFile);
		}
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

		// Unregister old session file before creating new one
		if (this.sessionFile) {
			unregisterActiveSessionFile(this.sessionFile);
		}

		this.fileEntries = [];
		this.byId.clear();
		this.labelsById.clear();
		this.leafId = null;
		this.flushed = false;
		this._hasAssistantMessage = false;
		this.sessionInitialized = false;
		this.metadataCache.reset();
		this._agentSnapshot = undefined;
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
		this._hasAssistantMessage = false;

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
				this._hasAssistantMessage = true;
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
			this._hasAssistantMessage = true;
		}
		this.persistEntry(entry);
	}

	private createTreeEntryId(): string {
		return generateEntryId(this.byId);
	}

	startSession(state: AgentState, options?: { subject?: string }): void {
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
			subject: options?.subject || undefined,
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

		this.persistEntry(entry);

		queueSharedMemoryUpdate({
			sessionId: this.sessionId,
			state: {
				sessionId: this.sessionId,
				cwd: process.cwd(),
				model: sessionModelKey,
				updatedAt: entry.timestamp,
				source: "maestro",
			},
			event: {
				type: "maestro.session.started",
				payload: {
					sessionId: this.sessionId,
					model: sessionModelKey,
					timestamp: entry.timestamp,
				},
			},
		});

		// Auto-prune old sessions in the background (non-blocking)
		if (
			SESSION_CONFIG.MAX_SESSIONS > 0 ||
			SESSION_CONFIG.MAX_SESSION_AGE_DAYS > 0
		) {
			setTimeout(() => {
				try {
					const result = this.pruneSessions();
					if (result.removed > 0) {
						logger.debug("Auto-pruned sessions", result);
					}
				} catch (error) {
					logger.error(
						"Session auto-prune failed",
						error instanceof Error ? error : undefined,
					);
				}
			}, 5000);
		}
	}

	saveMessage(message: AppMessage): void {
		if (!this.enabled) return;
		const sanitizedMessage = sanitizeMessageForSession(message);
		const entry: SessionMessageEntry = {
			type: "message",
			id: this.createTreeEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message: sanitizedMessage,
		};

		this.appendTreeEntry(entry);

		queueSharedMemoryUpdate({
			sessionId: this.sessionId,
			state: {
				sessionId: this.sessionId,
				updatedAt: entry.timestamp,
				lastMessageId: entry.id,
				lastMessageRole: message.role,
				source: "maestro",
			},
			event: {
				type: "maestro.message.saved",
				payload: {
					sessionId: this.sessionId,
					messageId: entry.id,
					role: message.role,
					timestamp: entry.timestamp,
				},
			},
		});
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
			const entry = this.fileEntries[i]!;
			if (entry.type === "compaction") {
				return entry as CompactionEntry;
			}
		}
		return null;
	}

	private getLatestThinkingLevel(): string | undefined {
		for (let i = this.fileEntries.length - 1; i >= 0; i--) {
			const entry = this.fileEntries[i]!;
			if (entry.type === "thinking_level_change") {
				return entry.thinkingLevel;
			}
		}
		return undefined;
	}

	private getLatestModelChange(): ModelChangeEntry | undefined {
		for (let i = this.fileEntries.length - 1; i >= 0; i--) {
			const entry = this.fileEntries[i]!;
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
			resumeSummary?: string;
			favorite?: boolean;
			title?: string;
			tags?: string[];
		},
	): void {
		if (!existsSync(targetFile)) return;
		if (
			meta.summary === undefined &&
			meta.resumeSummary === undefined &&
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
		if (target === this.sessionFile) {
			queueSharedMemoryUpdate({
				sessionId: this.sessionId,
				state: {
					sessionId: this.sessionId,
					updatedAt: new Date().toISOString(),
					summary: trimmed,
					source: "maestro",
				},
				event: {
					type: "maestro.session.summary",
					payload: {
						sessionId: this.sessionId,
						length: trimmed.length,
					},
				},
			});
		}
	}

	saveSessionResumeSummary(summary: string, sessionPath?: string): void {
		const trimmed = summary.trim();
		if (!trimmed) return;
		const target = sessionPath ?? this.sessionFile;
		if (!target || !existsSync(target)) return;
		this.appendSessionMetaEntry(target, { resumeSummary: trimmed });
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

	isInitialized(): boolean {
		return this.sessionInitialized;
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
		this._agentSnapshot = state;
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
		return this.catalog.loadAllSessions();
	}

	getSessionFileById(sessionId: string): string | null {
		return this.catalog.getSessionFileById(sessionId);
	}

	/**
	 * Set the session file to an existing session
	 */
	setSessionFile(path: string): void {
		// Unregister old session file before disposing writer
		if (this.sessionFile) {
			unregisterActiveSessionFile(this.sessionFile);
		}
		this.writer?.flushSync();
		this.writer?.dispose();

		this.sessionFile = resolve(path);
		// Register new session file to prevent migration race conditions
		registerActiveSessionFile(this.sessionFile);
		scheduleSessionMigration();

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
			// Unregister the non-existent path before initNewSession registers a new one
			unregisterActiveSessionFile(this.sessionFile);
			this.initNewSession();
		}
		this.initializeWriter();
	}

	/**
	 * Check if we should initialize the session based on message history.
	 * Session is initialized once we have at least 1 user message.
	 */
	shouldInitializeSession(messages: AppMessage[]): boolean {
		if (this.sessionInitialized) return false;

		const userMessages = messages.filter((m) => m.role === "user");
		return userMessages.length >= 1;
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
		return createBranchedSessionFromLeafFn(leafId, {
			sessionDir: this.sessionDir,
			sessionFile: this.sessionFile,
			branch: this.getBranch(leafId),
			context: this.buildSessionContext(leafId),
			header: this.getHeader(),
			labelsById: this.labelsById,
		});
	}

	private createBranchedSessionFromState(
		state: AgentState,
		branchFromIndex: number,
	): string {
		return createBranchedSessionFromStateFn(state, branchFromIndex, {
			sessionDir: this.sessionDir,
			sessionFile: this.sessionFile,
			lastModelMetadata: this.lastModelMetadata,
		});
	}

	/**
	 * List all sessions in the session directory
	 */
	async listSessions(options?: {
		limit?: number;
		offset?: number;
	}): Promise<SessionSummary[]> {
		return this.catalog.listSessions(options);
	}

	/**
	 * Load a session by ID
	 */
	async loadSession(sessionId: string): Promise<{
		id: string;
		subject?: string;
		title?: string;
		resumeSummary?: string;
		messages: AppMessage[];
		createdAt: string;
		updatedAt: string;
		messageCount: number;
		favorite: boolean;
		tags?: string[];
	} | null> {
		return this.catalog.loadSession(sessionId);
	}

	/**
	 * Create a new session
	 */
	async createSession(options?: { title?: string }): Promise<{
		id: string;
		title?: string;
		resumeSummary?: string;
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
		this.catalog.deleteSession(sessionId);
	}

	/**
	 * Prune old sessions based on configured limits.
	 * Removes sessions that exceed MAX_SESSIONS count or MAX_SESSION_AGE_DAYS.
	 * Favorites are never pruned.
	 * Returns the number of sessions removed.
	 */
	pruneSessions(): { removed: number; errors: number } {
		return this.catalog.pruneSessions();
	}
}
