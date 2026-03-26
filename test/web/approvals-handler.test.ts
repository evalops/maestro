import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { WebServerContext } from "../../src/server/app-context.js";
import { resetApprovalModeStore } from "../../src/server/approval-mode-store.js";
import { handleApprovals } from "../../src/server/handlers/approvals.js";
import { SessionManager } from "../../src/session/manager.js";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
const originalSessionDir = process.env.MAESTRO_SESSION_DIR;
let tempSessionDir: string | null = null;
const mockSessionState = {
	model: {
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		providerName: "Anthropic",
		name: "Claude Sonnet 4.5",
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: 8_192,
		source: "builtin",
	},
	thinkingLevel: "off",
	systemPrompt: "",
	tools: [],
} as never;

interface MockPassThrough extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	writableEnded: boolean;
	on: () => void;
	off: () => void;
	writeHead(status: number, headers?: Record<string, string>): void;
	write(chunk: string | Buffer): void;
	end(chunk?: string | Buffer): void;
}

function makeRes(): MockResponse {
	return {
		statusCode: 200,
		headers: {},
		body: "",
		writableEnded: false,
		on: () => {},
		off: () => {},
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			this.headers = headers || {};
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

function getTokenSubject(token: string): string {
	return `key:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

function makeSessionDir(): string {
	tempSessionDir = mkdtempSync(join(tmpdir(), "composer-approvals-"));
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

describe("handleApprovals", () => {
	afterEach(() => {
		resetApprovalModeStore();
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

	it("returns the server default approval mode for untouched sessions", async () => {
		const req = new PassThrough() as MockPassThrough;
		req.method = "GET";
		req.url = "/api/approvals?sessionId=session-default";
		req.headers = { host: "localhost" };

		const res = makeRes();

		await handleApprovals(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			{
				corsHeaders,
				defaultApprovalMode: "fail",
			} as Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({ mode: "fail" });
	});

	it("updates the session from the query parameter when the body omits sessionId", async () => {
		const postReq = new PassThrough() as MockPassThrough;
		postReq.method = "POST";
		postReq.url = "/api/approvals?sessionId=session-query";
		postReq.headers = { host: "localhost" };
		postReq.end(JSON.stringify({ mode: "fail" }));

		const postRes = makeRes();

		await handleApprovals(
			postReq as unknown as IncomingMessage,
			postRes as unknown as ServerResponse,
			{
				corsHeaders,
				defaultApprovalMode: "auto",
			} as Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
		);

		expect(postRes.statusCode).toBe(200);
		expect(JSON.parse(postRes.body)).toMatchObject({
			success: true,
			mode: "fail",
		});

		const sessionReq = new PassThrough() as MockPassThrough;
		sessionReq.method = "GET";
		sessionReq.url = "/api/approvals?sessionId=session-query";
		sessionReq.headers = { host: "localhost" };

		const sessionRes = makeRes();

		await handleApprovals(
			sessionReq as unknown as IncomingMessage,
			sessionRes as unknown as ServerResponse,
			{
				corsHeaders,
				defaultApprovalMode: "auto",
			} as Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
		);

		expect(JSON.parse(sessionRes.body)).toMatchObject({ mode: "fail" });

		const defaultReq = new PassThrough() as MockPassThrough;
		defaultReq.method = "GET";
		defaultReq.url = "/api/approvals?sessionId=default";
		defaultReq.headers = { host: "localhost" };

		const defaultRes = makeRes();

		await handleApprovals(
			defaultReq as unknown as IncomingMessage,
			defaultRes as unknown as ServerResponse,
			{
				corsHeaders,
				defaultApprovalMode: "auto",
			} as Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
		);

		expect(JSON.parse(defaultRes.body)).toMatchObject({ mode: "auto" });
	});

	it("does not let a request downgrade the server default approval mode", async () => {
		const postReq = new PassThrough() as MockPassThrough;
		postReq.method = "POST";
		postReq.url = "/api/approvals?sessionId=session-query";
		postReq.headers = { host: "localhost" };
		postReq.end(JSON.stringify({ mode: "auto" }));

		const postRes = makeRes();

		await handleApprovals(
			postReq as unknown as IncomingMessage,
			postRes as unknown as ServerResponse,
			{
				corsHeaders,
				defaultApprovalMode: "fail",
			} as Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
		);

		expect(postRes.statusCode).toBe(200);
		expect(JSON.parse(postRes.body)).toMatchObject({
			success: true,
			mode: "fail",
		});

		const sessionReq = new PassThrough() as MockPassThrough;
		sessionReq.method = "GET";
		sessionReq.url = "/api/approvals?sessionId=session-query";
		sessionReq.headers = { host: "localhost" };

		const sessionRes = makeRes();

		await handleApprovals(
			sessionReq as unknown as IncomingMessage,
			sessionRes as unknown as ServerResponse,
			{
				corsHeaders,
				defaultApprovalMode: "fail",
			} as Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
		);

		expect(JSON.parse(sessionRes.body)).toMatchObject({ mode: "fail" });
	});

	it("stores approval modes separately for each auth subject", async () => {
		const sessionId = "shared-session";
		const ownerToken = "owner-token";
		const otherToken = "other-token";

		const ownerReq = new PassThrough() as MockPassThrough;
		ownerReq.method = "POST";
		ownerReq.url = `/api/approvals?sessionId=${sessionId}`;
		ownerReq.headers = {
			host: "localhost",
			authorization: `Bearer ${ownerToken}`,
		};
		ownerReq.end(JSON.stringify({ mode: "fail" }));

		const ownerRes = makeRes();

		await handleApprovals(
			ownerReq as unknown as IncomingMessage,
			ownerRes as unknown as ServerResponse,
			{
				corsHeaders,
				defaultApprovalMode: "auto",
			} as Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
		);

		expect(ownerRes.statusCode).toBe(200);

		const otherReq = new PassThrough() as MockPassThrough;
		otherReq.method = "GET";
		otherReq.url = `/api/approvals?sessionId=${sessionId}`;
		otherReq.headers = {
			host: "localhost",
			authorization: `Bearer ${otherToken}`,
		};

		const otherRes = makeRes();

		await handleApprovals(
			otherReq as unknown as IncomingMessage,
			otherRes as unknown as ServerResponse,
			{
				corsHeaders,
				defaultApprovalMode: "auto",
			} as Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
		);

		expect(JSON.parse(otherRes.body)).toMatchObject({ mode: "auto" });

		const ownerStatusReq = new PassThrough() as MockPassThrough;
		ownerStatusReq.method = "GET";
		ownerStatusReq.url = `/api/approvals?sessionId=${sessionId}`;
		ownerStatusReq.headers = {
			host: "localhost",
			authorization: `Bearer ${ownerToken}`,
		};

		const ownerStatusRes = makeRes();

		await handleApprovals(
			ownerStatusReq as unknown as IncomingMessage,
			ownerStatusRes as unknown as ServerResponse,
			{
				corsHeaders,
				defaultApprovalMode: "auto",
			} as Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
		);

		expect(JSON.parse(ownerStatusRes.body)).toMatchObject({ mode: "fail" });
	});

	it("rejects approval updates for sessions owned by another subject", async () => {
		const sessionDir = makeSessionDir();
		const ownerToken = "owner-token";
		const intruderToken = "intruder-token";
		const sessionId = createOwnedSession(
			getTokenSubject(ownerToken),
			sessionDir,
		);

		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = `/api/approvals?sessionId=${sessionId}`;
		req.headers = {
			host: "localhost",
			authorization: `Bearer ${intruderToken}`,
		};
		req.end(JSON.stringify({ mode: "fail" }));

		const res = makeRes();

		await handleApprovals(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			{
				corsHeaders,
				defaultApprovalMode: "prompt",
			} as Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode">,
		);

		expect(res.statusCode).toBe(403);
		expect(JSON.parse(res.body)).toMatchObject({
			error: "Access denied: session belongs to another user",
		});
	});
});
