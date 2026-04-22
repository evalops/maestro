/**
 * @vitest-environment node
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, AppMessage } from "../../src/agent/types.js";

vi.mock("../../src/session/session-memory.js", () => ({
	syncSessionMemory: vi.fn(),
}));

const BASE_DB_URL =
	process.env.MAESTRO_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = BASE_DB_URL ? describe : describe.skip;

const originalEnv = { ...process.env };

function quoteIdent(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseUrlFor(baseUrl: string, databaseName: string): string {
	const url = new URL(baseUrl);
	url.pathname = `/${databaseName}`;
	return url.toString();
}

function createMockState(messages: AppMessage[] = []): AgentState {
	return {
		steeringMode: "all",
		followUpMode: "all",
		queueMode: "all",
		messages,
		systemPrompt: "hosted session test",
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

function userMessage(text: string): AppMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function assistantMessage(text: string): AppMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function createScopedRequest(token: string): IncomingMessage {
	return {
		headers: { authorization: `Bearer ${token}` },
		socket: { remoteAddress: "127.0.0.1" },
	} as unknown as IncomingMessage;
}

function countJsonlFiles(root: string): number {
	if (!existsSync(root)) return 0;
	let count = 0;
	for (const entry of readdirSync(root, { recursive: true })) {
		if (String(entry).endsWith(".jsonl")) {
			count += 1;
		}
	}
	return count;
}

describeDb("hosted session database storage", () => {
	let admin: postgres.Sql | null = null;
	let databaseName = "";
	let databaseUrl = "";
	let sessionDir = "";

	beforeEach(async () => {
		vi.resetModules();
		process.env = { ...originalEnv };

		databaseName = `maestro_hosted_sessions_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
		databaseUrl = databaseUrlFor(BASE_DB_URL!, databaseName);
		admin = postgres(BASE_DB_URL!, { max: 1 });
		await admin.unsafe(`CREATE DATABASE ${quoteIdent(databaseName)}`);

		const setup = postgres(databaseUrl, { max: 1 });
		try {
			await setup`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
		} finally {
			await setup.end();
		}

		sessionDir = mkdtempSync(join(tmpdir(), "maestro-hosted-sessions-"));
		process.env.MAESTRO_DATABASE_URL = databaseUrl;
		process.env.MAESTRO_DB_MAX_CONNECTIONS = "1";
		process.env.MAESTRO_SESSION_SCOPE = "auth";
		process.env.MAESTRO_HOSTED_SESSION_STORAGE = "database";
		process.env.MAESTRO_SESSION_DIR = sessionDir;
	});

	afterEach(async () => {
		try {
			const client = await import("../../src/db/client.js");
			await client.closeDb();
		} catch {
			// The test may fail before the app client is imported.
		}

		if (admin) {
			await admin.unsafe(
				`
				SELECT pg_terminate_backend(pid)
				FROM pg_stat_activity
				WHERE datname = '${databaseName.replaceAll("'", "''")}'
					AND pid <> pg_backend_pid()
				`,
			);
			await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)}`);
			await admin.end();
			admin = null;
		}

		if (sessionDir) {
			rmSync(sessionDir, { recursive: true, force: true });
			sessionDir = "";
		}

		process.env = originalEnv;
		vi.resetModules();
	});

	it("persists scoped web sessions in Postgres instead of JSONL files", async () => {
		const { migrate } = await import("../../src/db/migrate.js");
		await expect(migrate()).resolves.toBe(6);

		const { createWebSessionManagerForRequest } = await import(
			"../../src/server/session-scope.js"
		);
		const { isHostedSessionManager } = await import(
			"../../src/server/hosted-session-manager.js"
		);

		const req = createScopedRequest("production-identity-token");
		const manager = createWebSessionManagerForRequest(req, false);
		expect(isHostedSessionManager(manager)).toBe(true);

		const firstUser = userMessage("Store this in the hosted session database.");
		const firstAssistant = assistantMessage("Stored in Postgres.");
		const state = createMockState([firstUser, firstAssistant]);
		manager.startSession(state, { subject: "key:test-subject" });
		manager.saveMessage(firstUser);
		manager.saveMessage(firstAssistant);
		manager.saveSessionSummary("The session is backed by Postgres.");
		manager.saveSessionResumeSummary(
			"Continue from the database-backed state.",
		);
		await manager.flush();
		await expect(
			manager.countActiveSessions(new Date(Date.now() - 60 * 60 * 1000)),
		).resolves.toBe(1);

		const sessionId = manager.getSessionId();
		const loaded = await manager.loadSession(sessionId);
		expect(loaded).toMatchObject({
			id: sessionId,
			messageCount: 2,
			resumeSummary: "Continue from the database-backed state.",
		});
		expect(loaded?.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);

		const resumed = createWebSessionManagerForRequest(req, false);
		expect(isHostedSessionManager(resumed)).toBe(true);
		if (!isHostedSessionManager(resumed)) {
			throw new Error("expected hosted session manager");
		}
		await expect(resumed.resumeSession(sessionId)).resolves.toBe(true);
		const followUp = userMessage("Resume without touching JSONL.");
		resumed.saveMessage(followUp);
		await resumed.updateSessionMetadata(sessionId, {
			title: "Database session",
			favorite: true,
			tags: ["hosted", "identity"],
		});
		await resumed.flush();

		const reloaded = await resumed.loadSession(sessionId);
		expect(reloaded).toMatchObject({
			title: "Database session",
			favorite: true,
			tags: ["hosted", "identity"],
			messageCount: 3,
		});

		const entries = await resumed.loadEntries(sessionId);
		expect(entries?.some((entry) => entry.type === "session")).toBe(true);
		expect(entries?.filter((entry) => entry.type === "message")).toHaveLength(
			3,
		);
		expect(countJsonlFiles(sessionDir)).toBe(0);

		const verify = postgres(databaseUrl, { max: 1 });
		try {
			const rows = await verify<
				Array<{ session_count: string; entry_count: string }>
			>`
				SELECT
					(SELECT count(*)::text FROM hosted_sessions) AS session_count,
					(SELECT count(*)::text FROM hosted_session_entries) AS entry_count
			`;
			expect(rows[0]).toEqual({ session_count: "1", entry_count: "7" });
		} finally {
			await verify.end();
		}
	});
});
