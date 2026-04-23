import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { AgentState, AppMessage } from "../agent/types.js";
import { getDb } from "../db/client.js";
import { hostedSessionEntries, hostedSessions } from "../db/schema.js";
import {
	type SessionContextSnapshot,
	buildSessionContextFromEntries,
	generateEntryId,
} from "../session/session-context.js";
import {
	applyAttachmentExtracts,
	sanitizeMessageForSession,
} from "../session/session-sanitize.js";
import type { SessionMetadata } from "../session/types.js";
import {
	type AttachmentExtractedEntry,
	CURRENT_SESSION_VERSION,
	type CompactionEntry,
	type SessionEntry,
	type SessionHeaderEntry,
	type SessionMetaEntry,
	type SessionModelMetadata,
	type SessionSummary,
	type SessionTreeEntry,
	isSessionHeaderEntry,
	isSessionTreeEntry,
} from "../session/types.js";
import { queueSharedMemoryUpdate } from "../shared-memory/client.js";
import { recordMaestroPromptVariantSelected } from "../telemetry/maestro-event-bus.js";

type SessionRow = typeof hostedSessions.$inferSelect;

function parseSessionEntryValue(value: unknown): SessionEntry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	if (typeof (value as { type?: unknown }).type !== "string") {
		return null;
	}
	return value as SessionEntry;
}

export interface HostedSessionMetadataUpdate {
	title?: string;
	favorite?: boolean;
	tags?: string[];
}

export class HostedSessionManager {
	readonly storageKind = "database" as const;

	private readonly scope: string;
	private readonly subject?: string;
	private sessionId: string = randomUUID();
	private entries: SessionEntry[] = [];
	private byId: Map<string, SessionTreeEntry> = new Map();
	private leafId: string | null = null;
	private sessionInitialized = false;
	private writeChain: Promise<unknown> = Promise.resolve();
	private hasWriteError = false;
	private writeError: unknown;
	private snapshot?: AgentState;
	private lastModelMetadata?: SessionModelMetadata;

	constructor(options: { scope: string; subject?: string }) {
		this.scope = options.scope;
		this.subject = options.subject;
	}

	private toModelMetadata(model: AgentState["model"]): SessionModelMetadata {
		const optional = model as AgentState["model"] &
			Partial<Pick<SessionModelMetadata, "providerName" | "source">>;
		return {
			provider: model.provider,
			modelId: model.id,
			providerName: optional.providerName,
			name: model.name,
			baseUrl: model.baseUrl,
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			source: optional.source,
		};
	}

	private enqueue(operation: () => Promise<void>): void {
		const result = this.writeChain.then(operation, operation);
		this.writeChain = result.then(
			() => undefined,
			(error) => {
				if (!this.hasWriteError) {
					this.writeError = error;
					this.hasWriteError = true;
				}
			},
		);
	}

	private rebuildIndex(entries: SessionEntry[]): void {
		this.byId.clear();
		this.leafId = null;
		for (const entry of entries) {
			if (!isSessionTreeEntry(entry)) {
				continue;
			}
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
		}
		this.sessionInitialized = entries.some(isSessionHeaderEntry);
	}

	private currentMessageCount(): number {
		return this.buildSessionContext().messages.length;
	}

	private async ensureSessionRow(
		sessionId: string,
		values: Partial<typeof hostedSessions.$inferInsert> = {},
	): Promise<void> {
		const now = new Date();
		await getDb()
			.insert(hostedSessions)
			.values({
				sessionId,
				scope: this.scope,
				subject: this.subject ?? null,
				cwd: process.cwd(),
				messageCount: this.currentMessageCount(),
				createdAt: now,
				updatedAt: now,
				...values,
			})
			.onConflictDoUpdate({
				target: hostedSessions.sessionId,
				set: {
					scope: this.scope,
					subject: values.subject ?? this.subject ?? null,
					cwd: values.cwd ?? process.cwd(),
					updatedAt: now,
					deletedAt: null,
					...values,
				},
			});
	}

