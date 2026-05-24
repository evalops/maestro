import { resolve } from "node:path";
import {
	type MaestroAppServerClientRequest,
	type MaestroAppServerCommandExecResult,
	type MaestroAppServerCommandProcessResult,
	type MaestroAppServerDaemonStatusResult,
	type MaestroAppServerEmptyResult,
	type MaestroAppServerExternalAgentImportResult,
	type MaestroAppServerFsMetadataResult,
	type MaestroAppServerFsReadDirectoryResult,
	type MaestroAppServerFsReadFileResult,
	type MaestroAppServerFsWatchResult,
	type MaestroAppServerModel,
	type MaestroAppServerModelListResult,
	type MaestroAppServerModelProviderCapabilities,
	type MaestroAppServerModelProviderCapabilitiesReadResult,
	type MaestroAppServerNetworkAuditListResult,
	type MaestroAppServerNetworkFetchResult,
	type MaestroAppServerPluginBundleListResult,
	type MaestroAppServerPluginBundleMutationResult,
	type MaestroAppServerPolicyCheckResult,
	type MaestroAppServerPolicyReadResult,
	type MaestroAppServerRemoteControlDrainResult,
	type MaestroAppServerRemoteControlLeaseResult,
	type MaestroAppServerRemoteControlStatusResult,
	type MaestroAppServerRequirementsListResult,
	type MaestroAppServerResponse,
	type MaestroAppServerSandboxProbeResult,
	type MaestroAppServerSandboxProofResult,
	type MaestroAppServerServerNotification,
	type MaestroAppServerThread,
	type MaestroAppServerThreadArchiveResult,
	type MaestroAppServerThreadDeleteResult,
	type MaestroAppServerThreadForkResult,
	type MaestroAppServerThreadGoal,
	type MaestroAppServerThreadGoalResult,
	type MaestroAppServerThreadGraph,
	type MaestroAppServerThreadItem,
	type MaestroAppServerThreadListResult,
	type MaestroAppServerThreadMetadataUpdateResult,
	type MaestroAppServerThreadStartResult,
	type MaestroAppServerThreadSummary,
	type MaestroAppServerTurn,
	type MaestroAppServerTurnsListResult,
	maestroAppServerClientMethods,
	maestroAppServerProtocolVersion,
	maestroAppServerSupportedProtocolVersions,
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
import {
	type MaestroAppServerDaemonLifecycle,
	MaestroAppServerDaemonLifecycleError,
	createMaestroAppServerDaemonLifecycle,
} from "./daemon-lifecycle-api.js";
import {
	type MaestroAppServerExternalAgentImport,
	MaestroAppServerExternalAgentImportError,
	createMaestroAppServerExternalAgentImport,
	normalizeExternalAgentImportParams,
} from "./external-agent-import-api.js";
import {
	type MaestroAppServerHostControl,
	MaestroAppServerHostControlError,
	createMaestroAppServerHostControl,
} from "./host-control-api.js";
import {
	type MaestroAppServerNetworkGovernance,
	MaestroAppServerNetworkGovernanceError,
	createMaestroAppServerNetworkGovernance,
} from "./network-governance-api.js";
import {
	type MaestroAppServerPluginBundleApi,
	MaestroAppServerPluginBundleError,
	createMaestroAppServerPluginBundleApi,
} from "./plugin-bundle-api.js";
import {
	type MaestroAppServerPolicyControl,
	MaestroAppServerPolicyControlError,
	createMaestroAppServerPolicyControl,
} from "./policy-control-api.js";
import {
	type MaestroAppServerSandboxProof,
	MaestroAppServerSandboxProofError,
	createMaestroAppServerSandboxProof,
	normalizeSandboxProofParams,
} from "./sandbox-proof-api.js";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

export type { MaestroAppServerServerNotification };
export {
	type MaestroAppServerDaemonLifecycle,
	createMaestroAppServerDaemonLifecycle,
} from "./daemon-lifecycle-api.js";
export {
	type MaestroAppServerExternalAgentImport,
	createMaestroAppServerExternalAgentImport,
} from "./external-agent-import-api.js";
export {
	type MaestroAppServerPluginBundleApi,
	createMaestroAppServerPluginBundleApi,
} from "./plugin-bundle-api.js";
export {
	type MaestroAppServerSandboxProof,
	createMaestroAppServerSandboxProof,
} from "./sandbox-proof-api.js";

type JsonRpcId = string | number;
type MaybePromise<T> = T | Promise<T>;

type SessionStore = Pick<
	SessionManager,
	"getSessionFileById" | "loadAllSessions" | "listSessions" | "loadSession"
> & {
	getSessionFile?: () => string;
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
	setSessionArchived?: (
		sessionPath: string,
		archived: boolean,
	) => MaybePromise<void>;
	setSessionAppServerGoal?: (
		sessionPath: string,
		goal: MaestroAppServerThreadGoal | null,
	) => MaybePromise<void>;
	createSession?: (options?: { title?: string }) => Promise<{
		id: string;
		title?: string;
		createdAt: string;
		updatedAt: string;
		messageCount: number;
	}>;
	canCreateSession?: () => boolean;
	createBranchedSession?: (leafId: string) => string;
	setSessionFile?: (path: string) => MaybePromise<void>;
	resumeSession?: (sessionId: string) => Promise<boolean>;
	getLeafId?: () => string | null;
	getCurrentLeafId?: () => string | null;
	branch?: (branchFromId: string) => MaybePromise<void>;
	resetLeaf?: () => MaybePromise<void>;
	deleteSession?: (sessionId: string) => MaybePromise<void>;
	importSessionEntries?: (entries: SessionEntry[]) => {
		sessionFile: string;
		sessionId: string;
		importedCount: number;
	};
	importPortableSession?: (path: string) => {
		sessionFile: string;
		sessionId: string;
		importedCount: number;
	};
};

export interface MaestroAppServerSessionApiOptions {
	hostControl?: MaestroAppServerHostControl | false;
	policyControl?: MaestroAppServerPolicyControl | false;
	networkGovernance?: MaestroAppServerNetworkGovernance | false;
	sandboxProof?: MaestroAppServerSandboxProof | false;
	externalAgentImport?: MaestroAppServerExternalAgentImport | false;
	pluginBundles?: MaestroAppServerPluginBundleApi | false;
	daemonLifecycle?: MaestroAppServerDaemonLifecycle | false;
	onNotification?: (notification: MaestroAppServerServerNotification) => void;
}

export interface MaestroAppServerSessionApi {
	initialize(): MaestroAppServerResponse["result"];
	listModels(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerModelListResult>;
	readModelProviderCapabilities(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerModelProviderCapabilitiesReadResult>;
	readPolicy(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerPolicyReadResult>;
	checkPolicy(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerPolicyCheckResult>;
	listRequirements(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerRequirementsListResult>;
	fetchNetwork(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerNetworkFetchResult>;
	listNetworkAudit(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerNetworkAuditListResult>;
	probeSandbox(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerSandboxProbeResult>;
	runSandboxProof(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerSandboxProofResult>;
	importExternalAgent(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerExternalAgentImportResult>;
	listPluginBundles(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerPluginBundleListResult>;
	installPluginBundle(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerPluginBundleMutationResult>;
	removePluginBundle(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerPluginBundleMutationResult>;
	readDaemonStatus(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerDaemonStatusResult>;
	readRemoteControlStatus(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerRemoteControlStatusResult>;
	readRemoteControlLease(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerRemoteControlLeaseResult>;
	heartbeatRemoteControlLease(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerRemoteControlLeaseResult>;
	drainRemoteControl(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerRemoteControlDrainResult>;
	execCommand(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerCommandExecResult>;
	writeCommandStdin(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerCommandProcessResult>;
	terminateCommand(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerCommandProcessResult>;
	readFile(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerFsReadFileResult>;
	writeFile(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerEmptyResult>;
	readDirectory(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerFsReadDirectoryResult>;
	getMetadata(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerFsMetadataResult>;
	createDirectory(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerEmptyResult>;
	remove(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerEmptyResult>;
	copy(params?: Record<string, unknown>): Promise<MaestroAppServerEmptyResult>;
	watch(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerFsWatchResult>;
	unwatch(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerEmptyResult>;
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
	startThread(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadStartResult>;
	forkThread(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadForkResult>;
	archiveThread(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadArchiveResult>;
	unarchiveThread(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadArchiveResult>;
	deleteThread(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerThreadDeleteResult>;
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
	const archived = summary?.archived ?? metadata.archived ?? false;
	const archivedAt = archived
		? (summary?.archivedAt ?? metadata.archivedAt)
		: undefined;
	const thread: MaestroAppServerThreadSummary = {
		id: metadata.id,
		source: "session",
		status: archived ? "archived" : "notLoaded",
		title: summary?.title ?? metadata.title ?? metadata.summary,
		summary: metadata.summary,
		resumeSummary: summary?.resumeSummary ?? metadata.resumeSummary,
		memoryExtractionHash:
			summary?.memoryExtractionHash ?? metadata.memoryExtractionHash,
		subject: metadata.subject,
		path: metadata.path,
		createdAt: metadata.created.toISOString(),
		updatedAt: metadata.modified.toISOString(),
		messageCount: metadata.messageCount,
		favorite: summary?.favorite ?? metadata.favorite,
		tags: summary?.tags ?? metadata.tags,
		archived,
	};
	if (archivedAt) {
		thread.archivedAt = archivedAt;
	}
	return thread;
}

function toThreadSummaryFromSessionSummary(
	summary: SessionSummary,
): MaestroAppServerThreadSummary {
	const archived = summary.archived ?? false;
	const thread: MaestroAppServerThreadSummary = {
		id: summary.id,
		source: "session",
		status: archived ? "archived" : "notLoaded",
		title: summary.title ?? summary.subject,
		summary: summary.summary ?? summary.title ?? summary.subject,
		resumeSummary: summary.resumeSummary,
		memoryExtractionHash: summary.memoryExtractionHash,
		subject: summary.subject,
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt,
		messageCount: summary.messageCount,
		favorite: summary.favorite,
		tags: summary.tags,
		archived,
	};
	if (archived && summary.archivedAt) {
		thread.archivedAt = summary.archivedAt;
	}
	return thread;
}

function toThreadSummaryFromLoadedSession(loaded: {
	id: string;
	subject?: string;
	title?: string;
	summary?: string;
	resumeSummary?: string;
	memoryExtractionHash?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	favorite: boolean;
	tags?: string[];
	archived?: boolean;
	archivedAt?: string;
}): MaestroAppServerThreadSummary {
	const archived = loaded.archived ?? false;
	const thread: MaestroAppServerThreadSummary = {
		id: loaded.id,
		source: "session",
		status: archived ? "archived" : "notLoaded",
		title: loaded.title ?? loaded.subject,
		summary: loaded.summary ?? loaded.title ?? loaded.subject,
		resumeSummary: loaded.resumeSummary,
		memoryExtractionHash: loaded.memoryExtractionHash,
		subject: loaded.subject,
		createdAt: loaded.createdAt,
		updatedAt: loaded.updatedAt,
		messageCount: loaded.messageCount,
		favorite: loaded.favorite,
		tags: loaded.tags,
		archived,
	};
	if (archived && loaded.archivedAt) {
		thread.archivedAt = loaded.archivedAt;
	}
	return thread;
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

async function restoreSessionBinding(
	store: SessionStore,
	sessionReference: string | undefined,
	leafId?: string | null,
): Promise<void> {
	if (!sessionReference) {
		return;
	}
	const dbSessionId = sessionReference.startsWith("db:")
		? sessionReference.slice("db:".length)
		: undefined;
	let restored = false;
	if (dbSessionId && store.resumeSession) {
		restored = await store.resumeSession(dbSessionId);
	}
	if (!restored) {
		await store.setSessionFile?.(sessionReference);
	}
	if (leafId === null) {
		await store.resetLeaf?.();
	} else if (leafId && store.branch) {
		await store.branch(leafId);
	}
}

function getCurrentLeafId(store: SessionStore): string | null {
	return store.getLeafId?.() ?? store.getCurrentLeafId?.() ?? null;
}

function isActiveThreadSessionFile(
	store: SessionStore,
	sessionFile: string,
): boolean {
	const activeSessionFile = store.getSessionFile?.();
	if (!activeSessionFile) {
		return false;
	}
	return resolve(activeSessionFile) === resolve(sessionFile);
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
	const codexBackend =
		model.api === "openai-codex-responses" ||
		model.api === "openai-codex-app-server";
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
	options: MaestroAppServerSessionApiOptions = {},
): MaestroAppServerSessionApi {
	const hostControl =
		options.hostControl === false
			? undefined
			: (options.hostControl ??
				createMaestroAppServerHostControl({
					onNotification: options.onNotification,
				}));
	const policyControl =
		options.policyControl === false
			? undefined
			: (options.policyControl ?? createMaestroAppServerPolicyControl());
	const networkGovernance =
		options.networkGovernance === false
			? undefined
			: (options.networkGovernance ??
				createMaestroAppServerNetworkGovernance());
	const sandboxProof =
		options.sandboxProof === false
			? undefined
			: (options.sandboxProof ?? createMaestroAppServerSandboxProof());
	const pluginBundles =
		options.pluginBundles === false
			? undefined
			: (options.pluginBundles ?? createMaestroAppServerPluginBundleApi());
	const daemonLifecycle =
		options.daemonLifecycle === false
			? undefined
			: (options.daemonLifecycle ?? createMaestroAppServerDaemonLifecycle());
	const daemonLifecycleCapabilities = daemonLifecycle?.capabilities() ?? {
		daemonStatus: false,
		remoteControlStatus: false,
		remoteControlLease: false,
		remoteControlDrain: false,
	};
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
	const canMutateSessionPersistence = store.canCreateSession?.() ?? true;
	const externalAgentImport =
		options.externalAgentImport === false || !canMutateSessionPersistence
			? undefined
			: (options.externalAgentImport ??
				createMaestroAppServerExternalAgentImport({ store }));
	const canStartThreads = Boolean(
		store.createSession && canMutateSessionPersistence,
	);
	const canForkThreads = Boolean(
		canMutateSessionPersistence &&
			store.createBranchedSession &&
			store.setSessionFile,
	);
	const canArchiveThreads = Boolean(
		canMutateSessionPersistence && store.setSessionArchived,
	);
	const canDeleteThreads = Boolean(
		canMutateSessionPersistence && store.deleteSession,
	);
	const canUseHostControl = Boolean(hostControl);
	const canUseFilesystemWatch = Boolean(hostControl?.supportsWatch());
	const canUsePolicyControl = Boolean(policyControl);
	const canUseNetworkGovernance = Boolean(networkGovernance);
	const canUseSandboxProof = Boolean(sandboxProof);
	const canUseExternalAgentImport = Boolean(externalAgentImport);
	const canUsePluginBundles = Boolean(pluginBundles);

	return {
		initialize() {
			return {
				protocolVersion: maestroAppServerProtocolVersion,
				supportedProtocolVersions: [
					...maestroAppServerSupportedProtocolVersions,
				],
				serverInfo: {
					name: "maestro",
				},
				capabilities: {
					sessions: true,
					modelList: true,
					modelProviderCapabilities: true,
					managedPolicy: canUsePolicyControl,
					requirements: canUsePolicyControl,
					networkProxy: canUseNetworkGovernance,
					networkAudit: canUseNetworkGovernance,
					sandboxProbe: canUseSandboxProof,
					sandboxProof: canUseSandboxProof,
					externalAgentImport: canUseExternalAgentImport,
					pluginBundles: canUsePluginBundles,
					daemonStatus: daemonLifecycleCapabilities.daemonStatus,
					remoteControlStatus: daemonLifecycleCapabilities.remoteControlStatus,
					remoteControlLease: daemonLifecycleCapabilities.remoteControlLease,
					remoteControlDrain: daemonLifecycleCapabilities.remoteControlDrain,
					commandExec: canUseHostControl,
					commandProcessControl: canUseHostControl,
					filesystem: canUseHostControl,
					filesystemWatch: canUseFilesystemWatch,
					threadList: true,
					threadRead: true,
					threadMetadataUpdate: canUpdateThreadMetadata,
					threadNameSet: canSetThreadName,
					threadGoals: canUseThreadGoals,
					threadStart: canStartThreads,
					threadFork: canForkThreads,
					threadArchive: canArchiveThreads,
					threadDelete: canDeleteThreads,
					turnsList: true,
				},
			};
		},

		async readPolicy() {
			if (!policyControl) {
				throw new MaestroAppServerError(
					-32601,
					"Managed policy is not available",
				);
			}
			return policyControl.readPolicy();
		},

		async checkPolicy(params = {}) {
			if (!policyControl) {
				throw new MaestroAppServerError(
					-32601,
					"Managed policy is not available",
				);
			}
			return policyControl.checkPolicy(params);
		},

		async listRequirements() {
			if (!policyControl) {
				throw new MaestroAppServerError(
					-32601,
					"Requirements are not available",
				);
			}
			return policyControl.listRequirements();
		},

		async fetchNetwork(params = {}) {
			if (!networkGovernance) {
				throw new MaestroAppServerError(
					-32601,
					"Network proxy is not available",
				);
			}
			return networkGovernance.fetch(params);
		},

		async listNetworkAudit(params = {}) {
			if (!networkGovernance) {
				throw new MaestroAppServerError(
					-32601,
					"Network audit is not available",
				);
			}
			return networkGovernance.listAudit(params);
		},

		async probeSandbox(params = {}) {
			if (!sandboxProof) {
				throw new MaestroAppServerError(
					-32601,
					"Sandbox probe is not available",
				);
			}
			normalizeSandboxProofParams(params);
			return sandboxProof.probe();
		},

		async runSandboxProof(params = {}) {
			if (!sandboxProof) {
				throw new MaestroAppServerError(
					-32601,
					"Sandbox proof is not available",
				);
			}
			const normalizedParams = normalizeSandboxProofParams(params);
			return sandboxProof.runProof(normalizedParams);
		},

		async importExternalAgent(params = {}) {
			if (!externalAgentImport) {
				throw new MaestroAppServerError(
					-32601,
					"External agent import is not available",
				);
			}
			const normalizedParams = normalizeExternalAgentImportParams(params);
			return externalAgentImport.importBundle(normalizedParams);
		},

		async listPluginBundles(params = {}) {
			if (!pluginBundles) {
				throw new MaestroAppServerError(
					-32601,
					"Plugin bundle lifecycle is not available",
				);
			}
			return pluginBundles.listBundles(params);
		},

		async installPluginBundle(params = {}) {
			if (!pluginBundles) {
				throw new MaestroAppServerError(
					-32601,
					"Plugin bundle lifecycle is not available",
				);
			}
			return pluginBundles.installBundle(params);
		},

		async removePluginBundle(params = {}) {
			if (!pluginBundles) {
				throw new MaestroAppServerError(
					-32601,
					"Plugin bundle lifecycle is not available",
				);
			}
			return pluginBundles.removeBundle(params);
		},

		async readDaemonStatus(params = {}) {
			if (!daemonLifecycle) {
				throw new MaestroAppServerError(
					-32601,
					"Daemon lifecycle is not available",
				);
			}
			return daemonLifecycle.status(params);
		},

		async readRemoteControlStatus(params = {}) {
			if (!daemonLifecycle) {
				throw new MaestroAppServerError(
					-32601,
					"Remote control lifecycle is not available",
				);
			}
			return daemonLifecycle.remoteControlStatus(params);
		},

		async readRemoteControlLease(params = {}) {
			if (!daemonLifecycle) {
				throw new MaestroAppServerError(
					-32601,
					"Remote control lease is not available",
				);
			}
			return daemonLifecycle.readLease(params);
		},

		async heartbeatRemoteControlLease(params = {}) {
			if (!daemonLifecycle) {
				throw new MaestroAppServerError(
					-32601,
					"Remote control lease is not available",
				);
			}
			return daemonLifecycle.heartbeatLease(params);
		},

		async drainRemoteControl(params = {}) {
			if (!daemonLifecycle) {
				throw new MaestroAppServerError(
					-32601,
					"Remote control drain is not available",
				);
			}
			return daemonLifecycle.drain(params);
		},

		async execCommand(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(
					-32601,
					"Command exec is not available",
				);
			}
			return hostControl.execCommand(params);
		},

		async writeCommandStdin(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(
					-32601,
					"Command process control is not available",
				);
			}
			return hostControl.writeCommandStdin(params);
		},

		async terminateCommand(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(
					-32601,
					"Command process control is not available",
				);
			}
			return hostControl.terminateCommand(params);
		},

		async readFile(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(-32601, "Filesystem is not available");
			}
			return hostControl.readFile(params);
		},

		async writeFile(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(-32601, "Filesystem is not available");
			}
			return hostControl.writeFile(params);
		},

		async readDirectory(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(-32601, "Filesystem is not available");
			}
			return hostControl.readDirectory(params);
		},

		async getMetadata(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(-32601, "Filesystem is not available");
			}
			return hostControl.getMetadata(params);
		},

		async createDirectory(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(-32601, "Filesystem is not available");
			}
			return hostControl.createDirectory(params);
		},

		async remove(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(-32601, "Filesystem is not available");
			}
			return hostControl.remove(params);
		},

		async copy(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(-32601, "Filesystem is not available");
			}
			return hostControl.copy(params);
		},

		async watch(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(
					-32601,
					"Filesystem watch is not available",
				);
			}
			return hostControl.watch(params);
		},

		async unwatch(params = {}) {
			if (!hostControl) {
				throw new MaestroAppServerError(
					-32601,
					"Filesystem watch is not available",
				);
			}
			return hostControl.unwatch(params);
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
			const includeArchived =
				optionalBoolean(params.includeArchived, "includeArchived") ?? false;
			const metadata = store.loadAllSessions();
			if (metadata.length === 0) {
				const page: SessionSummary[] = [];
				let rawOffset = offset;
				let cursorAfterPage = offset;
				let hasMoreVisible = false;
				let exhausted = false;
				while (!hasMoreVisible && !exhausted) {
					const summaries = await store.listSessions({
						limit: limit + 1,
						offset: rawOffset,
					});
					exhausted = summaries.length <= limit;
					for (const summary of summaries) {
						rawOffset += 1;
						if (includeArchived || !summary.archived) {
							if (page.length < limit) {
								page.push(summary);
								cursorAfterPage = rawOffset;
							} else {
								hasMoreVisible = true;
								break;
							}
						}
					}
					if (summaries.length === 0) {
						exhausted = true;
					}
				}
				return {
					threads: page.map(toThreadSummaryFromSessionSummary),
					nextCursor: hasMoreVisible ? encodeCursor(cursorAfterPage) : null,
				};
			}
			const visible = includeArchived
				? metadata
				: metadata.filter((session) => !session.archived);
			const page = visible.slice(offset, offset + limit);
			const nextOffset = offset + page.length;
			return {
				threads: page.map((session) => toThreadSummary(session)),
				nextCursor:
					nextOffset < visible.length ? encodeCursor(nextOffset) : null,
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

		async startThread(params = {}) {
			const createThreadSession = store.createSession;
			if (!canStartThreads || !createThreadSession) {
				throw new MaestroAppServerError(
					-32601,
					"Thread start is not available",
				);
			}
			const title = optionalTrimmedString(params.title, "title");
			const previousSessionFile = store.getSessionFile?.();
			const previousLeafId = getCurrentLeafId(store);
			let created: Awaited<
				ReturnType<NonNullable<SessionStore["createSession"]>>
			>;
			try {
				created = await createThreadSession.call(
					store,
					title ? { title } : undefined,
				);
			} finally {
				await restoreSessionBinding(store, previousSessionFile, previousLeafId);
			}
			await flushSessionWrites(store);
			return {
				thread: await summarizeThreadAfterMutation(store, created.id),
			};
		},

		async forkThread(params = {}) {
			const createBranchedSession = store.createBranchedSession;
			if (!canForkThreads || !createBranchedSession) {
				throw new MaestroAppServerError(-32601, "Thread fork is not available");
			}
			const threadId = requireThreadId(params);
			const leafEntryId = optionalTrimmedString(
				params.leafEntryId,
				"leafEntryId",
			);
			if (!leafEntryId) {
				throw new MaestroAppServerError(-32602, "Missing leafEntryId");
			}
			const title = optionalTrimmedString(params.title, "title");
			const sessionFile = await requireExistingThreadReference(store, threadId);
			const previousSessionFile = store.getSessionFile?.();
			const previousLeafId = getCurrentLeafId(store);
			let forkedThreadId: string | undefined;
			try {
				await store.setSessionFile?.(sessionFile);
				let forkedSessionFile: string;
				try {
					forkedSessionFile = createBranchedSession.call(store, leafEntryId);
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === `Entry ${leafEntryId} not found`
					) {
						throw new MaestroAppServerError(-32602, "Unknown leafEntryId");
					}
					throw error;
				}
				const forkedEntries = safeReadSessionEntries(forkedSessionFile);
				const forkedHeader = forkedEntries.find(
					(entry) => entry.type === "session",
				);
				forkedThreadId =
					forkedHeader && "id" in forkedHeader ? forkedHeader.id : undefined;
				if (!forkedThreadId) {
					throw new MaestroAppServerError(
						-32000,
						"Thread fork did not produce a readable session",
					);
				}
				if (title && store.setSessionTitle) {
					await store.setSessionTitle(forkedSessionFile, title);
				}
			} finally {
				await restoreSessionBinding(store, previousSessionFile, previousLeafId);
			}
			await flushSessionWrites(store);
			return {
				thread: await summarizeThreadAfterMutation(store, forkedThreadId),
				parentThreadId: threadId,
				forkedFromEntryId: leafEntryId,
			};
		},

		async archiveThread(params = {}) {
			const setSessionArchived = store.setSessionArchived;
			if (!canArchiveThreads || !setSessionArchived) {
				throw new MaestroAppServerError(
					-32601,
					"Thread archive is not available",
				);
			}
			const threadId = requireThreadId(params);
			const sessionFile = await requireExistingThreadReference(store, threadId);
			await setSessionArchived.call(store, sessionFile, true);
			const thread = await summarizeThreadAfterMutation(store, threadId);
			if (!thread.archived) {
				throw new MaestroAppServerError(
					-32000,
					"Thread archive update was not persisted",
				);
			}
			return { thread, archived: true };
		},

		async unarchiveThread(params = {}) {
			const setSessionArchived = store.setSessionArchived;
			if (!canArchiveThreads || !setSessionArchived) {
				throw new MaestroAppServerError(
					-32601,
					"Thread archive is not available",
				);
			}
			const threadId = requireThreadId(params);
			const sessionFile = await requireExistingThreadReference(store, threadId);
			await setSessionArchived.call(store, sessionFile, false);
			const thread = await summarizeThreadAfterMutation(store, threadId);
			if (thread.archived) {
				throw new MaestroAppServerError(
					-32000,
					"Thread archive update was not persisted",
				);
			}
			return { thread, archived: false };
		},

		async deleteThread(params = {}) {
			const deleteSession = store.deleteSession;
			if (!canDeleteThreads || !deleteSession) {
				throw new MaestroAppServerError(
					-32601,
					"Thread delete is not available",
				);
			}
			const threadId = requireThreadId(params);
			const sessionFile = await requireExistingThreadReference(store, threadId);
			if (isActiveThreadSessionFile(store, sessionFile)) {
				throw new MaestroAppServerError(
					-32000,
					"Cannot delete the currently active thread",
				);
			}
			await deleteSession.call(store, threadId);
			await flushSessionWrites(store);
			return { threadId, deleted: true };
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
			case "policy/read":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.readPolicy(request.params),
				};
			case "policy/check":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.checkPolicy(request.params),
				};
			case "requirements/list":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.listRequirements(request.params),
				};
			case "network/fetch":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.fetchNetwork(request.params),
				};
			case "network/audit/list":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.listNetworkAudit(request.params),
				};
			case "sandbox/probe":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.probeSandbox(request.params),
				};
			case "sandbox/proof/run":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.runSandboxProof(request.params),
				};
			case "externalAgent/import":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.importExternalAgent(request.params),
				};
			case "pluginBundle/list":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.listPluginBundles(request.params),
				};
			case "pluginBundle/install":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.installPluginBundle(request.params),
				};
			case "pluginBundle/remove":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.removePluginBundle(request.params),
				};
			case "daemon/status":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.readDaemonStatus(request.params),
				};
			case "remoteControl/status":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.readRemoteControlStatus(request.params),
				};
			case "remoteControl/lease/read":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.readRemoteControlLease(request.params),
				};
			case "remoteControl/lease/heartbeat":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.heartbeatRemoteControlLease(request.params),
				};
			case "remoteControl/drain":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.drainRemoteControl(request.params),
				};
			case "command/exec":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.execCommand(request.params),
				};
			case "command/exec/write":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.writeCommandStdin(request.params),
				};
			case "command/exec/terminate":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.terminateCommand(request.params),
				};
			case "fs/readFile":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.readFile(request.params),
				};
			case "fs/writeFile":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.writeFile(request.params),
				};
			case "fs/readDirectory":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.readDirectory(request.params),
				};
			case "fs/getMetadata":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.getMetadata(request.params),
				};
			case "fs/createDirectory":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.createDirectory(request.params),
				};
			case "fs/remove":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.remove(request.params),
				};
			case "fs/copy":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.copy(request.params),
				};
			case "fs/watch":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.watch(request.params),
				};
			case "fs/unwatch":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.unwatch(request.params),
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
			case "thread/start":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.startThread(request.params),
				};
			case "thread/fork":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.forkThread(request.params),
				};
			case "thread/archive":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.archiveThread(request.params),
				};
			case "thread/unarchive":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.unarchiveThread(request.params),
				};
			case "thread/delete":
				return {
					jsonrpc: "2.0",
					id,
					result: await api.deleteThread(request.params),
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
		if (
			error instanceof MaestroAppServerError ||
			error instanceof MaestroAppServerHostControlError ||
			error instanceof MaestroAppServerNetworkGovernanceError ||
			error instanceof MaestroAppServerPolicyControlError ||
			error instanceof MaestroAppServerSandboxProofError ||
			error instanceof MaestroAppServerExternalAgentImportError ||
			error instanceof MaestroAppServerPluginBundleError ||
			error instanceof MaestroAppServerDaemonLifecycleError
		) {
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
