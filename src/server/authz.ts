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
}> {
	const bearer = getRequestToken(req);
	const jwtPayload = bearer ? await verifyJwt(bearer) : null;
	const userId = bearer ? verifySharedToken(bearer) : null;
	if (userId) return { ok: true };
	if (jwtPayload?.sub) return { ok: true };
	if (WEB_API_KEY) {
		if (bearer && secureCompare(bearer, WEB_API_KEY)) {
			return { ok: true };
		}
		return { ok: false, error: "Unauthorized" };
	}
	return { ok: true };
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
