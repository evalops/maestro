import type { IncomingMessage, ServerResponse } from "node:http";
import { TextEncoder } from "node:util";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	socket: { remoteAddress: string };
}

interface MockResponse {
	statusCode: number;
	headers: Record<string, string | number>;
	body: string;
	headersSent: boolean;
	writableEnded: boolean;
	writeHead(status: number, headers?: Record<string, string | number>): void;
	setHeader(name: string, value: string | number): void;
	end(chunk?: string): void;
}

function makeReq(overrides: Partial<MockRequest> = {}): IncomingMessage {
	return {
		method: "GET",
		url: "/api/status",
		headers: {},
		socket: { remoteAddress: "127.0.0.1" },
		...overrides,
	} as unknown as IncomingMessage;
}

function makeRes(): MockResponse & ServerResponse {
	const res: MockResponse = {
		statusCode: 200,
		headers: {},
		body: "",
		headersSent: false,
		writableEnded: false,
		writeHead(status, headers) {
			this.statusCode = status;
			Object.assign(this.headers, headers);
			this.headersSent = true;
		},
		setHeader(name, value) {
			this.headers[name] = value;
		},
		end(chunk) {
			this.body = chunk ?? "";
			this.writableEnded = true;
		},
	};
	return res as MockResponse & ServerResponse;
}

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
const jwtSecret = "0123456789abcdef0123456789abcdef";

async function signJwt(): Promise<string> {
	return new SignJWT({})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject("user-123")
		.setIssuedAt()
		.setExpirationTime("2h")
		.sign(new TextEncoder().encode(jwtSecret));
}

async function loadMiddlewares() {
	vi.resetModules();
	vi.stubEnv("MAESTRO_WEB_API_KEY", "");
	vi.stubEnv("MAESTRO_WEB_CSRF_TOKEN", "csrf-token");
	vi.stubEnv("MAESTRO_AUTH_SHARED_SECRET", "");
	vi.stubEnv("MAESTRO_JWT_SECRET", jwtSecret);
	vi.stubEnv("MAESTRO_JWT_JWKS_URL", "");
	return import("../../src/server/server-middlewares.js");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("hosted Maestro auth middlewares", () => {
	it("allows unauthenticated login requests through auth and csrf middleware", async () => {
		const { createAuthMiddleware, createCsrfMiddleware } =
			await loadMiddlewares();
		const auth = createAuthMiddleware(null, corsHeaders, true);
		const csrf = createCsrfMiddleware("csrf-token", corsHeaders, true);
		const req = makeReq({
			method: "POST",
			url: "/api/auth/login",
		});
		const res = makeRes();
		let authNextCalled = false;
		let csrfNextCalled = false;

		await auth(req, res, () => {
			authNextCalled = true;
		});
		await csrf(req, res, () => {
			csrfNextCalled = true;
		});

		expect(authNextCalled).toBe(true);
		expect(csrfNextCalled).toBe(true);
		expect(res.statusCode).toBe(200);
	});

	it("rejects protected API routes without credentials when JWT auth is configured", async () => {
		const { createAuthMiddleware } = await loadMiddlewares();
		const auth = createAuthMiddleware(null, corsHeaders, true);
		const req = makeReq({
			method: "GET",
			url: "/api/status",
		});
		const res = makeRes();
		let nextCalled = false;

		await auth(req, res, () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(false);
		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
	});

	it("accepts bearer JWTs on protected API routes", async () => {
		const { createAuthMiddleware } = await loadMiddlewares();
		const auth = createAuthMiddleware(null, corsHeaders, true);
		const req = makeReq({
			method: "GET",
			url: "/api/status",
			headers: {
				authorization: `Bearer ${await signJwt()}`,
			},
		});
		const res = makeRes();
		let nextCalled = false;

		await auth(req, res, () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(true);
		expect(res.writableEnded).toBe(false);
	});

	it("skips CSRF enforcement for bearer-authenticated state-changing requests", async () => {
		const { createCsrfMiddleware } = await loadMiddlewares();
		const csrf = createCsrfMiddleware("csrf-token", corsHeaders, true);
		const req = makeReq({
			method: "POST",
			url: "/api/chat",
			headers: {
				authorization: `Bearer ${await signJwt()}`,
			},
		});
		const res = makeRes();
		let nextCalled = false;

		await csrf(req, res, () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(true);
		expect(res.writableEnded).toBe(false);
	});
});
