import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentState } from "./agent/types.js";
import { getRegisteredModels } from "./models/registry.js";
import type { RegisteredModel } from "./models/registry.js";

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
	private pendingMessages: any[] = [];
	private agentSnapshot?: AgentState;
	private lastModelMetadata?: SessionModelMetadata;

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
	}

	/** Disable session saving (for --no-session mode) */
	disable() {
		this.enabled = false;
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
		appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);

		// Write any queued messages
		for (const msg of this.pendingMessages) {
			appendFileSync(this.sessionFile, `${JSON.stringify(msg)}\n`);
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
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
		}
	}

	saveThinkingLevelChange(thinkingLevel: string): void {
		if (!this.enabled) return;
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
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

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
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
		appendFileSync(targetFile, `${JSON.stringify(entry)}\n`);
	}

	saveSessionSummary(summary: string): void {
		if (!this.enabled || !this.sessionInitialized) return;
		if (!summary.trim()) return;
		this.appendSessionMetaEntry(this.sessionFile, { summary: summary.trim() });
	}

	setSessionFavorite(sessionPath: string, favorite: boolean): void {
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
		if (!existsSync(this.sessionFile)) return "off";

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");

		// Find the most recent thinking level (from session header or change event)
		let lastThinkingLevel = "off";
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session" && entry.thinkingLevel) {
					lastThinkingLevel = entry.thinkingLevel;
				} else if (
					entry.type === "thinking_level_change" &&
					entry.thinkingLevel
				) {
					lastThinkingLevel = entry.thinkingLevel;
				}
			} catch {
				// Skip malformed lines
			}
		}

		return lastThinkingLevel;
	}

	loadModel(): string | null {
		if (!existsSync(this.sessionFile)) return null;

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");

		// Find the most recent model (from session header or change event)
		let lastModel: string | null = null;
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session" && entry.model) {
					lastModel = entry.model;
				} else if (entry.type === "model_change" && entry.model) {
					lastModel = entry.model;
				}
			} catch {
				// Skip malformed lines
			}
		}

		return lastModel;
	}

	loadModelMetadata(): SessionModelMetadata | undefined {
		if (!existsSync(this.sessionFile)) return undefined;

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");

		let metadata: SessionModelMetadata | undefined;
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session" && entry.modelMetadata) {
					metadata = entry.modelMetadata;
				} else if (entry.type === "model_change" && entry.modelMetadata) {
					metadata = entry.modelMetadata;
				}
			} catch {
				// Ignore malformed
			}
		}
		return metadata;
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
		this.sessionFile = path;
		this.loadSessionId();
		// Mark as initialized since we're loading an existing session
		this.sessionInitialized = existsSync(path);
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
