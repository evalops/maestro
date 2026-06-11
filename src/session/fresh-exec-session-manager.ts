import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { isToolResultMessage } from "../agent/type-guards.js";
import type { AgentState, AppMessage } from "../agent/types.js";
import { SESSION_CONFIG, getAgentDir } from "../config/constants.js";
import type { UnifiedContextManifest } from "../context/manifest-types.js";
import type { RegisteredModel } from "../models/registry.js";
import type { SharedMemoryUpdate } from "../shared-memory/client.js";
import { resolveEnvPath } from "../utils/path-expansion.js";
import {
	registerActiveSessionFile,
	unregisterActiveSessionFile,
} from "./active-session-files.js";
import { SessionFileWriter } from "./file-writer.js";
import { toSessionModelMetadata } from "./model-metadata.js";
import { sanitizeSessionScope } from "./scope.js";
import {
	type SessionContextSnapshot,
	buildSessionContextFromEntries,
} from "./session-context-core.js";
import { sanitizeMessageForSession } from "./session-sanitize.js";
import {
	CURRENT_SESSION_VERSION,
	type CompactionEntry,
	type CustomEntry,
	type SessionEntry,
	type SessionHeaderEntry,
	type SessionMessageEntry,
	type SessionMetaEntry,
	type SessionMetadata,
	type SessionModelMetadata,
	type SessionTreeEntry,
	getPersistedSessionPromptContextManifest,
	isSessionTreeEntry,
} from "./types.js";

export interface FreshExecSessionManagerOptions {
	sessionDir?: string;
	sessionScope?: string;
	sessionId?: string;
}

const AUTO_PRUNE_DELAY_MS = 5000;
const pendingAutoPruneManagers = new Set<FreshExecSessionManager>();
let autoPruneBeforeExitRegistered = false;

let sharedMemoryClientPromise:
	| Promise<typeof import("../shared-memory/client.js")>
	| undefined;
let sessionMemoryPromise:
	| Promise<typeof import("./session-memory.js")>
	| undefined;
let maestroEventBusPromise:
	| Promise<typeof import("../telemetry/maestro-event-bus.js")>
	| undefined;

function queueSharedMemoryUpdateLazy(update: SharedMemoryUpdate): void {
	sharedMemoryClientPromise ??= import("../shared-memory/client.js");
	void sharedMemoryClientPromise
		.then(({ queueSharedMemoryUpdate }) => {
			queueSharedMemoryUpdate(update);
		})
		.catch(() => {
			// Shared-memory synchronization is best effort and must not affect the
			// fresh exec persistence path.
		});
}

function syncSessionMemoryLazy(sessionPath: string): void {
	sessionMemoryPromise ??= import("./session-memory.js");
	void sessionMemoryPromise
		.then(({ syncSessionMemory }) => {
			syncSessionMemory(sessionPath);
		})
		.catch(() => {
			// Session-memory indexing is best effort and must not affect JSONL
			// finalization for fresh exec sessions.
		});
}

function recordPromptVariantSelectedLazy(
	state: AgentState,
	sessionId: string,
	selectedAt: string,
): void {
	if (!state.promptMetadata) {
		return;
	}
	maestroEventBusPromise ??= import("../telemetry/maestro-event-bus.js");
	void maestroEventBusPromise
		.then(({ recordMaestroPromptVariantSelected }) => {
			recordMaestroPromptVariantSelected({
				prompt_metadata: state.promptMetadata!,
				correlation: {
					session_id: sessionId,
				},
				selected_at: selectedAt,
			});
		})
		.catch(() => {
			// Prompt telemetry is best effort and must not affect fresh exec startup.
		});
}

function sessionAutoPruneEnabled(): boolean {
	return (
		SESSION_CONFIG.MAX_SESSIONS > 0 || SESSION_CONFIG.MAX_SESSION_AGE_DAYS > 0
	);
}

