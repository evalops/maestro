import {
	type MaestroAppServerClientRequest,
	type MaestroAppServerResponse,
	type MaestroAppServerThread,
	type MaestroAppServerThreadItem,
	type MaestroAppServerThreadListResult,
	type MaestroAppServerThreadSummary,
	type MaestroAppServerTurn,
	type MaestroAppServerTurnsListResult,
	maestroAppServerClientMethods,
	maestroAppServerProtocolVersion,
} from "@evalops/contracts";
import type { AppMessage } from "../agent/types.js";
import type { SessionManager } from "../session/manager.js";
import { migrateToCurrentVersion } from "../session/migration.js";
import { safeReadSessionEntries } from "../session/session-context.js";
import type {
	SessionEntry,
	SessionMessagesView,
	SessionMetadata,
	SessionSummary,
	SessionTreeEntry,
} from "../session/types.js";
import { isSessionTreeEntry } from "../session/types.js";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

type JsonRpcId = string | number;

type SessionStore = Pick<
	SessionManager,
	"getSessionFileById" | "loadAllSessions" | "listSessions" | "loadSession"
> & {
	loadEntries?: (sessionId: string) => Promise<SessionEntry[] | null>;
};

export interface MaestroAppServerSessionApi {
	initialize(): MaestroAppServerResponse["result"];
	listThreads(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadListResult>;
	readThread(params?: Record<string, unknown>): Promise<MaestroAppServerThread>;
	listTurns(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerTurnsListResult>;
}

export class MaestroAppServerError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "MaestroAppServerError";
	}
}

function normalizeLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_PAGE_LIMIT;
	}
	return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(value)));
}

function encodeCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): number {
	if (value === undefined || value === null || value === "") {
		return 0;
	}
	if (typeof value !== "string") {
		throw new MaestroAppServerError(-32602, "Invalid cursor");
	}
	try {
		const decoded = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		);
		if (
			typeof decoded === "object" &&
			decoded !== null &&
			typeof decoded.offset === "number" &&
			Number.isFinite(decoded.offset) &&
			decoded.offset >= 0
		) {
			return Math.trunc(decoded.offset);
		}
	} catch {
		// Fall through to the normalized JSON-RPC error below.
	}
	throw new MaestroAppServerError(-32602, "Invalid cursor");
}

function requireThreadId(params?: Record<string, unknown>): string {
	const threadId = params?.threadId;
	if (typeof threadId !== "string" || threadId.length === 0) {
		throw new MaestroAppServerError(-32602, "Missing threadId");
	}
	return threadId;
}

function toThreadSummary(
	metadata: SessionMetadata,
	summary?: SessionSummary,
): MaestroAppServerThreadSummary {
	return {
		id: metadata.id,
		source: "session",
		status: "notLoaded",
		title: summary?.title ?? metadata.title ?? metadata.summary,
		summary: metadata.summary,
		resumeSummary: summary?.resumeSummary ?? metadata.resumeSummary,
		subject: metadata.subject,
		path: metadata.path,
		createdAt: metadata.created.toISOString(),
		updatedAt: metadata.modified.toISOString(),
		messageCount: metadata.messageCount,
		favorite: summary?.favorite ?? metadata.favorite,
		tags: summary?.tags ?? metadata.tags,
	};
}

function toThreadSummaryFromSessionSummary(
	summary: SessionSummary,
): MaestroAppServerThreadSummary {
	return {
		id: summary.id,
		source: "session",
		status: "notLoaded",
		title: summary.title ?? summary.subject,
		summary: summary.title ?? summary.subject,
		resumeSummary: summary.resumeSummary,
		subject: summary.subject,
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt,
		messageCount: summary.messageCount,
		favorite: summary.favorite,
		tags: summary.tags,
	};
}

