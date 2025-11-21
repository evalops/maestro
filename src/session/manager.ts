import { randomBytes } from "node:crypto";
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
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentState, AppMessage } from "../agent/types.js";
import { SESSION_CONFIG } from "../config/constants.js";
import {
	buildConversationModel,
	isRenderableUserMessage,
	renderMessageToPlainText,
} from "../conversation/render-model.js";
import { getRegisteredModels } from "../models/registry.js";
import type { RegisteredModel } from "../models/registry.js";
import { createLogger } from "../utils/logger.js";
import {
	type ModelChangeEntry,
	type SessionEntry,
	type SessionHeaderEntry,
	type SessionMessageEntry,
	type SessionMetaEntry,
	type SessionMetadata,
	type ThinkingLevelChangeEntry,
	tryParseSessionEntry,
} from "./types.js";

const logger = createLogger("session-manager");

class SessionFileWriter {
	private static readonly writers = new Set<SessionFileWriter>();
	private static beforeExitRegistered = false;

	private buffer: string[] = [];

	constructor(
		private readonly filePath: string,
		private readonly batchSize = SESSION_CONFIG.WRITE_BATCH_SIZE,
	) {
		SessionFileWriter.registerBeforeExit();
		SessionFileWriter.writers.add(this);
	}

	private static registerBeforeExit(): void {
		if (SessionFileWriter.beforeExitRegistered) {
			return;
		}
		SessionFileWriter.beforeExitRegistered = true;
		process.once("beforeExit", () => {
			for (const writer of SessionFileWriter.writers) {
				try {
					writer.flushSync();
				} catch (error) {
					logger.error(
						"Failed to flush session file on exit",
						error instanceof Error ? error : undefined,
					);
				}
			}
		});
	}

	dispose(): void {
		SessionFileWriter.writers.delete(this);
	}

	write(entry: SessionEntry): void {
		this.buffer.push(JSON.stringify(entry));
		if (this.buffer.length >= this.batchSize) {
			this.flushSync();
		}
	}

	private drainBuffer(): string | null {
		if (this.buffer.length === 0) return null;
		const chunk = `${this.buffer.join("\n")}\n`;
		this.buffer = [];
		return chunk;
	}

	private writeChunkSync(chunk: string): void {
		try {
			appendFileSync(this.filePath, chunk);
		} catch (error) {
			logger.error(
				"Failed to write session chunk",
				error instanceof Error ? error : undefined,
				{ filePath: this.filePath },
			);
			throw error;
		}
	}

	async flush(): Promise<void> {
		this.flushSync();
	}

	flushSync(): void {
		const chunk = this.drainBuffer();
		if (chunk) {
			this.writeChunkSync(chunk);
		}
	}
}

class SessionMetadataCache {
	private thinkingLevel = "off";
	private model: string | null = null;
	private metadata?: SessionModelMetadata;

	apply(entry: SessionEntry): void {
		if (entry.type === "session") {
			if (typeof entry.thinkingLevel === "string") {
				this.thinkingLevel = entry.thinkingLevel;
			}
			if (typeof entry.model === "string") {
				this.model = entry.model;
			}
			if (entry.modelMetadata) {
				this.metadata = entry.modelMetadata;
			}
			return;
		}
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
			this.thinkingLevel = entry.thinkingLevel;
			return;
		}
		if (entry.type === "model_change") {
			if (entry.model) {
				this.model = entry.model;
			}
			if (entry.modelMetadata) {
				this.metadata = entry.modelMetadata;
			}
		}
	}

	seedFromFile(filePath: string): void {
		const entries = safeReadSessionEntries(filePath);
		for (const entry of entries) {
			this.apply(entry);
		}
	}

	getThinkingLevel(): string {
		return this.thinkingLevel;
	}

	getModel(): string | null {
		return this.model;
	}

	getModelMetadata(): SessionModelMetadata | undefined {
		return this.metadata;
	}
}

