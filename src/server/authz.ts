import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from "jose";
import {
	authenticateRequest,
	getRequestHeader,
	getRequestToken,
	secureCompare,
	sendJson,
} from "./server-utils.js";

const WEB_API_KEY = process.env.MAESTRO_WEB_API_KEY?.trim() || null;
const CSRF_TOKEN = process.env.MAESTRO_WEB_CSRF_TOKEN?.trim() || null;
const SHARED_SECRET = process.env.MAESTRO_AUTH_SHARED_SECRET?.trim() || null;
const JWT_SECRET = process.env.MAESTRO_JWT_SECRET?.trim() || null;
const JWT_JWKS_URL = process.env.MAESTRO_JWT_JWKS_URL?.trim() || null;
const JWT_AUDIENCE = process.env.MAESTRO_JWT_AUD?.trim() || undefined;
const JWT_ISSUER = process.env.MAESTRO_JWT_ISS?.trim() || undefined;
const JWT_ALG = process.env.MAESTRO_JWT_ALG?.trim() || "HS256";
const REQUEST_PRINCIPAL = Symbol("maestro.requestPrincipal");

export type AuthMethod = "anon" | "api_key" | "jwt" | "shared_token";

export interface VerifiedRequestPrincipal {
	authMethod: AuthMethod;
	subject: string;
	scopeKey: string;
	userId?: string;
	workspaceId?: string;
	orgId?: string;
	teamId?: string;
	tokenId?: string;
	keyId?: string;
	roles: string[];
	scopes: string[];
	claims?: Record<string, unknown>;
}

type RequestWithPrincipal = IncomingMessage & {
	[REQUEST_PRINCIPAL]?: VerifiedRequestPrincipal | null;
};

function base64UrlDecode(input: string): string {
	return Buffer.from(
		input.replace(/-/g, "+").replace(/_/g, "/"),
		"base64",
	).toString("utf-8");
}

function verifySharedToken(token: string): string | null {
	if (!SHARED_SECRET) return null;
	// Format: base64url(userId).signature
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const user = parts[0]!;
	const providedSig = parts[1]!;
	let userId: string;
	try {
		userId = base64UrlDecode(user);
	} catch {
		return null;
	}
	// Use HMAC instead of plain hash to prevent length-extension attacks
	const hmac = createHmac("sha256", SHARED_SECRET);
	hmac.update(userId);
	const expected = hmac.digest("hex");
	if (!secureCompare(providedSig, expected)) return null;
	return userId;
}

function hasConfiguredAuth(): boolean {
	return Boolean(WEB_API_KEY || SHARED_SECRET || JWT_SECRET || JWT_JWKS_URL);
}

function sanitizePrincipalPart(value: string): string {
	return value
		.trim()
		.replace(/[^a-zA-Z0-9._-]/g, "_")
		.slice(0, 32);
}

