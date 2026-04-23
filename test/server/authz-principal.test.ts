/**
 * @vitest-environment node
 */

import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

function createRequest(
	headers: Record<string, string> = {},
	url = "/api/sessions",
): IncomingMessage {
	return {
		headers: {
			host: "localhost",
			...headers,
		},
		url,
		method: "GET",
	} as unknown as IncomingMessage;
}

function createSharedToken(userId: string, secret: string): string {
	const encodedUser = Buffer.from(userId, "utf-8").toString("base64url");
	const signature = createHmac("sha256", secret).update(userId).digest("hex");
	return `${encodedUser}.${signature}`;
}

async function createJwtToken(
	secret: string,
	claims: {
		sub: string;
		workspaceId?: string;
		orgId?: string;
		teamId?: string;
		jti?: string;
		scope?: string;
		roles?: string[];
	},
): Promise<string> {
	const jwt = new SignJWT({
		...(claims.workspaceId ? { workspace_id: claims.workspaceId } : {}),
		...(claims.orgId ? { org_id: claims.orgId } : {}),
		...(claims.teamId ? { team_id: claims.teamId } : {}),
		...(claims.jti ? { jti: claims.jti } : {}),
		...(claims.scope ? { scope: claims.scope } : {}),
		...(claims.roles ? { roles: claims.roles } : {}),
	})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(claims.sub);
	return jwt.sign(new TextEncoder().encode(secret));
}

function createResponse(): ServerResponse & {
	statusCode?: number;
	body: string;
} {
	return {
		body: "",
		writeHead(statusCode: number) {
			this.statusCode = statusCode;
			return this;
		},
		end(chunk?: string) {
			this.body += chunk ?? "";
			return this;
		},
	} as unknown as ServerResponse & { statusCode?: number; body: string };
}

afterEach(() => {
	process.env = { ...originalEnv };
	vi.resetModules();
});

