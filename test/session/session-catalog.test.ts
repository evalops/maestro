import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentState } from "../../src/agent/types.js";
import { SessionManager } from "../../src/session/manager.js";
import { SessionCatalog } from "../../src/session/session-catalog.js";

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

function createUserMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
}

function createAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-sonnet-4",
		stopReason: "stop" as const,
		timestamp: Date.now(),
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("SessionCatalog", () => {
	let testDir: string;
	let originalEnv: string | undefined;
	let originalCwd: string;
	const managers: SessionManager[] = [];

	beforeEach(() => {
		originalCwd = process.cwd();
		originalEnv = process.env.MAESTRO_AGENT_DIR;

		testDir = join(tmpdir(), `composer-session-catalog-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		process.env.MAESTRO_AGENT_DIR = testDir;
		process.chdir(testDir);
	});

	afterEach(() => {
		for (const manager of managers) {
			manager.disable();
		}
		managers.length = 0;

		process.chdir(originalCwd);
		if (originalEnv === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_AGENT_DIR");
		} else {
			process.env.MAESTRO_AGENT_DIR = originalEnv;
		}

		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	async function createPersistedSession(
		prompt: string,
		options: {
			title?: string;
			favorite?: boolean;
			resumeSummary?: string;
			modifiedAt?: Date;
		} = {},
	) {
		const manager = new SessionManager(false);
		managers.push(manager);

		const state = createMockState();
		const userMessage = createUserMessage(prompt);
		state.messages.push(userMessage);

		manager.saveMessage(userMessage);
		manager.startSession(state);
		manager.saveMessage(createAssistantMessage(`${prompt} ack`));
		await manager.flush();

		const sessionFile = manager.getSessionFile();
		if (options.title) {
			manager.setSessionTitle(sessionFile, options.title);
		}
		if (options.favorite) {
			manager.setSessionFavorite(sessionFile, true);
		}
		if (options.resumeSummary) {
			manager.saveSessionResumeSummary(options.resumeSummary, sessionFile);
		}
		if (options.title || options.favorite || options.resumeSummary) {
			await manager.flush();
		}
		if (options.modifiedAt) {
			utimesSync(sessionFile, options.modifiedAt, options.modifiedAt);
		}

		return {
			id: manager.getSessionId(),
			sessionFile,
		};
	}

	function createCatalog(sessionDir: string, currentSessionId?: string) {
		return new SessionCatalog({
			sessionDir,
			getCurrentSessionId: () => currentSessionId,
		});
	}

	it("loads metadata and full session details from persisted files", async () => {
		const session = await createPersistedSession(
			"Deeply review the codebase before touching tests",
			{
				title: "Review Session",
				favorite: true,
				resumeSummary: "Reviewing the codebase before touching tests.",
			},
		);

		const catalog = createCatalog(dirname(session.sessionFile), session.id);
		const sessions = catalog.loadAllSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			id: session.id,
			summary: expect.stringContaining("Deeply review the codebase"),
			resumeSummary: "Reviewing the codebase before touching tests.",
			favorite: true,
		});

		const summaries = catalog.listSessions();
		expect(summaries).toEqual([
			expect.objectContaining({
				id: session.id,
				title: "Review Session",
				resumeSummary: "Reviewing the codebase before touching tests.",
				favorite: true,
				messageCount: 2,
			}),
		]);

		const loaded = catalog.loadSession(session.id);
		expect(loaded).toMatchObject({
			id: session.id,
			title: "Review Session",
			resumeSummary: "Reviewing the codebase before touching tests.",
			favorite: true,
			messageCount: 2,
		});
		expect(loaded?.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("applies newest-first pagination when listing sessions", async () => {
		const now = Date.now();
		const oldest = await createPersistedSession("oldest session", {
			title: "Oldest",
			modifiedAt: new Date(now - 3000),
		});
		const middle = await createPersistedSession("middle session", {
			title: "Middle",
			modifiedAt: new Date(now - 2000),
		});
		const newest = await createPersistedSession("newest session", {
			title: "Newest",
			modifiedAt: new Date(now - 1000),
		});

		const catalog = createCatalog(dirname(newest.sessionFile));
		const page = catalog.listSessions({ offset: 1, limit: 1 });

		expect(page).toEqual([
			expect.objectContaining({ id: middle.id, title: "Middle" }),
		]);
		expect(catalog.listSessions().map((session) => session.id)).toEqual([
			newest.id,
			middle.id,
			oldest.id,
		]);
	});

	it("deletes sessions by id", async () => {
		const session = await createPersistedSession("delete me");
		const catalog = createCatalog(dirname(session.sessionFile));

		catalog.deleteSession(session.id);

		expect(existsSync(session.sessionFile)).toBe(false);
		expect(catalog.loadSession(session.id)).toBeNull();
	});

	it("prunes stale non-favorite sessions while preserving current and favorite sessions", async () => {
		const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
		const stale = await createPersistedSession("stale session", {
			modifiedAt: oldDate,
		});
		const favorite = await createPersistedSession("favorite session", {
			favorite: true,
			modifiedAt: oldDate,
		});
		const current = await createPersistedSession("current session");

		const catalog = createCatalog(dirname(current.sessionFile), current.id);
		const result = catalog.pruneSessions();

		expect(result).toEqual({ removed: 1, errors: 0 });
		expect(existsSync(stale.sessionFile)).toBe(false);
		expect(existsSync(favorite.sessionFile)).toBe(true);
		expect(existsSync(current.sessionFile)).toBe(true);
	});
});
