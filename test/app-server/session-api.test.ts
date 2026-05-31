import {
	existsSync,
	mkdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MaestroAppServerResponseSchema,
	maestroAppServerProtocolVersion,
} from "../../packages/contracts/src/maestro-app-server.js";
import type { AgentState } from "../../src/agent/types.js";
import {
	buildTurnsFromSessionEntries,
	createMaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "../../src/app-server/session-api.js";
import { SessionManager } from "../../src/session/manager.js";
import { safeReadSessionEntries } from "../../src/session/session-context.js";
import type { SessionEntry } from "../../src/session/types.js";

function createMockState(): AgentState {
	return {
		steeringMode: "all",
		followUpMode: "all",
		queueMode: "all",
		messages: [],
		systemPrompt: "test system prompt",
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4",
			contextWindow: 200000,
			name: "Claude Sonnet 4",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com/v1/messages",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 0.003,
				output: 0.015,
				cacheRead: 0.0003,
				cacheWrite: 0.00375,
			},
			maxTokens: 8192,
		},
		tools: [],
		thinkingLevel: "off",
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Map(),
	};
}

function createUserMessage(text: string, timestamp = Date.now()) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp,
	};
}

function createAssistantMessage(text: string, timestamp = Date.now()) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-sonnet-4",
		stopReason: "stop" as const,
		timestamp,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("Maestro app-server session API", () => {
	let testDir: string;
	const managers: SessionManager[] = [];

	beforeEach(() => {
		testDir = join(tmpdir(), `maestro-app-server-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		for (const manager of managers) {
			manager.disable();
		}
		managers.length = 0;

		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	function createSessionManager(customSessionPath?: string): SessionManager {
		const manager = new SessionManager(false, customSessionPath, {
			sessionDir: testDir,
		});
		managers.push(manager);
		return manager;
	}

	async function createPersistedSession(
		prompt: string,
		options: {
			title?: string;
			summary?: string;
			modifiedAt?: Date;
			resumeSummary?: string;
			memoryExtractionHash?: string;
			tags?: string[];
			secondPrompt?: string;
		} = {},
	) {
		const manager = createSessionManager();

		const state = createMockState();
		const firstUser = createUserMessage(prompt, 1);
		state.messages.push(firstUser);
		manager.saveMessage(firstUser);
		manager.startSession(state);
		manager.saveMessage(createAssistantMessage(`${prompt} ack`, 2));
		if (options.secondPrompt) {
			manager.saveMessage(createUserMessage(options.secondPrompt, 3));
			manager.saveMessage(
				createAssistantMessage(`${options.secondPrompt} ack`, 4),
			);
		}
		await manager.flush();

		const sessionFile = manager.getSessionFile();
		if (options.title) {
			manager.setSessionTitle(sessionFile, options.title);
		}
		if (options.summary) {
			manager.saveSessionSummary(options.summary, sessionFile);
		}
		if (options.resumeSummary) {
			manager.saveSessionResumeSummary(options.resumeSummary, sessionFile);
		}
		if (options.memoryExtractionHash) {
			manager.saveSessionMemoryExtractionHash(
				options.memoryExtractionHash,
				sessionFile,
			);
		}
		if (options.tags) {
			manager.setSessionTags(sessionFile, options.tags);
		}
		if (
			options.title ||
			options.summary ||
			options.resumeSummary ||
			options.memoryExtractionHash ||
			options.tags
		) {
			await manager.flush();
		}
		if (options.modifiedAt) {
			utimesSync(sessionFile, options.modifiedAt, options.modifiedAt);
		}

		return {
			id: manager.getSessionId(),
			sessionFile,
			sessionDir: dirname(sessionFile),
		};
	}

	it("initializes with protocol metadata and validates the shared response schema", async () => {
		const api = createMaestroAppServerSessionApi(createSessionManager());

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				clientInfo: {
					name: "maestro_test",
					title: "Maestro Test",
					version: "0.0.0",
				},
			},
		});

		expect(response.result).toMatchObject({
			protocolVersion: maestroAppServerProtocolVersion,
			serverInfo: { name: "maestro" },
			capabilities: {
				sessions: true,
				modelList: true,
				modelProviderCapabilities: true,
				threadList: true,
				threadRead: true,
				threadMetadataUpdate: true,
				threadNameSet: true,
				threadGoals: true,
				threadStart: true,
				threadFork: true,
				threadArchive: true,
				threadDelete: true,
				turnsList: true,
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, response)).toBe(true);
	});

	it("does not advertise thread goals without a durable goal read path", () => {
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async () => null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			setSessionAppServerGoal: () => {},
		});

		expect(api.initialize()).toMatchObject({
			capabilities: {
				threadGoals: false,
			},
		});
	});

	it("does not advertise persistent thread lifecycle mutations when sessions are disabled", async () => {
		const session = await createPersistedSession("disabled persistence", {
			title: "Disabled persistence",
		});
		const manager = createSessionManager(session.sessionFile);
		manager.disable();
		const api = createMaestroAppServerSessionApi(manager);

		expect(api.initialize()).toMatchObject({
			capabilities: {
				threadStart: false,
				threadFork: false,
				threadArchive: false,
				threadDelete: false,
			},
		});

		for (const request of [
			{
				id: "disabled-thread-start",
				method: "thread/start",
				params: { title: "Disabled thread" },
				message: "Thread start is not available",
			},
			{
				id: "disabled-thread-fork",
				method: "thread/fork",
				params: { threadId: session.id, leafEntryId: "leaf" },
				message: "Thread fork is not available",
			},
			{
				id: "disabled-thread-archive",
				method: "thread/archive",
				params: { threadId: session.id },
				message: "Thread archive is not available",
			},
			{
				id: "disabled-thread-delete",
				method: "thread/delete",
				params: { threadId: session.id },
				message: "Thread delete is not available",
			},
		]) {
			const response = await handleMaestroAppServerRequest(api, {
				jsonrpc: "2.0",
				id: request.id,
				method: request.method,
				params: request.params,
			});
			expect(response.error).toEqual({
				code: -32601,
				message: request.message,
			});
		}
	});

	it("lists models and provider capabilities through the app-server contract", async () => {
		const api = createMaestroAppServerSessionApi(createSessionManager());

		const models = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "models",
			method: "model/list",
			params: { provider: "openai-codex" },
		});

		expect(models.result).toMatchObject({
			models: expect.arrayContaining([
				expect.objectContaining({
					id: "gpt-5.1-codex-max",
					provider: "openai-codex",
					capabilities: expect.objectContaining({
						reasoning: true,
						responsesApi: false,
						codexBackend: true,
					}),
					defaultReasoningEffort: "medium",
				}),
			]),
		});
		expect(Value.Check(MaestroAppServerResponseSchema, models)).toBe(true);

		const providers = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "provider-capabilities",
			method: "modelProvider/capabilities/read",
			params: { provider: "openai-codex" },
		});

		expect(providers.result).toMatchObject({
			providers: [
				{
					id: "openai-codex",
					capabilities: expect.objectContaining({
						reasoning: true,
						responsesApi: false,
						codexBackend: true,
					}),
				},
			],
		});
		expect(Value.Check(MaestroAppServerResponseSchema, providers)).toBe(true);
	});

	it("lists persisted sessions as not-loaded threads with cursor pagination", async () => {
		const oldest = await createPersistedSession("older prompt", {
			modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
			title: "Older",
		});
		const newest = await createPersistedSession("newer prompt", {
			modifiedAt: new Date("2026-01-02T00:00:00.000Z"),
			title: "Newer",
			resumeSummary: "newer resume",
		});
		const manager = createSessionManager(newest.sessionFile);
		manager.listSessions = async () => {
			throw new Error(
				"file-backed thread/list should use loaded metadata only",
			);
		};
		const api = createMaestroAppServerSessionApi(manager);

		const firstPage = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "list-1",
			method: "thread/list",
			params: { limit: 1 },
		});

		expect(firstPage.result).toMatchObject({
			threads: [
				{
					id: newest.id,
					title: "Newer",
					resumeSummary: "newer resume",
					status: "notLoaded",
					source: "session",
				},
			],
		});
		expect(firstPage.result).toHaveProperty("nextCursor");
		expect(Value.Check(MaestroAppServerResponseSchema, firstPage)).toBe(true);

		const secondPage = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "list-2",
			method: "thread/list",
			params: { limit: 1, cursor: firstPage.result?.nextCursor },
		});

		expect(secondPage.result).toMatchObject({
			threads: [
				{
					id: oldest.id,
					title: "Older",
					status: "notLoaded",
					source: "session",
				},
			],
			nextCursor: null,
		});
	});

	it("starts and deletes threads through v2 lifecycle methods", async () => {
		const manager = createSessionManager();
		const api = createMaestroAppServerSessionApi(manager);

		const started = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start",
			method: "thread/start",
			params: { title: "Lifecycle thread" },
		});

		expect(started.result).toMatchObject({
			thread: {
				title: "Lifecycle thread",
				status: "notLoaded",
				messageCount: 0,
				source: "session",
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, started)).toBe(true);

		const threadId = started.result?.thread.id;
		expect(threadId).toEqual(expect.any(String));

		const listed = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start-list",
			method: "thread/list",
			params: {},
		});
		expect(listed.result?.threads).toEqual([
			expect.objectContaining({
				id: threadId,
				title: "Lifecycle thread",
			}),
		]);

		await manager.createSession({ title: "Active replacement" });

		const deleted = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-delete",
			method: "thread/delete",
			params: { threadId },
		});
		expect(deleted.result).toEqual({ threadId, deleted: true });
		expect(Value.Check(MaestroAppServerResponseSchema, deleted)).toBe(true);

		const readDeleted = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-delete-read",
			method: "thread/read",
			params: { threadId },
		});
		expect(readDeleted.error).toMatchObject({
			code: -32004,
			message: "Thread not found",
		});
	});

	it("rejects deleting the currently active thread", async () => {
		const session = await createPersistedSession("active prompt");
		const manager = createSessionManager(session.sessionFile);
		const api = createMaestroAppServerSessionApi(manager);

		const deleted = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-delete-active",
			method: "thread/delete",
			params: { threadId: session.id },
		});

		expect(deleted.error).toMatchObject({
			code: -32000,
			message: "Cannot delete the currently active thread",
		});
		expect(existsSync(session.sessionFile)).toBe(true);
		expect(manager.getSessionFile()).toBe(session.sessionFile);
	});

	it("preserves the active session binding when starting a thread", async () => {
		const active = await createPersistedSession("active prompt");
		const manager = createSessionManager(active.sessionFile);
		const api = createMaestroAppServerSessionApi(manager);

		const started = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start-active-binding",
			method: "thread/start",
			params: { title: "Background thread" },
		});
		const threadId = started.result?.thread.id;
		expect(threadId).toEqual(expect.any(String));
		expect(manager.getSessionFile()).toBe(active.sessionFile);

		manager.saveMessage(createUserMessage("continued active prompt", 10));
		await manager.flush();

		const readStarted = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start-active-binding-read-started",
			method: "thread/read",
			params: { threadId },
		});
		expect(readStarted.result?.thread).toMatchObject({
			id: threadId,
			messageCount: 0,
		});

		const readActive = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start-active-binding-read-active",
			method: "thread/read",
			params: { threadId: active.id },
		});
		expect(readActive.result?.thread).toMatchObject({
			id: active.id,
			messageCount: 3,
		});
	});

	it("restores hosted-style runtime state when starting a thread", async () => {
		const activeId = "active-thread";
		const activeLeafId = "active-leaf";
		const latestLeafId = "active-latest-leaf";
		const backgroundId = "background-thread";
		const now = "2026-05-24T06:00:00.000Z";
		let currentSessionId = activeId;
		let currentLeafId: string | null = activeLeafId;
		const sessions = new Map<
			string,
			{
				id: string;
				title?: string;
				createdAt: string;
				updatedAt: string;
				messages: [];
				messageCount: number;
				favorite: boolean;
				messagesView: "notLoaded";
			}
		>([
			[
				activeId,
				{
					id: activeId,
					title: "Active thread",
					createdAt: now,
					updatedAt: now,
					messages: [],
					messageCount: 2,
					favorite: false,
					messagesView: "notLoaded",
				},
			],
		]);
		const entriesBySessionId = new Map<string, SessionEntry[]>([
			[
				activeId,
				[
					{
						type: "session",
						id: activeId,
						timestamp: now,
						cwd: testDir,
					},
					{
						type: "message",
						id: activeLeafId,
						parentId: null,
						timestamp: now,
						message: createUserMessage("active prompt", 10),
					},
					{
						type: "message",
						id: latestLeafId,
						parentId: activeLeafId,
						timestamp: now,
						message: createAssistantMessage("latest response"),
					},
				],
			],
		]);
		const resumeCalls: string[] = [];
		const branchCalls: string[] = [];
		const setSessionFileCalls: string[] = [];
		const store = {
			getSessionFile: () => `db:${currentSessionId}`,
			getSessionFileById: (sessionId: string) =>
				sessions.has(sessionId) ? `db:${sessionId}` : null,
			loadAllSessions: () =>
				Array.from(sessions.values()).map((session) => ({
					path: `db:${session.id}`,
					id: session.id,
					title: session.title,
					created: new Date(session.createdAt),
					modified: new Date(session.updatedAt),
					size: 0,
					messageCount: session.messageCount,
					firstMessage: "",
					summary: session.title ?? session.id,
					favorite: session.favorite,
					allMessagesText: "",
				})),
			listSessions: async () => Array.from(sessions.values()),
			loadSession: async (sessionId: string) => sessions.get(sessionId) ?? null,
			flush: async () => undefined,
			createSession: async (options?: { title?: string }) => {
				currentSessionId = backgroundId;
				currentLeafId = null;
				sessions.set(backgroundId, {
					id: backgroundId,
					title: options?.title,
					createdAt: now,
					updatedAt: now,
					messages: [],
					messageCount: 0,
					favorite: false,
					messagesView: "notLoaded",
				});
				entriesBySessionId.set(backgroundId, [
					{
						type: "session",
						id: backgroundId,
						timestamp: now,
						cwd: testDir,
						provisional: true,
					},
				]);
				return {
					id: backgroundId,
					title: options?.title,
					createdAt: now,
					updatedAt: now,
					messageCount: 0,
				};
			},
			resumeSession: async (sessionId: string) => {
				resumeCalls.push(sessionId);
				const entries = entriesBySessionId.get(sessionId);
				if (!entries) {
					return false;
				}
				currentSessionId = sessionId;
				currentLeafId =
					[...entries].reverse().find((entry) => entry.type === "message")
						?.id ?? null;
				return true;
			},
			setSessionFile: (sessionReference: string) => {
				setSessionFileCalls.push(sessionReference);
				currentSessionId = sessionReference.replace(/^db:/, "");
			},
			getCurrentLeafId: () => currentLeafId,
			branch: (leafId: string) => {
				branchCalls.push(leafId);
				if (
					!entriesBySessionId
						.get(currentSessionId)
						?.some((entry) => entry.type === "message" && entry.id === leafId)
				) {
					throw new Error(`Entry ${leafId} not found`);
				}
				currentLeafId = leafId;
			},
		};
		const api = createMaestroAppServerSessionApi(store);

		const started = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start-hosted-restore",
			method: "thread/start",
			params: { title: "Background thread" },
		});

		expect(started.result?.thread).toMatchObject({
			id: backgroundId,
			title: "Background thread",
			messageCount: 0,
		});
		expect(resumeCalls).toEqual([activeId]);
		expect(branchCalls).toEqual([activeLeafId]);
		expect(setSessionFileCalls).toEqual([]);
		expect(store.getSessionFile()).toBe(`db:${activeId}`);
		expect(store.getCurrentLeafId()).toBe(activeLeafId);
	});

	it("preserves the selected branch leaf after starting a background thread", async () => {
		const active = await createPersistedSession("branch root", {
			title: "Branched active thread",
			secondPrompt: "later branch",
		});
		const manager = createSessionManager(active.sessionFile);
		const api = createMaestroAppServerSessionApi(manager);
		const messageEntries = safeReadSessionEntries(active.sessionFile).filter(
			(entry): entry is Extract<SessionEntry, { type: "message" }> =>
				entry.type === "message",
		);
		const branchLeafId = messageEntries[1]?.id;
		expect(branchLeafId).toEqual(expect.any(String));
		if (!branchLeafId) {
			throw new Error("Expected branch leaf id");
		}
		expect(manager.getLeafId()).not.toBe(branchLeafId);

		manager.branch(branchLeafId);

		await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start-branch-restore",
			method: "thread/start",
			params: { title: "Background branch thread" },
		});

		expect(manager.getSessionFile()).toBe(active.sessionFile);
		expect(manager.getLeafId()).toBe(branchLeafId);

		manager.saveMessage(createUserMessage("branch continuation", 5));
		await manager.flush();
		const continuation = safeReadSessionEntries(active.sessionFile).find(
			(entry): entry is Extract<SessionEntry, { type: "message" }> =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				entry.message.content.some(
					(part) => part.type === "text" && part.text === "branch continuation",
				),
		);
		expect(continuation?.parentId).toBe(branchLeafId);
	});

	it("preserves a root branch selection after starting a background thread", async () => {
		const active = await createPersistedSession("root branch prompt", {
			title: "Root selected active thread",
			secondPrompt: "later branch",
		});
		const manager = createSessionManager(active.sessionFile);
		const api = createMaestroAppServerSessionApi(manager);
		manager.resetLeaf();
		expect(manager.getLeafId()).toBeNull();

		await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start-root-restore",
			method: "thread/start",
			params: { title: "Background root thread" },
		});

		expect(manager.getSessionFile()).toBe(active.sessionFile);
		expect(manager.getLeafId()).toBeNull();

		manager.saveMessage(createUserMessage("root continuation", 5));
		await manager.flush();
		const continuation = safeReadSessionEntries(active.sessionFile).find(
			(entry): entry is Extract<SessionEntry, { type: "message" }> =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				entry.message.content.some(
					(part) => part.type === "text" && part.text === "root continuation",
				),
		);
		expect(continuation?.parentId).toBeNull();
	});

	it("lets a thread/start placeholder receive the normal first-turn session header", async () => {
		const manager = createSessionManager();
		const api = createMaestroAppServerSessionApi(manager);

		const started = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start",
			method: "thread/start",
			params: { title: "First turn thread" },
		});
		const threadId = started.result?.thread.id;
		expect(threadId).toEqual(expect.any(String));
		const threadSessionFile = manager.getSessionFileById(threadId as string);
		if (!threadSessionFile) {
			throw new Error("Started thread session file was not registered");
		}
		const provisionalEntries = safeReadSessionEntries(threadSessionFile);
		const provisionalHeader = provisionalEntries.find(
			(entry) => entry.type === "session",
		);
		const provisionalTimestamp = provisionalHeader?.timestamp;
		expect(provisionalTimestamp).toEqual(expect.any(String));
		await manager.setSessionFile(threadSessionFile);

		const state = createMockState();
		const firstUser = createUserMessage("first real turn", 10);
		state.messages.push(firstUser);
		expect(manager.shouldInitializeSession(state.messages)).toBe(true);

		manager.startSession(state);
		manager.saveMessage(firstUser);
		await manager.flush();

		const entries = safeReadSessionEntries(manager.getSessionFile());
		const headers = entries.filter((entry) => entry.type === "session");
		expect(headers).toHaveLength(1);
		expect(headers[0]).toMatchObject({
			id: threadId,
			timestamp: provisionalTimestamp,
			model: "anthropic/claude-sonnet-4",
			systemPrompt: "test system prompt",
		});
		expect(headers[0]).not.toHaveProperty("provisional");

		const read = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-read",
			method: "thread/read",
			params: { threadId },
		});
		expect(read.result?.thread).toMatchObject({
			id: threadId,
			title: "First turn thread",
			messageCount: 1,
		});
	});

	it("keeps reloaded thread/start placeholders eligible for first-turn initialization", async () => {
		const manager = createSessionManager();
		const api = createMaestroAppServerSessionApi(manager);

		const started = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start",
			method: "thread/start",
			params: { title: "Reloaded first turn thread" },
		});
		const threadId = started.result?.thread.id;
		expect(threadId).toEqual(expect.any(String));
		const sessionFile = manager.getSessionFileById(threadId as string);
		if (!sessionFile) {
			throw new Error("Started thread session file was not registered");
		}
		await manager.flush();
		manager.disable();

		const reopened = createSessionManager(sessionFile);
		expect(reopened.getSessionId()).toBe(threadId);

		const state = createMockState();
		const firstUser = createUserMessage("first real turn after reload", 10);
		state.messages.push(firstUser);
		expect(reopened.shouldInitializeSession(state.messages)).toBe(true);

		reopened.startSession(state);
		reopened.saveMessage(firstUser);
		await reopened.flush();

		const entries = safeReadSessionEntries(reopened.getSessionFile());
		const headers = entries.filter((entry) => entry.type === "session");
		expect(headers).toHaveLength(1);
		expect(headers[0]).toMatchObject({
			id: threadId,
			model: "anthropic/claude-sonnet-4",
			systemPrompt: "test system prompt",
		});
		expect(headers[0]).not.toHaveProperty("provisional");
	});

	it("preserves thread/start metadata through the first-turn session header rewrite", async () => {
		const manager = createSessionManager();
		const api = createMaestroAppServerSessionApi(manager);

		const started = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-start",
			method: "thread/start",
			params: { title: "Draft thread" },
		});
		const threadId = started.result?.thread.id;
		expect(threadId).toEqual(expect.any(String));
		const threadSessionFile = manager.getSessionFileById(threadId as string);
		if (!threadSessionFile) {
			throw new Error("Started thread session file was not registered");
		}

		await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "metadata-update",
			method: "thread/metadata/update",
			params: {
				threadId,
				summary: "Pre-turn summary",
				resumeSummary: "Pre-turn resume",
				favorite: true,
				tags: ["pre-turn", "metadata"],
			},
		});

		await manager.setSessionFile(threadSessionFile);
		const state = createMockState();
		const firstUser = createUserMessage("first real turn", 10);
		state.messages.push(firstUser);
		manager.startSession(state);
		manager.saveMessage(firstUser);
		await manager.flush();

		const read = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-read",
			method: "thread/read",
			params: { threadId },
		});
		expect(read.result?.thread).toMatchObject({
			id: threadId,
			title: "Draft thread",
			summary: "Pre-turn summary",
			resumeSummary: "Pre-turn resume",
			favorite: true,
			tags: ["pre-turn", "metadata"],
			messageCount: 1,
		});

		const entries = safeReadSessionEntries(threadSessionFile);
		expect(
			entries.some(
				(entry) =>
					entry.type === "session_meta" && entry.summary === "Pre-turn summary",
			),
		).toBe(true);
		expect(
			entries.some(
				(entry) => entry.type === "session_meta" && entry.favorite === true,
			),
		).toBe(true);
	});

	it("archives and unarchives threads without deleting their contents", async () => {
		const session = await createPersistedSession("archive prompt", {
			title: "Archive target",
		});
		const api = createMaestroAppServerSessionApi(
			createSessionManager(session.sessionFile),
		);

		const archived = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-archive",
			method: "thread/archive",
			params: { threadId: session.id },
		});

		expect(archived.result).toMatchObject({
			thread: {
				id: session.id,
				title: "Archive target",
				status: "archived",
				archived: true,
				archivedAt: expect.any(String),
			},
			archived: true,
		});
		expect(Value.Check(MaestroAppServerResponseSchema, archived)).toBe(true);

		const defaultList = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-list-active",
			method: "thread/list",
			params: {},
		});
		expect(defaultList.result?.threads).toEqual([]);

		const archivedList = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-list-archived",
			method: "thread/list",
			params: { includeArchived: true },
		});
		expect(archivedList.result?.threads).toEqual([
			expect.objectContaining({
				id: session.id,
				status: "archived",
				archived: true,
			}),
		]);

		const unarchived = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-unarchive",
			method: "thread/unarchive",
			params: { threadId: session.id },
		});

		expect(unarchived.result).toMatchObject({
			thread: {
				id: session.id,
				status: "notLoaded",
				archived: false,
			},
			archived: false,
		});
		expect(unarchived.result?.thread).not.toHaveProperty("archivedAt");
		expect(Value.Check(MaestroAppServerResponseSchema, unarchived)).toBe(true);
	});

	it("forks a thread from a stable entry id and exposes the new thread", async () => {
		const session = await createPersistedSession("fork root", {
			title: "Fork root",
			secondPrompt: "discarded follow up",
		});
		const current = await createPersistedSession("current root", {
			title: "Current thread",
		});
		const manager = createSessionManager(current.sessionFile);
		const api = createMaestroAppServerSessionApi(manager);
		const root = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "fork-root-read",
			method: "thread/read",
			params: { threadId: session.id, includeTurns: true },
		});
		const forkFromEntryId = root.result?.thread.turns?.[0]?.items.at(-1)?.id;
		expect(forkFromEntryId).toEqual(expect.any(String));

		const forked = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-fork",
			method: "thread/fork",
			params: {
				threadId: session.id,
				leafEntryId: forkFromEntryId,
				title: "Forked from root",
			},
		});

		expect(forked.result).toMatchObject({
			parentThreadId: session.id,
			forkedFromEntryId: forkFromEntryId,
			thread: {
				title: "Forked from root",
				messageCount: 2,
				status: "notLoaded",
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, forked)).toBe(true);

		const forkedThreadId = forked.result?.thread.id;
		const forkedRead = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "forked-read",
			method: "thread/read",
			params: { threadId: forkedThreadId, includeTurns: true },
		});

		expect(forkedRead.result?.thread.turns).toHaveLength(1);
		expect(JSON.stringify(forkedRead.result)).not.toContain(
			"discarded follow up",
		);
		expect(manager.getSessionFile()).toBe(current.sessionFile);
	});

	it("returns invalid params when a thread fork leaf id is unknown", async () => {
		const session = await createPersistedSession("fork root", {
			title: "Fork root",
		});
		const current = await createPersistedSession("current root", {
			title: "Current thread",
		});
		const manager = createSessionManager(current.sessionFile);
		const api = createMaestroAppServerSessionApi(manager);

		const forked = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "thread-fork-missing-leaf",
			method: "thread/fork",
			params: {
				threadId: session.id,
				leafEntryId: "missing-leaf-entry",
			},
		});

		expect(forked.error).toMatchObject({
			code: -32602,
			message: "Unknown leafEntryId",
		});
		expect(manager.getSessionFile()).toBe(current.sessionFile);
	});

	it("keeps file-backed page summaries aligned when unreadable files sort before the cursor", async () => {
		const older = await createPersistedSession("older prompt", {
			modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
			title: "Older title",
			resumeSummary: "older resume",
			tags: ["older-page"],
		});
		const newer = await createPersistedSession("newer prompt", {
			modifiedAt: new Date("2026-01-02T00:00:00.000Z"),
			title: "Newer title",
		});
		const unreadableBeforeCursor = join(testDir, "unreadable-newest.jsonl");
		writeFileSync(unreadableBeforeCursor, "not-json\n");
		utimesSync(
			unreadableBeforeCursor,
			new Date("2026-01-03T00:00:00.000Z"),
			new Date("2026-01-03T00:00:00.000Z"),
		);

		const manager = createSessionManager(newer.sessionFile);
		manager.listSessions = async () => {
			throw new Error(
				"file-backed thread/list must not join paged summaries by raw file offset",
			);
		};
		const api = createMaestroAppServerSessionApi(manager);

		const firstPage = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "unreadable-list-1",
			method: "thread/list",
			params: { limit: 1 },
		});

		expect(firstPage.result).toMatchObject({
			threads: [{ id: newer.id, title: "Newer title" }],
			nextCursor: expect.any(String),
		});

		const secondPage = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "unreadable-list-2",
			method: "thread/list",
			params: { limit: 1, cursor: firstPage.result?.nextCursor },
		});

		expect(secondPage.result).toMatchObject({
			threads: [
				{
					id: older.id,
					title: "Older title",
					resumeSummary: "older resume",
					tags: ["older-page"],
				},
			],
			nextCursor: null,
		});
	});

	it("exposes memory extraction hashes in file-backed thread summaries", async () => {
		const session = await createPersistedSession("memory prompt", {
			title: "Memory thread",
			memoryExtractionHash: "sha256:file-backed-memory",
		});
		const manager = createSessionManager(session.sessionFile);
		manager.listSessions = async () => {
			throw new Error(
				"file-backed memory extraction hashes should come from loaded metadata",
			);
		};
		const api = createMaestroAppServerSessionApi(manager);

		const listed = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "memory-list",
			method: "thread/list",
			params: {},
		});

		expect(listed.result).toMatchObject({
			threads: [
				{
					id: session.id,
					title: "Memory thread",
					memoryExtractionHash: "sha256:file-backed-memory",
				},
			],
		});
		expect(Value.Check(MaestroAppServerResponseSchema, listed)).toBe(true);

		const read = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "memory-read",
			method: "thread/read",
			params: { threadId: session.id },
		});

		expect(read.result?.thread).toMatchObject({
			id: session.id,
			memoryExtractionHash: "sha256:file-backed-memory",
		});
		expect(Value.Check(MaestroAppServerResponseSchema, read)).toBe(true);
	});

	it("lists hosted session summaries when file-backed metadata is unavailable", async () => {
		const summaries = [
			{
				id: "hosted-newer",
				subject: "Hosted Subject",
				resumeSummary: "hosted resume",
				createdAt: "2026-01-02T00:00:00.000Z",
				updatedAt: "2026-01-02T00:01:00.000Z",
				messageCount: 4,
				favorite: false,
				tags: ["hosted"],
			},
			{
				id: "hosted-older",
				title: "Hosted Older",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:01:00.000Z",
				messageCount: 2,
				favorite: true,
			},
		];
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async (options?: { limit?: number; offset?: number }) =>
				summaries.slice(
					options?.offset ?? 0,
					(options?.offset ?? 0) + (options?.limit ?? summaries.length),
				),
			loadSession: async () => null,
			getSessionFileById: () => null,
		});

		const firstPage = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "hosted-list-1",
			method: "thread/list",
			params: { limit: 1 },
		});

		expect(firstPage.result).toMatchObject({
			threads: [
				{
					id: "hosted-newer",
					title: "Hosted Subject",
					summary: "Hosted Subject",
					subject: "Hosted Subject",
					resumeSummary: "hosted resume",
					status: "notLoaded",
					source: "session",
					tags: ["hosted"],
				},
			],
			nextCursor: expect.any(String),
		});

		const secondPage = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "hosted-list-2",
			method: "thread/list",
			params: { limit: 1, cursor: firstPage.result?.nextCursor },
		});

		expect(secondPage.result).toMatchObject({
			threads: [{ id: "hosted-older", favorite: true }],
			nextCursor: null,
		});
	});

	it("continues hosted thread pagination past archived rows", async () => {
		const summaries = [
			{
				id: "archived-one",
				title: "Archived One",
				createdAt: "2026-01-03T00:00:00.000Z",
				updatedAt: "2026-01-03T00:01:00.000Z",
				messageCount: 1,
				favorite: false,
				archived: true,
				archivedAt: "2026-01-03T00:02:00.000Z",
			},
			{
				id: "archived-two",
				title: "Archived Two",
				createdAt: "2026-01-02T00:00:00.000Z",
				updatedAt: "2026-01-02T00:01:00.000Z",
				messageCount: 1,
				favorite: false,
				archived: true,
				archivedAt: "2026-01-02T00:02:00.000Z",
			},
			{
				id: "visible-hosted",
				title: "Visible Hosted",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:01:00.000Z",
				messageCount: 1,
				favorite: false,
			},
		];
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async (options?: { limit?: number; offset?: number }) =>
				summaries.slice(
					options?.offset ?? 0,
					(options?.offset ?? 0) + (options?.limit ?? summaries.length),
				),
			loadSession: async () => null,
			getSessionFileById: () => null,
		});

		const activeOnly = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "hosted-archive-skip",
			method: "thread/list",
			params: { limit: 1 },
		});

		expect(activeOnly.result).toMatchObject({
			threads: [{ id: "visible-hosted", archived: false }],
			nextCursor: null,
		});

		const withArchived = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "hosted-archive-include",
			method: "thread/list",
			params: { limit: 1, includeArchived: true },
		});

		expect(withArchived.result).toMatchObject({
			threads: [{ id: "archived-one", status: "archived", archived: true }],
			nextCursor: expect.any(String),
		});
	});

	it("exposes hosted memory extraction hashes from thread list and read", async () => {
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [
				{
					id: "hosted-memory",
					subject: "Hosted Memory",
					createdAt: "2026-01-02T00:00:00.000Z",
					updatedAt: "2026-01-02T00:01:00.000Z",
					messageCount: 4,
					favorite: false,
					memoryExtractionHash: "sha256:hosted-list-memory",
				},
			],
			loadSession: async (sessionId, options = {}) =>
				sessionId === "hosted-memory"
					? {
							id: sessionId,
							subject: "Hosted Memory",
							messages: [],
							createdAt: "2026-01-02T00:00:00.000Z",
							updatedAt: "2026-01-02T00:01:00.000Z",
							messageCount: 4,
							favorite: false,
							messagesView: options.messagesView ?? "notLoaded",
							memoryExtractionHash: "sha256:hosted-read-memory",
						}
					: null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
		});

		const listed = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "hosted-memory-list",
			method: "thread/list",
			params: {},
		});

		expect(listed.result?.threads).toEqual([
			expect.objectContaining({
				id: "hosted-memory",
				memoryExtractionHash: "sha256:hosted-list-memory",
			}),
		]);
		expect(Value.Check(MaestroAppServerResponseSchema, listed)).toBe(true);

		const read = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "hosted-memory-read",
			method: "thread/read",
			params: { threadId: "hosted-memory" },
		});

		expect(read.result?.thread).toMatchObject({
			id: "hosted-memory",
			memoryExtractionHash: "sha256:hosted-read-memory",
		});
		expect(Value.Check(MaestroAppServerResponseSchema, read)).toBe(true);
	});

	it("reads a thread and includes Codex-style turns only when requested", async () => {
		const session = await createPersistedSession("first prompt", {
			title: "Custom title",
			summary: "Persisted runtime summary",
			secondPrompt: "follow up",
		});
		const api = createMaestroAppServerSessionApi(
			createSessionManager(session.sessionFile),
		);

		const summary = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "read-summary",
			method: "thread/read",
			params: { threadId: session.id },
		});

		expect(summary.result).toMatchObject({
			thread: {
				id: session.id,
				status: "notLoaded",
				title: "Custom title",
				summary: "Persisted runtime summary",
				messagesView: "notLoaded",
				path: session.sessionFile,
			},
		});
		expect(summary.result?.thread).not.toHaveProperty("turns");

		const full = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "read-full",
			method: "thread/read",
			params: { threadId: session.id, includeTurns: true },
		});

		expect(full.result?.thread.turns).toHaveLength(2);
		expect(full.result?.thread.turns?.[0]).toMatchObject({
			status: "completed",
			items: [
				{ type: "message", role: "user" },
				{ type: "message", role: "assistant" },
			],
		});
		expect(full.result?.thread.turns?.[1]?.items[0]).toMatchObject({
			type: "message",
			role: "user",
			content: [{ type: "text", text: "follow up" }],
		});
		expect(Value.Check(MaestroAppServerResponseSchema, full)).toBe(true);
	});

	it("updates thread metadata and name through Codex-style app-server methods", async () => {
		const session = await createPersistedSession("metadata prompt", {
			title: "Original title",
		});
		const api = createMaestroAppServerSessionApi(
			createSessionManager(session.sessionFile),
		);

		const metadata = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "metadata-update",
			method: "thread/metadata/update",
			params: {
				threadId: session.id,
				summary: "Updated summary",
				resumeSummary: "Updated resume",
				favorite: true,
				tags: [" app-server ", "codex", "codex"],
			},
		});

		expect(metadata.result).toMatchObject({
			thread: {
				id: session.id,
				summary: "Updated summary",
				resumeSummary: "Updated resume",
				favorite: true,
				tags: ["app-server", "codex"],
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, metadata)).toBe(true);

		const name = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "name-set",
			method: "thread/name/set",
			params: { threadId: session.id, name: "Renamed thread" },
		});

		expect(name.result).toMatchObject({
			thread: {
				id: session.id,
				title: "Renamed thread",
				summary: "Updated summary",
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, name)).toBe(true);
	});

	it("uses hosted metadata writers for db-backed thread references", async () => {
		const hostedThreads = new Map([
			[
				"current-thread",
				{
					title: "Current title",
					summary: "Current summary",
					resumeSummary: "Current resume",
					favorite: false,
					tags: [] as string[],
				},
			],
			[
				"hosted-thread",
				{
					title: "Hosted title",
					summary: "Hosted summary",
					resumeSummary: "Hosted resume",
					favorite: false,
					tags: [] as string[],
				},
			],
		]);
		const writtenRefs: string[] = [];
		const readHostedThread = (sessionRef: string) =>
			hostedThreads.get(sessionRef.replace(/^db:/, ""));
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async (sessionId, options = {}) => {
				const hosted = hostedThreads.get(sessionId);
				return hosted
					? {
							id: sessionId,
							title: hosted.title,
							summary: hosted.summary,
							resumeSummary: hosted.resumeSummary,
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:02.000Z",
							messageCount: 2,
							favorite: hosted.favorite,
							tags: hosted.tags,
							messagesView: options.messagesView ?? "notLoaded",
						}
					: null;
			},
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			saveSessionSummary: async (summary, sessionRef) => {
				writtenRefs.push(sessionRef ?? "");
				await Promise.resolve();
				const hosted = readHostedThread(sessionRef ?? "");
				if (hosted) hosted.summary = summary;
			},
			saveSessionResumeSummary: async (summary, sessionRef) => {
				writtenRefs.push(sessionRef ?? "");
				await Promise.resolve();
				const hosted = readHostedThread(sessionRef ?? "");
				if (hosted) hosted.resumeSummary = summary;
			},
			setSessionFavorite: async (sessionRef, favorite) => {
				writtenRefs.push(sessionRef);
				await Promise.resolve();
				const hosted = readHostedThread(sessionRef);
				if (hosted) hosted.favorite = favorite;
			},
			setSessionTitle: async (sessionRef, title) => {
				writtenRefs.push(sessionRef);
				await Promise.resolve();
				const hosted = readHostedThread(sessionRef);
				if (hosted) hosted.title = title;
			},
			setSessionTags: async (sessionRef, tags) => {
				writtenRefs.push(sessionRef);
				await Promise.resolve();
				const hosted = readHostedThread(sessionRef);
				if (hosted) hosted.tags = tags;
			},
		});

		const initialized = api.initialize();
		expect(initialized).toMatchObject({
			capabilities: {
				threadMetadataUpdate: true,
				threadNameSet: true,
			},
		});

		const metadata = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "hosted-metadata-update",
			method: "thread/metadata/update",
			params: {
				threadId: "hosted-thread",
				summary: "Updated hosted summary",
				resumeSummary: "Updated hosted resume",
				favorite: true,
				tags: ["hosted"],
			},
		});
		expect(metadata.result).toMatchObject({
			thread: {
				id: "hosted-thread",
				summary: "Updated hosted summary",
				resumeSummary: "Updated hosted resume",
				favorite: true,
				tags: ["hosted"],
			},
		});
		expect(writtenRefs).toEqual([
			"db:hosted-thread",
			"db:hosted-thread",
			"db:hosted-thread",
			"db:hosted-thread",
		]);

		const name = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "hosted-name-set",
			method: "thread/name/set",
			params: { threadId: "hosted-thread", name: "Renamed hosted thread" },
		});
		expect(name.result).toMatchObject({
			thread: {
				id: "hosted-thread",
				title: "Renamed hosted thread",
			},
		});
		expect(writtenRefs).toEqual([
			"db:hosted-thread",
			"db:hosted-thread",
			"db:hosted-thread",
			"db:hosted-thread",
			"db:hosted-thread",
		]);
		expect(hostedThreads.get("current-thread")).toMatchObject({
			title: "Current title",
			summary: "Current summary",
			resumeSummary: "Current resume",
			favorite: false,
			tags: [],
		});
	});

	it("flushes queued store writes before returning metadata summaries", async () => {
		let summary = "Original summary";
		let pendingSummary: string | undefined;
		let flushCount = 0;
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async (sessionId, options = {}) =>
				sessionId === "queued-thread"
					? {
							id: sessionId,
							title: "Queued thread",
							summary,
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							messageCount: 1,
							favorite: false,
							messagesView: options.messagesView ?? "notLoaded",
						}
					: null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			saveSessionSummary: (nextSummary) => {
				pendingSummary = nextSummary;
			},
			flush: async () => {
				flushCount += 1;
				await Promise.resolve();
				if (pendingSummary !== undefined) {
					summary = pendingSummary;
					pendingSummary = undefined;
				}
			},
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "queued-summary-update",
			method: "thread/metadata/update",
			params: {
				threadId: "queued-thread",
				summary: "Flushed summary",
			},
		});

		expect(response.result).toMatchObject({
			thread: {
				id: "queued-thread",
				summary: "Flushed summary",
			},
		});
		expect(flushCount).toBe(1);
	});

	it("fails metadata updates when the writer does not persist the change", async () => {
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async (sessionId, options = {}) =>
				sessionId === "stale-metadata-thread"
					? {
							id: sessionId,
							title: "Stale thread",
							summary: "Original summary",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							messageCount: 1,
							favorite: false,
							messagesView: options.messagesView ?? "notLoaded",
						}
					: null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			saveSessionSummary: () => {},
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "stale-metadata-update",
			method: "thread/metadata/update",
			params: {
				threadId: "stale-metadata-thread",
				summary: "New summary",
			},
		});

		expect(response.error).toMatchObject({
			code: -32000,
			message: "Thread metadata update was not persisted",
		});
	});

	it("treats whitespace-only optional metadata strings as absent", async () => {
		let writeCount = 0;
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async (sessionId, options = {}) =>
				sessionId === "blank-summary-thread"
					? {
							id: sessionId,
							title: "Blank summary thread",
							summary: "Original summary",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							messageCount: 1,
							favorite: false,
							messagesView: options.messagesView ?? "notLoaded",
						}
					: null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			saveSessionSummary: () => {
				writeCount += 1;
			},
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "blank-summary-update",
			method: "thread/metadata/update",
			params: {
				threadId: "blank-summary-thread",
				summary: "   ",
			},
		});

		expect(response.result).toMatchObject({
			thread: {
				id: "blank-summary-thread",
				summary: "Original summary",
			},
		});
		expect(writeCount).toBe(0);
	});

	it("validates hosted thread existence before metadata writes", async () => {
		let writeCount = 0;
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async () => null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			saveSessionSummary: () => {
				writeCount += 1;
			},
			saveSessionResumeSummary: () => {
				writeCount += 1;
			},
			setSessionFavorite: () => {
				writeCount += 1;
			},
			setSessionTitle: () => {
				writeCount += 1;
			},
			setSessionTags: () => {
				writeCount += 1;
			},
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "missing-hosted-write",
			method: "thread/metadata/update",
			params: {
				threadId: "missing-hosted-thread",
				title: "Should not write",
				summary: "Should not write",
			},
		});

		expect(response.error).toMatchObject({
			code: -32004,
			message: "Thread not found",
		});
		expect(writeCount).toBe(0);
	});

	it("fails metadata updates when requested fields are not persisted", async () => {
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async (sessionId, options = {}) =>
				sessionId === "stale-metadata-thread"
					? {
							id: sessionId,
							title: "Original title",
							summary: "Original summary",
							resumeSummary: "Original resume",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							messageCount: 1,
							favorite: false,
							tags: ["original"],
							messagesView: options.messagesView ?? "notLoaded",
						}
					: null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			saveSessionSummary: () => {},
			saveSessionResumeSummary: () => {},
			setSessionFavorite: () => {},
			setSessionTitle: () => {},
			setSessionTags: () => {},
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "stale-metadata-update",
			method: "thread/metadata/update",
			params: {
				threadId: "stale-metadata-thread",
				title: "Updated title",
				summary: "Updated summary",
				resumeSummary: "Updated resume",
				favorite: true,
				tags: ["updated"],
			},
		});

		expect(response.error).toMatchObject({
			code: -32000,
			message: "Thread metadata update was not persisted",
		});
	});

	it("fails thread name updates when the new title is not persisted", async () => {
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async (sessionId, options = {}) =>
				sessionId === "stale-name-thread"
					? {
							id: sessionId,
							title: "Original title",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							messageCount: 1,
							favorite: false,
							messagesView: options.messagesView ?? "notLoaded",
						}
					: null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			setSessionTitle: () => {},
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "stale-name-set",
			method: "thread/name/set",
			params: {
				threadId: "stale-name-thread",
				name: "Updated title",
			},
		});

		expect(response.error).toMatchObject({
			code: -32000,
			message: "Thread metadata update was not persisted",
		});
	});

	it("persists thread goals and clears them through the app-server contract", async () => {
		const session = await createPersistedSession("goal prompt");
		const api = createMaestroAppServerSessionApi(
			createSessionManager(session.sessionFile),
		);

		const set = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "goal-set",
			method: "thread/goal/set",
			params: {
				threadId: session.id,
				objective: "Ship the app-server parity slice",
				tokenBudget: 5000,
			},
		});

		expect(set.result).toMatchObject({
			threadId: session.id,
			goal: {
				objective: "Ship the app-server parity slice",
				status: "active",
				tokenBudget: 5000,
				createdAt: expect.any(String),
				updatedAt: expect.any(String),
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, set)).toBe(true);

		const get = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "goal-get",
			method: "thread/goal/get",
			params: { threadId: session.id },
		});

		expect(get.result).toEqual(set.result);

		const fractionalBudget = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "goal-fractional-budget",
			method: "thread/goal/set",
			params: {
				threadId: session.id,
				objective: "Reject fractional budgets",
				tokenBudget: 0.5,
			},
		});

		expect(fractionalBudget.error).toMatchObject({
			code: -32602,
			message: "Invalid tokenBudget",
		});

		const clear = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "goal-clear",
			method: "thread/goal/clear",
			params: { threadId: session.id },
		});

		expect(clear.result).toEqual({ threadId: session.id, goal: null });
		expect(Value.Check(MaestroAppServerResponseSchema, clear)).toBe(true);
	});

	it("sets hosted thread goals without a file-backed goal read", async () => {
		let storedGoal: unknown;
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async (sessionId, options = {}) =>
				sessionId === "hosted-goal-thread"
					? {
							id: sessionId,
							title: "Hosted goal thread",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							messageCount: 1,
							favorite: false,
							messagesView: options.messagesView ?? "notLoaded",
						}
					: null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			loadEntries: async (sessionId) =>
				sessionId === "hosted-goal-thread" && storedGoal !== undefined
					? [
							{
								type: "session_meta",
								timestamp: "2026-01-01T00:00:00.000Z",
								appServerGoal: storedGoal,
							} as SessionEntry,
						]
					: [],
			setSessionAppServerGoal: async (sessionRef, goal) => {
				await Promise.resolve();
				if (sessionRef === "db:hosted-goal-thread") {
					storedGoal = goal;
				}
			},
		});

		expect(api.initialize()).toMatchObject({
			capabilities: {
				threadGoals: true,
			},
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "hosted-goal-set",
			method: "thread/goal/set",
			params: {
				threadId: "hosted-goal-thread",
				objective: "Persist hosted goals",
			},
		});

		expect(response.result).toMatchObject({
			threadId: "hosted-goal-thread",
			goal: {
				objective: "Persist hosted goals",
				status: "active",
			},
		});
		expect(storedGoal).toMatchObject({
			objective: "Persist hosted goals",
			status: "active",
		});
		expect(Value.Check(MaestroAppServerResponseSchema, response)).toBe(true);
	});

	it("fails goal updates when the writer does not persist the new goal", async () => {
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async (sessionId, options = {}) =>
				sessionId === "stale-goal-thread"
					? {
							id: sessionId,
							title: "Stale goal thread",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							messageCount: 1,
							favorite: false,
							messagesView: options.messagesView ?? "notLoaded",
						}
					: null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			loadEntries: async () => [],
			setSessionAppServerGoal: () => {},
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "stale-goal-set",
			method: "thread/goal/set",
			params: {
				threadId: "stale-goal-thread",
				objective: "This must be durable",
			},
		});

		expect(response.error).toMatchObject({
			code: -32000,
			message: "Thread goal update was not persisted",
		});
	});

	it("validates hosted thread existence before clearing goals", async () => {
		let writeCount = 0;
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async () => null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			setSessionAppServerGoal: () => {
				writeCount += 1;
			},
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "missing-hosted-goal-clear",
			method: "thread/goal/clear",
			params: { threadId: "missing-hosted-thread" },
		});

		expect(response.error).toMatchObject({
			code: -32004,
			message: "Thread not found",
		});
		expect(writeCount).toBe(0);
	});

	it("pages turns without resuming the session", async () => {
		const session = await createPersistedSession("first prompt", {
			secondPrompt: "second prompt",
		});
		const api = createMaestroAppServerSessionApi(
			createSessionManager(session.sessionFile),
		);

		const firstPage = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "turns-1",
			method: "thread/turns/list",
			params: { threadId: session.id, limit: 1 },
		});

		expect(firstPage.result?.turns).toHaveLength(1);
		expect(firstPage.result?.turns[0]?.items[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "first prompt" }],
		});
		expect(firstPage.result?.nextCursor).toEqual(expect.any(String));

		const secondPage = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "turns-2",
			method: "thread/turns/list",
			params: {
				threadId: session.id,
				limit: 1,
				cursor: firstPage.result?.nextCursor,
			},
		});

		expect(secondPage.result).toMatchObject({
			threadId: session.id,
			nextCursor: null,
		});
		expect(secondPage.result?.turns[0]?.items[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "second prompt" }],
		});
	});

	it("builds turns from the active branch path only", () => {
		const entries: SessionEntry[] = [
			{
				type: "session",
				id: "branch-thread",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace",
			},
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: createUserMessage("root prompt"),
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: createAssistantMessage("root response"),
			},
			{
				type: "message",
				id: "stale-user",
				parentId: "assistant-1",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: createUserMessage("stale branch prompt"),
			},
			{
				type: "message",
				id: "stale-assistant",
				parentId: "stale-user",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: createAssistantMessage("stale branch response"),
			},
			{
				type: "message",
				id: "active-user",
				parentId: "assistant-1",
				timestamp: "2026-01-01T00:00:05.000Z",
				message: createUserMessage("active branch prompt"),
			},
			{
				type: "message",
				id: "active-assistant",
				parentId: "active-user",
				timestamp: "2026-01-01T00:00:06.000Z",
				message: createAssistantMessage("active branch response"),
			},
		];

		const turns = buildTurnsFromSessionEntries(entries);

		expect(turns).toHaveLength(2);
		expect(turns.map((turn) => turn.items[0]?.id)).toEqual([
			"user-1",
			"active-user",
		]);
		expect(JSON.stringify(turns)).not.toContain("stale branch");
	});

	it("respects compaction cut points when building turns", () => {
		const entries: SessionEntry[] = [
			{
				type: "session",
				id: "compacted-thread",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace",
			},
			{
				type: "message",
				id: "old-user",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: createUserMessage("old prompt"),
			},
			{
				type: "message",
				id: "old-assistant",
				parentId: "old-user",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: createAssistantMessage("old response"),
			},
			{
				type: "message",
				id: "kept-user",
				parentId: "old-assistant",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: createUserMessage("kept prompt"),
			},
			{
				type: "message",
				id: "kept-assistant",
				parentId: "kept-user",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: createAssistantMessage("kept response"),
			},
			{
				type: "compaction",
				id: "compact-1",
				parentId: "kept-assistant",
				timestamp: "2026-01-01T00:00:05.000Z",
				summary: "Compacted earlier work",
				firstKeptEntryId: "kept-user",
				tokensBefore: 1200,
			},
			{
				type: "message",
				id: "new-user",
				parentId: "compact-1",
				timestamp: "2026-01-01T00:00:06.000Z",
				message: createUserMessage("new prompt"),
			},
		];

		const turns = buildTurnsFromSessionEntries(entries);

		expect(turns.map((turn) => turn.items[0]?.id)).toEqual([
			"kept-user",
			"new-user",
		]);
		expect(JSON.stringify(turns)).not.toContain("old prompt");
	});

	it("normalizes legacy sessions before building turns", () => {
		const entries = [
			{
				type: "session",
				id: "legacy-thread",
				version: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace",
			},
			{
				type: "message",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: createUserMessage("legacy prompt"),
			},
			{
				type: "message",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: createAssistantMessage("legacy response"),
			},
		] as unknown as SessionEntry[];

		const turns = buildTurnsFromSessionEntries(entries);

		expect(turns).toHaveLength(1);
		expect(turns[0]?.items.map((item) => item.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("reads hosted turns from the session entry store instead of file paths", async () => {
		const entries: SessionEntry[] = [
			{
				type: "session",
				id: "hosted-thread",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace",
			},
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: createUserMessage("hosted prompt"),
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: createAssistantMessage("hosted response"),
			},
		];
		let requestedMessagesView: unknown;
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => {
				throw new Error("thread/read should not list every hosted session");
			},
			loadSession: async (sessionId, options = {}) => {
				requestedMessagesView = options.messagesView;
				return sessionId === "hosted-thread"
					? {
							id: sessionId,
							subject: "Hosted Thread",
							messages: [],
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:02.000Z",
							messageCount: 2,
							favorite: false,
							messagesView: options.messagesView ?? "full",
						}
					: null;
			},
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			loadEntries: async (sessionId) =>
				sessionId === "hosted-thread" ? entries : null,
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "hosted-read",
			method: "thread/read",
			params: { threadId: "hosted-thread", includeTurns: true },
		});

		expect(requestedMessagesView).toBe("notLoaded");
		expect(response.result).toMatchObject({
			thread: {
				id: "hosted-thread",
				title: "Hosted Thread",
				summary: "Hosted Thread",
				subject: "Hosted Thread",
				turns: [
					{
						items: [
							{
								role: "user",
								content: [{ type: "text", text: "hosted prompt" }],
							},
							{
								role: "assistant",
								content: [{ type: "text", text: "hosted response" }],
							},
						],
					},
				],
			},
		});
	});

	it("returns graph metadata for replayable thread reads and turn pages", async () => {
		const entries: SessionEntry[] = [
			{
				type: "session",
				id: "graph-thread",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace",
			},
			{
				type: "message",
				id: "old-user",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: createUserMessage("old prompt"),
			},
			{
				type: "message",
				id: "kept-user",
				parentId: "old-user",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: createUserMessage("kept prompt"),
			},
			{
				type: "compaction",
				id: "compact-1",
				parentId: "kept-user",
				timestamp: "2026-01-01T00:00:03.000Z",
				summary: "Compacted older work",
				firstKeptEntryId: "kept-user",
				tokensBefore: 800,
			},
			{
				type: "message",
				id: "active-user",
				parentId: "compact-1",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: createUserMessage("active prompt"),
			},
			{
				type: "message",
				id: "assistant-tools",
				parentId: "active-user",
				timestamp: "2026-01-01T00:00:05.000Z",
				message: {
					...createAssistantMessage("checking"),
					content: [
						{ type: "text" as const, text: "checking" },
						{
							type: "toolCall" as const,
							id: "call-read",
							name: "read",
							arguments: { path: "README.md" },
						},
					],
				},
			},
		];
		const api = createMaestroAppServerSessionApi({
			loadAllSessions: () => [],
			listSessions: async () => [],
			loadSession: async (sessionId, options = {}) =>
				sessionId === "graph-thread"
					? {
							id: sessionId,
							subject: "Graph Thread",
							messages: [],
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:05.000Z",
							messageCount: 5,
							favorite: false,
							messagesView: options.messagesView ?? "notLoaded",
						}
					: null,
			getSessionFileById: (sessionId) => `db:${sessionId}`,
			loadEntries: async (sessionId) =>
				sessionId === "graph-thread" ? entries : null,
		});

		const read = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "graph-read",
			method: "thread/read",
			params: { threadId: "graph-thread", includeTurns: true },
		});

		expect(read.result?.thread.graph).toEqual({
			branchId: "graph-thread:assistant-tools",
			leafEntryId: "assistant-tools",
			activeEntryIds: [
				"kept-user",
				"compact-1",
				"active-user",
				"assistant-tools",
			],
			compactionSpans: [
				{
					id: "compact-1",
					firstKeptEntryId: "kept-user",
					summary: "Compacted older work",
					tokensBefore: 800,
					sourceEntryIds: ["old-user"],
				},
			],
		});
		expect(read.result?.thread.turns?.[1]).toMatchObject({
			id: "active-user",
			parentTurnId: "kept-user",
			sourceEntryIds: ["active-user", "assistant-tools"],
			toolCallIds: ["call-read"],
		});
		expect(Value.Check(MaestroAppServerResponseSchema, read)).toBe(true);

		const turnPage = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "graph-turn-page",
			method: "thread/turns/list",
			params: { threadId: "graph-thread", limit: 1 },
		});

		expect(turnPage.result?.graph).toMatchObject({
			branchId: "graph-thread:assistant-tools",
			leafEntryId: "assistant-tools",
		});
		expect(turnPage.result?.turns[0]).toMatchObject({
			id: "kept-user",
			sourceEntryIds: ["kept-user", "compact-1"],
		});
		expect(Value.Check(MaestroAppServerResponseSchema, turnPage)).toBe(true);
	});

	it("returns JSON-RPC errors for unknown methods and missing threads", async () => {
		const api = createMaestroAppServerSessionApi(createSessionManager());

		const unknown = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "bad-method",
			method: "thread/missing",
			params: {},
		});
		expect(unknown).toMatchObject({
			id: "bad-method",
			error: { code: -32601, message: "Method not found" },
		});

		const missing = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "missing-thread",
			method: "thread/read",
			params: { threadId: "missing" },
		});
		expect(missing).toMatchObject({
			id: "missing-thread",
			error: { code: -32004, message: "Thread not found" },
		});
	});
});
