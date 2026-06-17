import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../../src/agent/types.js";
import type { ComposerManager } from "../../src/composers/manager.js";
import type { WebServerContext } from "../../src/server/app-context.js";
import { handleComposer } from "../../src/server/handlers/composer.js";
import { SessionManager } from "../../src/session/manager.js";

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	writableEnded: boolean;
	writeHead(status: number, headers?: Record<string, string>): void;
	write(chunk: string | Buffer): void;
	end(chunk?: string | Buffer): void;
}

interface MockRequest extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

const cors = { "Access-Control-Allow-Origin": "*" };
let tempSessionDir: string | null = null;
const originalSessionDir = process.env.MAESTRO_SESSION_DIR;

const mockSessionState = {
	systemPrompt: "",
	tools: [] as AgentTool[],
	model: "anthropic/claude",
	thinkingLevel: "off" as const,
};

function makeRes(): MockResponse {
	return {
		statusCode: 200,
		headers: {},
		body: "",
		writableEnded: false,
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			this.headers = headers ?? {};
		},
		write(chunk: string | Buffer) {
			this.body += chunk.toString();
		},
		end(chunk?: string | Buffer) {
			if (chunk) this.write(chunk);
			this.writableEnded = true;
		},
	};
}

function makeJsonReq(
	method: string,
	url: string,
	body: unknown,
	token: string,
): MockRequest {
	const req = new PassThrough() as MockRequest;
	req.method = method;
	req.url = url;
	req.headers = {
		host: "localhost",
		authorization: `Bearer ${token}`,
	};
	req.end(JSON.stringify(body));
	return req;
}

