import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentState } from "./agent/types.js";
import { getRegisteredModels } from "./models/registry.js";
import type { RegisteredModel } from "./models/registry.js";

class SessionFileWriter {
	private buffer: string[] = [];
	private flushPromise: Promise<void> | null = null;

	constructor(
		private readonly filePath: string,
		private readonly batchSize = 25,
	) {
		process.once("beforeExit", () => {
			void this.flush();
		});
	}

	write(entry: unknown): void {
		this.buffer.push(JSON.stringify(entry));
		if (this.buffer.length >= this.batchSize) {
			void this.flush();
		}
	}

	async flush(): Promise<void> {
		if (this.buffer.length > 0 && !this.flushPromise) {
			const chunk = `${this.buffer.join("\n")}\n`;
			this.buffer = [];
			this.flushPromise = appendFile(this.filePath, chunk)
				.catch((error) => {
					console.error("Failed to flush session file", error);
				})
				.finally(() => {
					this.flushPromise = null;
				});
		}
		if (this.flushPromise) {
			await this.flushPromise;
		}
	}
}

class SessionMetadataCache {
	private thinkingLevel = "off";
	private model: string | null = null;
	private metadata?: SessionModelMetadata;

	apply(entry: any): void {
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
		if (!existsSync(filePath)) {
			return;
		}
		const contents = readFileSync(filePath, "utf8").trim();
		if (!contents) {
			return;
		}
		for (const line of contents.split("\n")) {
			try {
				const entry = JSON.parse(line);
				this.apply(entry);
			} catch {
				// ignore malformed lines
			}
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

function uuidv4(): string {
	const bytes = randomBytes(16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface SessionHeader {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
	model: string;
	modelMetadata?: SessionModelMetadata;
	thinkingLevel: string;
}

export interface SessionMessageEntry {
	type: "message";
	timestamp: string;
	message: any; // AppMessage from agent state
}

export interface ThinkingLevelChangeEntry {
	type: "thinking_level_change";
	timestamp: string;
	thinkingLevel: string;
}

export interface ModelChangeEntry {
	type: "model_change";
	timestamp: string;
	model: string;
	modelMetadata?: SessionModelMetadata;
}

export interface SessionMetaEntry {
	type: "session_meta";
	timestamp: string;
	summary?: string;
	favorite?: boolean;
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

	private findMostRecentlyModifiedSession(): string | null {
		try {
			const files = readdirSync(this.sessionDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => ({
					name: f,
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
		if (!existsSync(this.sessionFile)) return;

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session") {
					this.sessionId = entry.id;
					return;
				}
			} catch {
				// Skip malformed lines
			}
		}
		this.sessionId = uuidv4();
	}

	startSession(state: AgentState): void {
		if (!this.enabled || this.sessionInitialized) return;
		this.sessionInitialized = true;

		const modelKey = `${state.model.provider}/${state.model.id}`;
		const primaryMetadata = toSessionModelMetadata(
			state.model as RegisteredModel,
		);
		const fallbackModel = findRegisteredModel(modelKey);
		const fallbackMetadata = fallbackModel
			? toSessionModelMetadata(fallbackModel)
			: undefined;
		const entry: SessionHeader = {
			type: "session",
			id: this.sessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			model: modelKey,
			modelMetadata: primaryMetadata ?? fallbackMetadata,
			thinkingLevel: state.thinkingLevel,
		};
		this.metadataCache.apply(entry);
		this.writer?.write(entry);

		// Write any queued messages
		for (const msg of this.pendingMessages) {
			this.writer?.write(msg);
		}
		this.pendingMessages = [];
	}

	saveMessage(message: any): void {
		if (!this.enabled) return;
		const entry: SessionMessageEntry = {
			type: "message",
			timestamp: new Date().toISOString(),
			message,
		};

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			this.writer?.write(entry);
		}
	}

	saveThinkingLevelChange(thinkingLevel: string): void {
		if (!this.enabled) return;
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this.metadataCache.apply(entry);

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			this.writer?.write(entry);
		}
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

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			this.writer?.write(entry);
		}
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
		void appendFile(targetFile, `${JSON.stringify(entry)}\n`).catch((error) => {
			console.error("Failed to append session metadata", error);
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

	loadMessages(): any[] {
		if (!existsSync(this.sessionFile)) return [];

		const messages: any[] = [];
		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message") {
					messages.push(entry.message);
				}
			} catch {
				// Skip malformed lines
			}
		}

		return messages;
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
	loadAllSessions(): Array<{
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
	}> {
		const sessions: Array<{
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
		}> = [];

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
				const file = fileEntry.path;
				const stats = fileEntry.stats;
				try {
					const content = readFileSync(file, "utf8");
					const trimmed = content.trim();
					if (!trimmed) {
						continue;
					}
					const lines = trimmed.split("\n");

					let sessionId = "";
					let created = stats.birthtime;
					let messageCount = 0;
					let firstMessage = "";
					const allMessages: string[] = [];
					let summary: string | undefined;
					let favorite = false;

					for (const line of lines) {
						try {
							const entry = JSON.parse(line);

							if (entry.type === "session" && !sessionId) {
								sessionId = entry.id;
								created = new Date(entry.timestamp);
							}

							if (entry.type === "message") {
								messageCount++;
								if (
									entry.message.role === "user" ||
									entry.message.role === "assistant"
								) {
									const textContent = entry.message.content
										.filter((c: any) => c.type === "text")
										.map((c: any) => c.text)
										.join(" ");

									if (textContent) {
										allMessages.push(textContent);
										if (!firstMessage && entry.message.role === "user") {
											firstMessage = textContent;
										}
									}
								}
							}

							if (entry.type === "session_meta") {
								if (typeof entry.summary === "string" && entry.summary.trim()) {
									summary = entry.summary;
								}
								if (typeof entry.favorite === "boolean") {
									favorite = entry.favorite;
								}
							}
						} catch {
							// Skip malformed lines
						}
					}

					const derivedSummary = summary || firstMessage || "(no summary)";

					sessions.push({
						path: file,
						id: sessionId || "unknown",
						created,
						modified: stats.mtime,
						size: stats.size,
						messageCount,
						firstMessage: firstMessage || "(no messages)",
						summary: derivedSummary,
						favorite,
						allMessagesText: allMessages.join(" "),
					});
				} catch (error) {
					console.error(`Failed to read session file ${file}:`, error);
				}
			}
		} catch (error) {
			console.error("Failed to load sessions:", error);
		}

		return sessions;
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
	shouldInitializeSession(messages: any[]): boolean {
		if (this.sessionInitialized) return false;

		const userMessages = messages.filter((m) => m.role === "user");
		const assistantMessages = messages.filter((m) => m.role === "assistant");

		return userMessages.length >= 1 && assistantMessages.length >= 1;
	}
}