interface SessionFileInfo {
	id: string;
	created: Date;
	messages: AppMessage[];
	messageCount: number;
	summary?: string;
	favorite: boolean;
	firstMessage: string;
	allMessagesText: string;
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
	let favorite = false;
	const appMessages: AppMessage[] = [];

	for (const entry of entries) {
		switch (entry.type) {
			case "session":
				if (!sessionId) {
					sessionId = entry.id;
					created = new Date(entry.timestamp);
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
				if (typeof entry.favorite === "boolean") {
					favorite = entry.favorite;
				}
				break;
			default:
				break;
		}
	}

	const renderables = buildConversationModel(appMessages);
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
		messages: appMessages,
		messageCount,
		summary,
		favorite,
		firstMessage,
		allMessagesText,
	};
}

function uuidv4(): string {
	const bytes = randomBytes(16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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

export type {
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

export class SessionManager {
	private sessionId!: string;
	private sessionFile!: string;
	private sessionDir: string;
	private enabled = true;
	private sessionInitialized = false;
	private pendingMessages: PendingSessionEntry[] = [];
	private writer?: SessionFileWriter;
	private agentSnapshot?: AgentState;
	private lastModelMetadata?: SessionModelMetadata;
	private metadataCache = new SessionMetadataCache();

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

		const configDir = resolve(
			process.env.COMPOSER_AGENT_DIR ??
				process.env.PLAYWRIGHT_AGENT_DIR ??
				process.env.CODING_AGENT_DIR ??
				join(homedir(), ".composer/agent/"),
		);
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
		meta: { summary?: string; favorite?: boolean },
	): void {
		if (!existsSync(targetFile)) return;
		if (meta.summary === undefined && meta.favorite === undefined) {
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
			console.error("Failed to append session metadata", error);
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

	loadMessages(): AppMessage[] {
		this.writer?.flushSync();
		const entries = safeReadSessionEntries(this.sessionFile);
		return entries
			.filter(
				(entry): entry is SessionMessageEntry =>
					entry.type === "message" && Boolean(entry.message),
			)
			.map((entry) => entry.message as AppMessage);
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
			// Write session header
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
	async listSessions(): Promise<
		Array<{
			id: string;
			title?: string;
			createdAt: string;
			updatedAt: string;
			messageCount: number;
		}>
	> {
		this.writer?.flushSync();
		const files = readdirSync(this.sessionDir);
		const sessions = [];

		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;

			const filePath = join(this.sessionDir, file);
			const stats = statSync(filePath);

			try {
				const entries = safeReadSessionEntries(filePath);
				const info = buildSessionFileInfo(entries, stats);
				if (!info) continue;

				sessions.push({
					id: info.id,
					title: info.summary,
					createdAt: info.created.toISOString(),
					updatedAt: stats.mtime.toISOString(),
					messageCount: info.messageCount,
				});
			} catch (e) {
				// Skip files that can't be read
			}
		}

		// Sort by updated date, most recent first
		return sessions.sort(
			(a, b) =>
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		);
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
	} | null> {
		this.writer?.flushSync();
		const files = readdirSync(this.sessionDir);
		const sessionFile = files.find((f) => f.includes(sessionId));

		if (!sessionFile) {
			return null;
		}

		const filePath = join(this.sessionDir, sessionFile);
		const stats = statSync(filePath);
		const entries = safeReadSessionEntries(filePath);
		const info = buildSessionFileInfo(entries, stats);
		if (!info) {
			return null;
		}

		return {
			id: info.id,
			title: info.summary,
			messages: info.messages,
			createdAt: info.created.toISOString(),
			updatedAt: stats.mtime.toISOString(),
			messageCount: info.messageCount,
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
				summary: options.title,
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
		const files = readdirSync(this.sessionDir);
		const sessionFile = files.find((f) => f.includes(sessionId));

		if (!sessionFile) {
			throw new Error(`Session ${sessionId} not found`);
		}

		const filePath = join(this.sessionDir, sessionFile);
		unlinkSync(filePath);
	}
}