function isTestMode(): boolean {
	return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

function runFreshSessionAutoPrune(manager: FreshExecSessionManager): void {
	try {
		manager.pruneSessions();
	} catch {
		// Retention cleanup is best effort and must not affect fresh exec runs.
	}
}

function flushFreshSessionAutoPrunes(): void {
	const managers = [...pendingAutoPruneManagers];
	pendingAutoPruneManagers.clear();
	for (const manager of managers) {
		runFreshSessionAutoPrune(manager);
	}
}

function registerFreshAutoPruneBeforeExit(): void {
	if (autoPruneBeforeExitRegistered || isTestMode()) {
		return;
	}
	autoPruneBeforeExitRegistered = true;
	process.once("beforeExit", () => {
		flushFreshSessionAutoPrunes();
	});
}

function createEntryId(existing: Map<string, SessionTreeEntry>): string {
	for (let i = 0; i < 100; i++) {
		const id = uuidv4().slice(0, 8);
		if (!existing.has(id)) return id;
	}
	return uuidv4();
}

function readSessionPruneMetadata(filePath: string): {
	id: string;
	favorite: boolean;
} | null {
	if (!existsSync(filePath)) return null;
	let id: string | null = null;
	let favorite = false;
	try {
		// Keep pruning metadata lightweight; full history surfaces still use the
		// complete SessionManager catalog path.
		const contents = readFileSync(filePath, "utf8");
		for (const line of contents.split("\n")) {
			if (!line.trim()) continue;
			const parsed = JSON.parse(line) as SessionEntry;
			if (parsed.type === "session") {
				id = parsed.id;
			} else if (
				parsed.type === "session_meta" &&
				typeof parsed.favorite === "boolean"
			) {
				favorite = parsed.favorite;
			}
		}
	} catch {
		return null;
	}
	return id ? { id, favorite } : null;
}

export class FreshExecSessionManager {
	private sessionId!: string;
	private sessionFile!: string;
	private sessionDir: string;
	private sessionScope?: string;
	private sessionDirOverride?: string;
	private enabled = true;
	private sessionInitialized = false;
	private writer?: SessionFileWriter;
	private fileEntries: SessionEntry[] = [];
	private byId = new Map<string, SessionTreeEntry>();
	private leafId: string | null = null;
	private flushed = false;
	private lastModelMetadata?: SessionModelMetadata;

	constructor(options: FreshExecSessionManagerOptions = {}) {
		this.sessionScope = options.sessionScope;
		this.sessionDirOverride = options.sessionDir;
		this.sessionDir = this.getSessionDirectory();
		this.initNewSession(options.sessionId);
		this.initializeWriter();
	}

	disable(): void {
		this.enabled = false;
		if (this.sessionFile) {
			unregisterActiveSessionFile(this.sessionFile);
		}
		this.writer?.flushSync();
		this.writer?.dispose();
		this.writer = undefined;
		this.fileEntries = [];
		this.byId.clear();
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

	private initNewSession(sessionId = uuidv4()): void {
		this.sessionId = sessionId;
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		this.sessionFile = join(
			this.sessionDir,
			`${timestamp}_${this.sessionId}.jsonl`,
		);
		registerActiveSessionFile(this.sessionFile);
		this.fileEntries = [];
		this.byId.clear();
		this.leafId = null;
		this.flushed = false;
		this.sessionInitialized = false;
	}

	private persistEntry(entry: SessionEntry): void {
		if (!this.enabled || !this.writer || !this.sessionFile) return;
		if (!this.sessionInitialized) return;

		if (!this.flushed) {
			for (const pending of this.fileEntries) {
				this.writer.write(pending);
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
		this.persistEntry(entry);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string {
		return this.sessionFile;
	}

	getHeader(): SessionHeaderEntry | null {
		const header = this.fileEntries.find((entry) => entry.type === "session");
		return header ? (header as SessionHeaderEntry) : null;
	}

	isInitialized(): boolean {
		return this.sessionInitialized;
	}

	canCreateSession(): boolean {
		return this.enabled;
	}

	shouldInitializeSession(messages: AppMessage[]): boolean {
		return (
			this.enabled &&
			!this.sessionInitialized &&
			messages.some((message) => message.role === "user")
		);
	}

	startSession(state: AgentState): void {
		if (!this.enabled || this.sessionInitialized) return;
		const modelKey = `${state.model.provider}/${state.model.id}`;
		const timestamp = new Date().toISOString();
		const entry: SessionHeaderEntry = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: process.cwd(),
			model: modelKey,
			modelMetadata:
				this.lastModelMetadata ??
				toSessionModelMetadata(state.model as RegisteredModel),
			thinkingLevel: state.thinkingLevel,
			systemPrompt: state.systemPrompt,
			promptMetadata: state.promptMetadata,
			promptContextManifest: getPersistedSessionPromptContextManifest(state),
			unifiedContextManifest: state.unifiedContextManifest,
			tools: state.tools.map((tool) => ({
				name: tool.name,
				label: tool.label,
				description: tool.description,
			})),
		};
		this.fileEntries.unshift(entry);
		this.sessionInitialized = true;
		this.persistEntry(entry);

		queueSharedMemoryUpdateLazy({
			sessionId: this.sessionId,
			state: {
				sessionId: this.sessionId,
				cwd: process.cwd(),
				model: modelKey,
				updatedAt: entry.timestamp,
				source: "maestro",
			},
			event: {
				type: "maestro.session.started",
				payload: {
					sessionId: this.sessionId,
					model: modelKey,
					timestamp: entry.timestamp,
				},
			},
		});

		recordPromptVariantSelectedLazy(state, this.sessionId, entry.timestamp);

		if (sessionAutoPruneEnabled()) {
			this.scheduleAutoPrune();
		}
	}

	private scheduleAutoPrune(): void {
		pendingAutoPruneManagers.add(this);
		registerFreshAutoPruneBeforeExit();
		const pruneTimer = setTimeout(() => {
			if (!pendingAutoPruneManagers.delete(this)) {
				return;
			}
			runFreshSessionAutoPrune(this);
		}, AUTO_PRUNE_DELAY_MS);
		pruneTimer.unref?.();
	}

	saveMessage(message: AppMessage): void {
		if (!this.enabled) return;
		if (
			isToolResultMessage(message) &&
			this.fileEntries.some(
				(entry) =>
					entry.type === "message" &&
					isToolResultMessage(entry.message) &&
					entry.message.toolCallId === message.toolCallId,
			)
		) {
			return;
		}
		const sanitizedMessage = sanitizeMessageForSession(message);
		const entry: SessionMessageEntry = {
			type: "message",
			id: createEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message: sanitizedMessage,
		};
		this.appendTreeEntry(entry);

		queueSharedMemoryUpdateLazy({
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

	appendCustomEntry(customType: string, data?: unknown): void {
		if (!this.enabled) return;
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: createEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this.appendTreeEntry(entry);
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
		const targetEntry = options?.firstKeptEntryId
			? this.byId.get(options.firstKeptEntryId)
			: context.messageEntries[firstKeptEntryIndex];
		const fallbackEntry = this.fileEntries.find(isSessionTreeEntry);
		const firstKeptEntryId =
			targetEntry?.id ?? this.leafId ?? fallbackEntry?.id;
		if (!firstKeptEntryId) return;

		const entry: CompactionEntry = {
			type: "compaction",
			id: createEntryId(this.byId),
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

	updateSnapshot(_state: AgentState, metadata?: SessionModelMetadata): void {
		if (metadata) {
			this.lastModelMetadata = metadata;
		}
	}

	updateUnifiedContextManifest(manifest: UnifiedContextManifest): boolean {
		if (!this.enabled || !this.sessionInitialized) return false;
		const headerIndex = this.fileEntries.findIndex(
			(entry) => entry.type === "session",
		);
		if (headerIndex < 0) return false;
		const entry = {
			...(this.fileEntries[headerIndex] as SessionHeaderEntry),
			unifiedContextManifest: manifest,
		};
		this.fileEntries[headerIndex] = entry;
		this.writer?.flushSync();
		const content = `${this.fileEntries.map((item) => JSON.stringify(item)).join("\n")}\n`;
		writeFileSync(this.sessionFile, content);
		this.flushed = true;
		return true;
	}

	saveSessionSummary(summary: string, sessionPath?: string): void {
		const trimmed = summary.trim();
		if (!trimmed) return;
		const target = sessionPath ?? this.sessionFile;
		if (!target || !existsSync(target)) return;
		const entry: SessionMetaEntry = {
			type: "session_meta",
			timestamp: new Date().toISOString(),
			summary: trimmed,
		};
		this.writer?.flushSync();
		if (resolve(target) === resolve(this.sessionFile)) {
			this.fileEntries.push(entry);
			this.writer?.write(entry);
			this.writer?.flushSync();
			queueSharedMemoryUpdateLazy({
				sessionId: this.sessionId,
				state: {
					sessionId: this.sessionId,
					updatedAt: entry.timestamp,
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
		} else {
			appendFileSync(target, `${JSON.stringify(entry)}\n`);
		}
		syncSessionMemoryLazy(target);
	}

	saveSessionResumeSummary(summary: string, sessionPath?: string): void {
		const trimmed = summary.trim();
		if (!trimmed) return;
		const target = sessionPath ?? this.sessionFile;
		if (!target || !existsSync(target)) return;
		const entry: SessionMetaEntry = {
			type: "session_meta",
			timestamp: new Date().toISOString(),
			resumeSummary: trimmed,
		};
		this.writer?.flushSync();
		if (resolve(target) === resolve(this.sessionFile)) {
			this.fileEntries.push(entry);
			this.writer?.write(entry);
			this.writer?.flushSync();
		} else {
			appendFileSync(target, `${JSON.stringify(entry)}\n`);
		}
		syncSessionMemoryLazy(target);
	}

	saveSessionMemoryExtractionHash(hash: string, sessionPath?: string): void {
		const trimmed = hash.trim();
		if (!trimmed) return;
		const target = sessionPath ?? this.sessionFile;
		if (!target || !existsSync(target)) return;
		const entry: SessionMetaEntry = {
			type: "session_meta",
			timestamp: new Date().toISOString(),
			memoryExtractionHash: trimmed,
		};
		this.writer?.flushSync();
		if (resolve(target) === resolve(this.sessionFile)) {
			this.fileEntries.push(entry);
			this.writer?.write(entry);
			this.writer?.flushSync();
		} else {
			appendFileSync(target, `${JSON.stringify(entry)}\n`);
		}
	}

	loadAllSessions(): SessionMetadata[] {
		const sessions: SessionMetadata[] = [];
		try {
			const files = readdirSync(this.sessionDir)
				.filter((fileName) => fileName.endsWith(".jsonl"))
				.map((fileName) => {
					const path = join(this.sessionDir, fileName);
					const stats = statSync(path);
					return { path, stats };
				})
				.sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());
			for (const file of files) {
				const metadata = readSessionPruneMetadata(file.path);
				sessions.push({
					path: file.path,
					id: metadata?.id ?? "unknown",
					created: file.stats.birthtime,
					modified: file.stats.mtime,
					size: file.stats.size,
					messageCount: 0,
					firstMessage: "",
					summary: "",
					favorite: metadata?.favorite ?? false,
					allMessagesText: "",
				});
			}
		} catch {
			return sessions;
		}
		return sessions;
	}

	pruneSessions(): { removed: number; errors: number } {
		const maxSessions = SESSION_CONFIG.MAX_SESSIONS;
		const maxAgeDays = SESSION_CONFIG.MAX_SESSION_AGE_DAYS;
		if (maxSessions <= 0 && maxAgeDays <= 0) {
			return { removed: 0, errors: 0 };
		}

		const sessions = this.loadAllSessions();
		const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : 0;
		const now = Date.now();
		const toRemove: SessionMetadata[] = [];

		if (maxAgeMs > 0) {
			for (const session of sessions) {
				if (session.favorite) continue;
				if (session.id === this.sessionId) continue;
				if (now - session.modified.getTime() > maxAgeMs) {
					toRemove.push(session);
				}
			}
		}

		if (maxSessions > 0) {
			const eligible = sessions.filter(
				(session) =>
					!session.favorite &&
					session.id !== this.sessionId &&
					!toRemove.some((removedSession) => removedSession.id === session.id),
			);
			if (eligible.length > maxSessions) {
				toRemove.push(...eligible.slice(maxSessions));
			}
		}

		let removed = 0;
		let errors = 0;
		for (const session of toRemove) {
			try {
				unlinkSync(session.path);
				removed++;
			} catch {
				errors++;
			}
		}

		return { removed, errors };
	}

	async flush(): Promise<void> {
		await this.writer?.flush();
	}
}