function toThreadSummaryFromLoadedSession(loaded: {
	id: string;
	subject?: string;
	title?: string;
	summary?: string;
	resumeSummary?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	favorite: boolean;
	tags?: string[];
}): MaestroAppServerThreadSummary {
	return {
		id: loaded.id,
		source: "session",
		status: "notLoaded",
		title: loaded.title ?? loaded.subject,
		summary: loaded.summary ?? loaded.title ?? loaded.subject,
		resumeSummary: loaded.resumeSummary,
		subject: loaded.subject,
		createdAt: loaded.createdAt,
		updatedAt: loaded.updatedAt,
		messageCount: loaded.messageCount,
		favorite: loaded.favorite,
		tags: loaded.tags,
	};
}

function appMessageContent(message: AppMessage): unknown {
	return "content" in message ? message.content : message;
}

function treeEntryToItem(entry: SessionTreeEntry): MaestroAppServerThreadItem {
	if (entry.type === "message") {
		return {
			id: entry.id,
			type: "message",
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			role: entry.message.role,
			content: appMessageContent(entry.message),
		};
	}
	if (entry.type === "custom_message") {
		return {
			id: entry.id,
			type: entry.customType,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			content: entry.content,
			data: entry.details,
		};
	}
	return {
		id: entry.id,
		type: entry.type,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		data: entry,
	};
}

export function buildTurnsFromSessionEntries(
	entries: SessionEntry[],
): MaestroAppServerTurn[] {
	migrateToCurrentVersion(entries);
	const turns: MaestroAppServerTurn[] = [];
	let current: MaestroAppServerTurn | null = null;

	for (const entry of activeTreeEntriesFromSessionEntries(entries)) {
		const item = treeEntryToItem(entry);
		const startsUserTurn =
			entry.type === "message" && entry.message.role === "user";
		if (startsUserTurn && current?.items.length) {
			turns.push(current);
			current = null;
		}
		if (!current) {
			current = {
				id: startsUserTurn ? entry.id : `turn-${entry.id}`,
				status: "completed",
				startedAt: entry.timestamp,
				completedAt: entry.timestamp,
				items: [],
			};
		}
		current.items.push(item);
		current.completedAt = entry.timestamp;
	}

	if (current?.items.length) {
		turns.push(current);
	}

	return turns;
}

function activeTreeEntriesFromSessionEntries(
	entries: SessionEntry[],
): SessionTreeEntry[] {
	const treeEntries = entries.filter(isSessionTreeEntry);
	const leaf = treeEntries.at(-1);
	if (!leaf) {
		return [];
	}

	const entriesById = new Map(treeEntries.map((entry) => [entry.id, entry]));
	const activePath: SessionTreeEntry[] = [];
	const seen = new Set<string>();
	let current: SessionTreeEntry | undefined = leaf;

	while (current && !seen.has(current.id)) {
		activePath.unshift(current);
		seen.add(current.id);
		if (!current.parentId || current.parentId === current.id) {
			break;
		}
		current = entriesById.get(current.parentId);
	}

	let compactionIndex = -1;
	for (let index = activePath.length - 1; index >= 0; index -= 1) {
		if (activePath[index]?.type === "compaction") {
			compactionIndex = index;
			break;
		}
	}
	if (compactionIndex === -1) {
		return activePath;
	}
	const compaction = activePath[compactionIndex]!;
	if (compaction.type !== "compaction") {
		return activePath;
	}
	const firstKeptIndex = activePath.findIndex(
		(entry, index) =>
			index < compactionIndex && entry.id === compaction.firstKeptEntryId,
	);
	return activePath.slice(
		firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex,
	);
}

function parseMessagesView(value: unknown): SessionMessagesView {
	if (value === undefined || value === null) {
		return "notLoaded";
	}
	if (value === "full" || value === "summary" || value === "notLoaded") {
		return value;
	}
	throw new MaestroAppServerError(-32602, "Invalid messagesView");
}

