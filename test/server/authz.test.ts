import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
	return { headers } as IncomingMessage;
}

async function importAuthz(env: Record<string, string | undefined>) {
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
	return await import("../../src/server/authz.js");
}

function sharedToken(secret: string, userId: string): string {
	const user = Buffer.from(userId, "utf-8").toString("base64url");
	const signature = createHmac("sha256", secret).update(userId).digest("hex");
	return `${user}.${signature}`;
}

describe("checkApiAuth", () => {
	afterEach(() => {
		process.env = { ...originalEnv };
		vi.resetModules();
	});

	it("allows unauthenticated requests when no auth mechanism is configured", async () => {
		const { checkApiAuth } = await importAuthz({});

		await expect(checkApiAuth(makeReq())).resolves.toMatchObject({
			ok: true,
			principal: { authMethod: "anon", subject: "anon" },
		});
		await expect(
			checkApiAuth(makeReq({ authorization: "Bearer malformed" })),
		).resolves.toMatchObject({
			ok: true,
			principal: { authMethod: "anon", subject: "anon" },
		});
	});

	it("rejects missing credentials when JWT auth is configured without an API key", async () => {
		const { checkApiAuth } = await importAuthz({
			MAESTRO_JWT_SECRET: "jwt-test-secret",
		});

		await expect(checkApiAuth(makeReq())).resolves.toEqual({
			ok: false,
			error: "Unauthorized",
		});
	});

	it("rejects invalid bearer tokens when JWT auth is configured without an API key", async () => {
		const { checkApiAuth } = await importAuthz({
			MAESTRO_JWT_SECRET: "jwt-test-secret",
		});

		await expect(
			checkApiAuth(makeReq({ authorization: "Bearer malformed" })),
		).resolves.toEqual({
			ok: false,
			error: "Unauthorized",
		});
	});

	it("accepts shared-secret tokens when shared auth is configured without an API key", async () => {
		const secret = "shared-test-secret";
		const { checkApiAuth } = await importAuthz({
			MAESTRO_AUTH_SHARED_SECRET: secret,
		});

		await expect(
			checkApiAuth(
				makeReq({ authorization: `Bearer ${sharedToken(secret, "user-1")}` }),
			),
		).resolves.toMatchObject({
			ok: true,
			principal: { authMethod: "shared_token", subject: "user:user-1" },
		});
	});

	it("rejects invalid shared-secret tokens when shared auth is configured without an API key", async () => {
		const { checkApiAuth } = await importAuthz({
			MAESTRO_AUTH_SHARED_SECRET: "shared-test-secret",
		});

		await expect(
			checkApiAuth(makeReq({ authorization: "Bearer user.invalid" })),
		).resolves.toEqual({
			ok: false,
			error: "Unauthorized",
		});
	});

	it("enforces an API key passed directly to checkApiAuth", async () => {
		const { checkApiAuth } = await importAuthz({});

		await expect(
			checkApiAuth(makeReq(), { apiKey: "web-api-key" }),
		).resolves.toEqual({
			ok: false,
			error: "Unauthorized",
		});
		await expect(
			checkApiAuth(makeReq({ authorization: "Bearer web-api-key" }), {
				apiKey: "web-api-key",
			}),
		).resolves.toMatchObject({
			ok: true,
			principal: { authMethod: "api_key" },
		});
	});
});
