import { randomUUID } from "node:crypto";
import type { AgentProfilePin } from "@evalops/contracts";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { isToolResultMessage } from "../agent/type-guards.js";
import type { AgentState, AppMessage } from "../agent/types.js";
import { getDb } from "../db/client.js";
import { hostedSessionEntries, hostedSessions } from "../db/schema.js";
import {
	type SessionContextSnapshot,
	buildSessionContextFromEntries,
	generateEntryId,
	selectSessionMessagesForView,
} from "../session/session-context.js";
import {
	applyAttachmentExtracts,
	sanitizeMessageForSession,
	sanitizeSessionTextForPersistence,
} from "../session/session-sanitize.js";
import type { SessionMetadata } from "../session/types.js";
import {
	type AttachmentExtractedEntry,
	CURRENT_SESSION_VERSION,
	type CompactionEntry,
	type SessionEntry,
	type SessionHeaderEntry,
	type SessionMessagesView,
	type SessionMetaEntry,
	type SessionModelMetadata,
	type SessionSummary,
	type SessionTreeEntry,
	getPersistedSessionPromptContextManifest,
	isSessionHeaderEntry,
	isSessionTreeEntry,
	normalizeSessionEntry,
} from "../session/types.js";
import { queueSharedMemoryUpdate } from "../shared-memory/client.js";
import { recordMaestroPromptVariantSelected } from "../telemetry/maestro-event-bus.js";
import {
	type RequestContext,
	SINGLE_USER_CONTEXT,
	getSessionAccessControl,
} from "./access-control.js";

type SessionRow = typeof hostedSessions.$inferSelect;

function parseSessionEntryValue(value: unknown): SessionEntry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	if (typeof (value as { type?: unknown }).type !== "string") {
		return null;
	}
	return normalizeSessionEntry(value);
}

export interface HostedSessionMetadataUpdate {
	title?: string;
	favorite?: boolean;
	tags?: string[];
}

export interface HostedSessionManagerHooks {
	/**
	 * Called immediately after a session row is soft-deleted. The
	 * daemon binds this to `admin.forgetSessionOwner` so the
	 * `MultiClientSessionAccessControl` owner map sheds the entry —
	 * preventing ghost-ownership on resurrection and unbounded map
	 * growth. (Round-2-review fix.)
	 */
	onSessionDestroyed?: (sessionId: string) => void;
	/**
	 * Called immediately after a fresh session id is generated (either
	 * via `createSession` or `createBranchedSessionFromState`). The
	 * daemon binds this to `admin.recordSessionOwner` so the creating
	 * caller's subsequent `assertSessionWritable(newId, ctx)` finds
	 * the seeded owner instead of refusing. (Round-2-review fix.)
	 */
	onSessionCreated?: (sessionId: string, ctx: RequestContext) => void;
}

export class HostedSessionManager {
	readonly storageKind = "database" as const;

	private readonly scope: string;
	private readonly subject?: string;
	private readonly hooks: HostedSessionManagerHooks;
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
	private pendingAgentProfilePin?: AgentProfilePin;

