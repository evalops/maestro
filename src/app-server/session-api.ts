import {
	type MaestroAppServerClientRequest,
	type MaestroAppServerModel,
	type MaestroAppServerModelListResult,
	type MaestroAppServerModelProviderCapabilities,
	type MaestroAppServerModelProviderCapabilitiesReadResult,
	type MaestroAppServerResponse,
	type MaestroAppServerThread,
	type MaestroAppServerThreadGoal,
	type MaestroAppServerThreadGoalResult,
	type MaestroAppServerThreadGraph,
	type MaestroAppServerThreadItem,
	type MaestroAppServerThreadListResult,
	type MaestroAppServerThreadMetadataUpdateResult,
	type MaestroAppServerThreadSummary,
	type MaestroAppServerTurn,
	type MaestroAppServerTurnsListResult,
	maestroAppServerClientMethods,
	maestroAppServerProtocolVersion,
} from "@evalops/contracts";
import type { AppMessage } from "../agent/types.js";
import { getRegisteredModels } from "../models/registry.js";
import type { RegisteredModel } from "../models/registry.js";
import type { SessionManager } from "../session/manager.js";
import { safeReadSessionEntries } from "../session/session-context.js";
import {
	type SessionGraphProjection,
	buildSessionGraphProjection,
} from "../session/session-graph-projection.js";
import type {
	SessionEntry,
	SessionMessagesView,
	SessionMetadata,
	SessionSummary,
	SessionTreeEntry,
} from "../session/types.js";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

type JsonRpcId = string | number;
type MaybePromise<T> = T | Promise<T>;

type SessionStore = Pick<
	SessionManager,
	"getSessionFileById" | "loadAllSessions" | "listSessions" | "loadSession"
> & {
	loadEntries?: (sessionId: string) => Promise<SessionEntry[] | null>;
	flush?: () => Promise<void>;
	saveSessionSummary?: (
		summary: string,
		sessionPath?: string,
	) => MaybePromise<void>;
	saveSessionResumeSummary?: (
		summary: string,
		sessionPath?: string,
	) => MaybePromise<void>;
	setSessionFavorite?: (
		sessionPath: string,
		favorite: boolean,
	) => MaybePromise<void>;
	setSessionTitle?: (sessionPath: string, title: string) => MaybePromise<void>;
	setSessionTags?: (sessionPath: string, tags: string[]) => MaybePromise<void>;
	setSessionAppServerGoal?: (
		sessionPath: string,
		goal: MaestroAppServerThreadGoal | null,
	) => MaybePromise<void>;
};