describe("verified request principals", () => {
	it("uses verified JWT claims for subject and hosted session scope", async () => {
		process.env = {
			...originalEnv,
			MAESTRO_JWT_SECRET: "test-jwt-secret-should-be-long-enough",
			MAESTRO_SESSION_SCOPE: "auth",
		};
		vi.resetModules();
		const { checkApiAuth, getAuthScopeKey, getAuthSubject } = await import(
			"../../src/server/authz.js"
		);
		const { resolveSessionScope } = await import(
			"../../src/server/session-scope.js"
		);
		const token = await createJwtToken(process.env.MAESTRO_JWT_SECRET!, {
			sub: "user-123",
			workspaceId: "workspace-7",
			orgId: "org-9",
			jti: "jwt-1",
			scope: "sessions:read sessions:write",
			roles: ["member"],
		});
		const req = createRequest({ authorization: `Bearer ${token}` });

		const result = await checkApiAuth(req);

		expect(result).toMatchObject({
			ok: true,
			principal: {
				authMethod: "jwt",
				subject: "user:user-123",
				workspaceId: "workspace-7",
				orgId: "org-9",
				tokenId: "jwt-1",
				scopes: ["sessions:read", "sessions:write"],
				roles: ["member"],
			},
		});
		expect(getAuthSubject(req)).toBe("user:user-123");
		expect(getAuthScopeKey(req)).toBe(
			"workspace_workspace-7__org_org-9__user_user-123",
		);
		expect(resolveSessionScope(req)).toBe(
			"workspace_workspace-7__org_org-9__user_user-123",
		);
	});

	it("keeps hosted session scope stable across JWT rotation for the same user and workspace", async () => {
		process.env = {
			...originalEnv,
			MAESTRO_JWT_SECRET: "test-jwt-secret-should-be-long-enough",
			MAESTRO_SESSION_SCOPE: "auth",
		};
		vi.resetModules();
		const { checkApiAuth, getAuthScopeKey } = await import(
			"../../src/server/authz.js"
		);
		const tokenA = await createJwtToken(process.env.MAESTRO_JWT_SECRET!, {
			sub: "user-123",
			workspaceId: "workspace-7",
			orgId: "org-9",
			jti: "jwt-a",
		});
		const tokenB = await createJwtToken(process.env.MAESTRO_JWT_SECRET!, {
			sub: "user-123",
			workspaceId: "workspace-7",
			orgId: "org-9",
			jti: "jwt-b",
		});
		const tokenOtherWorkspace = await createJwtToken(
			process.env.MAESTRO_JWT_SECRET!,
			{
				sub: "user-123",
				workspaceId: "workspace-99",
				orgId: "org-9",
				jti: "jwt-c",
			},
		);
		const reqA = createRequest({ authorization: `Bearer ${tokenA}` });
		const reqB = createRequest({ authorization: `Bearer ${tokenB}` });
		const reqOtherWorkspace = createRequest({
			authorization: `Bearer ${tokenOtherWorkspace}`,
		});

		await checkApiAuth(reqA);
		await checkApiAuth(reqB);
		await checkApiAuth(reqOtherWorkspace);

		expect(getAuthScopeKey(reqA)).toBe(getAuthScopeKey(reqB));
		expect(getAuthScopeKey(reqA)).not.toBe(getAuthScopeKey(reqOtherWorkspace));
	});

	it("keeps shared-secret tokens scoped by durable user identity", async () => {
		process.env = {
			...originalEnv,
			MAESTRO_AUTH_SHARED_SECRET: "shared-secret",
			MAESTRO_SESSION_SCOPE: "auth",
		};
		vi.resetModules();
		const { checkApiAuth, getAuthScopeKey, getAuthSubject } = await import(
			"../../src/server/authz.js"
		);
		const { resolveSessionScope } = await import(
			"../../src/server/session-scope.js"
		);
		const token = createSharedToken(
			"alice",
			process.env.MAESTRO_AUTH_SHARED_SECRET!,
		);
		const req = createRequest({ authorization: `Bearer ${token}` });

		await checkApiAuth(req);

		expect(getAuthSubject(req)).toBe("user:alice");
		expect(getAuthScopeKey(req)).toBe("user_alice");
		expect(resolveSessionScope(req)).toBe("user_alice");
	});

	it("treats the web API key as a single-user scoped principal", async () => {
		process.env = {
			...originalEnv,
			MAESTRO_WEB_API_KEY: "maestro-web-api-key",
			MAESTRO_SESSION_SCOPE: "auth",
		};
		vi.resetModules();
		const { checkApiAuth, getAuthScopeKey, getAuthSubject } = await import(
			"../../src/server/authz.js"
		);
		const reqA = createRequest({
			authorization: `Bearer ${process.env.MAESTRO_WEB_API_KEY}`,
		});
		const reqB = createRequest({
			"x-composer-api-key": process.env.MAESTRO_WEB_API_KEY!,
		});

		await checkApiAuth(reqA);
		await checkApiAuth(reqB);

		expect(getAuthSubject(reqA)).toMatch(/^key:[a-f0-9]{16}$/);
		expect(getAuthScopeKey(reqA)).toBe(getAuthScopeKey(reqB));
	});

	it("rejects invalid bearer tokens when auth is configured", async () => {
		process.env = {
			...originalEnv,
			MAESTRO_JWT_SECRET: "test-jwt-secret-should-be-long-enough",
		};
		vi.resetModules();
		const { checkApiAuth } = await import("../../src/server/authz.js");
		const req = createRequest({ authorization: "Bearer definitely-not-a-jwt" });

		const result = await checkApiAuth(req);

		expect(result).toEqual({ ok: false, error: "Unauthorized" });
	});

	it("applies the authenticated boundary to /debug/z when auth is configured", async () => {
		process.env = {
			...originalEnv,
			MAESTRO_JWT_SECRET: "test-jwt-secret-should-be-long-enough",
			MAESTRO_WEB_REQUIRE_KEY: "0",
		};
		vi.resetModules();
		const { createAuthMiddleware } = await import(
			"../../src/server/server-middlewares.js"
		);
		const req = createRequest({}, "/debug/z");
		const res = createResponse();
		const next = vi.fn();

		await createAuthMiddleware(null, {}, false)(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(401);
		expect(res.body).toContain("Unauthorized");
	});

	it("keeps local unauthenticated requests explicitly anonymous", async () => {
		process.env = {
			...originalEnv,
			MAESTRO_SESSION_SCOPE: "auth",
		};
		vi.resetModules();
		const { checkApiAuth, getAuthScopeKey, getAuthSubject } = await import(
			"../../src/server/authz.js"
		);
		const { resolveSessionScope } = await import(
			"../../src/server/session-scope.js"
		);
		const req = createRequest();

		const result = await checkApiAuth(req);

		expect(result).toMatchObject({
			ok: true,
			principal: { authMethod: "anon", subject: "anon", scopeKey: "anon" },
		});
		expect(getAuthSubject(req)).toBe("anon");
		expect(getAuthScopeKey(req)).toBe("anon");
		expect(resolveSessionScope(req)).toBeNull();
	});
});