function getTokenSubject(token: string): string {
	return `key:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

function makeSessionDir(): string {
	tempSessionDir = mkdtempSync(join(tmpdir(), "maestro-composer-handler-"));
	process.env.MAESTRO_SESSION_DIR = tempSessionDir;
	return tempSessionDir;
}

function createOwnedSession(subject: string, sessionDir: string): string {
	const sessionManager = new SessionManager(false, undefined, {
		sessionDir,
	});
	sessionManager.startSession(mockSessionState, { subject });
	return sessionManager.getSessionId();
}

function createManagerStub(): ComposerManager {
	return {
		activate: vi.fn(() => true),
		deactivate: vi.fn(() => true),
		getState: vi.fn(() => ({
			active: null,
			available: [],
		})),
	} as unknown as ComposerManager;
}

function createContext(
	managers: Map<string, ComposerManager>,
	latest?: { subject: string; sessionId: string; manager: ComposerManager },
): WebServerContext {
	return {
		corsHeaders: cors,
		composerManagers: {
			bindAgentSession: vi.fn(() => true),
			get: (subject, sessionId) => managers.get(`${subject}:${sessionId}`),
			getOrCreate: (subject, sessionId) => {
				const key = `${subject}:${sessionId}`;
				let manager = managers.get(key);
				if (!manager) {
					manager = createManagerStub();
					managers.set(key, manager);
				}
				return manager;
			},
			getLatestForSubject: (subject) =>
				latest && latest.subject === subject
					? { sessionId: latest.sessionId, manager: latest.manager }
					: undefined,
		},
	} as unknown as WebServerContext;
}

describe("handleComposer", () => {
	afterEach(() => {
		if (tempSessionDir) {
			rmSync(tempSessionDir, { recursive: true, force: true });
			tempSessionDir = null;
		}
		if (originalSessionDir === undefined) {
			delete process.env.MAESTRO_SESSION_DIR;
		} else {
			process.env.MAESTRO_SESSION_DIR = originalSessionDir;
		}
	});

	it("activates only the requested session composer manager", async () => {
		const sessionDir = makeSessionDir();
		const token = "owner-token";
		const subject = getTokenSubject(token);
		const sessionA = createOwnedSession(subject, sessionDir);
		const sessionB = createOwnedSession(subject, sessionDir);
		const managerA = createManagerStub();
		const managerB = createManagerStub();
		const context = createContext(
			new Map([
				[`${subject}:${sessionA}`, managerA],
				[`${subject}:${sessionB}`, managerB],
			]),
		);

		const req = makeJsonReq(
			"POST",
			"/api/composer",
			{ action: "activate", name: "reviewer", sessionId: sessionA },
			token,
		);
		const res = makeRes();

		await handleComposer(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context,
		);

		expect(res.statusCode).toBe(200);
		expect(managerA.activate).toHaveBeenCalledWith("reviewer");
		expect(managerB.activate).not.toHaveBeenCalled();
	});

	it("uses the caller's latest session composer manager for legacy mutations without a session id", async () => {
		const sessionDir = makeSessionDir();
		const token = "owner-token";
		const subject = getTokenSubject(token);
		const sessionId = createOwnedSession(subject, sessionDir);
		const manager = createManagerStub();
		const context = createContext(
			new Map([[`${subject}:${sessionId}`, manager]]),
			{ subject, sessionId, manager },
		);

		const req = makeJsonReq(
			"POST",
			"/api/composer",
			{ action: "activate", name: "reviewer" },
			token,
		);
		const res = makeRes();

		await handleComposer(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context,
		);

		expect(res.statusCode).toBe(200);
		expect(manager.activate).toHaveBeenCalledWith("reviewer");
	});

	it("uses the caller's latest session composer manager for legacy reads without a session id", async () => {
		const sessionDir = makeSessionDir();
		const token = "owner-token";
		const subject = getTokenSubject(token);
		const sessionId = createOwnedSession(subject, sessionDir);
		const composer = {
			name: "reviewer",
			description: "Reviewer",
			source: "builtin" as const,
			filePath: "builtin/reviewer.md",
		};
		const manager = {
			...createManagerStub(),
			getState: vi.fn(() => ({
				active: composer,
				available: [composer],
			})),
		} as unknown as ComposerManager;
		const context = createContext(
			new Map([[`${subject}:${sessionId}`, manager]]),
			{ subject, sessionId, manager },
		);

		const req = makeJsonReq("GET", "/api/composer", {}, token);
		const res = makeRes();

		await handleComposer(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			composers: [composer],
			active: composer,
		});
		expect(manager.getState).toHaveBeenCalled();
	});

	it("creates a session-scoped composer manager before the first chat turn", async () => {
		const sessionDir = makeSessionDir();
		const token = "owner-token";
		const subject = getTokenSubject(token);
		const sessionId = createOwnedSession(subject, sessionDir);
		const managers = new Map<string, ComposerManager>();
		const context = createContext(managers);

		const req = makeJsonReq(
			"POST",
			"/api/composer",
			{ action: "activate", name: "reviewer", sessionId },
			token,
		);
		const res = makeRes();

		await handleComposer(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context,
		);

		const manager = managers.get(`${subject}:${sessionId}`);
		expect(res.statusCode).toBe(200);
		expect(manager).toBeDefined();
		expect(manager?.activate).toHaveBeenCalledWith("reviewer");
	});

	it("rejects composer mutations for sessions owned by another subject", async () => {
		const sessionDir = makeSessionDir();
		const ownerToken = "owner-token";
		const intruderToken = "intruder-token";
		const ownerSubject = getTokenSubject(ownerToken);
		const sessionId = createOwnedSession(ownerSubject, sessionDir);
		const manager = createManagerStub();
		const context = createContext(
			new Map([[`${ownerSubject}:${sessionId}`, manager]]),
		);

		const req = makeJsonReq(
			"POST",
			"/api/composer",
			{ action: "activate", name: "reviewer", sessionId },
			intruderToken,
		);
		const res = makeRes();

		await handleComposer(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			context,
		);

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.body)).toMatchObject({
			error: "Session not found",
		});
		expect(manager.activate).not.toHaveBeenCalled();
	});
});