	private appendEntry(entry: SessionEntry): void {
		this.entries.push(entry);
		if (isSessionTreeEntry(entry)) {
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
		}
		const sessionId = this.sessionId;
		const entryId =
			"id" in entry && typeof entry.id === "string" ? entry.id : undefined;
		const messageCount = this.currentMessageCount();

		this.enqueue(async () => {
			await this.ensureSessionRow(sessionId, { messageCount });
			await getDb().insert(hostedSessionEntries).values({
				sessionId,
				entryType: entry.type,
				entryId,
				entry,
			});
			await getDb()
				.update(hostedSessions)
				.set({
					messageCount,
					updatedAt: new Date(),
				})
				.where(eq(hostedSessions.sessionId, sessionId));
		});
	}

	private async loadRow(sessionId: string): Promise<SessionRow | null> {
		const [row] = await getDb()
			.select()
			.from(hostedSessions)
			.where(
				and(
					eq(hostedSessions.sessionId, sessionId),
					eq(hostedSessions.scope, this.scope),
					isNull(hostedSessions.deletedAt),
				),
			)
			.limit(1);
		return row ?? null;
	}

	private async loadEntriesForSession(
		sessionId: string,
	): Promise<SessionEntry[]> {
		const rows = await getDb()
			.select({ entry: hostedSessionEntries.entry })
			.from(hostedSessionEntries)
			.where(eq(hostedSessionEntries.sessionId, sessionId))
			.orderBy(asc(hostedSessionEntries.sequence));

		const entries: SessionEntry[] = [];
		for (const row of rows) {
			const entry = parseSessionEntryValue(row.entry);
			if (entry) {
				entries.push(entry);
			}
		}
		return entries;
	}

	async loadEntries(sessionId: string): Promise<SessionEntry[] | null> {
		const row = await this.loadRow(sessionId);
		if (!row) {
			return null;
		}
		return this.loadEntriesForSession(sessionId);
	}

	async resumeSession(sessionId: string): Promise<boolean> {
		await this.flush();
		const row = await this.loadRow(sessionId);
		if (!row) {
			return false;
		}
		const entries = await this.loadEntriesForSession(sessionId);
		this.sessionId = row.sessionId;
		this.entries = entries;
		this.rebuildIndex(entries);
		return true;
	}

	loadAllSessions(): SessionMetadata[] {
		return [];
	}

	async countActiveSessions(since: Date): Promise<number> {
		await this.flush();
		const [row] = await getDb()
			.select({ count: sql<number>`count(*)::int` })
			.from(hostedSessions)
			.where(
				and(
					eq(hostedSessions.scope, this.scope),
					gte(hostedSessions.updatedAt, since),
					isNull(hostedSessions.deletedAt),
				),
			);
		return Number(row?.count ?? 0);
	}

	async listSessions(options?: {
		limit?: number;
		offset?: number;
	}): Promise<SessionSummary[]> {
		await this.flush();
		let query = getDb()
			.select()
			.from(hostedSessions)
			.where(
				and(
					eq(hostedSessions.scope, this.scope),
					isNull(hostedSessions.deletedAt),
				),
			)
			.orderBy(desc(hostedSessions.updatedAt))
			.$dynamic();
		if (typeof options?.limit === "number") {
			query = query.limit(options.limit);
		}
		if (typeof options?.offset === "number") {
			query = query.offset(options.offset);
		}
		const rows = await query;

		return rows.map((row) => ({
			id: row.sessionId,
			subject: row.subject ?? undefined,
			title: row.title ?? undefined,
			resumeSummary: row.resumeSummary ?? undefined,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			messageCount: row.messageCount,
			favorite: row.favorite,
			tags: row.tags ?? undefined,
		}));
	}

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
		await this.flush();
		const row = await this.loadRow(sessionId);
		if (!row) {
			return null;
		}
		const entries = await this.loadEntriesForSession(sessionId);
		const context = buildSessionContextFromEntries(entries);
		const extractedById = new Map<string, string>();
		for (const entry of entries) {
			if (
				entry.type === "attachment_extract" &&
				entry.attachmentId &&
				entry.extractedText
			) {
				extractedById.set(entry.attachmentId, entry.extractedText);
			}
		}
		const messages =
			extractedById.size === 0
				? context.messages
				: context.messages.map((message) =>
						applyAttachmentExtracts(message, extractedById),
					);