export interface MaestroAppServerSessionApi {
	initialize(): MaestroAppServerResponse["result"];
	listModels(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerModelListResult>;
	readModelProviderCapabilities(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerModelProviderCapabilitiesReadResult>;
	listThreads(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadListResult>;
	readThread(params?: Record<string, unknown>): Promise<MaestroAppServerThread>;
	updateThreadMetadata(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadMetadataUpdateResult>;
	setThreadName(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadMetadataUpdateResult>;
	getThreadGoal(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadGoalResult>;
	setThreadGoal(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadGoalResult>;
	clearThreadGoal(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadGoalResult>;
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
		summary: summary.summary ?? summary.title ?? summary.subject,
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
	return turnsFromProjection(buildSessionGraphProjection(entries));
}

function turnsFromProjection(
	projection: SessionGraphProjection,
): MaestroAppServerTurn[] {
	return projection.turns.map((turn) => ({
		id: turn.id,
		parentTurnId: turn.parentTurnId,
		status: turn.status,
		startedAt: turn.startedAt,
		completedAt: turn.completedAt,
		sourceEntryIds: turn.sourceEntryIds,
		toolCallIds: turn.toolCallIds,
		items: turn.entries.map(treeEntryToItem),
	}));
}

function graphFromProjection(
	projection: SessionGraphProjection,
): MaestroAppServerThreadGraph {
	return {
		branchId: projection.branchId,
		leafEntryId: projection.leafEntryId,
		activeEntryIds: projection.activeEntryIds,
		compactionSpans: projection.compactionSpans,
	};
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

function optionalTrimmedString(
	value: unknown,
	field: string,
): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new MaestroAppServerError(-32602, `Invalid ${field}`);
	}
	return value.trim() || undefined;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new MaestroAppServerError(-32602, `Invalid ${field}`);
	}
	return value;
}

function optionalStringArray(
	value: unknown,
	field: string,
): string[] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string")
	) {
		throw new MaestroAppServerError(-32602, `Invalid ${field}`);
	}
	return Array.from(
		new Set(value.map((entry) => entry.trim()).filter(Boolean)),
	);
}

function requireThreadReference(store: SessionStore, threadId: string): string {
	const sessionFile = store.getSessionFileById(threadId);
	if (!sessionFile) {
		throw new MaestroAppServerError(-32004, "Thread not found");
	}
	return sessionFile;
}

async function requireExistingThreadReference(
	store: SessionStore,
	threadId: string,
): Promise<string> {
	const sessionFile = requireThreadReference(store, threadId);
	const loaded = await store.loadSession(threadId, {
		messagesView: "notLoaded",
	});
	if (!loaded) {
		throw new MaestroAppServerError(-32004, "Thread not found");
	}
	return sessionFile;
}

async function flushSessionWrites(store: SessionStore): Promise<void> {
	await store.flush?.();
}

interface ThreadMetadataExpectation {
	title?: string;
	summary?: string;
	resumeSummary?: string;
	favorite?: boolean;
	tags?: string[];
}

async function summarizeThreadAfterMutation(
	store: SessionStore,
	threadId: string,
): Promise<MaestroAppServerThreadSummary> {
	await flushSessionWrites(store);
	const loaded = await store.loadSession(threadId, {
		messagesView: "notLoaded",
	});
	if (!loaded) {
		throw new MaestroAppServerError(-32004, "Thread not found");
	}
	const summary = toThreadSummaryFromLoadedSession(loaded);
	const sessionFile = store.getSessionFileById(threadId);
	if (sessionFile && !sessionFile.startsWith("db:")) {
		summary.path = sessionFile;
	}
	return summary;
}

function tagsEqual(left: string[] | undefined, right: string[] | undefined) {
	if (left === undefined || right === undefined) {
		return left === right;
	}
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function verifyThreadMetadataPersisted(
	thread: MaestroAppServerThreadSummary,
	expected: ThreadMetadataExpectation,
): void {
	const persisted =
		(expected.title === undefined || thread.title === expected.title) &&
		(expected.summary === undefined || thread.summary === expected.summary) &&
		(expected.resumeSummary === undefined ||
			thread.resumeSummary === expected.resumeSummary) &&
		(expected.favorite === undefined ||
			thread.favorite === expected.favorite) &&
		(expected.tags === undefined || tagsEqual(thread.tags, expected.tags));
	if (!persisted) {
		throw new MaestroAppServerError(
			-32000,
			"Thread metadata update was not persisted",
		);
	}
}

function latestGoalFromEntries(
	entries: SessionEntry[],
): MaestroAppServerThreadGoal | null {
	let goal: MaestroAppServerThreadGoal | null = null;
	for (const entry of entries) {
		if (entry.type !== "session_meta" || entry.appServerGoal === undefined) {
			continue;
		}
		goal = entry.appServerGoal;
	}
	return goal;
}

function goalsEqual(
	actual: MaestroAppServerThreadGoal | null,
	expected: MaestroAppServerThreadGoal | null,
): boolean {
	if (actual === null || expected === null) {
		return actual === expected;
	}
	return (
		actual.objective === expected.objective &&
		actual.status === expected.status &&
		actual.tokenBudget === expected.tokenBudget &&
		actual.createdAt === expected.createdAt &&
		actual.updatedAt === expected.updatedAt
	);
}

async function verifyThreadGoalPersisted(
	store: SessionStore,
	threadId: string,
	expected: MaestroAppServerThreadGoal | null,
): Promise<MaestroAppServerThreadGoal | null> {
	const persisted = await loadThreadGoal(store, threadId);
	if (!goalsEqual(persisted, expected)) {
		throw new MaestroAppServerError(
			-32000,
			"Thread goal update was not persisted",
		);
	}
	return persisted;
}

function normalizeGoalStatus(
	value: unknown,
): MaestroAppServerThreadGoal["status"] {
	if (value === undefined || value === null) {
		return "active";
	}
	if (value === "active" || value === "complete" || value === "cancelled") {
		return value;
	}
	throw new MaestroAppServerError(-32602, "Invalid status");
}

function normalizeTokenBudget(value: unknown): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value <= 0 ||
		!Number.isInteger(value)
	) {
		throw new MaestroAppServerError(-32602, "Invalid tokenBudget");
	}
	return value;
}

function modelToAppServerModel(model: RegisteredModel): MaestroAppServerModel {
	const responsesApi =
		model.api === "openai-responses" || model.api === "openai-codex-responses";
	const codexBackend = model.api === "openai-codex-responses";
	return {
		id: model.id,
		provider: model.provider,
		name: model.name || model.id,
		api: model.api,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: model.cost,
		source: model.source,
		supportedReasoningEfforts: model.reasoning
			? ["minimal", "low", "medium", "high", "ultra"]
			: undefined,
		defaultReasoningEffort: model.reasoning ? "medium" : undefined,
		capabilities: {
			streaming: true,
			tools: model.toolUse === true,
			vision: model.input?.includes("image") || false,
			reasoning: model.reasoning || false,
			responsesApi,
			codexBackend,
			local: model.isLocal,
		},
	};
}

function mergeProviderCapabilities(
	current: MaestroAppServerModelProviderCapabilities | undefined,
	model: MaestroAppServerModel,
	providerName: string,
): MaestroAppServerModelProviderCapabilities {
	const capabilities = current?.capabilities ?? {
		streaming: false,
		tools: false,
		vision: false,
		reasoning: false,
		responsesApi: false,
		codexBackend: false,
		local: false,
	};
	const apis = new Set(current?.apis ?? []);
	apis.add(model.api);
	return {
		id: model.provider,
		name: current?.name ?? providerName,
		apis: Array.from(apis).sort(),
		modelCount: (current?.modelCount ?? 0) + 1,
		capabilities: {
			streaming: capabilities.streaming || model.capabilities.streaming,
			tools: capabilities.tools || model.capabilities.tools,
			vision: capabilities.vision || model.capabilities.vision,
			reasoning: capabilities.reasoning || model.capabilities.reasoning,
			responsesApi:
				capabilities.responsesApi || model.capabilities.responsesApi,
			codexBackend:
				capabilities.codexBackend || model.capabilities.codexBackend,
			local: capabilities.local || model.capabilities.local,
		},
	};
}

export function createMaestroAppServerSessionApi(
	store: SessionStore,
): MaestroAppServerSessionApi {
	const canUpdateThreadMetadata = Boolean(
		store.setSessionTitle &&
			store.saveSessionSummary &&
			store.saveSessionResumeSummary &&
			store.setSessionFavorite &&
			store.setSessionTags,
	);
	const canSetThreadName = Boolean(store.setSessionTitle);
	const canUseThreadGoals = Boolean(
		store.setSessionAppServerGoal && store.loadEntries,
	);

	return {
		initialize() {
			return {
				protocolVersion: maestroAppServerProtocolVersion,
				serverInfo: {
					name: "maestro",
				},
				capabilities: {
					sessions: true,
					modelList: true,
					modelProviderCapabilities: true,
					threadList: true,
					threadRead: true,
					threadMetadataUpdate: canUpdateThreadMetadata,
					threadNameSet: canSetThreadName,
					threadGoals: canUseThreadGoals,
					turnsList: true,
				},
			};
		},

		async listModels(params = {}) {
			const provider = optionalTrimmedString(params.provider, "provider");
			const api = optionalTrimmedString(params.api, "api");
			const models = getRegisteredModels()
				.filter((model) => !provider || model.provider === provider)
				.filter((model) => !api || model.api === api)
				.map(modelToAppServerModel)
				.sort((left, right) =>
					`${left.provider}/${left.id}`.localeCompare(
						`${right.provider}/${right.id}`,
					),
				);
			return { models };
		},

		async readModelProviderCapabilities(params = {}) {
			const provider = optionalTrimmedString(params.provider, "provider");
			const providers = new Map<
				string,
				MaestroAppServerModelProviderCapabilities
			>();
			for (const model of getRegisteredModels()) {
				if (provider && model.provider !== provider) {
					continue;
				}
				const appServerModel = modelToAppServerModel(model);
				providers.set(
					model.provider,
					mergeProviderCapabilities(
						providers.get(model.provider),
						appServerModel,
						model.providerName || model.provider,
					),
				);
			}
			return {
				providers: Array.from(providers.values()).sort((left, right) =>
					left.id.localeCompare(right.id),
				),
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
				const projection = await loadProjectionForThread(store, threadId);
				thread.turns = turnsFromProjection(projection);
				thread.graph = graphFromProjection(projection);
			}
			return thread;
		},

		async updateThreadMetadata(params = {}) {
			const threadId = requireThreadId(params);
			const title = optionalTrimmedString(params.title, "title");
			const summary = optionalTrimmedString(params.summary, "summary");
			const resumeSummary = optionalTrimmedString(
				params.resumeSummary,
				"resumeSummary",
			);
			const favorite = optionalBoolean(params.favorite, "favorite");
			const tags = optionalStringArray(params.tags, "tags");
			const sessionFile = await requireExistingThreadReference(store, threadId);

			if (title !== undefined) {
				if (!store.setSessionTitle) {
					throw new MaestroAppServerError(
						-32601,
						"Thread title updates are not available",
					);
				}
				await store.setSessionTitle(sessionFile, title);
			}
			if (summary !== undefined) {
				if (!store.saveSessionSummary) {
					throw new MaestroAppServerError(
						-32601,
						"Thread summary updates are not available",
					);
				}
				await store.saveSessionSummary(summary, sessionFile);
			}
			if (resumeSummary !== undefined) {
				if (!store.saveSessionResumeSummary) {
					throw new MaestroAppServerError(
						-32601,
						"Thread resume summary updates are not available",
					);
				}
				await store.saveSessionResumeSummary(resumeSummary, sessionFile);
			}
			if (favorite !== undefined) {
				if (!store.setSessionFavorite) {
					throw new MaestroAppServerError(
						-32601,
						"Thread favorite updates are not available",
					);
				}
				await store.setSessionFavorite(sessionFile, favorite);
			}
			if (tags !== undefined) {
				if (!store.setSessionTags) {
					throw new MaestroAppServerError(
						-32601,
						"Thread tag updates are not available",
					);
				}
				await store.setSessionTags(sessionFile, tags);
			}
			const thread = await summarizeThreadAfterMutation(store, threadId);
			verifyThreadMetadataPersisted(thread, {
				title,
				summary,
				resumeSummary,
				favorite,
				tags,
			});
			return { thread };
		},

		async setThreadName(params = {}) {
			const threadId = requireThreadId(params);
			const name = optionalTrimmedString(params.name, "name");
			if (!name) {
				throw new MaestroAppServerError(-32602, "Missing name");
			}
			const sessionFile = await requireExistingThreadReference(store, threadId);
			if (!store.setSessionTitle) {
				throw new MaestroAppServerError(
					-32601,
					"Thread name updates are not available",
				);
			}
			await store.setSessionTitle(sessionFile, name);
			const thread = await summarizeThreadAfterMutation(store, threadId);
			verifyThreadMetadataPersisted(thread, { title: name });
			return { thread };
		},

		async getThreadGoal(params = {}) {
			const threadId = requireThreadId(params);
			return {
				threadId,
				goal: await loadThreadGoal(store, threadId),
			};
		},

		async setThreadGoal(params = {}) {
			const threadId = requireThreadId(params);
			const sessionFile = await requireExistingThreadReference(store, threadId);
			const objective = optionalTrimmedString(params.objective, "objective");
			if (!objective) {
				throw new MaestroAppServerError(-32602, "Missing objective");
			}
			const existing = await loadThreadGoal(store, threadId);
			const now = new Date().toISOString();
			const goal: MaestroAppServerThreadGoal = {
				objective,
				status: normalizeGoalStatus(params.status),
				tokenBudget: normalizeTokenBudget(params.tokenBudget),
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			if (!store.setSessionAppServerGoal) {
				throw new MaestroAppServerError(
					-32601,
					"Thread goal updates are not available",
				);
			}
			await store.setSessionAppServerGoal(sessionFile, goal);
			await flushSessionWrites(store);
			return {
				threadId,
				goal: await verifyThreadGoalPersisted(store, threadId, goal),
			};
		},

		async clearThreadGoal(params = {}) {
			const threadId = requireThreadId(params);
			const sessionFile = await requireExistingThreadReference(store, threadId);
			if (!store.setSessionAppServerGoal) {
				throw new MaestroAppServerError(
					-32601,
					"Thread goal updates are not available",
				);
			}
			await store.setSessionAppServerGoal(sessionFile, null);
			await flushSessionWrites(store);
			await verifyThreadGoalPersisted(store, threadId, null);
			return { threadId, goal: null };
		},

		async listTurns(params = {}) {
			const threadId = requireThreadId(params);
			const limit = normalizeLimit(params.limit);
			const offset = decodeCursor(params.cursor);
			const projection = await loadProjectionForThread(store, threadId);
			const turns = turnsFromProjection(projection);
			const page = turns.slice(offset, offset + limit);
			const nextOffset = offset + page.length;
			return {
				threadId,
				turns: page,
				nextCursor: nextOffset < turns.length ? encodeCursor(nextOffset) : null,
				graph: graphFromProjection(projection),
			};
		},
	};
}

async function loadProjectionForThread(
	store: SessionStore,
	threadId: string,
): Promise<SessionGraphProjection> {
	if (store.loadEntries) {
		const entries = await store.loadEntries(threadId);
		if (entries) {
			return buildSessionGraphProjection(entries);
		}
	}
	const sessionFile = store.getSessionFileById(threadId);
	if (!sessionFile || sessionFile.startsWith("db:")) {
		throw new MaestroAppServerError(-32004, "Thread not found");
	}
	return buildSessionGraphProjection(safeReadSessionEntries(sessionFile));
}

async function loadThreadGoal(
	store: SessionStore,
	threadId: string,
): Promise<MaestroAppServerThreadGoal | null> {
	if (store.loadEntries) {
		const entries = await store.loadEntries(threadId);
		if (entries) {
			return latestGoalFromEntries(entries);
		}
	}
	const sessionFile = store.getSessionFileById(threadId);
	if (!sessionFile) {
		throw new MaestroAppServerError(-32004, "Thread not found");
	}
	if (sessionFile.startsWith("db:")) {
		const loaded = await store.loadSession(threadId, {
			messagesView: "notLoaded",
		});
		if (!loaded) {
			throw new MaestroAppServerError(-32004, "Thread not found");
		}
		return null;
	}
	return latestGoalFromEntries(safeReadSessionEntries(sessionFile));
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
			case "model/list":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.listModels(request.params),
				};
			case "modelProvider/capabilities/read":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.readModelProviderCapabilities(request.params),
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
			case "thread/metadata/update":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.updateThreadMetadata(request.params),
				};
			case "thread/name/set":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.setThreadName(request.params),
				};
			case "thread/goal/get":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.getThreadGoal(request.params),
				};
			case "thread/goal/set":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.setThreadGoal(request.params),
				};
			case "thread/goal/clear":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.clearThreadGoal(request.params),
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