export function createMaestroAppServerSessionApi(
	store: SessionStore,
): MaestroAppServerSessionApi {
	return {
		initialize() {
			return {
				protocolVersion: maestroAppServerProtocolVersion,
				serverInfo: {
					name: "maestro",
				},
				capabilities: {
					sessions: true,
					threadList: true,
					threadRead: true,
					turnsList: true,
				},
			};
		},

		async listThreads(params = {}) {
			const limit = normalizeLimit(params.limit);
			const offset = decodeCursor(params.cursor);
			const metadata = store.loadAllSessions();
			if (metadata.length === 0) {
				const summaries = await store.listSessions({
					limit: limit + 1,
					offset,
				});
				const page = summaries.slice(0, limit);
				return {
					threads: page.map(toThreadSummaryFromSessionSummary),
					nextCursor:
						summaries.length > limit ? encodeCursor(offset + limit) : null,
				};
			}
			const page = metadata.slice(offset, offset + limit);
			const nextOffset = offset + page.length;
			return {
				threads: page.map((session) => toThreadSummary(session)),
				nextCursor:
					nextOffset < metadata.length ? encodeCursor(nextOffset) : null,
			};
		},

		async readThread(params = {}) {
			const threadId = requireThreadId(params);
			const includeTurns = params.includeTurns === true;
			const messagesView = parseMessagesView(params.messagesView);
			const loaded = await store.loadSession(threadId, { messagesView });
			if (!loaded) {
				throw new MaestroAppServerError(-32004, "Thread not found");
			}
			const thread: MaestroAppServerThread = {
				...toThreadSummaryFromLoadedSession(loaded),
				messagesView: loaded.messagesView,
			};
			const sessionFile = store.getSessionFileById(threadId);
			if (sessionFile && !sessionFile.startsWith("db:")) {
				thread.path = sessionFile;
			}
			if (includeTurns) {
				thread.turns = await loadTurnsForThread(store, threadId);
			}
			return thread;
		},

		async listTurns(params = {}) {
			const threadId = requireThreadId(params);
			const limit = normalizeLimit(params.limit);
			const offset = decodeCursor(params.cursor);
			const turns = await loadTurnsForThread(store, threadId);
			const page = turns.slice(offset, offset + limit);
			const nextOffset = offset + page.length;
			return {
				threadId,
				turns: page,
				nextCursor: nextOffset < turns.length ? encodeCursor(nextOffset) : null,
			};
		},
	};
}

async function loadTurnsForThread(
	store: SessionStore,
	threadId: string,
): Promise<MaestroAppServerTurn[]> {
	if (store.loadEntries) {
		const entries = await store.loadEntries(threadId);
		if (entries) {
			return buildTurnsFromSessionEntries(entries);
		}
	}
	const sessionFile = store.getSessionFileById(threadId);
	if (!sessionFile || sessionFile.startsWith("db:")) {
		throw new MaestroAppServerError(-32004, "Thread not found");
	}
	return buildTurnsFromSessionEntries(safeReadSessionEntries(sessionFile));
}

function isSupportedMethod(
	method: string,
): method is (typeof maestroAppServerClientMethods)[number] {
	return maestroAppServerClientMethods.includes(
		method as (typeof maestroAppServerClientMethods)[number],
	);
}

export async function handleMaestroAppServerRequest(
	api: MaestroAppServerSessionApi,
	request: MaestroAppServerClientRequest,
): Promise<MaestroAppServerResponse> {
	const id = request.id as JsonRpcId;
	try {
		if (!isSupportedMethod(request.method)) {
			throw new MaestroAppServerError(-32601, "Method not found");
		}

		switch (request.method) {
			case "initialize":
				return {
					jsonrpc: "2.0",
					id,
					result: api.initialize(),
				};
			case "thread/list":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.listThreads(request.params),
				};
			case "thread/read":
				return {
					jsonrpc: "2.0",
					id,
					result: {
						thread: await api.readThread(request.params),
					},
				};
			case "thread/turns/list":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.listTurns(request.params),
				};
			default:
				throw new MaestroAppServerError(-32601, "Method not found");
		}
	} catch (error) {
		if (error instanceof MaestroAppServerError) {
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: error.code,
					message: error.message,
				},
			};
		}
		return {
			jsonrpc: "2.0",
			id,
			error: {
				code: -32603,
				message: error instanceof Error ? error.message : "Internal error",
			},
		};
	}
}