function getStringClaim(
	payload: JWTPayload,
	...names: string[]
): string | undefined {
	for (const name of names) {
		const raw = payload[name];
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function getStringListClaim(payload: JWTPayload, ...names: string[]): string[] {
	for (const name of names) {
		const raw = payload[name];
		if (Array.isArray(raw)) {
			return raw
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean);
		}
		if (typeof raw === "string") {
			return raw
				.split(/[,\s]+/)
				.map((value) => value.trim())
				.filter(Boolean);
		}
	}
	return [];
}

function buildScopeKey(parts: string[]): string {
	const normalized = parts
		.map((value) => sanitizePrincipalPart(value))
		.filter(Boolean);
	if (normalized.length === 0) {
		return "anon";
	}
	const joined = normalized.join("__");
	if (joined.length <= 64) {
		return joined;
	}
	const digest = createHash("sha256").update(joined).digest("hex").slice(0, 24);
	return `principal_${digest}`;
}

function setVerifiedRequestPrincipal(
	req: IncomingMessage,
	principal: VerifiedRequestPrincipal | null,
): VerifiedRequestPrincipal | null {
	const request = req as RequestWithPrincipal;
	request[REQUEST_PRINCIPAL] = principal;
	return principal;
}

function createAnonymousPrincipal(): VerifiedRequestPrincipal {
	return {
		authMethod: "anon",
		subject: "anon",
		scopeKey: "anon",
		roles: [],
		scopes: [],
	};
}

function createSharedTokenPrincipal(userId: string): VerifiedRequestPrincipal {
	const subject = `user:${userId}`;
	return {
		authMethod: "shared_token",
		subject,
		scopeKey: buildScopeKey([subject]),
		userId,
		roles: [],
		scopes: [],
	};
}

function createApiKeyPrincipal(token: string): VerifiedRequestPrincipal {
	const keyId = createHash("sha256").update(token).digest("hex").slice(0, 16);
	const subject = `key:${keyId}`;
	return {
		authMethod: "api_key",
		subject,
		scopeKey: buildScopeKey([subject]),
		keyId,
		roles: [],
		scopes: [],
	};
}

function createJwtPrincipal(payload: JWTPayload): VerifiedRequestPrincipal {
	const userId = payload.sub?.trim();
	if (!userId) {
		throw new Error("JWT principal requires sub");
	}
	const workspaceId = getStringClaim(
		payload,
		"workspace_id",
		"workspaceId",
		"wid",
	);
	const orgId = getStringClaim(
		payload,
		"org_id",
		"orgId",
		"organization_id",
		"organizationId",
		"tenant_id",
		"tenantId",
	);
	const teamId = getStringClaim(payload, "team_id", "teamId");
	const subject = `user:${userId}`;
	const scopeParts = [
		workspaceId ? `workspace_${workspaceId}` : null,
		orgId ? `org_${orgId}` : null,
		teamId ? `team_${teamId}` : null,
		`user_${userId}`,
	].filter((value): value is string => Boolean(value));
	return {
		authMethod: "jwt",
		subject,
		scopeKey: buildScopeKey(scopeParts),
		userId,
		workspaceId,
		orgId,
		teamId,
		tokenId: getStringClaim(payload, "jti"),
		roles: getStringListClaim(payload, "roles", "role"),
		scopes: getStringListClaim(payload, "scopes", "scope"),
		claims: { ...payload },
	};
}

export function getVerifiedRequestPrincipal(
	req: IncomingMessage,
): VerifiedRequestPrincipal | null {
	return (req as RequestWithPrincipal)[REQUEST_PRINCIPAL] ?? null;
}

async function verifyJwt(token: string): Promise<JWTPayload | null> {
	if (!JWT_SECRET && !JWT_JWKS_URL) return null;
	try {
		let payload: JWTPayload | null = null;
		if (JWT_JWKS_URL?.length) {
			const jwks = createRemoteJWKSet(new URL(JWT_JWKS_URL));
			const verified = await jwtVerify(token, jwks, {
				algorithms: [JWT_ALG],
				audience: JWT_AUDIENCE,
				issuer: JWT_ISSUER,
			});
			payload = verified.payload;
		} else {
			const secret = new TextEncoder().encode(JWT_SECRET ?? "");
			const verified = await jwtVerify(token, secret, {
				algorithms: [JWT_ALG],
				audience: JWT_AUDIENCE,
				issuer: JWT_ISSUER,
			});
			payload = verified.payload;
		}
		if (!payload.sub) return null;
		// basic exp/nbf checks handled by jose
		return payload;
	} catch {
		return null;
	}
}

export async function checkApiAuth(req: IncomingMessage): Promise<{
	ok: boolean;
	error?: string;
	principal?: VerifiedRequestPrincipal;
}> {
	const cachedPrincipal = getVerifiedRequestPrincipal(req);
	if (cachedPrincipal) {
		return { ok: true, principal: cachedPrincipal };
	}
	const bearer = getRequestToken(req);
	const jwtPayload = bearer ? await verifyJwt(bearer) : null;
	const userId = bearer ? verifySharedToken(bearer) : null;
	if (userId) {
		const principal = setVerifiedRequestPrincipal(
			req,
			createSharedTokenPrincipal(userId),
		);
		return { ok: true, principal: principal ?? undefined };
	}
	if (jwtPayload?.sub) {
		const principal = setVerifiedRequestPrincipal(
			req,
			createJwtPrincipal(jwtPayload),
		);
		return { ok: true, principal: principal ?? undefined };
	}
	if (WEB_API_KEY && bearer && secureCompare(bearer, WEB_API_KEY)) {
		const principal = setVerifiedRequestPrincipal(
			req,
			createApiKeyPrincipal(bearer),
		);
		return { ok: true, principal: principal ?? undefined };
	}
	if (hasConfiguredAuth()) {
		setVerifiedRequestPrincipal(req, null);
		return { ok: false, error: "Unauthorized" };
	}
	const principal = setVerifiedRequestPrincipal(
		req,
		createAnonymousPrincipal(),
	);
	return { ok: true, principal: principal ?? undefined };
}

export async function requireApiAuth(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<boolean> {
	const result = await checkApiAuth(req);
	if (result.ok) return true;
	sendJson(
		res,
		401,
		{
			error:
				"Authentication required. Provide JWT (MAESTRO_JWT_SECRET) or shared-secret bearer token or MAESTRO_WEB_API_KEY.",
		},
		corsHeaders,
		req,
	);
	return false;
}

export function requireCsrf(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): boolean {
	const method = (req.method || "GET").toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
		return true;
	}
	if (!CSRF_TOKEN) {
		sendJson(
			res,
			403,
			{
				error: "MAESTRO_WEB_CSRF_TOKEN is required for state-changing requests",
			},
			corsHeaders,
			req,
		);
		return false;
	}
	const value = getRequestHeader(
		req,
		"x-composer-csrf",
		"x-maestro-csrf",
		"x-csrf-token",
		"x-xsrf-token",
	);
	if (!value || !secureCompare(String(value), CSRF_TOKEN)) {
		sendJson(
			res,
			403,
			{ error: "Forbidden: invalid CSRF token" },
			corsHeaders,
			req,
		);
		return false;
	}
	return true;
}

// Derive a stable subject key from provided token (API key) for per-user scoping
export function getAuthSubject(req: IncomingMessage): string {
	const principal = getVerifiedRequestPrincipal(req);
	if (principal) {
		return principal.subject;
	}
	const token = getRequestToken(req);
	// Attempt JWT verification synchronously not possible; so use hash of token + prefix
	if (token && SHARED_SECRET) {
		const user = verifySharedToken(token);
		if (user) return `user:${user}`;
	}
	if (!token) return "anon";
	const digest = createHash("sha256").update(token).digest("hex");
	return `key:${digest.slice(0, 16)}`;
}

export function getAuthScopeKey(req: IncomingMessage): string {
	const principal = getVerifiedRequestPrincipal(req);
	if (principal) {
		return principal.scopeKey;
	}
	return getAuthSubject(req);
}