		return {
			id: row.sessionId,
			subject: row.subject ?? undefined,
			title: row.title ?? undefined,
			resumeSummary: row.resumeSummary ?? undefined,
			messages,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			messageCount: messages.length,
			favorite: row.favorite,
			tags: row.tags ?? undefined,
		};
	}

	async createSession(options?: { title?: string }): Promise<{
		id: string;
		title?: string;
		resumeSummary?: string;
		messages: AppMessage[];
		createdAt: string;
		updatedAt: string;
		messageCount: number;
		favorite: boolean;
		tags?: string[];
	}> {
		await this.flush();
		this.sessionId = randomUUID();
		this.entries = [];
		this.rebuildIndex([]);
		const now = new Date();
		await this.ensureSessionRow(this.sessionId, {
			title: options?.title,
			favorite: false,
			messageCount: 0,
			createdAt: now,
			updatedAt: now,
		});
		return {
			id: this.sessionId,
			title: options?.title,
			messages: [],
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
			messageCount: 0,
			favorite: false,
		};
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.flush();
		await getDb()
			.update(hostedSessions)
			.set({ deletedAt: new Date(), updatedAt: new Date() })
			.where(
				and(
					eq(hostedSessions.sessionId, sessionId),
					eq(hostedSessions.scope, this.scope),
				),
			);
	}

	async createBranchedSessionFromState(
		state: AgentState,
		branchFromIndex: number,
	): Promise<string> {
		await this.flush();
		const newSessionId = randomUUID();
		const timestamp = new Date().toISOString();
		const modelKey = `${state.model.provider}/${state.model.id}`;
		const branchEntries: SessionEntry[] = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: newSessionId,
				timestamp,
				cwd: process.cwd(),
				subject: this.subject,
				model: modelKey,
				modelMetadata: this.toModelMetadata(state.model),
				thinkingLevel: state.thinkingLevel,
				systemPrompt: state.systemPrompt,
				promptMetadata: state.promptMetadata,
				tools: state.tools.map((tool) => ({
					name: tool.name,
					label: tool.label,
					description: tool.description,
				})),
				branchedFrom: this.sessionId,
				parentSession: this.sessionId,
			} satisfies SessionHeaderEntry,
		];
		const branchIds = new Map<string, SessionTreeEntry>();
		let parentId: string | null = null;
		for (const message of state.messages.slice(0, branchFromIndex)) {
			const entry: SessionTreeEntry = {
				type: "message",
				id: generateEntryId(branchIds),
				parentId,
				timestamp: new Date().toISOString(),
				message: sanitizeMessageForSession(message),
			};
			branchIds.set(entry.id, entry);
			parentId = entry.id;
			branchEntries.push(entry);
		}
		const now = new Date();
		await getDb()
			.insert(hostedSessions)
			.values({
				sessionId: newSessionId,
				scope: this.scope,
				subject: this.subject,
				cwd: process.cwd(),
				model: modelKey,
				modelMetadata: this.toModelMetadata(state.model),
				thinkingLevel: state.thinkingLevel,
				systemPrompt: state.systemPrompt,
				promptMetadata: state.promptMetadata,
				tools: state.tools,
				messageCount: branchEntries.filter((entry) => entry.type === "message")
					.length,
				createdAt: now,
				updatedAt: now,
			});
		for (const entry of branchEntries) {
			await getDb()
				.insert(hostedSessionEntries)
				.values({
					sessionId: newSessionId,
					entryType: entry.type,
					entryId:
						"id" in entry && typeof entry.id === "string"
							? entry.id
							: undefined,
					entry,
				});
		}
		return newSessionId;
	}

	async updateSessionMetadata(
		sessionId: string,
		updates: HostedSessionMetadataUpdate,
	): Promise<void> {
		await this.flush();
		const set: Partial<typeof hostedSessions.$inferInsert> = {
			updatedAt: new Date(),
		};
		if (updates.title !== undefined) set.title = updates.title;
		if (updates.favorite !== undefined) set.favorite = updates.favorite;
		if (updates.tags !== undefined) set.tags = updates.tags;
		await getDb()
			.update(hostedSessions)
			.set(set)
			.where(
				and(
					eq(hostedSessions.sessionId, sessionId),
					eq(hostedSessions.scope, this.scope),
					isNull(hostedSessions.deletedAt),
				),
			);
		const meta: SessionMetaEntry = {
			type: "session_meta",
			timestamp: new Date().toISOString(),
			...(updates.title !== undefined ? { title: updates.title } : {}),
			...(updates.favorite !== undefined ? { favorite: updates.favorite } : {}),
			...(updates.tags !== undefined ? { tags: updates.tags } : {}),
		};
		if (sessionId === this.sessionId) {
			this.appendEntry(meta);
		} else {
			await getDb().insert(hostedSessionEntries).values({
				sessionId,
				entryType: meta.type,
				entry: meta,
			});
		}
	}

	startSession(state: AgentState, options?: { subject?: string }): void {
		if (this.sessionInitialized) return;

		const modelKey = `${state.model.provider}/${state.model.id}`;
		const entry: SessionHeaderEntry = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			subject: options?.subject ?? this.subject,
			model: modelKey,
			modelMetadata: this.toModelMetadata(state.model),
			thinkingLevel: state.thinkingLevel,
			systemPrompt: state.systemPrompt,
			promptMetadata: state.promptMetadata,
			tools: state.tools.map((tool) => ({
				name: tool.name,
				label: tool.label,
				description: tool.description,
			})),
		};
		this.sessionInitialized = true;
		this.appendEntry(entry);

		queueSharedMemoryUpdate({
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

		if (state.promptMetadata) {
			recordMaestroPromptVariantSelected({
				prompt_metadata: state.promptMetadata,
				correlation: {
					session_id: this.sessionId,
				},
				selected_at: entry.timestamp,
			});
		}
	}

	saveMessage(message: AppMessage): void {
		const sanitizedMessage = sanitizeMessageForSession(message);
		const entry: SessionTreeEntry = {
			type: "message",
			id: this.createTreeEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message: sanitizedMessage,
		};
		this.appendEntry(entry);

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
		const context = this.buildSessionContext();
		const fallbackEntry = context.messageEntries[firstKeptEntryIndex];
		const firstKeptEntryId =
			options?.firstKeptEntryId ?? fallbackEntry?.id ?? this.leafId;
		if (!firstKeptEntryId) {
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
		this.appendEntry(entry);
	}

	saveAttachmentExtraction(
		sessionRef: string,
		attachmentId: string,
		text: string,
	): void {
		if (!attachmentId || !text) return;
		const entry: AttachmentExtractedEntry = {
			type: "attachment_extract",
			timestamp: new Date().toISOString(),
			attachmentId,
			extractedText: text,
		};
		const targetSessionId = sessionRef.startsWith("db:")
			? sessionRef.slice("db:".length)
			: sessionRef;
		if (targetSessionId && targetSessionId !== this.sessionId) {
			this.enqueue(async () => {
				await getDb().insert(hostedSessionEntries).values({
					sessionId: targetSessionId,
					entryType: entry.type,
					entry,
				});
				await getDb()
					.update(hostedSessions)
					.set({ updatedAt: new Date() })
					.where(
						and(
							eq(hostedSessions.sessionId, targetSessionId),
							eq(hostedSessions.scope, this.scope),
							isNull(hostedSessions.deletedAt),
						),
					);
			});
			return;
		}
		this.appendEntry(entry);
	}

	saveSessionSummary(summary: string, _sessionRef?: string): void {
		const trimmed = summary.trim();
		if (!trimmed) return;
		const sessionId = this.sessionId;
		const entry: SessionMetaEntry = {
			type: "session_meta",
			timestamp: new Date().toISOString(),
			summary: trimmed,
		};
		this.appendEntry(entry);
		this.enqueue(async () => {
			await getDb()
				.update(hostedSessions)
				.set({ summary: trimmed, updatedAt: new Date() })
				.where(
					and(
						eq(hostedSessions.sessionId, sessionId),
						eq(hostedSessions.scope, this.scope),
					),
				);
		});
	}

	saveSessionResumeSummary(summary: string, _sessionRef?: string): void {
		const trimmed = summary.trim();
		if (!trimmed) return;
		const sessionId = this.sessionId;
		const entry: SessionMetaEntry = {
			type: "session_meta",
			timestamp: new Date().toISOString(),
			resumeSummary: trimmed,
		};
		this.appendEntry(entry);
		this.enqueue(async () => {
			await getDb()
				.update(hostedSessions)
				.set({ resumeSummary: trimmed, updatedAt: new Date() })
				.where(
					and(
						eq(hostedSessions.sessionId, sessionId),
						eq(hostedSessions.scope, this.scope),
					),
				);
		});
	}

	saveSessionMemoryExtractionHash(hash: string, _sessionRef?: string): void {
		const trimmed = hash.trim();
		if (!trimmed) return;
		const sessionId = this.sessionId;
		const entry: SessionMetaEntry = {
			type: "session_meta",
			timestamp: new Date().toISOString(),
			memoryExtractionHash: trimmed,
		};
		this.appendEntry(entry);
		this.enqueue(async () => {
			await getDb()
				.update(hostedSessions)
				.set({ memoryExtractionHash: trimmed, updatedAt: new Date() })
				.where(
					and(
						eq(hostedSessions.sessionId, sessionId),
						eq(hostedSessions.scope, this.scope),
					),
				);
		});
	}

	setSessionFavorite(_sessionRef: string, favorite: boolean): void {
		void this.updateSessionMetadata(this.sessionId, { favorite });
	}

	setSessionTitle(_sessionRef: string, title: string): void {
		void this.updateSessionMetadata(this.sessionId, { title });
	}

	setSessionTags(_sessionRef: string, tags: string[]): void {
		void this.updateSessionMetadata(this.sessionId, { tags });
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string {
		return `db:${this.sessionId}`;
	}

	getSessionFileById(sessionId: string): string | null {
		return `db:${sessionId}`;
	}

	setSessionFile(sessionRef: string): void {
		const sessionId = sessionRef.startsWith("db:")
			? sessionRef.slice("db:".length)
			: sessionRef;
		if (sessionId) {
			this.sessionId = sessionId;
		}
	}

	isInitialized(): boolean {
		return this.sessionInitialized;
	}

	shouldInitializeSession(messages: AppMessage[]): boolean {
		return (
			!this.sessionInitialized &&
			messages.some((message) => message.role === "user")
		);
	}

	updateSnapshot(state: AgentState, metadata?: SessionModelMetadata): void {
		this.snapshot = state;
		if (metadata) {
			this.lastModelMetadata = metadata;
		}
	}

	buildSessionContext(
		leafId: string | null = this.leafId,
	): SessionContextSnapshot {
		return buildSessionContextFromEntries(this.entries, {
			leafId,
			byId: this.byId,
			header: this.getHeader(),
		});
	}

	loadModel(): string | null {
		return this.buildSessionContext().model;
	}

	loadThinkingLevel(): string {
		return this.buildSessionContext().thinkingLevel;
	}

	getHeader(): SessionHeaderEntry | null {
		return (
			(this.entries.find((entry) => entry.type === "session") as
				| SessionHeaderEntry
				| undefined) ?? null
		);
	}

	private createTreeEntryId(): string {
		return generateEntryId(this.byId);
	}

	async flush(): Promise<void> {
		await this.writeChain;
		if (this.hasWriteError) {
			const error = this.writeError;
			this.writeError = undefined;
			this.hasWriteError = false;
			throw error;
		}
	}
}

export function isHostedSessionManager(
	manager: unknown,
): manager is HostedSessionManager {
	return (
		typeof manager === "object" &&
		manager !== null &&
		"storageKind" in manager &&
		(manager as { storageKind?: unknown }).storageKind === "database"
	);
}
