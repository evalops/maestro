import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const corsHeaders = { "Access-Control-Allow-Origin": "*" };
const ARTIFACT_ACCESS_HEADER = "x-composer-artifact-access";

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	headersSent: boolean;
	writableEnded: boolean;
	writeHead(status: number, headers?: Record<string, string>): void;
	end(chunk?: string | Buffer): void;
}

function makeReq(
	headers: Record<string, string> = {},
	url = "/api/chat",
): IncomingMessage {
	return {
		method: "GET",
		url,
		headers,
	} as IncomingMessage;
}

function makeRes(): MockResponse & ServerResponse {
	const res: MockResponse = {
		statusCode: 200,
		headers: {},
		body: "",
		headersSent: false,
		writableEnded: false,
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			Object.assign(this.headers, headers);
			this.headersSent = true;
		},
		end(chunk?: string | Buffer) {
			if (chunk) this.body += chunk.toString();
			this.writableEnded = true;
		},
	};
	return res as MockResponse & ServerResponse;
}

async function importMiddlewares(env: Record<string, string | undefined>) {
	process.env = { ...originalEnv };
	for (const key of [
		"MAESTRO_AUTH_SHARED_SECRET",
		"MAESTRO_JWT_ALG",
		"MAESTRO_JWT_AUD",
		"MAESTRO_JWT_ISS",
		"MAESTRO_JWT_JWKS_URL",
		"MAESTRO_JWT_SECRET",
		"MAESTRO_WEB_API_KEY",
	]) {
		delete process.env[key];
	}
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	vi.resetModules();
	return await import("../../src/server/server-middlewares.js");
}

function sharedToken(secret: string, userId: string): string {
	const user = Buffer.from(userId, "utf-8").toString("base64url");
	const signature = createHmac("sha256", secret).update(userId).digest("hex");
	return `${user}.${signature}`;
}

describe("createAuthMiddleware", () => {
	afterEach(() => {
		process.env = { ...originalEnv };
		vi.resetModules();
	});

	it("rejects invalid bearer tokens when shared-secret auth is configured without an API key", async () => {
		const { createAuthMiddleware } = await importMiddlewares({
			MAESTRO_AUTH_SHARED_SECRET: "shared-test-secret",
		});
		const middleware = createAuthMiddleware(null, corsHeaders, false);
		const res = makeRes();
		let nextCalled = false;

		await middleware(
			makeReq({ authorization: "Bearer user.invalid" }),
			res,
			() => {
				nextCalled = true;
			},
		);

		expect(nextCalled).toBe(false);
		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
	});

	it("accepts shared-secret tokens when an API key is configured", async () => {
		const secret = "shared-test-secret";
		const { createAuthMiddleware } = await importMiddlewares({
			MAESTRO_AUTH_SHARED_SECRET: secret,
		});
		const middleware = createAuthMiddleware("web-api-key", corsHeaders, false);
		const res = makeRes();
		let nextCalled = false;

		await middleware(
			makeReq({ authorization: `Bearer ${sharedToken(secret, "user-1")}` }),
			res,
			() => {
				nextCalled = true;
			},
		);

		expect(nextCalled).toBe(true);
		expect(res.writableEnded).toBe(false);
	});

	it("still enforces API keys passed directly to the middleware", async () => {
		const { createAuthMiddleware } = await importMiddlewares({});
		const middleware = createAuthMiddleware("web-api-key", corsHeaders, false);
		const res = makeRes();
		let nextCalled = false;

		await middleware(makeReq(), res, () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(false);
		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
	});

	it("protects debug routes with configured auth", async () => {
		const { createAuthMiddleware } = await importMiddlewares({
			MAESTRO_AUTH_SHARED_SECRET: "shared-test-secret",
		});
		const middleware = createAuthMiddleware(null, corsHeaders, false);
		const res = makeRes();
		let nextCalled = false;

		await middleware(
			makeReq({ authorization: "Bearer user.invalid" }, "/debug/metrics"),
			res,
			() => {
				nextCalled = true;
			},
		);

		expect(nextCalled).toBe(false);
		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
	});

	it("does not let artifact access grants bypass debug route auth", async () => {
		const { createAuthMiddleware } = await importMiddlewares({
			MAESTRO_AUTH_SHARED_SECRET: "shared-test-secret",
		});
		const { issueArtifactAccessGrant } = await import(
			"../../src/server/artifact-access.js"
		);
		const middleware = createAuthMiddleware(null, corsHeaders, false);
		const grant = issueArtifactAccessGrant({
			sessionId: "session-1",
			actions: ["view"],
			filename: "report.txt",
		});
		const res = makeRes();
		let nextCalled = false;

		await middleware(
			makeReq({ [ARTIFACT_ACCESS_HEADER]: grant.token }, "/debug/metrics"),
			res,
			() => {
				nextCalled = true;
			},
		);

		expect(nextCalled).toBe(false);
		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
	});
});