	constructor(options: {
		scope: string;
		subject?: string;
		hooks?: HostedSessionManagerHooks;
	}) {
		this.scope = options.scope;
		this.subject = options.subject;
		this.hooks = options.hooks ?? {};
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

	private resolveSessionId(sessionRef?: string): string {
		if (!sessionRef) {
			return this.sessionId;
		}
		return sessionRef.startsWith("db:")
			? sessionRef.slice("db:".length)
			: sessionRef;
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

	private appendSessionMetaEntry(
		sessionId: string,
		fields: Omit<SessionMetaEntry, "type" | "timestamp">,
		rowUpdates: Partial<typeof hostedSessions.$inferInsert> = {},
	): void {
		const entry: SessionMetaEntry = {
			type: "session_meta",
			timestamp: new Date().toISOString(),
			...fields,
		};
		if (sessionId === this.sessionId) {
			this.entries.push(entry);
		}
		const messageCount =
			sessionId === this.sessionId ? this.currentMessageCount() : undefined;
		this.enqueue(async () => {
			if (sessionId === this.sessionId) {
				await this.ensureSessionRow(sessionId, { messageCount });
			}
			await getDb().insert(hostedSessionEntries).values({
				sessionId,
				entryType: entry.type,
				entry,
			});
			await getDb()
				.update(hostedSessions)
				.set({
					...rowUpdates,
					...(messageCount !== undefined ? { messageCount } : {}),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(hostedSessions.sessionId, sessionId),
						eq(hostedSessions.scope, this.scope),
						isNull(hostedSessions.deletedAt),
					),
				);
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

	async loadEntries(
		sessionId: string,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): Promise<SessionEntry[] | null> {
		await getSessionAccessControl().assertSessionReadable(sessionId, ctx);
		const row = await this.loadRow(sessionId);
		if (!row) {
			return null;
		}
		return this.loadEntriesForSession(sessionId);
	}

	async resumeSession(
		sessionId: string,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): Promise<boolean> {
		await getSessionAccessControl().assertSessionReadable(sessionId, ctx);
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
			summary: row.summary ?? undefined,
			resumeSummary: row.resumeSummary ?? undefined,
			memoryExtractionHash: row.memoryExtractionHash ?? undefined,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			messageCount: row.messageCount,
			favorite: row.favorite,
			tags: row.tags ?? undefined,
		}));
	}

	async loadSession(
		sessionId: string,
		options: {
			messagesView?: SessionMessagesView;
			ctx?: RequestContext;
		} = {},
	): Promise<{
		id: string;
		subject?: string;
		title?: string;
		summary?: string;
		resumeSummary?: string;
		memoryExtractionHash?: string;
		messages: AppMessage[];
		createdAt: string;
		updatedAt: string;
		messageCount: number;
		favorite: boolean;
		tags?: string[];
		messagesView: SessionMessagesView;
	} | null> {
		await getSessionAccessControl().assertSessionReadable(
			sessionId,
			options.ctx ?? SINGLE_USER_CONTEXT,
		);
		await this.flush();
		const row = await this.loadRow(sessionId);
		if (!row) {
			return null;
		}
		const messagesView = options.messagesView ?? "full";
		if (messagesView === "notLoaded") {
			return {
				id: row.sessionId,
				subject: row.subject ?? undefined,
				title: row.title ?? undefined,
				summary: row.summary ?? undefined,
				resumeSummary: row.resumeSummary ?? undefined,
				memoryExtractionHash: row.memoryExtractionHash ?? undefined,
				messages: [],
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
				messageCount: row.messageCount,
				favorite: row.favorite,
				tags: row.tags ?? undefined,
				messagesView,
			};
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
				extractedById.set(
					entry.attachmentId,
					sanitizeSessionTextForPersistence(entry.extractedText),
				);
			}
		}
		const messages =
			extractedById.size === 0
				? context.messages
				: context.messages.map((message) =>
						applyAttachmentExtracts(message, extractedById),
					);
		const messageCount = row.messageCount || messages.length;
		const selectedMessages = selectSessionMessagesForView(
			messages,
			messagesView,
		);

		return {
			id: row.sessionId,
			subject: row.subject ?? undefined,
			title: row.title ?? undefined,
			summary: row.summary ?? undefined,
			resumeSummary: row.resumeSummary ?? undefined,
			memoryExtractionHash: row.memoryExtractionHash ?? undefined,
			messages: selectedMessages,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			messageCount,
			favorite: row.favorite,
			tags: row.tags ?? undefined,
			messagesView,
		};
	}

	async createSession(
		options?: { title?: string },
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): Promise<{
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
		// Seed owner FIRST so the gate accepts the immediate write that
		// follows (`ensureSessionRow` enqueues into our own write
		// chain; downstream callers issuing `assertSessionWritable`
		// would otherwise see an un-owned session and refuse). Round-2-
		// review fix.
		this.hooks.onSessionCreated?.(this.sessionId, ctx);
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

	async deleteSession(
		sessionId: string,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): Promise<void> {
		await getSessionAccessControl().assertSessionWritable(sessionId, ctx);
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
		// Drop the ownership record so the map doesn't grow unbounded
		// across destroyed sessions, and so a resurrected session can't
		// be reached by the original owner's `clientId` after admin
		// handoff (round-2-review fix). No-op in single-user mode.
		this.hooks.onSessionDestroyed?.(sessionId);
	}

	async createBranchedSessionFromState(
		state: AgentState,
		branchFromIndex: number,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): Promise<string> {
		await this.flush();
		const newSessionId = randomUUID();
		// Seed owner before any writes to the new session id (round-2-
		// review fix). Without this, the branched session is unowned;
		// subsequent `assertSessionWritable(newSessionId, ctx)` refuses
		// and the creator is locked out of their own branch.
		this.hooks.onSessionCreated?.(newSessionId, ctx);
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
				promptContextManifest: getPersistedSessionPromptContextManifest(state),
				unifiedContextManifest: state.unifiedContextManifest,
				systemPromptSourcePaths:
					state.systemPromptSourcePaths &&
					state.systemPromptSourcePaths.length > 0
						? [...state.systemPromptSourcePaths]
						: undefined,
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
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): Promise<void> {
		await getSessionAccessControl().assertSessionWritable(sessionId, ctx);
		const set: Partial<typeof hostedSessions.$inferInsert> = {};
		if (updates.title !== undefined) set.title = updates.title;
		if (updates.favorite !== undefined) set.favorite = updates.favorite;
		if (updates.tags !== undefined) set.tags = updates.tags;
		this.appendSessionMetaEntry(
			sessionId,
			{
				...(updates.title !== undefined ? { title: updates.title } : {}),
				...(updates.favorite !== undefined
					? { favorite: updates.favorite }
					: {}),
				...(updates.tags !== undefined ? { tags: updates.tags } : {}),
			},
			set,
		);
		await this.flush();
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
			promptContextManifest: getPersistedSessionPromptContextManifest(state),
			unifiedContextManifest: state.unifiedContextManifest,
			agentProfilePin: this.pendingAgentProfilePin,
			systemPromptSourcePaths:
				state.systemPromptSourcePaths &&
				state.systemPromptSourcePaths.length > 0
					? [...state.systemPromptSourcePaths]
					: undefined,
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

	updateAgentProfilePin(pin: AgentProfilePin): boolean {
		const profile = pin.profile.trim();
		if (!profile || !pin.updatedAt.trim()) return false;
		const normalized = Object.freeze({ profile, updatedAt: pin.updatedAt });
		this.pendingAgentProfilePin = normalized;
		if (!this.sessionInitialized) return true;
		const headerIndex = this.entries.findIndex(
			(entry) => entry.type === "session",
		);
		if (headerIndex < 0) return false;
		const entry = {
			...(this.entries[headerIndex] as SessionHeaderEntry),
			agentProfilePin: normalized,
		};
		this.entries[headerIndex] = entry;
		const sessionId = this.sessionId;
		this.enqueue(async () => {
			await getDb()
				.update(hostedSessionEntries)
				.set({ entry })
				.where(
					and(
						eq(hostedSessionEntries.sessionId, sessionId),
						eq(hostedSessionEntries.entryType, "session"),
					),
				);
		});
		return true;
	}

	saveMessage(message: AppMessage): void {
		if (
			isToolResultMessage(message) &&
			this.entries.some(
				(entry) =>
					entry.type === "message" &&
					isToolResultMessage(entry.message) &&
					entry.message.toolCallId === message.toolCallId,
			)
		) {
			return;
		}
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

	/**
	 * Sync gate helper for the fire-and-forget setter methods. The
	 * `assertSessionWritableSync` form throws synchronously; callers
	 * don't have to await the gate before scheduling their DB write.
	 * (#2641 adversarial review.)
	 */
	private assertWritableForRefSync(
		sessionRef: string | undefined,
		ctx: RequestContext,
	): string {
		const sessionId = this.resolveSessionId(sessionRef);
		getSessionAccessControl().assertSessionWritableSync(sessionId, ctx);
		return sessionId;
	}

	saveAttachmentExtraction(
		sessionRef: string,
		attachmentId: string,
		text: string,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): void {
		if (!attachmentId || !text) return;
		// Round-2-review fixes:
		//   1. The previous `targetSessionId && targetSessionId !==
		//      this.sessionId` guard short-circuited on empty-string
		//      `sessionRef`, silently routing the write to whatever
		//      session the manager was currently bound to — a cross-
		//      tenant write hole once the daemon ships. Normalize
		//      through `resolveSessionId` so empty/missing refs
		//      deterministically target the bound session, matching
		//      every other `*sessionRef?` setter on this class.
		//   2. The same-session bypass was TOCTOU-vulnerable through
		//      `setSessionFile`: an in-process caller could flip
		//      `this.sessionId` to a target it owned, have that
		//      ownership revoked, and keep writing because the
		//      "same-session" branch skipped the gate. Always gate
		//      now; the cost is one map lookup.
		const targetSessionId = this.resolveSessionId(sessionRef || undefined);
		getSessionAccessControl().assertSessionWritableSync(targetSessionId, ctx);

		const entry: AttachmentExtractedEntry = {
			type: "attachment_extract",
			timestamp: new Date().toISOString(),
			attachmentId,
			extractedText: sanitizeSessionTextForPersistence(text),
		};
		if (targetSessionId !== this.sessionId) {
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

	saveSessionSummary(
		summary: string,
		sessionRef?: string,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): void {
		const trimmed = summary.trim();
		if (!trimmed) return;
		const sessionId = this.assertWritableForRefSync(sessionRef, ctx);
		this.appendSessionMetaEntry(
			sessionId,
			{ summary: trimmed },
			{ summary: trimmed },
		);
	}

	saveSessionResumeSummary(
		summary: string,
		sessionRef?: string,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): void {
		const trimmed = summary.trim();
		if (!trimmed) return;
		const sessionId = this.assertWritableForRefSync(sessionRef, ctx);
		this.appendSessionMetaEntry(
			sessionId,
			{ resumeSummary: trimmed },
			{ resumeSummary: trimmed },
		);
	}

	saveSessionMemoryExtractionHash(
		hash: string,
		sessionRef?: string,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): void {
		const trimmed = hash.trim();
		if (!trimmed) return;
		const sessionId = this.assertWritableForRefSync(sessionRef, ctx);
		this.appendSessionMetaEntry(
			sessionId,
			{ memoryExtractionHash: trimmed },
			{ memoryExtractionHash: trimmed },
		);
	}

	setSessionFavorite(
		sessionRef: string,
		favorite: boolean,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): void {
		const sessionId = this.assertWritableForRefSync(sessionRef, ctx);
		this.appendSessionMetaEntry(sessionId, { favorite }, { favorite });
	}

	setSessionTitle(
		sessionRef: string,
		title: string,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): void {
		const sessionId = this.assertWritableForRefSync(sessionRef, ctx);
		this.appendSessionMetaEntry(sessionId, { title }, { title });
	}

	setSessionTags(
		sessionRef: string,
		tags: string[],
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): void {
		const sessionId = this.assertWritableForRefSync(sessionRef, ctx);
		this.appendSessionMetaEntry(sessionId, { tags }, { tags });
	}

	setSessionAppServerGoal(
		sessionRef: string,
		goal: NonNullable<SessionMetaEntry["appServerGoal"]> | null,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): void {
		const sessionId = this.assertWritableForRefSync(sessionRef, ctx);
		this.appendSessionMetaEntry(sessionId, { appServerGoal: goal });
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string {
		return `db:${this.sessionId}`;
	}

	getCurrentLeafId(): string | null {
		return this.leafId;
	}

	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	getSessionFileById(sessionId: string): string | null {
		return `db:${sessionId}`;
	}

	setSessionFile(
		sessionRef: string,
		ctx: RequestContext = SINGLE_USER_CONTEXT,
	): void {
		const sessionId = sessionRef.startsWith("db:")
			? sessionRef.slice("db:".length)
			: sessionRef;
		if (!sessionId) return;
		// Adversarial-review fix: this method flips the manager's
		// active sessionId from caller-controlled input. Without the
		// gate, an in-process caller (a tool, a plugin) could redirect
		// the manager onto another tenant's session and have
		// subsequent writes land on it. Require write access first.
		getSessionAccessControl().assertSessionWritableSync(sessionId, ctx);
		this.sessionId = sessionId;
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
